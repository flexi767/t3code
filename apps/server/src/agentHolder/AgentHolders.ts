// @effect-diagnostics nodeBuiltinImport:off - A detached process and its socket have no Effect platform equivalent.
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { type ProviderSessionId, type ThreadId, type ProviderInstanceId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import packageJson from "../../package.json" with { type: "json" };
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import {
  REGISTRATION_DIRECTORY,
  type HeldSessionDescriptor,
  type HeldSessionSnapshot,
  type HolderHello,
  type HolderRegistration,
} from "./protocol.ts";
import { AGENT_HOLDER_PROTOCOL, decodeLine, encodeLine, toWire } from "./wire.ts";
import { AckTracker } from "./retainedEvents.ts";

const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_MS = 100;
const ACK_FLUSH_MS = 100;
const HELLO_TIMEOUT_MS = 10_000;

export class AgentHolderError extends Schema.TaggedError<AgentHolderError>()("AgentHolderError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Agent holder failed: ${this.detail}`;
  }
}

const decodeAdapterError = Schema.decodeUnknownSync(ProviderAdapter.ProviderAdapterV2Error);

type PendingCall = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

interface HolderConnection {
  readonly version: string;
  readonly call: (
    message: Record<string, unknown>,
  ) => Effect.Effect<unknown, AgentHolderError | ProviderAdapter.ProviderAdapterV2Error>;
  readonly send: (message: Record<string, unknown>) => void;
  readonly sessionQueues: Map<
    string,
    Queue.Queue<
      { seq: number; event: ProviderAdapter.ProviderAdapterV2Event },
      ProviderAdapter.ProviderAdapterV2Error | Cause.Done
    >
  >;
  readonly close: () => void;
  readonly closed: () => boolean;
}

const eventSeqs = new WeakMap<object, number>();

/** Extra surface a runtime has when its session lives in a holder process. */
export interface HeldRuntimeControl {
  /** True when the holder runs another build, so its session mustn't take a new turn. */
  readonly stale: boolean;
  readonly acks: AckTracker;
  readonly seqOf: (event: ProviderAdapter.ProviderAdapterV2Event) => number | undefined;
  readonly markSeq: (event: ProviderAdapter.ProviderAdapterV2Event, seq: number) => void;
  /** Forward an acknowledged position; `settled` also frees that turn's retained events. */
  readonly flushAck: (settledThrough?: number) => void;
  /** After this the scope's close leaves the session running in the holder. */
  readonly detach: () => void;
}

export type HeldRuntime = ProviderAdapter.ProviderAdapterV2SessionRuntime & {
  readonly held: HeldRuntimeControl;
};

export const heldControl = (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
): HeldRuntimeControl | undefined => (runtime as Partial<HeldRuntime>).held;

// oxlint-disable-next-line t3code/prefer-effect-fn -- One proxy per session; the socket call spans carry the tracing.
const makeHeldRuntime = (input: {
  readonly connection: HolderConnection;
  readonly descriptor: HeldSessionDescriptor;
  readonly stale: boolean;
  readonly afterSeq: number;
  readonly pushMcp: (threadId: ThreadId) => Effect.Effect<void>;
  readonly scope: Scope.Scope;
}): Effect.Effect<HeldRuntime> =>
  Effect.gen(function* () {
    const { connection, descriptor } = input;
    const sessionId = descriptor.providerSessionId;
    const queue = yield* Queue.unbounded<
      { seq: number; event: ProviderAdapter.ProviderAdapterV2Event },
      ProviderAdapter.ProviderAdapterV2Error | Cause.Done
    >();
    connection.sessionQueues.set(sessionId, queue);
    let detached = false;
    const acks = new AckTracker(input.afterSeq);
    let lastAcked = input.afterSeq;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    const flushAck = (settledThrough?: number) => {
      // With its consumers gone, the position would claim events nobody finished.
      if (detached) return;
      if (ackTimer !== null) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
      const position = acks.position();
      if (position === lastAcked && settledThrough === undefined) return;
      lastAcked = position;
      connection.send({
        op: "ack",
        sessionId,
        seq: position,
        ...(settledThrough === undefined ? {} : { settledThrough }),
      });
    };
    yield* Scope.addFinalizer(
      input.scope,
      Effect.suspend(() => {
        connection.sessionQueues.delete(sessionId);
        if (detached || connection.closed()) return Effect.void;
        return connection.call({ op: "close", sessionId }).pipe(Effect.ignore);
      }),
    );

    const call = (method: string, callInput: unknown, mcpApp = false) =>
      connection
        .call({ op: "call", sessionId, method, input: callInput, ...(mcpApp ? { mcpApp } : {}) })
        .pipe(
          Effect.catchTags({
            AgentHolderError: (cause) =>
              Effect.fail(
                new ProviderAdapter.ProviderAdapterEventStreamError({
                  driver: descriptor.driver,
                  providerSessionId: sessionId,
                  cause: cause.detail,
                }),
              ),
          }),
        ) as Effect.Effect<never, ProviderAdapter.ProviderAdapterV2Error>;

    const forward = <I>(method: string, threadIdOf?: (input: I) => ThreadId | undefined) =>
      descriptor.methods.includes(method)
        ? {
            [method]: (callInput: I) => {
              const threadId = threadIdOf?.(callInput);
              return (threadId === undefined ? Effect.void : input.pushMcp(threadId)).pipe(
                Effect.andThen(call(method, callInput)),
              );
            },
          }
        : {};

    const events = Stream.unwrap(
      connection.call({ op: "subscribe", sessionId, afterSeq: input.afterSeq }).pipe(
        Effect.ignore,
        Effect.as(
          Stream.fromQueue(queue).pipe(
            Stream.map(({ seq, event }) => {
              eventSeqs.set(event, seq);
              return event;
            }),
          ),
        ),
      ),
    );

    const runtime = {
      instanceId: descriptor.instanceId,
      driver: descriptor.driver,
      providerSessionId: sessionId,
      providerSession: descriptor.providerSession,
      events,
      hasPendingBackgroundWork: connection.call({ op: "pending", sessionId }).pipe(
        Effect.map((value) => value === true),
        Effect.orElseSucceed(() => false),
      ),
      ...(descriptor.backgroundTasksEndWithProcess
        ? { backgroundTasksEndWithProcess: true as const }
        : {}),
      ...forward("ensureThread", (value: { threadId: ThreadId }) => value.threadId),
      ...forward("resumeThread", (value: { threadId?: ThreadId }) => value.threadId),
      ...forward("injectHistory"),
      ...forward("startTurn", (value: { threadId: ThreadId }) => value.threadId),
      ...forward("compactThread", (value: { threadId: ThreadId }) => value.threadId),
      ...forward("steerTurn"),
      ...forward("stopTask"),
      ...forward("awaitBackgroundTasks"),
      ...forward("interruptTurn"),
      ...forward("stopSubagent"),
      ...forward("unloadThread"),
      ...forward("respondToRuntimeRequest"),
      ...forward("readThreadSnapshot"),
      ...forward("uploadFeedback"),
      ...forward("rollbackThread"),
      ...forward("forkThread"),
      ...(descriptor.methods.includes("hasPendingBackgroundWorkForThread")
        ? {
            hasPendingBackgroundWorkForThread: (
              providerThread: unknown,
              options?: unknown,
            ): Effect.Effect<boolean> =>
              connection
                .call({
                  op: "call",
                  sessionId,
                  method: "hasPendingBackgroundWorkForThread",
                  input: providerThread,
                  options,
                })
                .pipe(
                  Effect.map((value) => value === true),
                  Effect.orElseSucceed(() => false),
                ),
          }
        : {}),
      ...(descriptor.mcpAppMethods
        ? {
            mcpApps: {
              listTools: (value: unknown) => call("listTools", value, true),
              callTool: (value: unknown) => call("callTool", value, true),
              readResource: (value: unknown) => call("readResource", value, true),
            },
          }
        : {}),
      held: {
        stale: input.stale,
        acks,
        seqOf: (event: ProviderAdapter.ProviderAdapterV2Event) => eventSeqs.get(event),
        markSeq: (event: ProviderAdapter.ProviderAdapterV2Event, seq: number) => {
          eventSeqs.set(event, seq);
        },
        flushAck: (settledThrough?: number) => {
          if (settledThrough !== undefined) {
            flushAck(settledThrough);
            return;
          }
          ackTimer ??= setTimeout(() => flushAck(), ACK_FLUSH_MS);
        },
        detach: () => {
          flushAck();
          detached = true;
        },
      },
    };
    return runtime as unknown as HeldRuntime;
  });

export interface AdoptableSession {
  readonly runtime: HeldRuntime;
  readonly snapshot: HeldSessionSnapshot;
  readonly scope: Scope.Closeable;
}

/** What a driver offers the holder; drivers without it always run in the server. */
export interface HoldableInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly createInput: Record<string, unknown>;
  readonly onUsageLimits?: (update: never) => Effect.Effect<void>;
}

export const AgentHolders = Context.Reference<{
  /** Routes a holdable instance's sessions through the holder while the setting is on. */
  readonly wrap: (
    instance: HoldableInstance,
    adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  ) => ProviderAdapter.ProviderAdapterV2["Service"];
  /** Finds holders from earlier server processes; every session still in one is returned. */
  readonly reattach: Effect.Effect<ReadonlyArray<AdoptableSession>>;
  /** Threads whose agents outlive this server, which recovery and shutdown must leave alone. */
  readonly heldThreadIds: Effect.Effect<ReadonlySet<ThreadId>>;
  readonly setHeldThreadIds: (threadIds: ReadonlySet<ThreadId>) => Effect.Effect<void>;
}>("t3/agentHolder/AgentHolders", {
  defaultValue: () => ({
    wrap: (_instance, adapter) => adapter,
    reattach: Effect.succeed([]),
    heldThreadIds: Effect.succeed(new Set()),
    setHeldThreadIds: () => Effect.void,
  }),
});

const connect = (socketPath: string): Promise<NodeNet.Socket> =>
  new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(socketPath);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });

const openConnection = (
  socket: NodeNet.Socket,
  version: string,
  onPush: (message: Record<string, any>) => void,
): HolderConnection => {
  let nextId = 0;
  let closed = false;
  const pending = new Map<number, PendingCall>();
  const sessionQueues: HolderConnection["sessionQueues"] = new Map();
  const failAll = (detail: string) => {
    closed = true;
    for (const call of pending.values()) call.reject(new AgentHolderError({ detail }));
    pending.clear();
    for (const [sessionId, queue] of sessionQueues) {
      Queue.failCauseUnsafe(
        queue,
        Cause.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: "unknown" as never,
            providerSessionId: sessionId as ProviderSessionId,
            cause: detail,
          }),
        ),
      );
    }
  };
  socket.on("error", () => failAll("The holder connection failed."));
  socket.on("close", () => failAll("The holder connection closed."));
  NodeReadline.createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
    let message: Record<string, any>;
    try {
      message = decodeLine(line) as Record<string, any>;
    } catch {
      // An older holder's frame must end its sessions rather than crash this server.
      socket.destroy();
      return;
    }
    if (message.push !== undefined) {
      if (message.push === "event") {
        const queue = sessionQueues.get(message.sessionId);
        if (queue !== undefined) {
          Queue.offerUnsafe(queue, { seq: message.seq, event: message.event });
        }
      } else if (message.push === "ended") {
        const queue = sessionQueues.get(message.sessionId);
        if (queue !== undefined) {
          Queue.failCauseUnsafe(
            queue,
            message.failure === null
              ? Cause.fail(Cause.Done() as never)
              : Cause.fail(
                  new ProviderAdapter.ProviderAdapterEventStreamError({
                    driver: "unknown" as never,
                    providerSessionId: message.sessionId,
                    cause: message.failure,
                  }),
                ),
          );
        }
      } else {
        onPush(message);
      }
      return;
    }
    const call = pending.get(message.id);
    if (call === undefined) return;
    pending.delete(message.id);
    if (message.adapterError !== undefined) {
      try {
        call.reject(decodeAdapterError(message.adapterError));
      } catch {
        call.reject(new AgentHolderError({ detail: JSON.stringify(message.adapterError) }));
      }
    } else if (message.error !== undefined) {
      call.reject(new AgentHolderError({ detail: String(message.error) }));
    } else {
      call.resolve(message.ok);
    }
  });
  return {
    version,
    sessionQueues,
    closed: () => closed,
    close: () => socket.destroy(),
    send: (message) => {
      if (!closed) socket.write(encodeLine(message));
    },
    call: (message) =>
      Effect.callback((resume) => {
        if (closed) {
          resume(Effect.fail(new AgentHolderError({ detail: "The holder connection closed." })));
          return;
        }
        const id = nextId++;
        pending.set(id, {
          resolve: (value) => resume(Effect.succeed(value)),
          reject: (error) => resume(Effect.fail(error as AgentHolderError)),
        });
        socket.write(encodeLine({ ...message, id }));
      }),
  };
};

export const layer = Layer.effect(
  AgentHolders,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const mcpRegistry = yield* McpSessionRegistry.McpSessionRegistry;
    const continuations = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const scope = yield* Scope.Scope;
    const runPush = Effect.runForkWith(yield* Effect.context<never>());
    const directory = NodePath.join(config.stateDir, REGISTRATION_DIRECTORY);
    const usageHooks = new Map<string, (update: never) => Effect.Effect<void>>();
    let heldThreadIds: ReadonlySet<ThreadId> = new Set();
    let ownConnection: Promise<HolderConnection> | null = null;

    const onPush = (message: Record<string, any>) => {
      if (message.push === "usage") {
        const hook = usageHooks.get(message.instanceId);
        if (hook !== undefined) runPush(hook(message.update as never));
      } else if (message.push === "continuation") {
        runPush(continuations.offer(message.request));
      }
    };

    const spawnHolder = async (): Promise<HolderConnection> => {
      NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const bootstrapPath = NodePath.join(directory, `bootstrap-${process.pid}-${Date.now()}.json`);
      NodeFS.writeFileSync(
        bootstrapPath,
        JSON.stringify(toWire({ version: packageJson.version, config })),
        { mode: 0o600 },
      );
      const entry = process.argv[1]!;
      const holderCommand = [
        process.execPath,
        ...process.execArgv,
        entry,
        "__agent-holder",
        bootstrapPath,
      ];
      let launchFailed = false;
      const launch = (prefix: ReadonlyArray<string>) => {
        const [command, ...args] = [...prefix, ...holderCommand];
        const child = NodeChildProcess.spawn(command!, args, {
          detached: true,
          stdio: "ignore",
          env: process.env,
        });
        child.on("error", () => {
          launchFailed = true;
        });
        child.on("exit", () => {
          launchFailed = true;
        });
        child.unref();
      };
      // A service stop kills its whole cgroup, so a new process group isn't far enough on Linux.
      const scoped =
        // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs from a detached promise, outside Effect.
        process.platform === "linux" && process.env.XDG_RUNTIME_DIR !== undefined;
      launch(scoped ? ["systemd-run", "--user", "--scope", "--quiet", "--collect"] : []);
      let fallbackLaunched = !scoped;
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      for (;;) {
        if (launchFailed && !fallbackLaunched) {
          fallbackLaunched = true;
          launchFailed = false;
          launch([]);
        }
        for (const candidate of listRegistrations()) {
          const registration = readRegistration(candidate);
          if (
            registration === null ||
            registration.version !== packageJson.version ||
            !isAlive(registration.pid)
          )
            continue;
          const socket = await connect(registration.socket).catch(() => null);
          if (socket === null) continue;
          const connection = openConnection(socket, registration.version, onPush);
          // @effect-diagnostics-next-line runEffectInsideEffect:off - Runs inside a detached promise.
          await Effect.runPromise(connection.call({ op: "hello" }).pipe(Effect.ignore));
          return connection;
        }
        if (Date.now() >= deadline) {
          throw new AgentHolderError({ detail: "The holder process did not start." });
        }
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
      }
    };

    const listRegistrations = () => {
      try {
        return NodeFS.readdirSync(directory)
          .filter((name) => /^\d+\.json$/.test(name))
          .map((name) => NodePath.join(directory, name));
      } catch {
        return [];
      }
    };

    const readRegistration = (path: string): HolderRegistration | null => {
      try {
        return JSON.parse(NodeFS.readFileSync(path, "utf8")) as HolderRegistration;
      } catch {
        return null;
      }
    };

    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const holder = (): Promise<HolderConnection> => {
      ownConnection ??= spawnHolder().catch((error) => {
        ownConnection = null;
        throw error;
      });
      return ownConnection.then((connection) => {
        if (!connection.closed()) return connection;
        ownConnection = null;
        return holder();
      });
    };

    const pushMcp = (connection: HolderConnection) => (threadId: ThreadId) =>
      mcpSessions
        .read(threadId)
        .pipe(
          Effect.flatMap((mcp) =>
            mcp === undefined
              ? Effect.void
              : connection.call({ op: "set-mcp", config: mcp }).pipe(Effect.ignore),
          ),
        );

    const wrap = (
      instance: HoldableInstance,
      adapter: ProviderAdapter.ProviderAdapterV2["Service"],
    ): ProviderAdapter.ProviderAdapterV2["Service"] => {
      if (instance.onUsageLimits !== undefined) {
        usageHooks.set(instance.instanceId, instance.onUsageLimits);
      }
      return {
        ...adapter,
        openSession: Effect.fn("AgentHolders.openSession")(function* (input) {
          const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
          if (current?.keepAgentsRunningAcrossRestarts !== true) {
            return yield* adapter.openSession(input);
          }
          const sessionScope = yield* Scope.Scope;
          const connection = yield* Effect.tryPromise({
            try: holder,
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: adapter.driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          });
          const mcp = yield* mcpSessions.read(input.threadId);
          const descriptor = (yield* connection
            .call({
              op: "open",
              instance: {
                instanceId: instance.instanceId,
                driver: instance.driver,
                input: instance.createInput,
              },
              ...(mcp === undefined ? {} : { mcp }),
              input,
            })
            .pipe(
              Effect.catchTags({
                AgentHolderError: (cause) =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver: adapter.driver,
                      providerSessionId: input.providerSessionId,
                      cause: cause.detail,
                    }),
                  ),
              }),
            )) as HeldSessionDescriptor;
          return yield* makeHeldRuntime({
            connection,
            descriptor,
            stale: false,
            afterSeq: 0,
            pushMcp: pushMcp(connection),
            scope: sessionScope,
          });
        }),
      };
    };

    const reattach = Effect.gen(function* () {
      const adoptable: AdoptableSession[] = [];
      for (const path of listRegistrations()) {
        const registration = readRegistration(path);
        if (registration === null || !isAlive(registration.pid)) {
          NodeFS.rmSync(path, { force: true });
          continue;
        }
        const socket = yield* Effect.promise(() => connect(registration.socket).catch(() => null));
        if (socket === null) continue;
        const connection = openConnection(socket, registration.version, onPush);
        const mcpUpstream = yield* mcpRegistry.endpoint;
        const hello = (yield* connection.call({ op: "hello", mcpUpstream }).pipe(
          Effect.timeoutOption(HELLO_TIMEOUT_MS),
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        )) as HolderHello | null;
        if (hello === null) {
          // It answered the socket but not us; recovery can't run beside a live agent.
          yield* Effect.logWarning("Killing an unresponsive agent holder", {
            pid: registration.pid,
          });
          process.kill(registration.pid, "SIGKILL");
          connection.close();
          NodeFS.rmSync(path, { force: true });
          continue;
        }
        if (hello.protocol !== AGENT_HOLDER_PROTOCOL) {
          yield* Effect.logWarning("Stopping an agent holder from an incompatible build", {
            pid: hello.pid,
            version: hello.version,
          });
          connection.send({ op: "shutdown" });
          connection.close();
          continue;
        }
        // An older build only finishes what it has; this server's new sessions use its own build.
        if (hello.version === packageJson.version) {
          ownConnection ??= Promise.resolve(connection);
        } else {
          connection.send({ op: "retire" });
        }
        for (const snapshot of hello.sessions) {
          const sessionScope = yield* Scope.fork(scope);
          const runtime = yield* makeHeldRuntime({
            connection,
            descriptor: snapshot.descriptor,
            stale: hello.version !== packageJson.version,
            afterSeq: snapshot.lastSeq,
            pushMcp: pushMcp(connection),
            scope: sessionScope,
          });
          for (const mcp of snapshot.mcpConfigs) {
            // A later turn pushes this config back, which must not undo a changed port.
            const current = { ...(mcp as McpProviderSessionConfig), endpoint: mcpUpstream };
            yield* mcpRegistry.restore(current);
            yield* mcpSessions.set(current);
          }
          adoptable.push({ runtime, snapshot, scope: sessionScope });
        }
      }
      return adoptable;
    });

    return {
      wrap,
      reattach: reattach as Effect.Effect<ReadonlyArray<AdoptableSession>>,
      heldThreadIds: Effect.sync(() => heldThreadIds),
      setHeldThreadIds: Effect.fn("AgentHolders.setHeldThreadIds")(function* (
        threadIds: ReadonlySet<ThreadId>,
      ) {
        heldThreadIds = threadIds;
      }),
    };
  }),
);

// @effect-diagnostics nodeBuiltinImport:off - The holder's socket and lifecycle run outside any server runtime.
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics unsafeEffectTypeAssertion:off - The holder only sees driver input as JSON.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProviderDriverKind, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeClaudeScopedLimitNames } from "../provider/claudeUsageLimits.ts";
import { startMcpHoldingProxy, type McpHoldingProxy } from "./mcpHoldingProxy.ts";
import {
  FORWARDED_RUNTIME_METHODS,
  REGISTRATION_DIRECTORY,
  type HeldSessionDescriptor,
  type HeldSessionSnapshot,
  type HolderRegistration,
} from "./protocol.ts";
import { RetainedEvents } from "./retainedEvents.ts";
import { AGENT_HOLDER_PROTOCOL, decodeLine, encodeLine, fromWire } from "./wire.ts";

/** Quiet this long with no server, the agents have nobody to report to. */
const ORPHAN_TIMEOUT_MS = 30 * 60 * 1000;
const EMPTY_EXIT_MS = 60 * 1000;
const LIFECYCLE_POLL_MS = 15 * 1000;

interface HolderBootstrap {
  readonly version: string;
  readonly config: ServerConfig.ServerConfig["Service"];
}

interface InstanceCreateInput {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly input: Record<string, unknown>;
}

interface HeldSession {
  readonly descriptor: HeldSessionDescriptor;
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly scope: Scope.Closeable;
  readonly log: RetainedEvents;
  readonly threadIds: Set<ThreadId>;
  lastSeq: number;
  /** A subscribed connection receives everything after this position. */
  sentThrough: number | null;
  ended: boolean;
  endFailure: string | null;
}

const encodeAdapterError = Schema.encodeUnknownSync(ProviderAdapter.ProviderAdapterV2Error);

export const runAgentHolder = async (bootstrapPath: string): Promise<void> => {
  const bootstrap = fromWire(
    JSON.parse(NodeFS.readFileSync(bootstrapPath, "utf8")),
  ) as HolderBootstrap;
  NodeFS.rmSync(bootstrapPath, { force: true });
  const { config, version } = bootstrap;
  const directory = NodePath.join(config.stateDir, REGISTRATION_DIRECTORY);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socketPath = NodePath.join(directory, `${process.pid}.sock`);
  const registrationPath = NodePath.join(directory, `${process.pid}.json`);

  const mcpSessionsLayer = McpProviderSessions.layer;
  const continuationsLayer = ProviderContinuationRequests.layer;
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      ClaudeAdapterV2.layerQueryRunner,
      CodexAdapterV2.layerAppServerClientFactory,
      IdAllocator.layer,
      mcpSessionsLayer,
      continuationsLayer,
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(ServerConfig.ServerConfig, config),
          // The holder has no log directories of its own; the server keeps the protocol logs.
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
          // Only the server scans ports, so a held agent's servers are found without this count.
          Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );
  const holderScope = await runtime.runPromise(Scope.make());
  const sessions = new Map<string, HeldSession>();
  const adapters = new Map<string, Promise<ProviderAdapter.ProviderAdapterV2["Service"]>>();
  const mcpConfigs = new Map<ThreadId, McpProviderSessionConfig>();
  let connection: NodeNet.Socket | null = null;
  let proxy: McpHoldingProxy | null = null;
  let lastActivity = Date.now();
  let emptySince: number | null = Date.now();
  let shuttingDown = false;
  let retiring = false;

  const write = (message: unknown) => {
    connection?.write(encodeLine(message));
  };
  /** A wake is the agent's only way back to work, so one sent during the outage must survive it. */
  const undeliveredContinuations: unknown[] = [];

  const register = () => {
    const threadIds = [...sessions.values()].flatMap((session) => [...session.threadIds]);
    const registration: HolderRegistration = {
      pid: process.pid,
      version,
      socket: socketPath,
      protocol: AGENT_HOLDER_PROTOCOL,
      threadIds,
    };
    const temporary = `${registrationPath}.next`;
    NodeFS.writeFileSync(temporary, JSON.stringify(registration), { mode: 0o600 });
    NodeFS.renameSync(temporary, registrationPath);
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const session of sessions.values()) {
      await runtime.runPromise(Scope.close(session.scope, Exit.void)).catch(() => undefined);
    }
    NodeFS.rmSync(registrationPath, { force: true });
    NodeFS.rmSync(socketPath, { force: true });
    proxy?.close();
    process.exit(0);
  };

  const pump = (session: HeldSession) =>
    session.runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          lastActivity = Date.now();
          session.lastSeq += 1;
          const seq = session.lastSeq;
          const line = encodeLine({
            push: "event",
            sessionId: session.descriptor.providerSessionId,
            seq,
            event,
          });
          session.log.add(seq, event, line.length);
          if (session.sentThrough !== null) {
            connection?.write(line);
            session.sentThrough = seq;
          }
        }),
      ),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.sync(() => {
          session.ended = true;
          session.endFailure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : null;
          // Otherwise subscribe reports it after the replay, so no event is lost to an early close.
          if (session.sentThrough !== null) {
            write({
              push: "ended",
              sessionId: session.descriptor.providerSessionId,
              failure: session.endFailure,
            });
          }
        }),
      ),
    );

  const adapterFor = (instance: InstanceCreateInput) => {
    const key = JSON.stringify(instance);
    const existing = adapters.get(key);
    if (existing !== undefined) return existing;
    const onUsageLimits = (update: unknown) =>
      Effect.sync(() => write({ push: "usage", instanceId: instance.instanceId, update }));
    const created = runtime.runPromise(
      Effect.gen(function* () {
        const input = instance.input as never;
        if (instance.driver === ProviderDriverKind.make("claudeAgent")) {
          const scopedLimitNames = yield* makeClaudeScopedLimitNames;
          return yield* ClaudeAdapterV2.createClaudeAdapterV2(input, {
            scopedLimitNames,
            onUsageLimits: onUsageLimits as never,
          });
        }
        return yield* CodexAdapterV2.createCodexAdapterV2(input, {
          onUsageLimits: onUsageLimits as never,
        });
      }).pipe(Effect.provideService(Scope.Scope, holderScope)) as Effect.Effect<
        ProviderAdapter.ProviderAdapterV2["Service"],
        unknown,
        never
      >,
    );
    adapters.set(key, created);
    created.catch(() => adapters.delete(key));
    return created;
  };

  const describe = (
    runtimeSession: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  ): HeldSessionDescriptor => ({
    providerSessionId: runtimeSession.providerSessionId,
    instanceId: runtimeSession.instanceId,
    driver: runtimeSession.driver,
    providerSession: runtimeSession.providerSession,
    methods: FORWARDED_RUNTIME_METHODS.filter((method) => runtimeSession[method] !== undefined),
    mcpAppMethods: runtimeSession.mcpApps !== undefined,
    backgroundTasksEndWithProcess: runtimeSession.backgroundTasksEndWithProcess === true,
  });

  /** Agents get the proxy's address, which stays valid while the server restarts. */
  const applyMcpConfig = async (config: McpProviderSessionConfig) => {
    mcpConfigs.set(config.threadId, config);
    proxy ??= await startMcpHoldingProxy(config.endpoint);
    proxy.setUpstream(config.endpoint);
    const proxied = { ...config, endpoint: proxy.endpoint };
    await runtime.runPromise(
      McpProviderSessions.McpProviderSessions.pipe(
        Effect.flatMap((service) => service.set(proxied)),
      ),
    );
  };

  const snapshot = (session: HeldSession): HeldSessionSnapshot => ({
    descriptor: session.descriptor,
    threadIds: [...session.threadIds],
    mcpConfigs: [...session.threadIds].flatMap((threadId) => {
      const config = mcpConfigs.get(threadId);
      return config === undefined ? [] : [config];
    }),
    lastSeq: session.lastSeq,
    ackedSeq: session.log.ackedSeq,
    truncated: session.log.truncated,
    retained: session.log.snapshot(),
    ended: session.ended,
  });

  const sessionFor = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new Error(`Unknown held session ${sessionId}.`);
    return session;
  };

  const handle = async (message: Record<string, any>): Promise<unknown> => {
    switch (message.op) {
      case "hello": {
        if (typeof message.mcpUpstream === "string") proxy?.setUpstream(message.mcpUpstream);
        for (const session of sessions.values()) session.sentThrough = null;
        setImmediate(() => {
          for (const request of undeliveredContinuations.splice(0)) {
            write({ push: "continuation", request });
          }
        });
        return {
          protocol: AGENT_HOLDER_PROTOCOL,
          pid: process.pid,
          version,
          sessions: [...sessions.values()].map(snapshot),
        };
      }
      case "open": {
        if (message.mcp !== undefined) await applyMcpConfig(message.mcp);
        const adapter = await adapterFor(message.instance);
        const scope = await runtime.runPromise(Scope.make("parallel"));
        const opened = await runtime.runPromise(
          adapter
            .openSession(message.input)
            .pipe(Effect.provideService(Scope.Scope, scope)) as Effect.Effect<
            ProviderAdapter.ProviderAdapterV2SessionRuntime,
            ProviderAdapter.ProviderAdapterV2Error,
            never
          >,
        );
        const session: HeldSession = {
          descriptor: describe(opened),
          runtime: opened,
          scope,
          log: new RetainedEvents(),
          threadIds: new Set([message.input.threadId]),
          lastSeq: 0,
          sentThrough: null,
          ended: false,
          endFailure: null,
        };
        sessions.set(opened.providerSessionId, session);
        register();
        void runtime.runPromise(pump(session));
        return session.descriptor;
      }
      case "call": {
        const session = sessionFor(message.sessionId);
        if (typeof message.input?.threadId === "string") {
          if (!session.threadIds.has(message.input.threadId)) {
            session.threadIds.add(message.input.threadId);
            register();
          }
        }
        const target = (message.mcpApp === true
          ? session.runtime.mcpApps
          : session.runtime) as unknown as Record<
          string,
          (input: unknown, options?: unknown) => Effect.Effect<unknown, unknown>
        >;
        return runtime.runPromise(target[message.method]!(message.input, message.options));
      }
      case "pending": {
        const pending = sessionFor(message.sessionId).runtime.hasPendingBackgroundWork;
        return pending === undefined ? false : runtime.runPromise(pending);
      }
      case "set-mcp": {
        await applyMcpConfig(message.config);
        return null;
      }
      case "subscribe": {
        const session = sessionFor(message.sessionId);
        session.sentThrough = message.afterSeq;
        for (const { seq, event } of session.log.snapshot()) {
          if (seq > message.afterSeq) {
            write({ push: "event", sessionId: session.descriptor.providerSessionId, seq, event });
            session.sentThrough = seq;
          }
        }
        session.sentThrough = session.lastSeq;
        if (session.ended) {
          write({
            push: "ended",
            sessionId: session.descriptor.providerSessionId,
            failure: session.endFailure,
          });
        }
        return null;
      }
      case "ack": {
        const session = sessions.get(message.sessionId);
        session?.log.ack(message.seq);
        if (message.settledThrough !== undefined) session?.log.dropThrough(message.settledThrough);
        return null;
      }
      case "retire": {
        retiring = true;
        if (sessions.size === 0) void shutdown();
        return null;
      }
      case "close": {
        const session = sessions.get(message.sessionId);
        if (session !== undefined) {
          sessions.delete(message.sessionId);
          register();
          await runtime.runPromise(Scope.close(session.scope, Exit.void));
          if (retiring && sessions.size === 0) void shutdown();
        }
        return null;
      }
      default:
        throw new Error(`Unknown agent holder operation ${String(message.op)}.`);
    }
  };

  // Ids restart with each server, so an answer must go back on the socket that asked.
  const reply = (socket: NodeNet.Socket, id: unknown, result: Exit.Exit<unknown, unknown>) => {
    const send = (message: unknown) => {
      if (!socket.destroyed) socket.write(encodeLine(message));
    };
    if (Exit.isSuccess(result)) {
      send({ id, ok: result.value ?? null });
      return;
    }
    const failure = Cause.squash(result.cause);
    try {
      send({ id, adapterError: encodeAdapterError(failure) });
    } catch {
      send({ id, error: failure instanceof Error ? failure.message : String(failure) });
    }
  };

  const continuationPump = runtime.runPromise(
    ProviderContinuationRequests.ProviderContinuationRequests.pipe(
      Effect.flatMap((requests) =>
        requests.take.pipe(
          Effect.tap((request) =>
            Effect.sync(() => {
              if (connection === null) undeliveredContinuations.push(request);
              else write({ push: "continuation", request });
            }),
          ),
          Effect.forever,
        ),
      ),
    ),
  );
  continuationPump.catch(() => undefined);

  NodeFS.rmSync(socketPath, { force: true });
  const server = NodeNet.createServer((socket) => {
    // A new server replaces an old one that hasn't closed yet; events go to whoever said hello last.
    connection?.destroy();
    connection = socket;
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (connection === socket) connection = null;
    });
    NodeReadline.createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      const message = decodeLine(line) as Record<string, any>;
      if (message.op === "shutdown") {
        void shutdown();
        return;
      }
      handle(message).then(
        (value) => reply(socket, message.id, Exit.succeed(value)),
        // ManagedRuntime rejects with the squashed failure of the failed effect.
        (error) => reply(socket, message.id, Exit.die(error)),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  NodeFS.chmodSync(socketPath, 0o600);
  register();

  setInterval(() => {
    const now = Date.now();
    emptySince = sessions.size === 0 ? (emptySince ?? now) : null;
    if (connection === null && emptySince !== null && now - emptySince > EMPTY_EXIT_MS) {
      void shutdown();
    } else if (connection === null && now - lastActivity > ORPHAN_TIMEOUT_MS) {
      void shutdown();
    }
  }, LIFECYCLE_POLL_MS);

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  // A server's stop signal must never take the agents with it, and neither must its closed pipes.
  process.on("SIGHUP", () => undefined);
  process.on("SIGPIPE", () => undefined);
};

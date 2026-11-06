import {
  isOrchestrationV2WorkActive,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as AgentHolders from "../agentHolder/AgentHolders.ts";
import type { HeldSessionSnapshot } from "../agentHolder/protocol.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";

export interface RecoveringRun {
  readonly id: RunId;
  readonly status: string;
  readonly ordinal: number;
  readonly activeAttemptId: string | null;
  readonly providerThreadId: ProviderThreadId | null;
}

export type HeldSessionPlan =
  | { readonly type: "discard"; readonly reason: string }
  | {
      readonly type: "adopt";
      readonly resume: ReadonlyArray<{ readonly threadId: ThreadId; readonly run: RecoveringRun }>;
    };

const IN_FLIGHT = new Set(["preparing", "starting", "running"]);

/**
 * A run counts as the holder's only once the provider reported a turn for its active attempt. A run
 * it can't prove is discarded, because recovery would otherwise start a second agent on the thread.
 */
export const planHeldSession = (
  snapshot: Pick<HeldSessionSnapshot, "truncated" | "retained" | "threadIds">,
  runsByThread: ReadonlyMap<ThreadId, ReadonlyArray<RecoveringRun>>,
): HeldSessionPlan => {
  if (snapshot.truncated) {
    return { type: "discard", reason: "its retained events passed the replay limit" };
  }
  const acceptedAttempts = new Set(
    snapshot.retained.flatMap(({ event }) =>
      event.type === "provider_turn.updated" ? [event.providerTurn.runAttemptId as string] : [],
    ),
  );
  const resume: Array<{ readonly threadId: ThreadId; readonly run: RecoveringRun }> = [];
  for (const threadId of snapshot.threadIds) {
    for (const run of runsByThread.get(threadId) ?? []) {
      const accepted = run.activeAttemptId !== null && acceptedAttempts.has(run.activeAttemptId);
      // Retained events outlast a settled root turn only while its subagents or commands still run.
      if (accepted) resume.push({ threadId, run });
      // A `waiting` run without events is past its turn, waiting on a checkpoint or on the user.
      else if (IN_FLIGHT.has(run.status)) {
        return { type: "discard", reason: `run ${run.id} never reached the provider` };
      }
    }
  }
  return { type: "adopt", resume };
};

/** Which provider turns a retained terminal already ended, so they aren't counted as busy. */
export const unfinishedRuns = (
  snapshot: Pick<HeldSessionSnapshot, "retained">,
  resume: ReadonlyArray<{ readonly run: RecoveringRun }>,
) => {
  const ended = new Set(
    snapshot.retained.flatMap(({ event }) =>
      event.type === "turn.terminal" ? [`${event.providerThreadId}\0${event.runOrdinal}`] : [],
    ),
  );
  return resume.flatMap(({ run }) =>
    run.providerThreadId === null ||
    !IN_FLIGHT.has(run.status) ||
    ended.has(`${run.providerThreadId}\0${run.ordinal}`)
      ? []
      : [{ providerThreadId: run.providerThreadId, runOrdinal: run.ordinal }],
  );
};

interface PendingResume {
  readonly exposedRuntime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly snapshot: HeldSessionSnapshot;
  readonly resume: ReadonlyArray<{ readonly threadId: ThreadId; readonly run: RecoveringRun }>;
}

export const HeldSessionRecovery = Context.Reference<{
  /** Runs before recovery, which must already know which threads aren't lost. */
  readonly reattach: Effect.Effect<ReadonlyArray<PendingResume>>;
  /** Runs after recovery: each run's consumer subscribes before its session's events flow. */
  readonly resume: (pending: ReadonlyArray<PendingResume>) => Effect.Effect<void>;
  /** Graceful shutdown leaves these threads' sessions running, so reconciliation skips them. */
  readonly markForShutdown: Effect.Effect<void>;
}>("t3/orchestration-v2/HeldSessionRecovery", {
  defaultValue: () => ({
    reattach: Effect.succeed([]),
    resume: () => Effect.void,
    markForShutdown: Effect.void,
  }),
});

export const layer = Layer.effect(
  HeldSessionRecovery,
  Effect.gen(function* () {
    const holders = yield* AgentHolders.AgentHolders;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const turnStart = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
    const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
    /** Recovery reads each thread alone, so a live agent's subagents need listing too, at any depth. */
    const withSubagentThreads = Effect.fn("HeldSessionRecovery.withSubagentThreads")(function* (
      threadIds: Iterable<ThreadId>,
    ) {
      const seen = new Set(threadIds);
      for (const threadId of seen) {
        const projection = yield* projections
          .getRuntimeRecoveryProjection(threadId)
          .pipe(Effect.option);
        if (projection._tag === "None") continue;
        for (const subagent of projection.value.subagents) {
          if (subagent.childThreadId !== null && isOrchestrationV2WorkActive(subagent.status)) {
            seen.add(subagent.childThreadId);
          }
        }
      }
      return seen;
    });
    const reattach = Effect.gen(function* () {
      const adoptable = yield* holders.reattach;
      const pending: PendingResume[] = [];
      const held = new Set<ThreadId>();
      for (const { runtime, snapshot, scope } of adoptable) {
        const runsByThread = new Map<ThreadId, ReadonlyArray<RecoveringRun>>();
        const read = yield* Effect.exit(
          Effect.forEach(
            snapshot.threadIds,
            (threadId) =>
              projections
                .getRuntimeRecoveryProjection(threadId)
                .pipe(
                  Effect.tap((projection) =>
                    Effect.sync(() => runsByThread.set(threadId, projection.runs)),
                  ),
                ),
            { discard: true },
          ),
        );
        const plan: HeldSessionPlan = Exit.isFailure(read)
          ? { type: "discard", reason: "its thread records could not be read" }
          : planHeldSession(snapshot, runsByThread);
        if (plan.type === "discard") {
          yield* Effect.logWarning("Stopping a held agent session; normal recovery takes over", {
            providerSessionId: snapshot.descriptor.providerSessionId,
            reason: plan.reason,
          });
          yield* Scope.close(scope, Exit.void);
          continue;
        }
        const exposedRuntime = yield* sessions.adopt({
          runtime,
          scope,
          threadIds: snapshot.threadIds,
          mcpCredentialIdByThread: new Map(
            snapshot.mcpConfigs.map((config) => [config.threadId, config.providerSessionId]),
          ),
          busy: unfinishedRuns(snapshot, plan.resume),
        });
        for (const threadId of yield* withSubagentThreads(snapshot.threadIds)) held.add(threadId);
        pending.push({ exposedRuntime, snapshot, resume: plan.resume });
      }
      yield* holders.setHeldThreadIds(held);
      return pending;
    });
    const resume = Effect.fn("HeldSessionRecovery.resume")(function* (
      pending: ReadonlyArray<PendingResume>,
    ) {
      for (const { exposedRuntime, snapshot, resume } of pending) {
        const replay = snapshot.retained.map(({ event }) => event);
        const alreadyIngested = new Set(
          snapshot.retained.filter(({ seq }) => seq <= snapshot.ackedSeq).map(({ event }) => event),
        );
        const control = AgentHolders.heldControl(exposedRuntime);
        for (const { seq, event } of snapshot.retained) control?.markSeq(event, seq);
        for (const { threadId, run } of resume) {
          yield* turnStart
            .resumeHeld({
              threadId,
              runId: run.id,
              session: exposedRuntime,
              replay,
              alreadyIngested,
            })
            .pipe(
              // Nothing is consuming the turn, so hand the thread to recovery instead of leaving it.
              Effect.catchCause((cause) =>
                Effect.logError("Could not resume a held run", { runId: run.id, cause }).pipe(
                  Effect.andThen(holders.heldThreadIds),
                  Effect.flatMap((held) =>
                    holders.setHeldThreadIds(
                      new Set([...held].filter((candidate) => candidate !== threadId)),
                    ),
                  ),
                  Effect.andThen(
                    sessions
                      .release({
                        providerSessionId: exposedRuntime.providerSessionId,
                        reason: "runtime_error",
                      })
                      .pipe(Effect.ignore),
                  ),
                  Effect.andThen(recovery.reconcile("startup").pipe(Effect.ignore)),
                ),
              ),
            );
        }
        yield* sessions.startAdopted(exposedRuntime.providerSessionId);
      }
    });
    return {
      reattach,
      resume,
      markForShutdown: sessions.heldThreadIds.pipe(
        Effect.flatMap(withSubagentThreads),
        Effect.flatMap(holders.setHeldThreadIds),
      ),
    };
  }),
);

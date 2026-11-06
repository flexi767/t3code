import {
  ORCHESTRATION_V2_WS_METHODS,
  type ThreadId,
  type EnvironmentId,
  type ProjectId,
  type ThreadMoveArchive,
  type OrchestrationGetTurnDiffResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

import { applyCommandOutputFrame, EMPTY_COMMAND_OUTPUT } from "./commandOutput.ts";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentCommand,
  createRuntimeCommand,
  type QueryAnswerHandler,
} from "./runtime.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelayDpopSigner from "../relay/managedRelay.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { fetchEnvironmentThreadTranscript } from "./threadTranscriptHttp.ts";
import { exportThreadMove, importThreadMove, finishThreadMove } from "./threadMoveHttp.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
  options: {
    /** Runs on each turn-range and full-thread diff the server answers. */
    readonly onCheckpointDiffAnswer?: QueryAnswerHandler<
      { readonly ignoreWhitespace?: boolean },
      OrchestrationGetTurnDiffResult
    >;
  } = {},
) {
  // Keep a bounded snapshot for retrying a lost import response without re-exporting changed history.
  const pendingMoves = new Map<string, ThreadMoveArchive>();
  const onCheckpointDiffAnswer =
    options.onCheckpointDiffAnswer === undefined
      ? {}
      : { onAnswer: options.onCheckpointDiffAnswer };
  return {
    moveThread: createRuntimeCommand(runtime, {
      label: "Move thread to another machine",
      concurrency: { mode: "serial", key: () => "thread-move" },
      execute: Effect.fn("orchestration.moveThread")(function* (input: {
        readonly sourceEnvironmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly destinationEnvironmentId: EnvironmentId;
        readonly destinationProjectId: ProjectId;
        readonly transferId: string;
        readonly onProgress?: (phase: "preparing" | "copying" | "finishing") => void;
      }) {
        const registry = yield* EnvironmentRegistry;
        input.onProgress?.("preparing");
        const key = `${input.sourceEnvironmentId}:${input.threadId}:${input.destinationEnvironmentId}:${input.destinationProjectId}:${input.transferId}`;
        const archive =
          pendingMoves.get(key) ??
          (yield* registry.run(
            input.sourceEnvironmentId,
            exportThreadMove({ threadId: input.threadId, transferId: input.transferId }),
          ));
        pendingMoves.set(key, archive);
        while (pendingMoves.size > 2) pendingMoves.delete(pendingMoves.keys().next().value!);
        input.onProgress?.("copying");
        const receipt = yield* registry
          .run(
            input.destinationEnvironmentId,
            importThreadMove({ projectId: input.destinationProjectId, archive }),
          )
          .pipe(
            // A refusal such as an unpushed commit is fixed at the source, so retry must re-export.
            Effect.tapErrorTag("ThreadMoveError", () =>
              Effect.sync(() => pendingMoves.delete(key)),
            ),
          );
        input.onProgress?.("finishing");
        // A lost source connection cannot undo a successfully committed destination copy.
        const finished = yield* registry
          .run(input.sourceEnvironmentId, finishThreadMove(receipt))
          .pipe(Effect.exit);
        pendingMoves.delete(key);
        return { receipt, sourceArchived: Exit.isSuccess(finished) };
      }),
    }),
    threadTranscript: createEnvironmentCommand(runtime, {
      label: "environment-data:orchestration:thread-transcript",
      execute: Effect.fn("orchestration.execute")(function* (input: {
        readonly threadId: ThreadId;
      }) {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          return yield* new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: "The source environment is not connected.",
          });
        }
        return yield* fetchEnvironmentThreadTranscript({
          prepared: prepared.value,
          threadId: input.threadId,
          signer: yield* Effect.serviceOption(ManagedRelayDpopSigner.ManagedRelayDpopSigner),
          remoteAuthorization: yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          ),
        });
      }),
    }),
    v2: {
      dispatchCommand: createEnvironmentRpcCommand(runtime, {
        label: "environment-data:orchestration-v2:dispatch-command",
        tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      }),
      shell: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:shell",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      }),
      thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:thread",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        idleTtlMs: 0,
      }),
      // One expanded command row's output. Mounted only while the row is open,
      // and released as soon as it closes, so hidden rows receive nothing.
      commandOutput: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:command-output",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
        idleTtlMs: 0,
        // `scan` emits its seed first; skipping it keeps the row "loading" until the first frame.
        transform: (frames) =>
          frames.pipe(
            Stream.scan(() => EMPTY_COMMAND_OUTPUT, applyCommandOutputFrame),
            Stream.filter((view) => view !== EMPTY_COMMAND_OUTPUT),
          ),
      }),
    },
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
      ...onCheckpointDiffAnswer,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    // Mounted only while a subagent inspector is open; running children change between opens.
    nativeChildWork: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:native-child-work",
      tag: ORCHESTRATION_V2_WS_METHODS.getNativeChildWork,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    stopWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:stop-workflow",
      tag: ORCHESTRATION_V2_WS_METHODS.stopWorkflow,
    }),
    forceStopThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:force-stop-thread",
      tag: ORCHESTRATION_V2_WS_METHODS.forceStopThread,
    }),
    turnItem: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-item",
      tag: ORCHESTRATION_V2_WS_METHODS.getTurnItem,
      staleTimeMs: 60_000,
      idleTtlMs: 60_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
      ...onCheckpointDiffAnswer,
    }),
    threadFind: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-find",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThread,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    threadFindProgressive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-find-progressive",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
      completeWhen: (result) => result.complete !== false,
      idleTtlMs: 0,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
    }),
    // Read right before deleting a worktree, so never served from cache.
    worktreeThreadIds: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:worktree-thread-ids",
      tag: ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
  };
}

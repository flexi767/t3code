import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type ThreadMoveBundle,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  assertMoveIdle,
  importedMoveProjections,
  movedId,
  moveDigest,
  moveProjectionEvents,
  validateMoveBundle,
} from "./threadMove.ts";

const now = DateTime.makeUnsafe("2026-08-01T10:00:00Z");
const sourceId = ThreadId.make("thread:source");
const projectId = ProjectId.make("project:destination");
const transferId = "c39671d4-1603-4996-9b35-19ebce82fb41";
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const runId = RunId.make("run:source");

function projection(id = sourceId): OrchestrationV2ThreadProjection {
  const messageId = MessageId.make(`message:${id}`);
  return {
    thread: {
      id,
      projectId: ProjectId.make("project:source"),
      title: "Saved conversation",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: "/old/repo",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, rootThreadId: id, relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId: id,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId: id,
        runId,
        nodeId: null,
        role: "user",
        text: "Keep run:source literal in my prompt",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make(`item:${id}`),
        threadId: id,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution",
        input: "git status",
        output: "recorded output\n",
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    plans: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
}

function bundle(): ThreadMoveBundle {
  return {
    version: 1,
    transferId,
    sourceEnvironmentId: EnvironmentId.make("source"),
    sourceThreadId: sourceId,
    projections: [{ projection: projection(), sequence: 8, move: true, commitSha: "a".repeat(40) }],
    assets: [],
  };
}

it.effect(
  "moves completed history through durable projections without rewriting prompt or tool text",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const input = bundle();
      const imported = importedMoveProjections(
        input,
        projectId,
        new Map([[sourceId, { path: "/new/worktree", branch: "moved" }]]),
        new Map(),
        now,
      );
      const events = moveProjectionEvents(imported, transferId, moveDigest(input));
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      const target = ThreadId.make(movedId(transferId, sourceId));
      const saved = yield* store.getThreadProjection(target);
      assert.equal(saved.thread.projectId, projectId);
      assert.equal(saved.thread.worktreePath, "/new/worktree");
      assert.equal(saved.thread.pendingContextImport, true);
      assert.isNull(saved.thread.activeProviderThreadId);
      assert.equal(saved.runs[0]?.status, "completed");
      assert.equal(saved.messages[0]?.runId, movedId(transferId, runId));
      assert.equal(saved.messages[0]?.text, "Keep run:source literal in my prompt");
      assert.equal(
        saved.turnItems[0]?.type === "command_execution" && saved.turnItems[0].output,
        "recorded output\n",
      );
      assert.deepEqual(saved.messages[0]?.createdAt, now);
      assert.deepEqual(moveProjectionEvents(imported, transferId, moveDigest(input)), events);
      assert.notEqual(
        moveDigest({ ...input, assets: [{ path: "file.bin", data: "YQ==" }] }),
        moveDigest(input),
      );
    }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);

it("preserves child grouping, archives context dependencies, and detaches a moved child from its source parent", () => {
  const input = bundle();
  const childId = ThreadId.make("thread:child");
  const ancestorId = ThreadId.make("thread:ancestor");
  const root = projection();
  const child = projection(childId);
  const ancestor = projection(ancestorId);
  const entries = [
    {
      ...input.projections[0]!,
      projection: {
        ...root,
        thread: {
          ...root.thread,
          lineage: {
            parentThreadId: ancestorId,
            relationshipToParent: "fork" as const,
            rootThreadId: ancestorId,
          },
        },
      },
    },
    {
      ...input.projections[0]!,
      projection: {
        ...child,
        thread: {
          ...child.thread,
          lineage: {
            parentThreadId: sourceId,
            relationshipToParent: "subagent" as const,
            rootThreadId: sourceId,
          },
        },
      },
    },
    { ...input.projections[0]!, projection: ancestor, move: false },
  ];
  const result = importedMoveProjections(
    { ...input, projections: entries },
    projectId,
    new Map(
      [sourceId, childId, ancestorId].map((id) => [id, { path: `/new/${id}`, branch: null }]),
    ),
    new Map(),
    now,
  );
  assert.isNull(result[0]?.thread.lineage.parentThreadId);
  assert.equal(result[1]?.thread.lineage.parentThreadId, result[0]?.thread.id);
  assert.deepEqual(result[2]?.thread.archivedAt, now);
});

it("rejects active work and foreign records before importing", () => {
  const input = bundle();
  const source = projection();
  for (const status of ["queued", "preparing", "starting", "running", "waiting"] as const) {
    assert.throws(
      () => assertMoveIdle({ ...source, runs: [{ ...source.runs[0]!, status }] }),
      "Finish this thread",
    );
  }
  const foreign = {
    ...source,
    messages: [{ ...source.messages[0]!, threadId: ThreadId.make("thread:foreign") }],
  };
  assert.throws(
    () =>
      validateMoveBundle({
        ...input,
        projections: [{ ...input.projections[0]!, projection: foreign }],
      }),
    "different thread",
  );
  assert.throws(
    () =>
      validateMoveBundle({ ...input, projections: [...input.projections, ...input.projections] }),
    "Duplicate thread",
  );
});

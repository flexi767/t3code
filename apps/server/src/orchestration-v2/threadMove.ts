// @effect-diagnostics nodeBuiltinImport:off - deterministic transfer ids and content hashes use node:crypto.
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  type ProjectId,
  type ThreadMoveBundle,
  ThreadMoveError,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjectionJson,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  htmlRenderFromToolItem,
  mcpAppFromToolItem,
  previewRecordingIdFromToolItem,
} from "@t3tools/shared/toolOutput";

type ToolItem = { readonly toolName: string | null; readonly output?: unknown };
export function movedToolAssetIds(item: ToolItem): ReadonlyArray<string> {
  return [
    htmlRenderFromToolItem(item)?.attachmentId,
    mcpAppFromToolItem(item)?.attachmentId,
    previewRecordingIdFromToolItem(item),
  ].filter((id): id is string => id !== undefined);
}

export function movedToolOutput(item: ToolItem, assets: ReadonlyMap<string, string>): unknown {
  const recognized = new Set(movedToolAssetIds(item));
  const visit = (value: unknown, depth: number, key = ""): unknown => {
    if (depth > 16) return value;
    if (typeof value === "string") {
      if ((key === "id" || key === "attachmentId") && recognized.has(value))
        return assets.get(value) ?? value;
      try {
        const parsed: unknown = JSON.parse(value);
        const next = visit(parsed, depth + 1);
        return next === parsed ? value : JSON.stringify(next);
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) {
      const next = value.map((child) => visit(child, depth + 1));
      return next.every((child, index) => child === value[index]) ? value : next;
    }
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value);
    const next = entries.map(([field, child]) => [field, visit(child, depth + 1, field)] as const);
    return next.every((entry, index) => entry[1] === entries[index]?.[1])
      ? value
      : Object.fromEntries(next);
  };
  return recognized.size === 0 ? item.output : visit(item.output, 0);
}

export const THREAD_MOVE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 63 * 1024 * 1024;
const encodeProjection = Schema.encodeSync(OrchestrationV2ThreadProjectionJson);
const decodeProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjectionJson);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);

export function validateMoveBundle(bundle: ThreadMoveBundle): void {
  const seen = new Set<string>();
  for (const { projection } of bundle.projections) {
    const id = projection.thread.id;
    if (seen.has(id)) throw new ThreadMoveError({ message: "Duplicate thread in transfer." });
    seen.add(id);
    for (const [key, rows] of Object.entries(projection)) {
      if (!Array.isArray(rows) || key === "visibleTurnItems") continue;
      for (const row of rows) {
        if (
          ("threadId" in row && row.threadId !== id) ||
          ("appThreadId" in row && row.appThreadId !== id)
        ) {
          throw new ThreadMoveError({ message: "Transfer records belong to a different thread." });
        }
      }
    }
  }
  if (
    !bundle.projections.some(
      (entry) => entry.move && entry.projection.thread.id === bundle.sourceThreadId,
    )
  ) {
    throw new ThreadMoveError({ message: "The source thread is missing from the transfer." });
  }
  const encoded = JSON.stringify({
    ...bundle,
    projections: bundle.projections.map((entry) => ({
      ...entry,
      projection: encodeProjection(entry.projection),
    })),
  });
  if (Buffer.byteLength(encoded) > MAX_BUNDLE_BYTES)
    throw new ThreadMoveError({
      message: "Saved history and attachments exceed the 63 MB move limit.",
    });
}

export function movedId(transferId: string, id: string): string {
  const hex = NodeCrypto.createHash("sha256").update(`${transferId}\n${id}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Hash encoded data, including all attachment bytes; retries cannot replace a different snapshot. */
export function moveDigest(bundle: ThreadMoveBundle): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        ...bundle,
        projections: bundle.projections.map((entry) => ({
          ...entry,
          projection: encodeProjection(entry.projection),
        })),
      }),
    )
    .digest("hex");
}

export function assertMoveIdle(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "providerThreads" | "subagents"
  >,
): void {
  if (
    projection.thread.deletedAt !== null ||
    projection.thread.linkOrigin !== undefined ||
    projection.runs.some((run) =>
      ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
    ) ||
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.subagents.some((agent) =>
      ["pending", "running", "waiting"].includes(agent.status),
    ) ||
    projection.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0)
  ) {
    throw new ThreadMoveError({
      message:
        "Finish this thread and its background work before moving it. Linked-agent work must be moved by its owning environment.",
    });
  }
}

const opaqueFields = new Set([
  "text",
  "input",
  "output",
  "result",
  "payload",
  "metadata",
  "arguments",
  "summaryText",
]);

/** Remap typed record references without rewriting user text or recorded tool inputs/outputs. */
function remap(
  value: unknown,
  ids: ReadonlyMap<string, string>,
  assets: ReadonlyMap<string, string>,
  key = "",
  opaque = false,
): unknown {
  if (typeof value === "string") {
    if (assets.has(value)) return assets.get(value);
    return !opaque && (key === "id" || key.endsWith("Id") || key.endsWith("Ids"))
      ? (ids.get(value) ?? value)
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => remap(item, ids, assets, key, opaque));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([field, item]) => [
      field,
      remap(item, ids, assets, field, opaque || opaqueFields.has(field)),
    ]),
  );
}

export interface MoveCheckout {
  readonly path: string;
  readonly branch: string | null;
}

export function importedMoveProjections(
  bundle: ThreadMoveBundle,
  projectId: ProjectId,
  checkouts: ReadonlyMap<string, MoveCheckout>,
  assets: ReadonlyMap<string, string>,
  now: DateTime.Utc,
): ReadonlyArray<OrchestrationV2ThreadProjection> {
  validateMoveBundle(bundle);
  const ids = new Map<string, string>(assets);
  for (const { projection } of bundle.projections) {
    ids.set(projection.thread.id, movedId(bundle.transferId, projection.thread.id));
    ids.set(projection.thread.projectId, projectId);
    for (const rows of Object.values(projection)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows)
        if (typeof row === "object" && row !== null && "id" in row && typeof row.id === "string") {
          ids.set(row.id, movedId(bundle.transferId, row.id));
        }
    }
  }
  return bundle.projections.map(({ projection, move }) => {
    const encoded = encodeProjection(projection);
    const mapped = decodeProjection(remap(encoded, ids, assets));
    const checkout = checkouts.get(projection.thread.id);
    if (checkout === undefined)
      throw new ThreadMoveError({ message: "The destination checkout was not prepared." });
    // Runtime ownership and local credentials never travel with saved history.
    return {
      ...mapped,
      ...(!move
        ? {
            runs: mapped.runs.map((row) =>
              ["queued", "preparing", "starting", "running", "waiting"].includes(row.status)
                ? {
                    ...row,
                    status: "interrupted" as const,
                    completedAt: now,
                    activeAttemptId: null,
                  }
                : row,
            ),
            attempts: mapped.attempts.map((row) =>
              ["pending", "running"].includes(row.status)
                ? { ...row, status: "interrupted" as const, completedAt: now }
                : row,
            ),
            nodes: mapped.nodes.map((row) =>
              ["pending", "running", "waiting"].includes(row.status)
                ? { ...row, status: "interrupted" as const, completedAt: now }
                : row,
            ),
            subagents: mapped.subagents.map((row) =>
              ["pending", "running", "waiting", "idle"].includes(row.status)
                ? { ...row, status: "cancelled" as const, completedAt: now }
                : row,
            ),
            providerTurns: mapped.providerTurns.map((row) =>
              ["pending", "running"].includes(row.status)
                ? { ...row, status: "interrupted" as const, completedAt: now }
                : row,
            ),
            runtimeRequests: mapped.runtimeRequests.map((row) => ({
              ...row,
              ...(row.status === "pending"
                ? { status: "cancelled" as const, resolvedAt: now }
                : {}),
              responseCapability: {
                type: "not_resumable" as const,
                reason: "History snapshot from another machine.",
              },
            })),
            contextTransfers: mapped.contextTransfers.map((row) =>
              ["pending", "resolved_native", "resolved_portable"].includes(row.status)
                ? { ...row, status: "superseded" as const }
                : row,
            ),
          }
        : {}),
      turnItems: mapped.turnItems.map((item, index) => {
        const original = projection.turnItems[index];
        const frozen =
          !move && ["pending", "running", "waiting"].includes(item.status)
            ? { ...item, status: "interrupted" as const, completedAt: now }
            : item;
        return frozen.type === "dynamic_tool" && original?.type === "dynamic_tool"
          ? { ...frozen, output: movedToolOutput(original, assets) }
          : frozen;
      }),
      thread: {
        ...mapped.thread,
        projectId,
        activeProviderThreadId: null,
        pendingContextImport: true,
        branch: checkout.branch,
        worktreePath: checkout.path,
        linkOrigin: undefined,
        delegatedFrom: undefined,
        guestShare: undefined,
        titleRegeneration: null,
        ...(projection.thread.id === bundle.sourceThreadId
          ? {
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: mapped.thread.id,
              },
            }
          : {}),
        archivedAt: move ? null : now,
        deletedAt: null,
      },
      providerSessions: mapped.providerSessions.map((session) => ({
        ...session,
        status: "stopped" as const,
      })),
      providerThreads: mapped.providerThreads.map((thread) => ({
        ...thread,
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        nativeMetadata: undefined,
        pendingBackgroundTasks: [],
        status: "not_loaded" as const,
      })),
      // Checkpoint Git objects and host-owned sessions are not portable execution state.
      checkpointScopes: [],
      checkpoints: [],
      visibleTurnItems: [],
    };
  });
}

export function moveProjectionEvents(
  projections: ReadonlyArray<OrchestrationV2ThreadProjection>,
  transferId: string,
  digest: string,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  let ordinal = 0;
  const events: OrchestrationV2DomainEvent[] = [];
  for (const p of projections) {
    const add = (event: Omit<OrchestrationV2DomainEvent, "id" | "occurredAt" | "threadId">) => {
      events.push(
        decodeEvent({
          ...event,
          id: EventId.make(`thread-move:${transferId}:${digest}:${ordinal++}`),
          threadId: p.thread.id,
          occurredAt: p.thread.updatedAt,
        }),
      );
    };
    add({ type: "thread.created", payload: p.thread });
    for (const row of p.runs) add({ type: "run.created", payload: row });
    for (const row of p.attempts) add({ type: "run-attempt.created", payload: row });
    for (const row of p.nodes) add({ type: "node.updated", payload: row });
    for (const row of p.subagents) add({ type: "subagent.updated", payload: row });
    for (const row of p.providerSessions) add({ type: "provider-session.updated", payload: row });
    for (const row of p.providerThreads) add({ type: "provider-thread.updated", payload: row });
    for (const row of p.providerTurns) add({ type: "provider-turn.updated", payload: row });
    for (const row of p.runtimeRequests) add({ type: "runtime-request.updated", payload: row });
    for (const row of p.messages) add({ type: "message.updated", payload: row });
    for (const row of p.plans) add({ type: "plan.updated", payload: row });
    for (const row of p.turnItems) add({ type: "turn-item.updated", payload: row });
    for (const row of p.contextHandoffs) add({ type: "context-handoff.updated", payload: row });
    for (const row of p.contextTransfers) add({ type: "context-transfer.created", payload: row });
  }
  return events;
}

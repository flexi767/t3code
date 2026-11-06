import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2ThreadProjection } from "./orchestrationV2.ts";

export const ThreadMoveId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
export const ThreadMoveExportInput = Schema.Struct({
  threadId: ThreadId,
  transferId: ThreadMoveId,
  prepareRepository: Schema.optional(Schema.Boolean),
});
export const ThreadMoveBundle = Schema.Struct({
  version: Schema.Literal(1),
  transferId: ThreadMoveId,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  projections: Schema.Array(
    Schema.Struct({
      projection: OrchestrationV2ThreadProjection,
      sequence: NonNegativeInt,
      move: Schema.Boolean,
      commitSha: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  assets: Schema.Array(Schema.Struct({ path: TrimmedNonEmptyString, data: Schema.String })),
});
export type ThreadMoveBundle = typeof ThreadMoveBundle.Type;
/** Opaque to clients: they relay it between environments without decoding the history. */
export const ThreadMoveArchive = Schema.Struct({
  encoding: Schema.Literal("gzip+base64"),
  data: Schema.String,
});
export type ThreadMoveArchive = typeof ThreadMoveArchive.Type;
export const ThreadMoveImportInput = Schema.Struct({
  projectId: ProjectId,
  archive: ThreadMoveArchive,
});
export type ThreadMoveImportInput = typeof ThreadMoveImportInput.Type;
export const ThreadMoveReceipt = Schema.Struct({
  transferId: ThreadMoveId,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  destinationEnvironmentId: EnvironmentId,
  destinationThreadId: ThreadId,
  destinationProjectId: ProjectId,
  digest: TrimmedNonEmptyString,
  sources: Schema.Array(Schema.Struct({ threadId: ThreadId, sequence: NonNegativeInt })),
});
export type ThreadMoveReceipt = typeof ThreadMoveReceipt.Type;
export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()(
  "ThreadMoveError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

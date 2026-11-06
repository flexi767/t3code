import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthSourceControlWriteScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";

export const layer = HttpApiBuilder.group(EnvironmentHttpApi, "threadMove", (handlers) =>
  Effect.gen(function* () {
    const moves = yield* ThreadMoveService.ThreadMoveService;
    return handlers
      .handle("threadMoveExport", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.andThen(requireEnvironmentScope(AuthOrchestrationReadScope)),
          Effect.andThen(requireEnvironmentScope(AuthFilesystemReadScope)),
          Effect.andThen(
            payload.prepareRepository
              ? requireEnvironmentScope(AuthFilesystemWriteScope)
              : Effect.void,
          ),
          Effect.andThen(
            payload.prepareRepository
              ? requireEnvironmentScope(AuthSourceControlWriteScope)
              : Effect.void,
          ),
          Effect.andThen(moves.exportArchive(payload)),
        ),
      )
      .handle("threadMoveImport", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.andThen(requireEnvironmentScope(AuthFilesystemWriteScope)),
          Effect.andThen(requireEnvironmentScope(AuthSourceControlWriteScope)),
          Effect.andThen(moves.receiveArchive(payload)),
        ),
      )
      .handle("threadMoveFinish", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.andThen(moves.finish(payload)),
        ),
      );
  }),
);

// @effect-diagnostics nodeBuiltinImport:off - fork-deploy shares this hold with the server as a file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { OrchestrationV2DomainEvent, OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

export const TURN_ADMISSION_HOLD_FILE = "turn-admission-hold.json";
const STEER_FOLLOW_UP_COMMAND_PREFIX = "command:steer-follow-up:";

export class TurnAdmissionHeldError extends Schema.TaggedError<TurnAdmissionHeldError>()(
  "TurnAdmissionHeldError",
  {},
) {
  override get message(): string {
    return "T3 Code is waiting to update, so new turns are paused. Try again in a few minutes.";
  }
}

export const TurnAdmission = Context.Reference<{
  readonly isHeld: Effect.Effect<boolean>;
}>("t3/orchestration-v2/TurnAdmission", {
  defaultValue: () => ({ isHeld: Effect.succeed(false) }),
});

/** An unreadable or expired hold is open: a dead deploy must never stop turns indefinitely. */
export function holdIsActive(text: string, nowMs: number): boolean {
  try {
    const expiresAtMs = (JSON.parse(text) as { readonly expiresAtMs?: unknown }).expiresAtMs;
    return typeof expiresAtMs === "number" && expiresAtMs > nowMs;
  } catch {
    return false;
  }
}

/**
 * New work a person or schedule asked for. Work an admitted turn depends on stays open, because
 * refusing it would fail that turn: its child tasks, wakes, steers, and restart continuations.
 */
export function startsNewWork(
  command: OrchestrationV2ServerCommand,
  events: ReadonlyArray<Pick<OrchestrationV2DomainEvent, "type">>,
): boolean {
  return (
    command.type === "message.dispatch" &&
    events.some((event) => event.type === "run.created") &&
    command.creationSource !== "provider" &&
    command.senderThreadId === undefined &&
    command.delegatedCompletion === undefined &&
    command.notification === undefined &&
    command.restartContinuationOfRunId === undefined &&
    !command.commandId.startsWith(STEER_FOLLOW_UP_COMMAND_PREFIX)
  );
}

export const layer = Layer.effect(
  TurnAdmission,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = NodePath.join(config.stateDir, TURN_ADMISSION_HOLD_FILE);
    return {
      isHeld: Effect.clockWith((clock) =>
        Effect.sync(() => {
          try {
            return holdIsActive(NodeFS.readFileSync(path, "utf8"), clock.currentTimeMillisUnsafe());
          } catch {
            return false;
          }
        }),
      ),
    };
  }),
);

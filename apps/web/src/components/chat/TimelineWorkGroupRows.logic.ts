import { toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

export function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }
  return formatWorkingDuration(endedAtMs - startedAtMs);
}

export function formatWorkingDuration(elapsedMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  return formatDuration(elapsedSeconds * 1_000);
}

/** Live timers count on the host's clock, so client clock skew does not shift them. */
export function formatWorkingTimerNow(
  startIso: string,
  environmentId: EnvironmentId,
  clock = false,
): string {
  const startedAtMs = Date.parse(startIso);
  const elapsedMs = Number.isFinite(startedAtMs)
    ? toServerClock(environmentId, Date.now()) - startedAtMs
    : 0;
  if (clock) {
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  return formatWorkingDuration(elapsedMs);
}

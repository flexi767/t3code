import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SIDEBAR_THREAD_FILTER,
  matchesSidebarThreadFilter,
  type SidebarThreadFilter,
} from "./SidebarThreadFilters";

function thread(input: {
  provider: string;
  model: string;
  runStatus: "completed" | "failed" | "interrupted";
  running?: boolean;
}) {
  return {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    modelSelection: { instanceId: ProviderInstanceId.make(input.provider), model: input.model },
    latestRun: {
      runId: "run-1" as never,
      status: input.runStatus,
      assistantMessageId: null,
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: "2026-03-09T10:05:00.000Z",
    },
    runtime: input.running
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make(input.provider),
          providerName: input.provider,
          lastError: null,
          updatedAt: "2026-03-09T10:00:00.000Z",
        }
      : null,
  };
}

const filter = (overrides: Partial<SidebarThreadFilter>): SidebarThreadFilter => ({
  ...EMPTY_SIDEBAR_THREAD_FILTER,
  ...overrides,
});

describe("matchesSidebarThreadFilter", () => {
  const codexDone = thread({ provider: "codex", model: "gpt-5.4", runStatus: "completed" });
  const codexMini = thread({ provider: "codex", model: "gpt-5.4-mini", runStatus: "failed" });
  const claudeWorking = thread({
    provider: "claude",
    model: "opus",
    runStatus: "completed",
    running: true,
  });
  const claudeStopped = thread({ provider: "claude", model: "opus", runStatus: "interrupted" });
  const all = [codexDone, codexMini, claudeWorking, claudeStopped];
  const matching = (value: SidebarThreadFilter) =>
    all.filter((candidate) => matchesSidebarThreadFilter(candidate, value));

  it.each([
    ["no filter", filter({}), [codexDone, codexMini, claudeWorking, claudeStopped]],
    ["a provider", filter({ providers: new Set(["codex"]) }), [codexDone, codexMini]],
    [
      "a model narrows only its own provider",
      filter({ providers: new Set(["codex", "claude"]), models: new Set(["codex:gpt-5.4"]) }),
      [codexDone, claudeWorking, claudeStopped],
    ],
    ["done", filter({ statuses: new Set(["done"]) }), [codexDone]],
    ["working wins over the last run", filter({ statuses: new Set(["working"]) }), [claudeWorking]],
    [
      "statuses combine with providers",
      filter({ providers: new Set(["codex"]), statuses: new Set(["failed", "working"]) }),
      [codexMini],
    ],
  ] as const)("%s", (_name, value, expected) => {
    expect(matching(value)).toEqual(expected);
  });
});

import { assert, it } from "@effect/vitest";
import { ProviderThreadId, RunId, ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

import { planHeldSession, unfinishedRuns, type RecoveringRun } from "./HeldSessionRecovery.ts";

const threadId = ThreadId.make("thread:held");
const run = (status: string, activeAttemptId: string | null = "attempt:1"): RecoveringRun => ({
  id: RunId.make("run:1"),
  status,
  ordinal: 1,
  activeAttemptId,
  providerThreadId: ProviderThreadId.make("provider-thread:1"),
});
const turn = (runAttemptId: string) => ({
  seq: 1,
  event: {
    type: "provider_turn.updated",
    providerTurn: { id: "turn:1", runAttemptId },
  } as unknown as ProviderAdapterV2Event,
});
const snapshot = (retained: ReadonlyArray<ReturnType<typeof turn>>, truncated = false) => ({
  truncated,
  retained,
  threadIds: [threadId],
});

it("adopts a session whose running turn the provider confirmed", () => {
  const plan = planHeldSession(
    snapshot([turn("attempt:1")]),
    new Map([[threadId, [run("running")]]]),
  );
  assert.deepStrictEqual(plan, { type: "adopt", resume: [{ threadId, run: run("running") }] });
});

it("resumes a settled run whose subagents or commands still keep its events retained", () => {
  const plan = planHeldSession(
    snapshot([turn("attempt:1")]),
    new Map([[threadId, [run("completed")]]]),
  );
  assert.deepStrictEqual(plan, { type: "adopt", resume: [{ threadId, run: run("completed") }] });
});

it("adopts a run waiting on its checkpoint without proof, since its turn is over", () => {
  assert.deepStrictEqual(planHeldSession(snapshot([]), new Map([[threadId, [run("waiting")]]])), {
    type: "adopt",
    resume: [],
  });
});

it("doesn't count a turn that ended during the outage as busy", () => {
  const terminal = {
    seq: 2,
    event: {
      type: "turn.terminal",
      providerThreadId: "provider-thread:1",
      runOrdinal: 1,
    } as unknown as ProviderAdapterV2Event,
  };
  const resume = [{ threadId, run: run("running") }];
  assert.lengthOf(unfinishedRuns({ retained: [turn("attempt:1")] }, resume), 1);
  assert.lengthOf(unfinishedRuns({ retained: [turn("attempt:1"), terminal] }, resume), 0);
});

it("adopts an idle session without resuming anything", () => {
  assert.deepStrictEqual(planHeldSession(snapshot([]), new Map([[threadId, [run("completed")]]])), {
    type: "adopt",
    resume: [],
  });
});

it.each([
  ["a start that never reached the provider", snapshot([]), run("starting")],
  ["a run still preparing its workspace", snapshot([]), run("preparing")],
  ["another attempt's turn", snapshot([turn("attempt:old")]), run("running")],
  ["a log past the replay limit", snapshot([turn("attempt:1")], true), run("running")],
])("discards %s so recovery has one owner", (_name, held, active) => {
  assert.equal(planHeldSession(held, new Map([[threadId, [active]]])).type, "discard");
});

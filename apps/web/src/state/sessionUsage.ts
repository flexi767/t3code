import { useAtomValue } from "@effect/atom-react";
import { AuthDiagnosticsReadScope, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { serverEnvironment } from "./server";
import { environmentIdsKey } from "./environmentAtomList";
import { environmentSession, sessionHasScope } from "./session";
import { environmentThreadShells } from "./threads";
import { SESSION_USAGE_WINDOW } from "../lib/sessionUsage";
import { workingUsageQuery } from "./workingUsageQuery";

// One timer per environment, shared by every usage badge and context meter.
export const sessionUsageAtom = Atom.family((environmentId: EnvironmentId) => {
  const working = Atom.make((get) =>
    get(environmentThreadShells.environmentThreadsAtom(environmentId)).some(
      (thread) => thread.status === "running",
    ),
  );
  const query = serverEnvironment.threadUsageSummary({
    environmentId,
    input: SESSION_USAGE_WINDOW,
  });
  return workingUsageQuery(query, working);
});

/** Lifetime cost in dollars, keyed `${environmentId}:${threadId}`. */
export type ThreadCosts = ReadonlyMap<string, number>;

const threadCostsAtom = Atom.family((key: string) =>
  Atom.make((get): ThreadCosts => {
    const costs = new Map<string, number>();
    if (key === "") return costs;
    for (const environmentId of key.split("\n") as EnvironmentId[]) {
      const session = get(environmentSession.sessionStateAtom(environmentId));
      if (!sessionHasScope(session, AuthDiagnosticsReadScope)) continue;
      const usage = AsyncResult.getOrElse(get(sessionUsageAtom(environmentId)), () => null);
      for (const entry of usage?.threadUsage ?? []) {
        costs.set(`${environmentId}:${entry.threadId}`, entry.costUsd);
      }
    }
    return costs;
  }).pipe(Atom.withLabel(`thread-costs:${key}`)),
);
const NO_THREAD_COSTS = Atom.make<ThreadCosts>(new Map());

/** Off by default: reading costs starts every environment's usage summary. */
export function useThreadCosts(
  environmentIds: ReadonlyArray<EnvironmentId>,
  enabled: boolean,
): ThreadCosts {
  return useAtomValue(
    enabled ? threadCostsAtom(environmentIdsKey(environmentIds)) : NO_THREAD_COSTS,
  );
}

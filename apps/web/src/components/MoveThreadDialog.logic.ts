import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

type ProjectIdentity = Pick<EnvironmentProject, "environmentId" | "title" | "repositoryIdentity">;

export function selectThreadMoveTarget<T extends { key: string; project: ProjectIdentity }>(
  targets: readonly T[],
  selectedKey: string | null,
  environmentId: string | null,
  source: ProjectIdentity | null,
): T | undefined {
  if (selectedKey !== null) return targets.find((entry) => entry.key === selectedKey);
  const candidates = targets.filter(
    (entry) => environmentId === null || entry.project.environmentId === environmentId,
  );
  if (source === null) return undefined;
  const repository = source.repositoryIdentity?.canonicalKey;
  const matching = candidates.filter((entry) =>
    repository
      ? entry.project.repositoryIdentity?.canonicalKey === repository
      : entry.project.title === source.title,
  );
  return (
    matching.find((entry) => entry.project.title === source.title) ??
    (matching.length === 1 ? matching[0] : undefined)
  );
}

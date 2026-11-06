import { describe, expect, it } from "vite-plus/test";
import { selectThreadMoveTarget } from "./MoveThreadDialog.logic";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

function project(title: string, environmentId: EnvironmentProject["environmentId"]) {
  return { title, environmentId, repositoryIdentity: null };
}

describe("transfer destination defaults", () => {
  const m3 = "m3" as EnvironmentProject["environmentId"];
  const j = "j" as EnvironmentProject["environmentId"];
  const source = project("scrapeui", m3);
  const targets = [
    { key: "m3:t3", project: project("T3 Code", m3) },
    { key: "m3:s", project: project("scrapeui", m3) },
    { key: "j:s", project: project("scrapeui", j) },
  ];
  it("selects the matching project on the chosen machine", () => {
    expect(selectThreadMoveTarget(targets, null, j, source)?.key).toBe("j:s");
    expect(selectThreadMoveTarget(targets, null, m3, source)?.key).toBe("m3:s");
  });
  it("matches repository identity and prefers the same project name", () => {
    const repositoryIdentity = {
      canonicalKey: "github:owner/repo",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/owner/repo.git",
      },
    };
    const sourceWithRepo = { ...source, repositoryIdentity };
    const matching = [
      { key: "j:rc", project: { ...project("scrapeui-rc", j), repositoryIdentity } },
      { key: "j:s", project: { ...project("scrapeui", j), repositoryIdentity } },
    ];
    expect(selectThreadMoveTarget(matching, null, j, sourceWithRepo)?.key).toBe("j:s");
    expect(selectThreadMoveTarget(matching.slice(0, 1), null, j, sourceWithRepo)?.key).toBe("j:rc");
    expect(selectThreadMoveTarget(targets, null, j, sourceWithRepo)).toBeUndefined();
  });
  it("preserves an explicit project choice", () => {
    expect(selectThreadMoveTarget(targets, "m3:t3", j, source)?.key).toBe("m3:t3");
  });
  it("does not silently choose another machine or unrelated project", () => {
    expect(selectThreadMoveTarget(targets, null, "gone", source)).toBeUndefined();
    expect(selectThreadMoveTarget(targets.slice(0, 1), null, m3, source)).toBeUndefined();
    expect(selectThreadMoveTarget(targets, "gone", m3, source)).toBeUndefined();
  });
});

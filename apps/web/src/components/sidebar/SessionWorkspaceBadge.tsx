import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { GitBranchIcon } from "lucide-react";
import GitActionsControl from "../GitActionsControl";
import { ThreadWorktreeIndicator } from "../ThreadStatusIndicators";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import type { SidebarThreadSummary } from "../../types";

function CheckoutDetails({
  environmentId,
  cwd,
  heading,
  threadRef,
  onOpenChanges,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  heading: string;
  threadRef: ScopedThreadRef;
  onOpenChanges: () => void;
}) {
  const query = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId,
      input: { cwd, includeRemote: false, includeCheckoutDetails: true },
    }),
  );
  const status = query.data;
  const details = status?.checkoutDetails;
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: "short",
          timeStyle: "medium",
        }).format(new Date(value))
      : "Unavailable";
  const behindLabel =
    details?.behindOriginMain == null
      ? "origin/main comparison unavailable"
      : details.behindOriginMain === 0
        ? "Up to date with origin/main"
        : `${details.behindOriginMain} commits behind origin/main`;
  return (
    <div className="grid min-w-0 grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
      <GitBranchIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <div className="font-medium text-foreground">{heading}</div>
      <div className="col-start-2 grid min-w-0 gap-1">
        <div className="break-all text-muted-foreground">{cwd}</div>
        {query.error ? (
          <div role="status">{query.error}</div>
        ) : status === null ? (
          <div role="status">Loading checkout details…</div>
        ) : status.isRepo === false ? (
          <div>No Git repository</div>
        ) : (
          <>
            <div>Branch: {status?.refName ?? "Loading…"}</div>
            <div>
              Version:{" "}
              <span className="font-mono">{details?.commit.slice(0, 10) ?? "Unavailable"}</span>
            </div>
            <div>Version committed: {date(details?.committedAt ?? null)}</div>
            <div>Checkout last updated: {date(details?.headUpdatedAt ?? null)}</div>
            <div className="-ml-2">
              <GitActionsControl
                gitCwd={cwd}
                activeThreadRef={threadRef}
                menuOnlyLabel={behindLabel}
                showChanges={false}
              />
              {status?.hasWorkingTreeChanges ? (
                <GitActionsControl
                  gitCwd={cwd}
                  activeThreadRef={threadRef}
                  showActions={false}
                  onOpenChanges={onOpenChanges}
                />
              ) : null}
            </div>
            <div className="text-muted-foreground">
              Compared with the locally fetched origin/main.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function SessionWorkspaceDetails({
  thread,
  workspaceRoot,
  onOpenChanges,
}: {
  thread: SidebarThreadSummary;
  workspaceRoot: string | null;
  onOpenChanges: () => void;
}) {
  const cwd = thread.worktreePath ?? workspaceRoot;
  return (
    <div className="grid min-w-0 gap-3">
      {cwd ? (
        <CheckoutDetails
          environmentId={thread.environmentId}
          cwd={cwd}
          threadRef={scopeThreadRef(thread.environmentId, thread.id)}
          onOpenChanges={onOpenChanges}
          heading={
            thread.worktreePath
              ? `Worktree: ${thread.worktreePath.split(/[\\/]/).at(-1)}`
              : "Main checkout"
          }
        />
      ) : (
        <span>Workspace unavailable</span>
      )}
      {thread.worktreePath && workspaceRoot && workspaceRoot !== cwd ? (
        <CheckoutDetails
          environmentId={thread.environmentId}
          cwd={workspaceRoot}
          threadRef={scopeThreadRef(thread.environmentId, thread.id)}
          onOpenChanges={onOpenChanges}
          heading="Main checkout"
        />
      ) : null}
    </div>
  );
}

export function SessionWorkspaceBadge({ thread }: { thread: SidebarThreadSummary }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0"
      aria-label={thread.worktreePath ? "Worktree" : "Main checkout"}
    >
      {thread.worktreePath ? (
        <ThreadWorktreeIndicator thread={thread} showTooltip={false} />
      ) : (
        <GitBranchIcon aria-hidden className="size-3" />
      )}
      {thread.worktreePath ? "w" : "m"}
    </span>
  );
}

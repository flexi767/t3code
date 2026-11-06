import { useState } from "react";
import { selectThreadMoveTarget } from "./MoveThreadDialog.logic";
import { useRouter } from "@tanstack/react-router";
import { create } from "zustand";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type ScopedThreadRef,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useProject, useProjects, useServerConfigs, useThreadShell } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { readEnvironmentScope } from "../state/session";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";
import { randomUUID } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { toastManager } from "./ui/toast";

const useRequest = create<{
  ref: ScopedThreadRef | null;
  session: number;
  destinationEnvironmentId: EnvironmentId | null;
}>(() => ({
  ref: null,
  session: 0,
  destinationEnvironmentId: null,
}));
export function openMoveThreadDialog(
  ref: ScopedThreadRef,
  destinationEnvironmentId: EnvironmentId | null = null,
) {
  useRequest.setState((state) => ({ ref, destinationEnvironmentId, session: state.session + 1 }));
}
export function MoveThreadDialogHost() {
  const ref = useRequest((state) => state.ref);
  const session = useRequest((state) => state.session);
  const destinationEnvironmentId = useRequest((state) => state.destinationEnvironmentId);
  return ref ? (
    <MoveThreadDialog
      key={session}
      threadRef={ref}
      destinationEnvironmentId={destinationEnvironmentId}
    />
  ) : null;
}

export function useThreadMoveTargets(sourceEnvironmentId: EnvironmentId) {
  const projects = useProjects();
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
  return projects.flatMap((project) => {
    const environment = environments.find((entry) => entry.environmentId === project.environmentId);
    if (
      project.environmentId === sourceEnvironmentId ||
      project.archivedAt != null ||
      environment?.connection.phase !== "connected" ||
      configs.get(project.environmentId)?.environment.capabilities.threadMove !== true ||
      ![AuthOrchestrationOperateScope, AuthFilesystemWriteScope, AuthSourceControlWriteScope].every(
        (scope) => readEnvironmentScope(project.environmentId, scope),
      )
    )
      return [];
    return [
      {
        project,
        environment,
        machine: configs.get(project.environmentId)?.environment.platform.machine ?? "server",
        label: `${environment.label} · ${project.title}`,
        key: `${project.environmentId}:${project.id}`,
      },
    ];
  });
}

function MoveThreadDialog({
  threadRef,
  destinationEnvironmentId,
}: {
  threadRef: ScopedThreadRef;
  destinationEnvironmentId: EnvironmentId | null;
}) {
  const router = useRouter();
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(threadRef.environmentId, thread.projectId) : null,
  );
  const configs = useServerConfigs();
  const targets = useThreadMoveTargets(threadRef.environmentId);
  const [destination, setDestination] = useState<string | null>(null);
  const [phase, setPhase] = useState<"preparing" | "copying" | "finishing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transferId] = useState(randomUUID);
  const move = useAtomCommand(orchestrationEnvironment.moveThread, { reportFailure: false });
  const target = selectThreadMoveTarget(targets, destination, destinationEnvironmentId, project);
  const canMove =
    thread !== null &&
    thread.runtime?.activeRunId == null &&
    configs.get(threadRef.environmentId)?.environment.capabilities.threadMove === true &&
    [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthFilesystemReadScope,
      AuthFilesystemWriteScope,
      AuthSourceControlWriteScope,
    ].every((scope) => readEnvironmentScope(threadRef.environmentId, scope));
  const close = () => {
    if (phase === null) useRequest.setState({ ref: null });
  };
  const submit = async () => {
    if (!target || !canMove || phase !== null) return;
    setError(null);
    setPhase("preparing");
    const result = await move({
      sourceEnvironmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      destinationEnvironmentId: target.project.environmentId,
      destinationProjectId: target.project.id,
      transferId,
      onProgress: setPhase,
    });
    setPhase(null);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : "Move failed. The source is kept; any preparation commit remains; retry to reconcile any saved destination copy.",
      );
      return;
    }
    const { receipt, sourceArchived } = result.value;
    toastManager.add(
      sourceArchived
        ? { type: "success", title: "Thread moved" }
        : {
            type: "warning",
            title: "Destination copy saved",
            description:
              "The source changed or disconnected and was kept. Review it before archiving.",
          },
    );
    useRequest.setState({ ref: null });
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(receipt.destinationEnvironmentId, receipt.destinationThreadId),
      ),
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move to another machine</DialogTitle>
          <DialogDescription>{thread?.title ?? "Thread"}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="thread-move-destination">Destination project</Label>
              <Select
                items={targets.map((entry) => ({ value: entry.key, label: entry.label }))}
                value={target?.key ?? null}
                onValueChange={setDestination}
                disabled={phase !== null}
              >
                <SelectTrigger id="thread-move-destination">
                  <SelectValue placeholder="No connected destination" />
                </SelectTrigger>
                <SelectPopup>
                  {targets.map((entry) => (
                    <SelectItem key={entry.key} value={entry.key}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <p className="text-muted-foreground text-xs">
              Moves saved history, attachments and subthreads into a matching checkout. Checkout
              changes are committed and pushed automatically. The source stays recoverable in
              Archive.
            </p>
            {!canMove ? (
              <p className="text-muted-foreground text-xs">
                Finish active work and update both servers to a build that supports moving threads.
              </p>
            ) : null}
            {phase !== null ? (
              <p role="status" className="text-muted-foreground text-xs">
                {phase === "preparing"
                  ? "Committing, pushing and preparing history…"
                  : phase === "copying"
                    ? "Copying to destination…"
                    : "Confirming move…"}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive text-xs">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={phase !== null}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void submit();
            }}
            disabled={!target || !canMove || phase !== null}
          >
            {phase === null ? "Move thread" : "Moving…"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

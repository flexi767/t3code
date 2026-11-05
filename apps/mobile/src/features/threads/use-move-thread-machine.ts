import { useState } from "react";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
} from "@t3tools/contracts";
import * as Dialog from "../../components/ui/Dialog";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { readEnvironmentScope } from "../../state/session";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

export function useMoveThreadMachine(thread: EnvironmentThreadShell) {
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [moving, setMoving] = useState(false);
  const move = useAtomCommand(orchestrationEnvironment.moveThread, { reportFailure: false });
  const source = environments.find((entry) => entry.environmentId === thread.environmentId);
  const targets = projects.flatMap((project) => {
    const environment = environments.find((entry) => entry.environmentId === project.environmentId);
    if (
      project.environmentId === thread.environmentId ||
      project.archivedAt != null ||
      environment?.connection.phase !== "connected" ||
      environment.serverConfig?.environment.capabilities.threadMove !== true ||
      ![AuthOrchestrationOperateScope, AuthFilesystemWriteScope, AuthSourceControlWriteScope].every(
        (scope) => readEnvironmentScope(project.environmentId, scope),
      )
    )
      return [];
    return [
      {
        project,
        label: `${environment.label} · ${project.title}`,
        id: `move-machine:${project.environmentId}:${project.id}`,
      },
    ];
  });
  const supported =
    source?.serverConfig?.environment.capabilities.threadMove === true &&
    [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthFilesystemReadScope].every(
      (scope) => readEnvironmentScope(thread.environmentId, scope),
    );
  const items: MenuAction[] = supported
    ? [
        {
          id: "move-machine",
          title: moving ? "Moving thread…" : "Move to another machine…",
          image: "arrow.right",
          attributes: {
            disabled: moving || thread.runtime?.activeRunId != null || targets.length === 0,
          },
          subactions: targets.map((entry) => ({ id: entry.id, title: entry.label })),
        },
      ]
    : [];
  const handle = (event: string): boolean => {
    const target = targets.find((entry) => entry.id === event);
    if (!target) return false;
    if (moving || thread.runtime?.activeRunId != null) return true;
    const transferId = uuidv4();
    const perform = async () => {
      setMoving(true);
      const result = await move({
        sourceEnvironmentId: thread.environmentId,
        threadId: thread.id,
        destinationEnvironmentId: target.project.environmentId,
        destinationProjectId: target.project.id,
        transferId,
      });
      setMoving(false);
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        Dialog.confirm({
          title: "Move could not finish",
          message:
            cause instanceof Error
              ? cause.message
              : "The source is unchanged. Retry to reconcile any saved destination copy.",
          confirmText: "Retry",
          onConfirm: () => {
            void perform();
          },
        });
        return;
      }
      const { receipt, sourceArchived } = result.value;
      if (!sourceArchived)
        Dialog.alert(
          "Destination copy saved",
          "The source changed or disconnected and was kept. Review it before archiving.",
        );
      selectDetail({
        name: "Thread",
        params: {
          environmentId: receipt.destinationEnvironmentId,
          threadId: receipt.destinationThreadId,
        },
      });
    };
    Dialog.confirm({
      title: `Move to ${target.label}?`,
      message:
        "Move saved history, attachments and subthreads into a matching checkout. Commit and push working changes first. The original stays recoverable in Archive.",
      confirmText: "Move thread",
      onConfirm: () => {
        void perform();
      },
    });
    return true;
  };
  return { items, handle };
}

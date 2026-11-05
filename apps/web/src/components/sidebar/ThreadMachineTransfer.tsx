import { useState } from "react";
import type { EnvironmentMachineKind, ScopedThreadRef } from "@t3tools/contracts";
import { sessionMachineLabel } from "../../lib/sessionLabels";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { openMoveThreadDialog, useThreadMoveTargets } from "../MoveThreadDialog";
import { Menu, MenuTrigger, MenuPopup, MenuGroup, MenuGroupLabel, MenuItem } from "../ui/menu";

function TransferDestinations({
  threadRef,
  working,
}: {
  threadRef: ScopedThreadRef;
  working: boolean;
}) {
  const targets = useThreadMoveTargets(threadRef.environmentId);
  const devices = [
    ...new Map(
      targets.map(({ environment, machine }) => [
        environment.environmentId,
        { ...environment, machine },
      ]),
    ).values(),
  ];
  return (
    <MenuGroup>
      <MenuGroupLabel>Transfer to</MenuGroupLabel>
      {devices.map((device) => (
        <MenuItem
          key={device.environmentId}
          disabled={working}
          onClick={() => openMoveThreadDialog(threadRef, device.environmentId)}
        >
          <EnvironmentMachineIcon aria-hidden kind={device.machine ?? "server"} />
          {sessionMachineLabel(device.label)}
        </MenuItem>
      ))}
      {working || devices.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">
          {working ? "Finish active work first" : "No available devices"}
        </div>
      ) : null}
    </MenuGroup>
  );
}

export function ThreadMachineTransfer({
  threadRef,
  label,
  kind,
  working,
  detail = false,
}: {
  threadRef: ScopedThreadRef;
  label: string | null;
  kind: EnvironmentMachineKind;
  working: boolean;
  detail?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = sessionMachineLabel(label);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        aria-label={`Transfer thread from ${name}`}
        render={
          <button
            type="button"
            className={
              detail
                ? "inline-flex min-w-0 items-center gap-2 rounded-sm text-foreground/75 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                : "inline-flex shrink-0 items-center rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            }
          />
        }
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <EnvironmentMachineIcon
          aria-hidden
          kind={kind}
          className={detail ? "size-3 shrink-0" : "size-3.5 shrink-0"}
        />
        <span>{name}</span>
      </MenuTrigger>
      {open ? (
        <MenuPopup
          side="bottom"
          align="start"
          alignOffset={-12}
          width="content"
          layer="above-tooltip"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <TransferDestinations threadRef={threadRef} working={working} />
        </MenuPopup>
      ) : null}
    </Menu>
  );
}

import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { render } from "../../../test/render";
import { ThreadMachineTransfer } from "./ThreadMachineTransfer";

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../MoveThreadDialog", () => ({
  openMoveThreadDialog: state.open,
  useThreadMoveTargets: () => [
    { environment: { environmentId: "m3", label: "M3" }, machine: "laptop" },
    { environment: { environmentId: "m3", label: "M3" }, machine: "laptop" },
    { environment: { environmentId: "j", label: "J" }, machine: "server" },
  ],
}));

vi.mock("../../state/entities", () => ({
  useServerConfigs: () =>
    new Map([["m5", { environment: { capabilities: { threadMove: true } } }]]),
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));

it("selects one destination per device without activating the thread", async () => {
  state.open.mockReset();
  const activate = vi.fn();
  const threadRef = scopeThreadRef(EnvironmentId.make("m5"), ThreadId.make("thread:test"));
  // This isolated menu does not navigate; its destination dialog is captured by the mock.
  await using screen = await render(
    <div onClick={activate}>
      <ThreadMachineTransfer threadRef={threadRef} label="M5" kind="laptop" working={false} />
    </div>,
    { router: false },
  );
  await screen.getByRole("button", { name: "Transfer thread from M5" }).click();
  await expect.element(screen.getByText("Transfer to")).toBeVisible();
  await expect.element(screen.getByRole("menuitem", { name: "M3", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("menuitem", { name: "J", exact: true })).toBeVisible();
  await screen.getByRole("menuitem", { name: "M3", exact: true }).click();
  expect(state.open).toHaveBeenCalledExactlyOnceWith(threadRef, "m3");
  expect(activate).not.toHaveBeenCalled();
});

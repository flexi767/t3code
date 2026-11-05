import { useRef } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createPortal } from "react-dom";
import { render } from "../../../test/render";
import { ComposerSurface } from "./ComposerSurface";

function Composer() {
  const editor = useRef<HTMLTextAreaElement>(null);
  return (
    <ComposerSurface.Main
      onFocusInput={() => {
        editor.current?.focus();
        editor.current?.setSelectionRange(5, 5);
      }}
    >
      <textarea ref={editor} aria-label="Message" defaultValue="hello" />
      <div style={{ display: "flex", minHeight: 32 }}>
        <button type="button" onPointerDown={(event) => event.preventDefault()}>
          Attach
        </button>
        <div data-testid="gap" style={{ width: 80 }} />
        <button type="button" onPointerDown={(event) => event.preventDefault()}>
          Model
        </button>
      </div>
      {createPortal(
        <div data-testid="popup-gap" style={{ width: 80, height: 32 }} />,
        document.body,
      )}
    </ComposerSurface.Main>
  );
}

it("focuses the input when clicking empty composer space", async () => {
  // This surface has no routing behavior.
  await using screen = await render(<Composer />, { router: false });
  await userEvent.click(screen.getByTestId("gap"));
  await expect.element(screen.getByRole("textbox")).toHaveFocus();
});

it("preserves the cursor for controls, editor clicks and portaled popup space", async () => {
  // This surface has no routing behavior.
  await using screen = await render(<Composer />, { router: false });
  const editor = screen.getByRole("textbox").element() as HTMLTextAreaElement;
  editor.focus();
  editor.setSelectionRange(0, 0);
  await userEvent.click(screen.getByRole("button", { name: "Attach" }));
  expect(editor.selectionStart).toBe(0);
  await userEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(editor.selectionStart).toBe(0);
  editor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  expect(editor.selectionStart).toBe(0);
  await userEvent.click(page.getByTestId("popup-gap"));
  expect(editor.selectionStart).toBe(0);
});

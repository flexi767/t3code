import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** Notices and the context row share the composer tray. */
function Shell({
  contextRow = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextRow?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-context-row={contextRow || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto flex w-full max-w-(--chat-content-max-width) flex-col rounded-2xl surface-tray border-0!",
        // Paint the rim above the main surface without expanding the 48px + 30px stack.
        "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-[inherit] after:border after:border-(--tray-stroke)",
        "[--chat-composer-surface:var(--popover)] [--chat-composer-outline:var(--tray-stroke)]",
        className,
      )}
      {...props}
    />
  );
}

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="composer-host" className={cn("relative z-10 w-full", className)} {...props} />
  );
}

/** The message surface sits flush in the tray, so it follows the tray's corners. */
function Main({
  className,
  onFocusInput,
  onPointerDown,
  ...props
}: ComponentProps<"div"> & {
  onFocusInput?: (() => void) | undefined;
}) {
  return (
    <div
      data-chat-composer-main-surface="true"
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!onFocusInput || event.defaultPrevented || event.button !== 0) return;
        const target = event.target;
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
        if (
          target.closest(
            'button, a[href], input, select, textarea, label, [role="button"], [role="combobox"], [role="menuitem"], [role="slider"], [contenteditable], [tabindex]',
          )
        )
          return;
        event.preventDefault();
        onFocusInput();
      }}
      className={cn("group relative z-10 rounded-composer surface-composer", className)}
      {...props}
    />
  );
}

/** A plain row under the card (environment, worktree, branch) with no surface of its own. */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-tray-row"
      // 8px on the right, so a trailing chip's hover fill ends on the send pill's edge; 5px on
      // the left, so the first chip's icon (after its 1px border and 8px padding) sits on the text line.
      className={cn(
        "group/composer-context relative flex h-7.5 min-w-0 items-center gap-1 ps-1.25 pe-2 py-1 text-meta text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };

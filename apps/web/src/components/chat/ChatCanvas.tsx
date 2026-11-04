import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { useStore } from "zustand";
import { ChatCanvasContext } from "./ChatCanvasContext";
import type { ChatCanvasPreview } from "./chatCanvasLayout";
import { resolveChatCanvasModel, type ChatCanvasStore } from "./canvasStore";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { observeResize } from "../../lib/observeResize";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useClientSettings } from "../../hooks/useSettings";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ChatCanvas({
  store,
  threadRef,
  preview,
  composerOverlayElement,
  detailsCardTopInset = 0,
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style" | "ref"> & {
  store: ChatCanvasStore;
  /** The thread whose details card sits on the canvas; other threads' measurements are stale. */
  threadRef: ScopedThreadRef | null;
  /** The thread's mini player while it renders on this canvas. */
  preview: ChatCanvasPreview | null;
  composerOverlayElement: HTMLElement | null;
  detailsCardTopInset?: number;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const widthProbeRef = useRef<HTMLDivElement | null>(null);
  const [timelineElement, registerTimeline] = useState<HTMLElement | null>(null);
  const measurements = useStore(store, (state) => state.measurements);
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const maxHalfWidth =
    measurements.width > 0 ? Math.max(320, Math.min(1200, (measurements.width - 96) / 2)) : 1200;
  // A centered column grows on both sides, so a one-pixel edge drag adds two pixels.
  const resize = useResizableWidth({
    storageKey: `t3code:conversation-half-width:${chatWidth}`,
    defaultWidth:
      chatWidth === "full"
        ? Math.max(368, measurements.width / 2)
        : chatWidth === "wide"
          ? 576
          : 368,
    minWidth: 320,
    maxWidth: maxHalfWidth,
    edge: "right",
  });
  const detailsCardMeasurement = useStore(store, (state) => state.detailsCardMeasurement);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes canvas, find bar and timeline resizes and writes the measurements to the canvas store
  useLayoutEffect(() => {
    const element = elementRef.current;
    const probe = widthProbeRef.current;
    if (!element || !probe) return;
    const findBar =
      detailsCardTopInset > 0 ? element.querySelector<HTMLElement>("[data-thread-find-bar]") : null;
    const measure = () => {
      const canvasBounds = element.getBoundingClientRect();
      const findBarBounds = findBar?.getBoundingClientRect();
      const styles = getComputedStyle(probe);
      store.getState().setMeasurements({
        findBar:
          detailsCardTopInset > 0
            ? {
                left: findBarBounds ? findBarBounds.left - canvasBounds.left : 0,
                right: findBarBounds ? findBarBounds.right - canvasBounds.left : 0,
                bottom: findBarBounds ? findBarBounds.bottom - canvasBounds.top : 0,
              }
            : null,
        width: element.clientWidth,
        height: element.clientHeight,
        padding: Number.parseFloat(styles.paddingLeft),
        maxChatWidth: Number.parseFloat(styles.width),
        minChatWidth: Number.parseFloat(styles.minWidth),
        composerHeight: composerOverlayElement?.getBoundingClientRect().height ?? 0,
        timelineGutter: timelineElement
          ? (timelineElement.offsetWidth - timelineElement.clientWidth) / 2
          : 0,
      });
    };
    measure();
    const observed: Element[] = [element, probe];
    if (findBar) observed.push(findBar);
    if (composerOverlayElement) observed.push(composerOverlayElement);
    if (timelineElement) observed.push(timelineElement);
    return observeResize(observed, measure);
  }, [store, composerOverlayElement, timelineElement, detailsCardTopInset]);
  const detailsCardInlineOpen = useRightPanelStore((state) =>
    threadRef === null
      ? false
      : selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const model = resolveChatCanvasModel({
    measurements,
    detailsCardMeasurement,
    threadRef,
    preview,
    detailsCardInlineOpen,
  });
  const context = {
    container: model.container,
    lane: model.lane,
    layout: model.layout,
    previewKey: preview?.key ?? null,
    registerTimeline,
    measureDetailsCard: store.getState().measureDetailsCard,
    detailsCardTopInset: model.detailsCardTopInset,
    preferredDetailsCard: model.preferredDetailsCard,
    detailsCardPlacement: model.detailsCardPlacement,
  };
  const { layout } = context;
  return (
    <ChatCanvasContext value={context}>
      <div
        {...props}
        ref={elementRef}
        data-chat-canvas
        data-preview-overlaps-chat={layout.overlapsChat || undefined}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          {
            "--chat-timeline-gutter": `${measurements.timelineGutter}px`,
            "--resizable-width": `${resize.width}px`,
            "--chat-content-max-width": "calc(var(--resizable-width) * 2)",
            "--chat-lane-inset-start": `${layout.chat.insetStart}px`,
            "--chat-lane-inset-end": `${layout.chat.insetEnd}px`,
          } as CSSProperties
        }
      >
        <div
          ref={widthProbeRef}
          aria-hidden
          className="pointer-events-none invisible absolute h-0 w-(--chat-content-max-width) min-w-[40rem] box-content ps-3 sm:ps-12"
        />
        {children}
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="separator"
                aria-label="Resize conversation"
                aria-orientation="vertical"
                aria-valuemin={640}
                aria-valuemax={maxHalfWidth * 2}
                aria-valuenow={resize.width * 2}
                tabIndex={0}
                className="group absolute inset-y-0 z-20 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none select-none sm:block pointer-coarse:hidden"
                style={{ left: layout.chat.left + layout.chat.width }}
                {...resize.handlers}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    resize.setWidth(resize.width + (event.key === "ArrowLeft" ? -10 : 10));
                  }
                }}
              />
            }
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
            />
          </TooltipTrigger>
          <TooltipPopup>Drag to resize conversation</TooltipPopup>
        </Tooltip>
      </div>
    </ChatCanvasContext>
  );
}

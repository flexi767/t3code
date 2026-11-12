import { Button } from "../ui/button";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
} from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";
import { contextWindowSegments } from "./compaction.logic";
import { cn } from "~/lib/utils";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
  compact?: boolean;
}) {
  const { modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const missing = props.usage === null;
  const usage = props.usage ?? {
    usedPercentage: null,
    maxTokens: null,
    usedTokens: 0,
    totalProcessedTokens: null,
    cost: null,
    compactsAutomatically: false,
    autoCompactThreshold: null,
    updatedAt: null,
  };
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = missing
    ? "color-mix(in oklab, var(--color-muted-foreground) 30%, transparent)"
    : isOverloaded
      ? "var(--color-error)"
      : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size={props.compact ? "icon-xs" : "icon-sm"}
            variant="ghost-muted"
            className={props.compact ? undefined : "size-7"}
            onClick={(event) => event.stopPropagation()}
            aria-label={
              missing
                ? "Context usage unavailable"
                : usage.maxTokens !== null && usedPercentage
                  ? `Context window ${usedPercentage} used`
                  : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span
              className={
                props.compact
                  ? "relative flex size-3.5 items-center justify-center"
                  : "relative flex size-5 items-center justify-center"
              }
            >
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  className="stroke-muted-foreground/24"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={missing ? "2 3" : circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side={props.compact ? "bottom" : "top"}
        align="end"
        padding="none"
        width="auto"
        className="max-w-52 text-left whitespace-normal"
      >
        <div className="flex min-w-0 flex-col gap-1 px-2 py-1.5">
          {onCompact ? (
            <>
              <Button
                size="micro"
                variant="ghost-muted"
                className="self-start"
                disabled={compactDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onCompact();
                }}
              >
                <Minimize2Icon aria-hidden="true" className="size-3" />
                Compact
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-secondary-label text-caption leading-tight">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
          {missing ? null : (
            <div className="flex items-center justify-between gap-2">
              {usage.maxTokens !== null && usedPercentage ? (
                <div className="flex gap-2 text-secondary-label text-caption tabular-nums">
                  <span>{usedPercentage}</span>
                  <span>
                    {formatContextWindowTokens(usage.usedTokens)}/
                    {formatContextWindowTokens(usage.maxTokens ?? null)}
                  </span>
                </div>
              ) : (
                <div className="text-secondary-label text-caption tabular-nums">
                  {formatContextWindowTokens(usage.usedTokens)}
                </div>
              )}
            </div>
          )}
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-caption leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.maxTokens != null ? (
            <div className="flex items-center justify-between gap-3 text-caption">
              <span>Remaining</span>
              <span>
                {formatContextWindowTokens(Math.max(0, usage.maxTokens - usage.usedTokens))}
              </span>
            </div>
          ) : null}
          {usage.updatedAt ? (
            <div className="text-secondary-label text-caption">
              Updated {new Date(usage.updatedAt).toLocaleString()}
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-caption leading-4">
              <span className="text-secondary-label">Cost</span>
              <span className="tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-caption">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** The details row can reserve visible notches without changing the used/max fill. */
export function ContextWindowSegments({
  usage,
  minSegmentWidth = 0,
}: {
  usage: ContextWindowSnapshot;
  minSegmentWidth?: number;
}) {
  const percentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const segments = contextWindowSegments(usage);
  const largest = segments.reduce((max, segment) => Math.max(max, segment.tokens), 0);
  const largestIndex = segments.findIndex((segment) => segment.tokens === largest);
  // When the entire used fill is tiny, scale gaps and minimums down together.
  const gap = `min(1px, calc(100% / ${segments.length * 2 - 1}))`;
  const available = `(100% - ${segments.length - 1} * ${gap})`;
  const minimum = `min(${minSegmentWidth}px, calc(${available} / ${segments.length}))`;
  return (
    <span
      className="block h-1 min-w-0 overflow-hidden rounded-full bg-black/10 dark:bg-white/[0.063]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percentage)}
      aria-label="Context window usage"
    >
      <span
        className="flex h-full gap-px overflow-hidden"
        style={{ width: `${percentage}%`, ...(minSegmentWidth > 0 ? { gap } : {}) }}
      >
        {segments.map((segment, index) => (
          <span
            key={segment.label}
            className={cn("h-full min-w-0 basis-0", segment.color)}
            style={
              minSegmentWidth > 0
                ? {
                    minWidth: minimum,
                    flexGrow: index === largestIndex ? 1 : 0,
                    flexBasis:
                      index === largestIndex
                        ? 0
                        : `max(${minimum}, calc(${available} * ${segment.tokens / Math.max(1, usage.usedTokens)}))`,
                  }
                : { flexGrow: segment.tokens }
            }
          />
        ))}
      </span>
    </span>
  );
}

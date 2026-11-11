import { Slider } from "@base-ui/react/slider";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";

import { cn } from "~/lib/utils";
import type { ThreadCosts } from "~/state/sessionUsage";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import type { SidebarProviderEntry } from "./SidebarThreadRow";

export type SidebarThreadStatusFilter = "done" | "working" | "failed";

export interface SidebarThreadFilter {
  readonly providers: ReadonlySet<string>;
  /** `${providerInstanceId}:${model}`; a provider with none selected matches all its models. */
  readonly models: ReadonlySet<string>;
  readonly statuses: ReadonlySet<SidebarThreadStatusFilter>;
  /** Inclusive dollars; null matches every cost. */
  readonly costRange: readonly [number, number] | null;
}

export const EMPTY_SIDEBAR_THREAD_FILTER: SidebarThreadFilter = {
  providers: new Set(),
  models: new Set(),
  statuses: new Set(),
  costRange: null,
};

const STATUS_OPTIONS: ReadonlyArray<{ value: SidebarThreadStatusFilter; label: string }> = [
  { value: "done", label: "Done" },
  { value: "working", label: "Working" },
  { value: "failed", label: "Failed" },
];

type SidebarFilterThread = Parameters<typeof isThreadWorking>[0] &
  Pick<EnvironmentThreadShell, "modelSelection">;

export function isSidebarThreadFilterActive(filter: SidebarThreadFilter): boolean {
  return filter.providers.size > 0 || filter.statuses.size > 0 || filter.costRange !== null;
}

function threadProvider(thread: SidebarFilterThread): string {
  return thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
}

function sidebarThreadStatus(thread: SidebarFilterThread): SidebarThreadStatusFilter | null {
  if (isThreadWorking(thread)) return "working";
  if (thread.latestRun?.status === "failed") return "failed";
  if (thread.latestRun?.status === "completed") return "done";
  return null;
}

export function threadCostKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

export function matchesSidebarThreadFilter(
  thread: SidebarFilterThread,
  filter: SidebarThreadFilter,
  /** A thread with no recorded usage has cost nothing. */
  cost = 0,
): boolean {
  if (filter.costRange !== null) {
    const [min, max] = filter.costRange;
    if (cost < min || cost > max) return false;
  }
  if (filter.providers.size > 0) {
    const provider = threadProvider(thread);
    if (!filter.providers.has(provider)) return false;
    const providerHasModelFilter = [...filter.models].some((key) => key.startsWith(`${provider}:`));
    if (
      providerHasModelFilter &&
      !filter.models.has(`${provider}:${thread.modelSelection.model}`)
    ) {
      return false;
    }
  }
  if (filter.statuses.size > 0) {
    const status = sidebarThreadStatus(thread);
    if (status === null || !filter.statuses.has(status)) return false;
  }
  return true;
}

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function costStep(max: number): number {
  if (max <= 1) return 0.01;
  return max <= 20 ? 0.1 : 1;
}

function CostRangeFilter(props: {
  max: number;
  value: readonly [number, number] | null;
  onChange: (value: readonly [number, number] | null) => void;
}) {
  const { max, onChange } = props;
  const [low, high] = props.value ?? [0, max];
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Price</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {dollars.format(low)} – {dollars.format(Math.min(high, props.max))}
        </span>
      </div>
      <Slider.Root
        min={0}
        max={props.max}
        step={costStep(props.max)}
        value={[low, Math.min(high, props.max)]}
        onValueChange={(next) => {
          const nextLow = next[0] ?? 0;
          const nextHigh = next[1] ?? max;
          onChange(nextLow <= 0 && nextHigh >= max ? null : [nextLow, nextHigh]);
        }}
      >
        <Slider.Control className="flex w-full touch-none items-center px-1.5 py-1.5 select-none">
          <Slider.Track className="relative h-1 w-full rounded-full bg-muted">
            <Slider.Indicator className="rounded-full bg-primary" />
            {(["Minimum price", "Maximum price"] as const).map((label, index) => (
              <Slider.Thumb
                key={label}
                index={index}
                aria-label={label}
                className="size-3 rounded-full border border-primary bg-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            ))}
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
    </>
  );
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

function FilterChip(props: { selected: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onClick}
      className={cn(
        "max-w-full cursor-pointer truncate rounded-md border px-2 py-0.5 text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

export function SidebarThreadFilterSection(props: {
  threads: readonly EnvironmentThreadShell[];
  providerEntriesByEnvironment: ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>;
  threadCosts: ThreadCosts;
  filter: SidebarThreadFilter;
  onFilterChange: (filter: SidebarThreadFilter) => void;
}) {
  const { filter, onFilterChange } = props;
  let maxCost = 0;
  for (const thread of props.threads) {
    maxCost = Math.max(maxCost, props.threadCosts.get(threadCostKey(thread)) ?? 0);
  }
  // Whole dollars keep the scale readable; under a dollar it stays in cents.
  maxCost = maxCost > 1 ? Math.ceil(maxCost) : Math.ceil(maxCost * 100) / 100;
  const providers = new Map<string, { label: string; models: Map<string, string> }>();
  for (const thread of props.threads) {
    const instanceId = threadProvider(thread);
    const entry = props.providerEntriesByEnvironment.get(thread.environmentId)?.get(instanceId);
    let provider = providers.get(instanceId);
    if (!provider) {
      provider = { label: entry?.displayName ?? instanceId, models: new Map() };
      providers.set(instanceId, provider);
    }
    const slug = thread.modelSelection.model;
    if (!provider.models.has(slug)) {
      const model = entry?.models.find((candidate) => candidate.slug === slug);
      provider.models.set(
        slug,
        model ? getTriggerDisplayModelName(model, entry?.driverKind) : slug,
      );
    }
  }
  const sortedProviders = [...providers].toSorted((left, right) =>
    left[1].label.localeCompare(right[1].label),
  );

  const toggleProvider = (instanceId: string) => {
    const deselecting = filter.providers.has(instanceId);
    onFilterChange({
      ...filter,
      providers: toggled(filter.providers, instanceId),
      models: deselecting
        ? new Set([...filter.models].filter((key) => !key.startsWith(`${instanceId}:`)))
        : filter.models,
    });
  };

  return (
    <div className="flex flex-col gap-2 border-t px-2 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Provider</span>
        {isSidebarThreadFilterActive(filter) ? (
          <button
            type="button"
            onClick={() => onFilterChange(EMPTY_SIDEBAR_THREAD_FILTER)}
            className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {sortedProviders.map(([instanceId, provider]) => (
          <FilterChip
            key={instanceId}
            selected={filter.providers.has(instanceId)}
            onClick={() => toggleProvider(instanceId)}
          >
            {provider.label}
          </FilterChip>
        ))}
      </div>
      {sortedProviders
        .filter(([instanceId]) => filter.providers.has(instanceId))
        .map(([instanceId, provider]) => (
          <div key={instanceId} className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{provider.label} models</span>
            <div className="flex flex-wrap gap-1">
              {[...provider.models]
                .toSorted((left, right) => left[1].localeCompare(right[1]))
                .map(([slug, label]) => {
                  const key = `${instanceId}:${slug}`;
                  return (
                    <FilterChip
                      key={key}
                      selected={filter.models.has(key)}
                      onClick={() =>
                        onFilterChange({ ...filter, models: toggled(filter.models, key) })
                      }
                    >
                      {label}
                    </FilterChip>
                  );
                })}
            </div>
          </div>
        ))}
      <span className="text-xs font-medium text-muted-foreground">Status</span>
      <div className="flex flex-wrap gap-1">
        {STATUS_OPTIONS.map((option) => (
          <FilterChip
            key={option.value}
            selected={filter.statuses.has(option.value)}
            onClick={() =>
              onFilterChange({ ...filter, statuses: toggled(filter.statuses, option.value) })
            }
          >
            {option.label}
          </FilterChip>
        ))}
      </div>
      {maxCost > 0 || filter.costRange !== null ? (
        <CostRangeFilter
          max={Math.max(maxCost, filter.costRange?.[1] ?? 0)}
          value={filter.costRange}
          onChange={(costRange) => onFilterChange({ ...filter, costRange })}
        />
      ) : null}
    </div>
  );
}

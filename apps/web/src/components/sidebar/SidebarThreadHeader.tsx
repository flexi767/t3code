import { FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  /** Without projects there is nothing to scope, so the scope picker stays out. */
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewProject: () => void;
  onNewThread: () => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
  /** Lifts the row onto the window's top row (Labs: Title bar search). */
  inTitleBar?: boolean;
}

export function SidebarThreadHeader({
  hasProjects,
  projectScope,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
  inTitleBar = false,
}: SidebarThreadHeaderProps) {
  const [searchFocused, setSearchFocused] = useState(false);
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";

  return (
    <div
      className={cn(
        "flex items-center gap-1",
        // Centered on the chrome row above this group, right of the traffic lights.
        inTitleBar &&
          "pointer-events-auto absolute top-[calc(var(--workspace-controls-top)+(var(--workspace-chrome-row-height)-1.75rem)/2-var(--workspace-chrome-row-height)+(--spacing(1)))] right-[calc(var(--sidebar-content-inset)+3px)] left-[calc(var(--workspace-controls-left)-6px)] [-webkit-app-region:no-drag]",
      )}
    >
      <InputGroup size="sidebar" className="min-w-0 flex-1">
        <InputGroupAddon>
          {/* A 16px slot like a row's favicon, pulled out like the addon's own
              svg: the glyph centers on the icon column and the placeholder
              starts where the rows' labels do. */}
          <span className="-mx-0.5 flex size-4 shrink-0 items-center justify-center">
            <SearchIcon className="size-[13px] text-(--sidebar-icon-color)" />
          </span>
        </InputGroupAddon>
        <InputGroupInput
          ref={searchInputRef}
          nativeInput
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (inTitleBar && event.key === "Escape" && searchQuery === "") {
              event.currentTarget.blur();
            }
            onSearchKeyDown(event);
          }}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          placeholder="Search"
          aria-label="Search threads"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
          aria-activedescendant={
            activeResultExists
              ? `sidebar-thread-search-result-${activeSearchResultIndex}`
              : undefined
          }
        />
        {/* Unfocused in the title bar, the query text gets the room instead. */}
        {isSearching && (!inTitleBar || searchFocused) ? (
          <InputGroupAddon align="inline-end">
            {/* 2px in from the addon, so the 12px glyph centers 16px inside
                the field like a row trailing glyph. */}
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="me-0.5"
              aria-label="Clear thread search"
              // Keeps focus in the field, so blur does not hide this button mid-click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onClearSearch();
                searchInputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {/* Three 28px controls with 4px gaps (pen s8qVFu). */}
      <div
        className={cn(
          "flex shrink-0 items-center",
          inTitleBar ? searchFocused && "hidden" : "gap-1",
        )}
      >
        {hasProjects ? projectScope : null}
        <SidebarHeaderIconButton
          label="Add project"
          size={inTitleBar ? "titlebar" : "header"}
          onClick={onNewProject}
        >
          <FolderPlusIcon />
        </SidebarHeaderIconButton>
        <SidebarHeaderIconButton
          label="New thread"
          tooltip={newThreadLabel}
          size={inTitleBar ? "titlebar" : "header"}
          disabled={newThreadDisabled}
          onClick={onNewThread}
        >
          {/* The pen's glyph fills more of its box, so 13px matches its 14px neighbours. */}
          <SquarePenIcon className={cn(inTitleBar && "size-[13px] translate-y-px")} />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  size = "header",
  children,
  ...rest
}: {
  label: string;
  size?: "header" | "titlebar" | "footer";
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label" | "size"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            data-sidebar-header-control={size === "footer" ? undefined : ""}
            {...rest}
            className={cn(
              "relative shrink-0",
              // Title bar controls sit a traffic-light gap apart (pen icons are 16px).
              size === "footer" ? "size-8" : size === "titlebar" ? "size-[22px]" : "size-7",
              className,
            )}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

// A per-device layout preference, kept out of synced settings so a UI-only deploy can ship it.
export function useSidebarTitleBarSearch() {
  return useLocalStorage("t3code:sidebar:title-bar-search", false, Schema.Boolean);
}

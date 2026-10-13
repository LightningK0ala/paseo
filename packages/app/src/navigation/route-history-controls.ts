import { create } from "zustand";
import type { RouteHistoryDirection } from "./route-history-state";

interface RouteHistoryControlsState {
  canGoBack: boolean;
  canGoForward: boolean;
  navigate: ((direction: RouteHistoryDirection) => void) | null;
}

// Published by the route history owner so chrome outside it can render Back/Forward.
export const useRouteHistoryControls = create<RouteHistoryControlsState>(() => ({
  canGoBack: false,
  canGoForward: false,
  navigate: null,
}));

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

/**
 * Suggested replies: the daemon predicts the user's next message once an agent
 * finishes a turn, and the composer shows it as its placeholder.
 *
 * The daemon generates once per finished turn and caches it for as long as it
 * runs, trying the next provider only when one fails. This store
 * keeps the answer per agent and turn on the client, so re-renders and
 * reopening the agent do not even make a request.
 */

type ReplySuggestionEntry =
  | { turnKey: string; state: "loading" }
  | { turnKey: string; state: "ready"; suggestion: string | null };

interface ReplySuggestionStoreState {
  entries: Record<string, ReplySuggestionEntry>;
}

const useReplySuggestionStore = create<ReplySuggestionStoreState>(() => ({ entries: {} }));

function setEntry(key: string, entry: ReplySuggestionEntry | null): void {
  useReplySuggestionStore.setState((state) => {
    const entries = { ...state.entries };
    if (entry) entries[key] = entry;
    else delete entries[key];
    return { entries };
  });
}

/**
 * The client's identity for a finished turn. Keyed on updatedAt, not
 * lastUserMessageAt: a turn the agent starts on its own leaves
 * lastUserMessageAt unchanged, and a client that was not watching (panel
 * closed, app backgrounded, reconnecting) never sees the running state that
 * would have cleared the entry. updatedAt moves with every turn. It also moves
 * on idle edits such as a mode change; those refetch, and the daemon answers
 * from its cache without a new model call.
 */
export function buildReplySuggestionTurnKey(updatedAt: Date): string {
  return String(updatedAt.getTime());
}

export function resolveVisibleReplySuggestion(
  entry: ReplySuggestionEntry | undefined,
  agent: { status: AgentLifecycleStatus; turnKey: string } | null,
  isSettingEnabled: boolean,
): string | null {
  if (!isSettingEnabled || !entry || entry.state !== "ready" || !agent) return null;
  if (agent.status !== "idle" || entry.turnKey !== agent.turnKey) return null;
  return entry.suggestion;
}

export interface ReplySuggestionKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Plain Tab in an empty composer takes the suggestion. Never touches typed text. */
export function shouldAcceptReplySuggestionOnKey(
  event: ReplySuggestionKeyEvent,
  text: string,
  suggestion: string | null,
): boolean {
  if (!suggestion || text.length > 0) return false;
  if (event.key !== "Tab") return false;
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/**
 * Whether the host's Suggested replies setting is on, as far as this client
 * knows. It reads the daemon config already cached (the settings screen loads
 * it and the daemon pushes every change) and never fetches it; unknown counts
 * as on, because the daemon returns nothing when the setting is off anyway.
 */
function useReplySuggestionsSettingEnabled(serverId: string): boolean {
  // Read the cache directly instead of adding a query observer. A second
  // observer without a queryFn would become the query's options whenever it
  // rendered last, and the reconnect invalidation would then refetch the
  // settings screen's daemon config with no queryFn and put it in error.
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => daemonConfigQueryKey(serverId), [serverId]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const queryHash = hashKey(queryKey);
      return queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === queryHash) onChange();
      });
    },
    [queryClient, queryKey],
  );
  const read = useCallback(
    () =>
      queryClient.getQueryData<MutableDaemonConfig>(queryKey)?.metadataGeneration.replySuggestions
        ?.enabled !== false,
    [queryClient, queryKey],
  );
  return useSyncExternalStore(subscribe, read, read);
}

export function useReplySuggestion(input: { serverId: string; agentId: string }): string | null {
  const { serverId, agentId } = input;
  const client = useHostRuntimeClient(serverId);
  const isSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.replySuggestions === true,
  );
  const status = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.status ?? null,
  );
  // Only read while idle: updatedAt moves on every stream event of a running
  // turn, and the composer should not re-render for each one.
  const turnKey = useSessionStore((state) => {
    const agent = state.sessions[serverId]?.agents?.get(agentId);
    return agent?.status === "idle" ? buildReplySuggestionTurnKey(agent.updatedAt) : null;
  });
  const isSettingEnabled = useReplySuggestionsSettingEnabled(serverId);
  const entryKey = `${serverId}:${agentId}`;
  const entry = useReplySuggestionStore((state) => state.entries[entryKey]);

  useEffect(() => {
    // A new turn makes the stored suggestion stale; drop it as soon as the
    // agent leaves idle so it can never resurface for the next turn. Turning
    // the setting off drops it too, so turning it back on asks the daemon again.
    if ((status !== null && status !== "idle") || !isSettingEnabled) setEntry(entryKey, null);
  }, [entryKey, isSettingEnabled, status]);

  useEffect(() => {
    if (!isSettingEnabled || !isSupported || !client || status !== "idle" || turnKey === null) {
      return;
    }
    const existing = useReplySuggestionStore.getState().entries[entryKey];
    if (existing?.turnKey === turnKey) return;

    setEntry(entryKey, { turnKey, state: "loading" });
    function settle(suggestion: string | null): void {
      const current = useReplySuggestionStore.getState().entries[entryKey];
      if (current?.turnKey !== turnKey || current.state !== "loading") return;
      setEntry(entryKey, { turnKey, state: "ready", suggestion });
    }
    // Fire and forget: the composer works normally until (and unless) it arrives.
    client
      .getAgentReplySuggestion(agentId)
      .then((payload) => settle(payload.suggestion))
      .catch(() => settle(null));
  }, [agentId, client, entryKey, isSettingEnabled, isSupported, status, turnKey]);

  if (status === null || turnKey === null) return null;
  return resolveVisibleReplySuggestion(entry, { status, turnKey }, isSettingEnabled);
}

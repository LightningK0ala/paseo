import { basename } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import type { AgentSnapshotPayload } from "../../messages.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import { buildStoredAgentPayload } from "../agent-projections.js";
import { serializeSnapshotWithMetadata } from "../mcp-shared.js";
import { isStoredAgentProviderAvailable } from "../../persistence-hooks.js";
import { sendPromptToAgent } from "../agent-prompt.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../../workspace-registry.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

// Owner-facing tools for voice assistants (ChatGPT voice mode over the remote MCP
// endpoint). Every extra tool call costs the caller a model turn and a round trip,
// so each tool answers a whole spoken question in one call with a small payload.

const DEFAULT_WINDOW_HOURS = 24;
const MAX_ITEMS_PER_SECTION = 5;
const GIST_MAX_CHARS = 220;
const WANTS_MAX_CHARS = 140;
const ERROR_MAX_CHARS = 160;
const MAX_CANDIDATES = 5;
// A message to an agent that has to be resumed first can take several seconds to
// reach it. Past this, acknowledge and let the delivery finish in the background.
const SEND_ACK_TIMEOUT_MS = 2_500;

export interface VoicePermission {
  id: string;
  kind: string;
  name: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  actions?: Array<{ id: string; label: string }>;
}

export interface VoiceAgentView {
  id: string;
  title: string | null;
  project: string;
  status: string;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
  attentionTimestamp: string | null;
  updatedAt: string;
  lastError: string | null;
  pendingPermissions: VoicePermission[];
}

export interface WhatsWaitingPermission {
  agentId: string;
  agent: string;
  project: string;
  wants: string;
  requestId: string;
  options?: string[];
}

export interface WhatsWaitingError {
  agentId: string;
  agent: string;
  project: string;
  ago: string;
  error: string;
}

export interface WhatsWaitingFinished {
  agentId: string;
  agent: string;
  project: string;
  ago: string;
  gist: string | null;
}

export interface WhatsWaitingSummary {
  summary: string;
  permissions: WhatsWaitingPermission[];
  errors: WhatsWaitingError[];
  finished: WhatsWaitingFinished[];
  running: number;
  notListed?: { permissions?: number; errors?: number; finished?: number; olderUnread?: number };
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cuts at a word boundary and marks the cut with an ellipsis. */
export function truncateForSpeech(text: string, maxChars: number): string {
  const clean = collapseWhitespace(text);
  if (clean.length <= maxChars) {
    return clean;
  }
  const slice = clean.slice(0, maxChars - 1);
  const endsOnWord = clean[maxChars - 1] === " ";
  const lastSpace = slice.lastIndexOf(" ");
  const cut = endsOnWord || lastSpace <= maxChars / 2 ? slice : slice.slice(0, lastSpace);
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}

function stripMarkdown(text: string): string {
  return (
    text
      // Fenced code is unreadable aloud; keep a marker so the gist doesn't lie.
      .replace(/```[\s\S]*?(```|$)/g, " (code) ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      // Headings ("## Summary") say little and run into the first sentence.
      .replace(/^\s{0,3}#{1,6}\s+.*$/gm, " ")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\|.*\|\s*$/gm, " ")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
  );
}

/**
 * The first one or two sentences of an agent's final message, as plain text
 * short enough to read aloud.
 */
export function gistOfMessage(message: string, maxChars = GIST_MAX_CHARS): string | null {
  const plain = collapseWhitespace(stripMarkdown(message));
  if (!plain) {
    return null;
  }
  const sentences = plain.split(/(?<=[.!?])\s+/);
  let gist = sentences[0] ?? plain;
  const second = sentences[1];
  if (second && gist.length + second.length + 1 <= maxChars) {
    gist = `${gist} ${second}`;
  }
  return truncateForSpeech(gist, maxChars);
}

const PERMISSION_INPUT_KEYS = ["command", "file_path", "path", "url", "query", "pattern", "plan"];

function describePermission(permission: VoicePermission): string {
  const label = permission.title ?? permission.description ?? permission.name;
  const input = permission.input ?? {};
  const detailKey = PERMISSION_INPUT_KEYS.find(
    (key) => typeof input[key] === "string" && (input[key] as string).trim().length > 0,
  );
  const detail = detailKey ? collapseWhitespace(input[detailKey] as string) : null;
  const text = detail && !label.includes(detail) ? `${label}: ${detail}` : label;
  return truncateForSpeech(text, WANTS_MAX_CHARS);
}

export function formatAgo(fromIso: string | null, now: number): string {
  const from = fromIso ? Date.parse(fromIso) : Number.NaN;
  if (Number.isNaN(from)) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.round((now - from) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function attentionTime(agent: VoiceAgentView): number {
  const parsed = Date.parse(agent.attentionTimestamp ?? agent.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function agentLabel(agent: VoiceAgentView): string {
  return agent.title?.trim() || `agent ${agent.id.slice(0, 7)}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function buildSummarySentence(counts: {
  permissions: number;
  errors: number;
  finished: number;
  running: number;
}): string {
  const parts: string[] = [];
  if (counts.permissions > 0) {
    parts.push(`${plural(counts.permissions, "permission request")} waiting`);
  }
  if (counts.errors > 0) {
    parts.push(`${plural(counts.errors, "agent")} errored`);
  }
  if (counts.finished > 0) {
    parts.push(`${plural(counts.finished, "agent")} finished with unread output`);
  }
  const running = `${plural(counts.running, "agent")} running`;
  if (parts.length === 0) {
    return `Nothing needs you. ${running}.`;
  }
  return `${parts.join(", ")}. ${running}.`;
}

/**
 * Ordered by urgency: blocked agents first (longest-blocked first), then errors,
 * then finished work (newest first). Finished and errored agents outside the
 * window are counted, not listed; the attention flag on old agents is often stale.
 */
export function buildWhatsWaiting(input: {
  agents: VoiceAgentView[];
  lastMessages: ReadonlyMap<string, string | null>;
  now: number;
  windowHours?: number;
  maxPerSection?: number;
}): WhatsWaitingSummary {
  const { agents, lastMessages, now } = input;
  const windowStart = now - (input.windowHours ?? DEFAULT_WINDOW_HOURS) * 60 * 60 * 1000;
  const maxPerSection = input.maxPerSection ?? MAX_ITEMS_PER_SECTION;

  const blocked = agents
    .filter((agent) => agent.pendingPermissions.length > 0)
    .sort((a, b) => attentionTime(a) - attentionTime(b));
  const permissions = blocked.flatMap((agent) =>
    agent.pendingPermissions.map((permission) => ({
      agentId: agent.id,
      agent: agentLabel(agent),
      project: agent.project,
      wants: describePermission(permission),
      requestId: permission.id,
      ...(permission.actions && permission.actions.length > 0
        ? { options: permission.actions.map((action) => action.label) }
        : {}),
    })),
  );

  const blockedIds = new Set(blocked.map((agent) => agent.id));
  const newestFirst = (a: VoiceAgentView, b: VoiceAgentView) => attentionTime(b) - attentionTime(a);
  const errored = agents
    .filter(
      (agent) =>
        !blockedIds.has(agent.id) &&
        (agent.status === "error" ||
          (agent.requiresAttention && agent.attentionReason === "error")),
    )
    .sort(newestFirst);
  const unread = agents
    .filter(
      (agent) =>
        !blockedIds.has(agent.id) &&
        agent.status !== "error" &&
        agent.status !== "running" &&
        agent.requiresAttention &&
        agent.attentionReason === "finished",
    )
    .sort(newestFirst);

  const recentErrors = errored.filter((agent) => attentionTime(agent) >= windowStart);
  const recentUnread = unread.filter((agent) => attentionTime(agent) >= windowStart);
  const olderUnread = unread.length - recentUnread.length;

  const errors = recentErrors.slice(0, maxPerSection).map((agent) => ({
    agentId: agent.id,
    agent: agentLabel(agent),
    project: agent.project,
    ago: formatAgo(agent.attentionTimestamp ?? agent.updatedAt, now),
    error: truncateForSpeech(agent.lastError ?? "unknown error", ERROR_MAX_CHARS),
  }));
  const finished = recentUnread.slice(0, maxPerSection).map((agent) => {
    const message = lastMessages.get(agent.id);
    return {
      agentId: agent.id,
      agent: agentLabel(agent),
      project: agent.project,
      ago: formatAgo(agent.attentionTimestamp ?? agent.updatedAt, now),
      gist: message ? gistOfMessage(message) : null,
    };
  });

  const notListed = {
    ...(permissions.length > maxPerSection
      ? { permissions: permissions.length - maxPerSection }
      : {}),
    ...(recentErrors.length > errors.length ? { errors: recentErrors.length - errors.length } : {}),
    ...(recentUnread.length > finished.length
      ? { finished: recentUnread.length - finished.length }
      : {}),
    ...(olderUnread > 0 ? { olderUnread } : {}),
  };
  const running = agents.filter((agent) => agent.status === "running").length;

  return {
    summary: buildSummarySentence({
      permissions: permissions.length,
      errors: recentErrors.length,
      finished: recentUnread.length,
      running,
    }),
    permissions: permissions.slice(0, maxPerSection),
    errors,
    finished,
    running,
    ...(Object.keys(notListed).length > 0 ? { notListed } : {}),
  };
}

export interface AgentMatchCandidate {
  agentId: string;
  agent: string;
  project: string;
  status: string;
  lastActive: string;
}

export type AgentMatchResult =
  | { kind: "unique"; agent: VoiceAgentView }
  | { kind: "ambiguous"; candidates: VoiceAgentView[]; total: number }
  | { kind: "none"; suggestions: VoiceAgentView[] };

// Words a speaker adds around the part that identifies the agent.
const QUERY_STOPWORDS = new Set([
  "a",
  "about",
  "agent",
  "agents",
  "an",
  "and",
  "for",
  "in",
  "is",
  "my",
  "of",
  "on",
  "one",
  "session",
  "that",
  "the",
  "thing",
  "this",
  "to",
  "with",
  "working",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function queryTokens(query: string): string[] {
  const tokens = words(query).filter((word) => !QUERY_STOPWORDS.has(word));
  return tokens.length > 0 ? tokens : words(query);
}

function tokenMatches(token: string, haystack: string[]): boolean {
  const stem = token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
  return haystack.some(
    (word) => word.startsWith(stem) || (stem.length >= 4 && word.includes(stem)),
  );
}

function scoreAgent(tokens: string[], phrase: string, agent: VoiceAgentView): number {
  const titleWords = words(agent.title ?? "");
  const haystack = [...titleWords, ...words(agent.project)];
  const matched = tokens.filter((token) => tokenMatches(token, haystack)).length;
  if (matched === 0) {
    return 0;
  }
  // A query that reads as a run of the title beats one whose words are scattered
  // across title and project.
  const phraseBonus = phrase.length > 0 && titleWords.join(" ").includes(phrase) ? 0.5 : 0;
  return matched / tokens.length + phraseBonus;
}

function lastActiveTime(agent: VoiceAgentView): number {
  const parsed = Date.parse(agent.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Resolves a spoken reference ("the billing agent", "usage dashboard") or an id
 * to one agent. Only a sole best match that covers every query word counts as
 * unique; anything else returns candidates so the caller can ask.
 */
export function matchAgent(query: string, agents: VoiceAgentView[]): AgentMatchResult {
  const trimmed = query.trim();
  const byId = agents.find((agent) => agent.id === trimmed);
  if (byId) {
    return { kind: "unique", agent: byId };
  }
  if (/^[0-9a-f-]{6,}$/i.test(trimmed)) {
    const byPrefix = agents.filter((agent) => agent.id.startsWith(trimmed.toLowerCase()));
    if (byPrefix.length === 1) {
      return { kind: "unique", agent: byPrefix[0] };
    }
  }

  const tokens = queryTokens(trimmed);
  const phrase = tokens.join(" ");
  const scored = agents
    .map((agent) => ({ agent, score: scoreAgent(tokens, phrase, agent) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || lastActiveTime(b.agent) - lastActiveTime(a.agent));

  const complete = scored.filter((entry) => entry.score >= 1);
  if (complete.length === 0) {
    return { kind: "none", suggestions: scored.slice(0, MAX_CANDIDATES).map((e) => e.agent) };
  }
  const best = complete[0].score;
  const tied = complete.filter((entry) => entry.score === best);
  if (tied.length === 1) {
    return { kind: "unique", agent: tied[0].agent };
  }
  return {
    kind: "ambiguous",
    candidates: tied.slice(0, MAX_CANDIDATES).map((entry) => entry.agent),
    total: tied.length,
  };
}

export function toMatchCandidate(agent: VoiceAgentView, now: number): AgentMatchCandidate {
  return {
    agentId: agent.id,
    agent: agentLabel(agent),
    project: agent.project,
    status: agent.status,
    lastActive: formatAgo(agent.updatedAt, now),
  };
}

type RegisterTool = (
  name: string,
  config: PaseoToolConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
  handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
) => void;

export interface RegisterVoiceAssistantToolsOptions {
  registerTool: RegisterTool;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: ProviderSnapshotManager;
  workspaceRegistry?: Pick<WorkspaceRegistry, "get">;
  projectRegistry?: Pick<ProjectRegistry, "get">;
  logger: Logger;
}

function textResult(data: unknown): PaseoToolResult {
  // Compact JSON in text only: voice callers pay for every token they read, and a
  // structuredContent copy would double it.
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function registerVoiceAssistantTools(options: RegisterVoiceAssistantToolsOptions): void {
  const { registerTool, agentManager, agentStorage, providerSnapshotManager, logger } = options;

  async function resolveProjectName(payload: AgentSnapshotPayload): Promise<string> {
    if (payload.workspaceId && options.workspaceRegistry && options.projectRegistry) {
      const workspace = await options.workspaceRegistry.get(payload.workspaceId);
      const project = workspace ? await options.projectRegistry.get(workspace.projectId) : null;
      if (project) {
        return project.customName ?? project.displayName;
      }
    }
    return basename(payload.cwd);
  }

  async function toView(payload: AgentSnapshotPayload): Promise<VoiceAgentView> {
    return {
      id: payload.id,
      title: payload.title,
      project: await resolveProjectName(payload),
      status: payload.status,
      requiresAttention: payload.requiresAttention ?? false,
      attentionReason: payload.attentionReason ?? null,
      attentionTimestamp: payload.attentionTimestamp ?? null,
      updatedAt: payload.updatedAt,
      lastError: payload.lastError ?? null,
      pendingPermissions: payload.pendingPermissions.map((permission) => ({
        id: permission.id,
        kind: permission.kind,
        name: permission.name,
        title: permission.title,
        description: permission.description,
        input: permission.input,
        actions: permission.actions?.map((action) => ({ id: action.id, label: action.label })),
      })),
    };
  }

  // Same population as list_agents: loaded agents plus stored ones, without
  // internal or archived agents.
  async function collectAgentViews(): Promise<VoiceAgentView[]> {
    const liveSnapshots = agentManager.listAgents();
    const livePayloads = await Promise.all(
      liveSnapshots.map((snapshot) =>
        serializeSnapshotWithMetadata(agentStorage, snapshot, logger),
      ),
    );
    const liveIds = new Set(liveSnapshots.map((snapshot) => snapshot.id));
    const registeredProviderIds = new Set(providerSnapshotManager.listRegisteredProviderIds());
    const records = await agentStorage.list();
    const internalIds = new Set(
      records.filter((record) => record.internal).map((record) => record.id),
    );
    const storedPayloads = records
      .filter((record) => !record.internal && !liveIds.has(record.id) && !record.archivedAt)
      .filter((record) => isStoredAgentProviderAvailable(record, registeredProviderIds))
      .map((record) => buildStoredAgentPayload(record, registeredProviderIds));
    const payloads = [...livePayloads, ...storedPayloads].filter(
      (payload) => !payload.archivedAt && !internalIds.has(payload.id),
    );
    return Promise.all(payloads.map(toView));
  }

  registerTool(
    "whats_waiting",
    {
      title: "What's waiting for me",
      description: [
        "One-call briefing of everything that needs the user across all Paseo agents, ordered by urgency:",
        "pending permission requests (with agentId and requestId to answer them via respond_to_permission),",
        "errored agents, agents that finished with unread output (with a one or two sentence gist of their final message),",
        "and how many agents are running.",
        "Use this FIRST whenever the user asks what's going on, what needs them, what finished, or for a status update,",
        "instead of combining list_agents, list_pending_permissions, get_agent_status and get_agent_activity.",
        "The response is short and written to be read aloud. A null gist means the agent is asleep;",
        "call get_agent_activity only if the user asks for more detail on one agent.",
      ].join(" "),
      inputSchema: {
        sinceHours: z
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .optional()
          .describe(
            `Only list finished or errored agents from the last N hours (default ${DEFAULT_WINDOW_HOURS}). Older ones are only counted.`,
          ),
      },
    },
    async ({ sinceHours }: { sinceHours?: number }) => {
      const agents = await collectAgentViews();
      const lastMessages = new Map<string, string | null>();
      await Promise.all(
        agents
          .filter((agent) => agent.requiresAttention && agent.attentionReason === "finished")
          .map(async (agent) => {
            // Null for agents that aren't loaded; loading one would start its process.
            lastMessages.set(agent.id, await agentManager.getLastAssistantMessage(agent.id));
          }),
      );
      return textResult(
        buildWhatsWaiting({ agents, lastMessages, now: Date.now(), windowHours: sinceHours }),
      );
    },
  );

  registerTool(
    "message_agent",
    {
      title: "Message an agent",
      description: [
        "Send a message to an existing agent, named by id or by how the user refers to it",
        '("the billing agent", "usage dashboard", "the daily brief one"); matched against agent titles and project names.',
        "Returns as soon as the message is delivered, without waiting for the agent's reply.",
        "If the agent is mid-task, the message is steered into its current turn.",
        "Use this instead of list_agents plus send_agent_prompt when the user says to tell, ask or reply to an agent.",
        "If the reference is ambiguous or matches nothing, nothing is sent and the response lists candidates: ask the user which one, then call again with that agentId.",
        "Does not create agents.",
      ].join(" "),
      inputSchema: {
        agent: z
          .string()
          .trim()
          .min(1, "agent is required")
          .describe("Agent id (or id prefix), or the user's words for it: title or project."),
        message: z.string().trim().min(1, "message is required").describe("The message to send."),
      },
    },
    async ({ agent: reference, message }: { agent: string; message: string }) => {
      const now = Date.now();
      const agents = await collectAgentViews();
      let match = matchAgent(reference, agents);
      if (match.kind !== "unique") {
        // An exact id may name an archived agent; sending to it unarchives it, as
        // send_agent_prompt does.
        const record = await agentStorage.get(reference.trim());
        if (record && !record.internal) {
          const registeredProviderIds = new Set(
            providerSnapshotManager.listRegisteredProviderIds(),
          );
          match = {
            kind: "unique",
            agent: await toView(buildStoredAgentPayload(record, registeredProviderIds)),
          };
        }
      }

      if (match.kind === "ambiguous") {
        return textResult({
          sent: false,
          reason: `"${reference}" matches ${plural(match.total, "agent")}. Ask the user which one, then call again with its agentId.`,
          candidates: match.candidates.map((agent) => toMatchCandidate(agent, now)),
        });
      }
      if (match.kind === "none") {
        return textResult({
          sent: false,
          reason: `No agent matches "${reference}".`,
          ...(match.suggestions.length > 0
            ? { closest: match.suggestions.map((agent) => toMatchCandidate(agent, now)) }
            : {}),
        });
      }

      const target = match.agent;
      const delivery = sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: target.id,
        prompt: message,
        activeTurnBehavior: "steer",
        logger,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        delivery.then(({ disposition }) => disposition),
        new Promise<"pending">((resolve) => {
          timer = setTimeout(() => resolve("pending"), SEND_ACK_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (outcome === "pending") {
        delivery.catch((error: unknown) => {
          logger.error({ err: error, agentId: target.id }, "message_agent delivery failed");
        });
      }

      const name = agentLabel(target);
      const ack: Record<string, string> = {
        pending: `Waking up "${name}"; the message will reach it in a few seconds.`,
        steered: `Added to what "${name}" is working on now.`,
        turn_started: `Sent to "${name}". It's working on it.`,
        out_of_band: `Sent to "${name}" as a command.`,
      };
      return textResult({
        sent: true,
        agentId: target.id,
        agent: name,
        project: target.project,
        ack: ack[outcome],
      });
    },
  );
}

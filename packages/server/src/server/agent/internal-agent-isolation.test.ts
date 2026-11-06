import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { generateStructuredAgentResponseWithFallback } from "./agent-response-loop.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPermissionResponse,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import type { PaseoToolCatalog } from "./tools/types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsNativePaseoTools: true,
} as const;

const EMPTY_CATALOG: PaseoToolCatalog = {
  tools: new Map(),
  getTool: () => undefined,
  executeTool: async () => {
    throw new Error("not used");
  },
};

type TurnScript = (session: ScriptedSession, turnId: string) => void;

class ScriptedSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  readonly permissionResponses: AgentPermissionResponse[] = [];
  closed = false;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(private readonly script: TurnScript) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    const turnId = randomUUID();
    setTimeout(() => this.script(this, turnId), 0);
    return { turnId };
  }

  push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(_requestId: string, response: AgentPermissionResponse) {
    this.permissionResponses.push(response);
  }
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

class RecordingClient implements AgentClient {
  readonly provider = "codex" as const;
  capabilities: AgentClient["capabilities"] = CAPABILITIES;
  readonly launches: Array<{ config: AgentSessionConfig; context?: AgentLaunchContext }> = [];
  readonly sessions: ScriptedSession[] = [];

  constructor(private readonly script: TurnScript) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async createSession(
    config: AgentSessionConfig,
    context?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.launches.push({ config, context });
    const session = new ScriptedSession(this.script);
    this.sessions.push(session);
    return session;
  }
  async resumeSession(): Promise<AgentSession> {
    throw new Error("not used");
  }
}

function replyWith(text: string): TurnScript {
  return (session, turnId) => {
    session.push({ type: "turn_started", provider: "codex", turnId });
    session.push({
      type: "timeline",
      provider: "codex",
      turnId,
      item: { type: "assistant_message", text },
    });
    session.push({ type: "turn_completed", provider: "codex", turnId });
  };
}

function createManager(client: RecordingClient): AgentManager {
  return new AgentManager({
    clients: { codex: client },
    logger: createTestLogger(),
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    paseoToolsEnabled: true,
    paseoToolCatalogFactory: () => EMPTY_CATALOG,
  });
}

async function generate(manager: AgentManager) {
  return generateStructuredAgentResponseWithFallback({
    manager,
    cwd: process.cwd(),
    prompt: "Name this branch",
    schema: z.object({ branch: z.string() }),
    providers: [{ provider: "codex" }],
    maxRetries: 0,
    persistSession: false,
    agentConfigOverrides: { title: "Branch name generator", internal: true },
  });
}

describe("internal generator agents", () => {
  test.each([
    { tools: "native Paseo tools", supportsNativePaseoTools: true },
    { tools: "the Paseo MCP server", supportsNativePaseoTools: false },
  ])("launch without $tools or any MCP server", async ({ supportsNativePaseoTools }) => {
    const client = new RecordingClient(replyWith('{"branch":"fix/login"}'));
    client.capabilities = { ...CAPABILITIES, supportsNativePaseoTools };
    const manager = createManager(client);

    // Control: the same manager gives a normal agent Paseo tools.
    await manager.createAgent({ provider: "codex", cwd: process.cwd() }, undefined, {
      workspaceId: undefined,
    });
    const normal = client.launches[0];
    expect({
      nativeTools: normal.context?.paseoTools === EMPTY_CATALOG,
      mcpServers: Object.keys(normal.config.mcpServers ?? {}),
    }).toEqual({
      nativeTools: supportsNativePaseoTools,
      mcpServers: supportsNativePaseoTools ? [] : ["paseo"],
    });

    await expect(generate(manager)).resolves.toEqual({ branch: "fix/login" });

    const internal = client.launches[1];
    expect(internal.config.internal).toBe(true);
    expect(internal.config.mcpServers).toBe(undefined);
    expect(internal.context?.paseoTools).toBe(undefined);
  });

  test("deny a permission request and close instead of waiting for an answer", async () => {
    const client = new RecordingClient((session, turnId) => {
      session.push({ type: "turn_started", provider: "codex", turnId });
      session.push({
        type: "permission_requested",
        provider: "codex",
        turnId,
        request: { id: "perm-1", provider: "codex", kind: "tool", name: "Bash" },
      });
    });
    const manager = createManager(client);

    await expect(generate(manager)).rejects.toThrow();

    const session = client.sessions[0];
    expect(session.permissionResponses.map((response) => response.behavior)).toEqual(["deny"]);
    expect(session.closed).toBe(true);
  });
});

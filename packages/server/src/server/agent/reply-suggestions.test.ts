import { describe, expect, test } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  ReplySuggestionService,
  buildReplySuggestionPrompt,
  type ReplySuggestionServiceOptions,
} from "./reply-suggestions.js";

type FakeAgentManager = ReplySuggestionServiceOptions["agentManager"];

class FakeAgent {
  lifecycle: "idle" | "running" = "idle";
  items: AgentTimelineItem[] = [];

  finishTurn(user: string, reply: string): void {
    this.items.push({ type: "user_message", text: user });
    this.items.push({ type: "assistant_message", text: reply });
    this.lifecycle = "idle";
  }

  startTurn(user: string): void {
    this.items.push({ type: "user_message", text: user });
    this.lifecycle = "running";
  }

  manager(): FakeAgentManager {
    return {
      getAgent: () =>
        ({
          id: "agent-1",
          cwd: "/repo",
          lifecycle: this.lifecycle,
          internal: false,
          pendingPermissions: new Map(),
        }) as unknown as ReturnType<FakeAgentManager["getAgent"]>,
      fetchTimeline: () =>
        ({
          epoch: "epoch-1",
          endSeq: this.items.length === 0 ? null : this.items.length,
          rows: this.items.map((item, index) => ({ seq: index + 1, item })),
        }) as unknown as ReturnType<FakeAgentManager["fetchTimeline"]>,
    };
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const silentLogger = { warn: () => undefined };

describe("ReplySuggestionService", () => {
  test("generates once per finished turn, however many clients ask", async () => {
    const agent = new FakeAgent();
    agent.finishTurn("Set up the node", "I've stopped for admin approval of the node.");
    const prompts: string[] = [];
    const service = new ReplySuggestionService({
      agentManager: agent.manager(),
      isEnabled: () => true,
      generate: async ({ prompt }) => {
        prompts.push(prompt);
        return "The node has been approved. Continue with the setup.";
      },
      logger: silentLogger,
    });

    const [first, second] = await Promise.all([service.get("agent-1"), service.get("agent-1")]);
    const reopened = await service.get("agent-1");

    expect(prompts).toHaveLength(1);
    expect(first.suggestion).toBe("The node has been approved. Continue with the setup.");
    expect(second).toEqual(first);
    expect(reopened).toEqual(first);
  });

  test("a non-message row appended while idle does not pay for the same turn again", async () => {
    const agent = new FakeAgent();
    agent.finishTurn("Set up the node", "I've stopped for admin approval of the node.");
    let calls = 0;
    const service = new ReplySuggestionService({
      agentManager: agent.manager(),
      isEnabled: () => true,
      generate: async () => {
        calls += 1;
        return "Approved, continue.";
      },
      logger: silentLogger,
    });

    await service.get("agent-1");
    // e.g. a plugin appends a timeline item to the idle agent
    agent.items.push({ type: "todo", items: [] });
    const afterAppend = await service.get("agent-1");

    expect(calls).toBe(1);
    expect(afterAppend).toEqual({ turnKey: "epoch-1:3", suggestion: "Approved, continue." });
  });

  test("drops a suggestion that finishes after a new turn has started", async () => {
    const agent = new FakeAgent();
    agent.finishTurn("Set up the node", "I've stopped for admin approval of the node.");
    const pending = deferred<string>();
    const service = new ReplySuggestionService({
      agentManager: agent.manager(),
      isEnabled: () => true,
      generate: () => pending.promise,
      logger: silentLogger,
    });

    const request = service.get("agent-1");
    agent.startTurn("Actually, use the staging cluster instead");
    pending.resolve("The node has been approved. Continue with the setup.");

    expect(await request).toEqual({ turnKey: null, suggestion: null });
  });

  test("does not reuse the previous turn's suggestion after the next turn finishes", async () => {
    const agent = new FakeAgent();
    agent.finishTurn("Set up the node", "I've stopped for admin approval of the node.");
    const replies = ["Approved, continue.", "Run the checks again."];
    const service = new ReplySuggestionService({
      agentManager: agent.manager(),
      isEnabled: () => true,
      generate: async () => replies.shift() ?? "unexpected third call",
      logger: silentLogger,
    });

    await service.get("agent-1");
    agent.finishTurn("Approved, continue.", "Setup done, but two checks failed.");
    const next = await service.get("agent-1");

    expect(next.suggestion).toBe("Run the checks again.");
  });

  test("caches a failed generation instead of retrying on every request", async () => {
    const agent = new FakeAgent();
    agent.finishTurn("Set up the node", "I've stopped for admin approval of the node.");
    let calls = 0;
    const service = new ReplySuggestionService({
      agentManager: agent.manager(),
      isEnabled: () => true,
      generate: async () => {
        calls += 1;
        throw new Error("provider unavailable");
      },
      logger: silentLogger,
    });

    const first = await service.get("agent-1");
    await service.get("agent-1");

    expect(first.suggestion).toBe(null);
    expect(calls).toBe(1);
  });

  test("makes no call while the agent is running or when the setting is off", async () => {
    const agent = new FakeAgent();
    agent.finishTurn("Set up the node", "I've stopped for admin approval of the node.");
    let enabled = false;
    let calls = 0;
    const service = new ReplySuggestionService({
      agentManager: agent.manager(),
      isEnabled: () => enabled,
      generate: async () => {
        calls += 1;
        return "Approved, continue.";
      },
      logger: silentLogger,
    });

    await service.get("agent-1");
    enabled = true;
    agent.startTurn("Keep going");
    const whileRunning = await service.get("agent-1");

    expect(whileRunning).toEqual({ turnKey: null, suggestion: null });
    expect(calls).toBe(0);
  });
});

describe("buildReplySuggestionPrompt", () => {
  test("has nothing to answer when the turn ended in an error", () => {
    expect(
      buildReplySuggestionPrompt([
        { type: "user_message", text: "Deploy it" },
        { type: "assistant_message", text: "Deploying now." },
        { type: "error", message: "Provider crashed" },
      ]),
    ).toBe(null);
  });

  test("keeps the end of a long final reply, where the question to the user is", () => {
    const longReply = `${"Log line. ".repeat(1000)}Should I merge the PR now?`;
    const prompt = buildReplySuggestionPrompt([
      { type: "user_message", text: "Fix the build" },
      { type: "assistant_message", text: longReply },
    ]);

    expect(prompt).toContain("Should I merge the PR now?");
    expect(prompt).not.toContain(longReply);
  });
});

import { describe, expect, it } from "vitest";

import {
  buildWhatsWaiting,
  gistOfMessage,
  matchAgent,
  type VoiceAgentView,
} from "./voice-assistant-tools.js";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

function agent(overrides: Partial<VoiceAgentView> & { id: string }): VoiceAgentView {
  return {
    title: null,
    project: "paseo",
    status: "idle",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    updatedAt: "2026-10-18T11:00:00.000Z",
    lastError: null,
    pendingPermissions: [],
    ...overrides,
  };
}

describe("matchAgent", () => {
  const agents = [
    agent({ id: "a1", title: "Fix billing webhook retries", project: "everpaid" }),
    agent({ id: "a2", title: "At-a-glance provider overview", project: "usage-dashboard" }),
    agent({
      id: "a3",
      title: "Daily brief 17 Oct",
      project: "Commander",
      updatedAt: "2026-10-17T08:00:00.000Z",
    }),
    agent({
      id: "a4",
      title: "Daily brief 18 Oct",
      project: "Commander",
      updatedAt: "2026-10-18T08:00:00.000Z",
    }),
    agent({ id: "4f0c2a9e-1111-2222-3333-444444444444", title: "Release notes", project: "paseo" }),
  ];

  it("resolves a spoken reference that only one agent's title fits", () => {
    const result = matchAgent("the billing agent", agents);
    expect(result).toEqual({ kind: "unique", agent: agents[0] });
  });

  it("matches on the project name when the title doesn't mention it", () => {
    const result = matchAgent("usage dashboard", agents);
    expect(result).toEqual({ kind: "unique", agent: agents[1] });
  });

  it("returns every equally good match, newest first, instead of picking one", () => {
    const result = matchAgent("the daily brief one", agents);
    expect(result).toEqual({ kind: "ambiguous", candidates: [agents[3], agents[2]], total: 2 });
  });

  it("does not treat a partial match as a target", () => {
    const result = matchAgent("billing dashboard", agents);
    expect(result.kind).toBe("none");
  });

  it("prefers the agent whose title contains the words in order", () => {
    const pool = [
      agent({ id: "b1", title: "Webhook billing audit", project: "everpaid" }),
      agent({ id: "b2", title: "Billing webhook fix", project: "everpaid" }),
    ];
    expect(matchAgent("billing webhook", pool)).toEqual({ kind: "unique", agent: pool[1] });
  });

  it("accepts an id prefix", () => {
    expect(matchAgent("4f0c2a9e", agents)).toEqual({ kind: "unique", agent: agents[4] });
  });
});

describe("buildWhatsWaiting", () => {
  it("orders permissions, then errors, then finished work newest first", () => {
    const result = buildWhatsWaiting({
      now: NOW,
      lastMessages: new Map([
        ["done-old", "Old result."],
        ["done-new", "New result."],
      ]),
      agents: [
        agent({
          id: "done-old",
          title: "Old task",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: "2026-10-18T09:00:00.000Z",
        }),
        agent({
          id: "broken",
          title: "Broken task",
          status: "error",
          requiresAttention: true,
          attentionReason: "error",
          attentionTimestamp: "2026-10-18T11:30:00.000Z",
          lastError: "Provider exited with code 1",
        }),
        agent({
          id: "done-new",
          title: "New task",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: "2026-10-18T11:50:00.000Z",
        }),
        agent({
          id: "blocked",
          title: "Deploy",
          project: "infra",
          status: "running",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: "2026-10-18T11:55:00.000Z",
          pendingPermissions: [
            {
              id: "perm-1",
              kind: "tool",
              name: "Bash",
              title: "Run command",
              input: { command: "npm run deploy" },
              actions: [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
        agent({ id: "busy", title: "Busy", status: "running" }),
      ],
    });

    expect(result).toEqual({
      summary:
        "1 permission request waiting, 1 agent errored, 2 agents finished with unread output. 2 agents running.",
      permissions: [
        {
          agentId: "blocked",
          agent: "Deploy",
          project: "infra",
          wants: "Run command: npm run deploy",
          requestId: "perm-1",
          options: ["Allow", "Deny"],
        },
      ],
      errors: [
        {
          agentId: "broken",
          agent: "Broken task",
          project: "paseo",
          ago: "30m ago",
          error: "Provider exited with code 1",
        },
      ],
      finished: [
        {
          agentId: "done-new",
          agent: "New task",
          project: "paseo",
          ago: "10m ago",
          gist: "New result.",
        },
        {
          agentId: "done-old",
          agent: "Old task",
          project: "paseo",
          ago: "3h ago",
          gist: "Old result.",
        },
      ],
      running: 2,
    });
  });

  it("counts stale and overflowing unread agents instead of listing them", () => {
    const finishedAt = (hour: string) =>
      agent({
        id: `done-${hour}`,
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: `2026-10-${hour}:00:00.000Z`,
      });
    const result = buildWhatsWaiting({
      now: NOW,
      lastMessages: new Map(),
      maxPerSection: 2,
      agents: [
        finishedAt("18T11"),
        finishedAt("18T10"),
        finishedAt("18T09"),
        // Outside the default 24h window.
        finishedAt("16T09"),
        // A running agent's old "finished" flag is not unread output.
        agent({
          id: "running-again",
          status: "running",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: "2026-10-18T11:59:00.000Z",
        }),
      ],
    });

    expect(result.finished.map((item) => item.agentId)).toEqual(["done-18T11", "done-18T10"]);
    expect(result.notListed).toEqual({ finished: 1, olderUnread: 1 });
    expect(result.summary).toBe("3 agents finished with unread output. 1 agent running.");
  });

  it("says nothing needs the owner when nothing does", () => {
    const result = buildWhatsWaiting({
      now: NOW,
      lastMessages: new Map(),
      agents: [agent({ id: "idle" })],
    });
    expect(result.summary).toBe("Nothing needs you. 0 agents running.");
  });
});

describe("gistOfMessage", () => {
  it("keeps the first two sentences as plain text", () => {
    const message = [
      "## Done",
      "",
      "I **fixed** the [retry bug](https://example.invalid/pr/1) in `webhook.ts`. Tests pass.",
      "",
      "- Detail one that should not be read out.",
    ].join("\n");
    expect(gistOfMessage(message)).toBe("I fixed the retry bug in webhook.ts. Tests pass.");
  });

  it("cuts a long sentence at a word boundary and marks the cut", () => {
    const message =
      "The migration rewrote every invoice row and recalculated the totals for each customer account";
    expect(gistOfMessage(message, 40)).toBe("The migration rewrote every invoice row…");
  });

  it("replaces code blocks with a marker", () => {
    expect(gistOfMessage("Run this:\n```sh\nrm -rf build\n```\nthen retry.")).toBe(
      "Run this: (code) then retry.",
    );
  });
});

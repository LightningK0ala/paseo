import { describe, expect, test } from "vitest";
import {
  buildReplySuggestionTurnKey,
  resolveVisibleReplySuggestion,
  shouldAcceptReplySuggestionOnKey,
} from "./reply-suggestion";

const TAB = { key: "Tab", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
const SUGGESTION = "The node has been approved. Continue with the setup.";

describe("shouldAcceptReplySuggestionOnKey", () => {
  test("Tab in an empty composer takes the suggestion", () => {
    expect(shouldAcceptReplySuggestionOnKey(TAB, "", SUGGESTION)).toBe(true);
  });

  test("Tab never replaces text the user already typed, even whitespace", () => {
    expect(shouldAcceptReplySuggestionOnKey(TAB, "Wait, ", SUGGESTION)).toBe(false);
    expect(shouldAcceptReplySuggestionOnKey(TAB, " ", SUGGESTION)).toBe(false);
  });

  test("Shift+Tab keeps its own meaning", () => {
    expect(shouldAcceptReplySuggestionOnKey({ ...TAB, shiftKey: true }, "", SUGGESTION)).toBe(
      false,
    );
  });
});

describe("resolveVisibleReplySuggestion", () => {
  const firstTurn = buildReplySuggestionTurnKey(new Date("2026-11-06T10:00:00Z"));
  const secondTurn = buildReplySuggestionTurnKey(new Date("2026-11-06T10:05:00Z"));
  const entry = { turnKey: firstTurn, state: "ready" as const, suggestion: SUGGESTION };

  test("shows the suggestion for the turn it was made for", () => {
    expect(resolveVisibleReplySuggestion(entry, { status: "idle", turnKey: firstTurn }, true)).toBe(
      SUGGESTION,
    );
  });

  test("a suggestion from the previous turn does not survive into the next one", () => {
    expect(
      resolveVisibleReplySuggestion(entry, { status: "idle", turnKey: secondTurn }, true),
    ).toBe(null);
  });

  test("hides a suggestion already on screen once the setting is turned off", () => {
    expect(
      resolveVisibleReplySuggestion(entry, { status: "idle", turnKey: firstTurn }, false),
    ).toBe(null);
  });

  test("hides the suggestion while the agent is working", () => {
    expect(
      resolveVisibleReplySuggestion(entry, { status: "running", turnKey: firstTurn }, true),
    ).toBe(null);
  });
});

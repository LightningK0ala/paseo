import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { HighlightedCodeBlock } from "./highlighted-code-block";

// The system clipboard is the boundary; expo-clipboard's web build also ships JSX the
// browser test bundler cannot parse.
const setStringAsync = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock("expo-clipboard", () => ({ setStringAsync }));

// Load translations so the button exposes its real accessible name.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  setStringAsync.mockClear();
});

const NO_STYLE = {};

function mountCodeBlock(code: string, language: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <HighlightedCodeBlock
        code={code}
        language={language}
        inheritedStyles={NO_STYLE}
        textStyle={NO_STYLE}
      />,
    ),
  );
  mounted.push({ root, container });
  return within(container);
}

describe("HighlightedCodeBlock copy button", () => {
  // A real pointer click with no hover first, as on a touch screen. A button that only
  // appears on hover is transparent or ignores pointer events here, and this fails.
  it("copies the code without a hover, leaving out the header and trailing blank lines", async () => {
    const view = mountCodeBlock("export TOKEN=abc123\ncurl -s https://example.invalid\n\n", "bash");

    const button = view.getByRole("button", { name: "Copy code" });
    expect(getComputedStyle(button).opacity).toBe("1");
    await userEvent.click(button);

    await vi.waitFor(() =>
      expect(setStringAsync).toHaveBeenCalledWith(
        "export TOKEN=abc123\ncurl -s https://example.invalid",
      ),
    );
  });
});

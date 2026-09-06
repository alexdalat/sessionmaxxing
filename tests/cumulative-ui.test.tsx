// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { aggregate } from "../server/analytics.js";
import type { ActivityEvent } from "../shared/types.js";
import { App } from "../src/App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const event = (timestamp: string): ActivityEvent => ({
  timestamp,
  project: "demo",
  model: "claude-opus-5",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

it("charts a running total of Claude active minutes over the selected range with no table fallback", async () => {
  const analytics = aggregate(
    {
      events: [
        event("2026-09-04T12:00:00Z"),
        event("2026-09-05T12:00:00Z"),
        event("2026-09-05T12:00:30Z"),
        event("2026-09-05T12:01:00Z"),
      ],
      health: { files: 1, lines: 4, warnings: 0, historyEntries: 0 },
    },
    7,
    new Date("2026-09-06T12:00:00Z"),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url === "/api/queue" ? { tasks: [], autoDispatch: false } : analytics,
    })),
  );
  render(<App />);
  const figure = await screen.findByRole("figure", {
    name: "Cumulative Claude activity over the last 7 days",
  });
  expect(within(figure).queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByText(/view .* as a table/i)).not.toBeInTheDocument();
  expect(
    within(figure).getByRole("heading", { name: "Cumulative active minutes" }),
  ).toBeInTheDocument();
  expect(
    within(figure).getByText("Running total since 2026-08-31"),
  ).toBeInTheDocument();
});

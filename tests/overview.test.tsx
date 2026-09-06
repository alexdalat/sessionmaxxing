// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { aggregate } from "../server/analytics.js";
import { planDispatch, taskGate } from "../server/dispatch.js";
import { sessionWindows } from "../server/usage-history.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchSettings,
  type PublicTask,
  type UsageReport,
  type UsageSample,
  type UsageState,
} from "../shared/types.js";
import { App } from "../src/App";
import { usageSnapshot } from "./helpers";

const now = new Date("2026-09-06T12:00:00Z");
const analytics = () =>
  aggregate(
    {
      events: [],
      health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
    },
    30,
    now,
    usageSnapshot(),
  );
const samples: UsageSample[] = [
  {
    at: "2026-09-05T03:00:00.000Z",
    session: 55,
    sessionResetsAt: "2026-09-05T06:00:00.000Z",
    weekly: 1,
    weeklyResetsAt: "2026-09-13T07:53:00.000Z",
    fable: 0,
  },
  {
    at: "2026-09-06T12:00:00.000Z",
    session: 16,
    sessionResetsAt: "2026-09-06T16:09:00.000Z",
    weekly: 2,
    weeklyResetsAt: "2026-09-13T07:53:00.000Z",
    fable: 4,
  },
];
const task = (patch: Partial<PublicTask>): PublicTask => ({
  id: "a".repeat(24),
  title: "PRIVATE TASK TITLE",
  provider: "claude",
  model: "opus",
  priority: 0,
  status: "pending",
  createdAt: now.toISOString(),
  earliestStart: null,
  preferredWindowStart: null,
  maxTurns: 10,
  ...patch,
});

function stub({
  usage = { snapshot: usageSnapshot(), error: null },
  tasks = [],
  settings = DEFAULT_DISPATCH_SETTINGS,
}: {
  usage?: UsageState;
  tasks?: PublicTask[];
  settings?: DispatchSettings;
} = {}) {
  const state = { usage, settings, autoDispatch: false, refreshes: 0 };
  const planning = () => planDispatch(state.settings, state.usage, now);
  const report = (): UsageReport => ({
    ...state.usage,
    samples,
    windows: sessionWindows(samples, now),
  });
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (url === "/api/usage/refresh") {
      state.refreshes++;
      return { ok: true, json: async () => report() };
    }
    if (url === "/api/usage") return { ok: true, json: async () => report() };
    if (url === "/api/dispatch-settings") {
      state.settings = body;
      return { ok: true, json: async () => planning() };
    }
    if (url === "/api/queue/auto") {
      state.autoDispatch = body.enabled;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (url === "/api/queue") {
      const plan = planning();
      return {
        ok: true,
        json: async () => ({
          autoDispatch: state.autoDispatch,
          planning: plan,
          tasks: tasks.map((t) => ({ ...t, gate: taskGate(t, plan) })),
        }),
      };
    }
    return { ok: true, json: async () => analytics() };
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, state };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("leads with official Claude Max usage: percentages, reset countdowns, pace and dispatch ceilings", async () => {
  vi.useFakeTimers({ now, shouldAdvanceTime: true });
  try {
    stub();
    render(<App />);
    const panel = await screen.findByRole("region", {
      name: "Claude Max usage",
    });
    await within(panel).findByText("Fetched <1m ago");
    const session = within(panel).getByRole("img", { name: /^Session \(5h\)/ });
    await waitFor(() =>
      expect(session).toHaveAccessibleName(
        /Session \(5h\): 16% used\. resets in 4h 9m\. dispatch ceiling 75%/,
      ),
    );
    expect(
      within(panel).getByRole("img", { name: /^Weekly/ }),
    ).toHaveAccessibleName(
      /Weekly: 2% used\. resets in 6d 19h\. pace 3%\. dispatch ceiling 13%/,
    );
    expect(
      within(panel).getByRole("img", { name: /^Fable weekly/ }),
    ).toHaveAccessibleName(/Fable weekly: 4% used/);
    expect(within(panel).getByText(/under pace/)).toBeInTheDocument();
    expect(screen.queryByText(/view .* as a table/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Advanced activity caps/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Tokens and parse health/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Update official usage/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not official/i)).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("shows the fetch error, keeps the last snapshot, and refreshes on demand", async () => {
  const { state } = stub({
    usage: {
      snapshot: usageSnapshot({ fetchedAt: "2026-09-06T11:30:00.000Z" }),
      error: "Anthropic usage endpoint returned HTTP 503.",
    },
  });
  render(<App />);
  const panel = await screen.findByRole("region", {
    name: "Claude Max usage",
  });
  expect(await within(panel).findByRole("alert")).toHaveTextContent("HTTP 503");
  expect(within(panel).getByText("16%")).toBeInTheDocument();
  await userEvent.click(within(panel).getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(state.refreshes).toBe(1));
});

it("explains why Claude tasks wait, saves dispatch settings, and toggles auto-dispatch", async () => {
  const { state } = stub({
    usage: {
      snapshot: usageSnapshot({
        session: { percent: 90, resetsAt: "2026-09-06T16:09:00.000Z" },
      }),
      error: null,
    },
    tasks: [
      task({ id: "a".repeat(24) }),
      task({ id: "b".repeat(24), provider: "codex", model: "gpt-6-astra" }),
      task({ id: "c".repeat(24), status: "running" }),
    ],
  });
  render(<App />);
  const dispatch = await screen.findByRole("region", { name: "Auto-dispatch" });
  expect(within(dispatch).getByText("Claude waiting")).toBeInTheDocument();
  expect(
    within(dispatch).getByText("Session at 90%, above the 75% ceiling"),
  ).toBeInTheDocument();
  const count = (label: string) =>
    within(dispatch).getByText(label).closest("div") as HTMLElement;
  await waitFor(() =>
    expect(count("Waiting")).toHaveTextContent("Waiting tasks 1"),
  );
  expect(count("Ready")).toHaveTextContent("Ready tasks 1");
  expect(count("Running")).toHaveTextContent("Running tasks 1");
  expect(screen.queryByText(/PRIVATE TASK TITLE/)).not.toBeInTheDocument();
  const user = userEvent.setup();
  const reserve = within(dispatch).getByLabelText(/Session reserve/);
  await user.clear(reserve);
  await user.type(reserve, "5");
  await user.click(
    within(dispatch).getByRole("button", { name: "Save settings" }),
  );
  await within(dispatch).findByText("Dispatch settings saved.");
  expect(state.settings).toEqual({
    sessionReservePercent: 5,
    weeklyMarginPercent: 10,
  });
  await within(dispatch).findByText("Claude ready");
  await user.click(within(dispatch).getByRole("checkbox"));
  await waitFor(() => expect(state.autoDispatch).toBe(true));
  await user.click(
    within(dispatch).getByRole("button", { name: "Go to task queue" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Task queue", level: 1 }),
  ).toBeInTheDocument();
  expect(screen.getAllByText("PRIVATE TASK TITLE").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
  expect(screen.queryByText(/budget/i)).not.toBeInTheDocument();
});

it("charts the recorded five-hour windows and weekly pace from usage samples", async () => {
  stub();
  render(<App />);
  const windows = await screen.findByRole("region", {
    name: "Session windows over the last 7 days",
  });
  await within(windows).findByText(
    "2 windows · avg peak 36% · 94% of the week idle",
  );
  expect(within(windows).getByText(/peak 55%/)).toBeInTheDocument();
  expect(
    screen.getByRole("figure", { name: "Weekly usage against pace" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/Window resets Sep 13/)).toBeInTheDocument();
});

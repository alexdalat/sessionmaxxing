// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { aggregate } from "../server/analytics.js";
import type { TaskInput } from "../shared/types.js";
import { App } from "../src/App";
import { TaskForm } from "../src/TaskForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
const emptyAnalytics = (days: 7 | 14 | 30 | 90) =>
  aggregate(
    {
      events: [],
      health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
    },
    days,
    new Date("2026-09-06T12:00:00Z"),
  );

it("edits a task without receiving or replacing its private saved directory", async () => {
  const save = vi.fn(async (_input: Partial<TaskInput>) => true);
  render(
    <TaskForm
      busy={false}
      onSave={save}
      task={{
        id: "a".repeat(24),
        title: "Existing task",
        provider: "codex",
        model: "gpt-6-astra",
        priority: 0,
        status: "pending",
        createdAt: "2026-09-06T12:00:00Z",
        earliestStart: null,
        preferredWindowStart: null,
        maxTurns: 10,
      }}
    />,
  );
  expect(
    screen.getByLabelText("Replacement work directory (optional)"),
  ).toHaveValue("");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0]).not.toHaveProperty("workdir");
});

it("loads real API aggregates and changing the date range requests and displays that range", async () => {
  const fetcher = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => emptyAnalytics(url.includes("days=7") ? 7 : 30),
  }));
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  expect(await screen.findByText(/No Claude activity/)).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("Date range"), "7");
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/analytics?days=7",
      expect.any(Object),
    ),
  );
  expect(
    await screen.findByRole("heading", { name: "Last 7 days", level: 2 }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Claude Max", level: 1 }),
  ).toBeInTheDocument();
});
it("lists all 24 ranked quiet windows on the planner without estimate caveats", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => emptyAnalytics(30) })),
  );
  render(<App />);
  await screen.findByText(/No Claude activity/);
  await userEvent.click(
    screen.getByRole("button", { name: "Capacity planner" }),
  );
  expect(
    screen.getByRole("heading", { name: "Capacity planner" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/No current five-hour block/)).toBeInTheDocument();
  expect(screen.getAllByRole("row")).toHaveLength(25);
  expect(screen.queryByText(/estimate/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("keeps an omitted earliest-start field as null instead of sending an invalid timestamp", async () => {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith("/api/analytics"))
      return { ok: true, json: async () => emptyAnalytics(30) };
    if (url === "/api/tasks") {
      const { prompt: _prompt, ...safe } = JSON.parse(String(options?.body));
      return {
        ok: true,
        json: async () => ({
          ...safe,
          id: "d".repeat(24),
          status: "pending",
          createdAt: "2026-09-06T12:00:00Z",
        }),
      };
    }
    return { ok: true, json: async () => ({ tasks: [], autoDispatch: false }) };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  await screen.findByText(/No Claude activity/);
  await userEvent.click(screen.getByRole("button", { name: "Task queue" }));
  await userEvent.type(screen.getByLabelText("Title"), "Empty start field");
  await userEvent.type(
    screen.getByLabelText("Prompt"),
    "Keep earliest start empty",
  );
  await userEvent.click(screen.getByRole("button", { name: "Add task" }));
  const call = fetcher.mock.calls.find(([url]) => url === "/api/tasks");
  expect(call).toBeDefined();
  expect(JSON.parse(String(call?.[1]?.body)).earliestStart).toBeNull();
});
it("creates a queued Codex task with its default model and clears the locally entered prompt after saving", async () => {
  let tasks: unknown[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith("/api/analytics"))
      return { ok: true, json: async () => emptyAnalytics(30) };
    if (url === "/api/tasks") {
      const body = JSON.parse(String(options?.body));
      const { prompt: _prompt, ...safe } = body;
      tasks = [
        {
          ...safe,
          id: "a".repeat(24),
          status: "pending",
          createdAt: "2026-09-06T12:00:00Z",
        },
      ];
      return { ok: true, json: async () => tasks[0] };
    }
    return { ok: true, json: async () => ({ tasks, autoDispatch: false }) };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  await screen.findByText(/No Claude activity/);
  await userEvent.click(screen.getByRole("button", { name: "Task queue" }));
  await screen.findByLabelText("Title");
  await userEvent.type(
    screen.getByLabelText("Title"),
    "Fix keyboard navigation",
  );
  await userEvent.type(screen.getByLabelText("Prompt"), "PRIVATE instruction");
  await userEvent.selectOptions(screen.getByLabelText("Provider"), "codex");
  expect(screen.getByLabelText("Model")).toHaveValue("gpt-6-astra");
  await userEvent.click(screen.getByRole("button", { name: "Add task" }));
  expect(
    await screen.findByText("Fix keyboard navigation"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Prompt")).toHaveValue("");
  const call = fetcher.mock.calls.find(([url]) => url === "/api/tasks");
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
    provider: "codex",
    model: "gpt-6-astra",
    prompt: "PRIVATE instruction",
    workdir: "/home/user/workspace",
  });
  expect(screen.getByRole("status")).toHaveTextContent("Task added");
});
it("lets keyboard users edit, reorder, dispatch, cancel, retry and remove tasks and inspect runs", async () => {
  const base = {
    id: "a".repeat(24),
    title: "First task",
    workdir: "/home/user",
    provider: "claude",
    model: "opus",
    priority: 0,
    status: "pending",
    createdAt: "2026-09-06T12:00:00Z",
    earliestStart: null,
    preferredWindowStart: 23,
    maxTurns: 10,
  };
  let tasks = [
    base,
    { ...base, id: "b".repeat(24), title: "Failed task", status: "failed" },
  ];
  let autoDispatch = false;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith("/api/analytics"))
      return { ok: true, json: async () => emptyAnalytics(30) };
    if (url === "/api/queue")
      return { ok: true, json: async () => ({ tasks, autoDispatch }) };
    if (url === "/api/runs")
      return {
        ok: true,
        json: async () => ({
          runs: [
            {
              id: "c".repeat(24),
              taskId: base.id,
              title: "Edited task",
              provider: "claude",
              model: "opus",
              status: "cancelled",
              startedAt: base.createdAt,
              endedAt: base.createdAt,
              durationMs: 1000,
              exitCode: null,
              error: null,
              preview: ["[redacted stdout]"],
            },
          ],
        }),
      };
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url.endsWith("/auto")) autoDispatch = body.enabled;
    if (options?.method === "PATCH")
      tasks = tasks.map((t) => (t.id === base.id ? { ...t, ...body } : t));
    if (url.endsWith("/run"))
      tasks = tasks.map((t) =>
        t.id === base.id ? { ...t, status: "running" } : t,
      );
    if (url.endsWith("/cancel"))
      tasks = tasks.map((t) =>
        t.id === base.id ? { ...t, status: "cancelled" } : t,
      );
    if (url.endsWith("/retry"))
      tasks = tasks.map((t) =>
        t.id !== base.id ? { ...t, status: "pending" } : t,
      );
    if (options?.method === "DELETE")
      tasks = tasks.filter((t) => !url.includes(t.id));
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  await screen.findByText(/No Claude activity/);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Task queue" }));
  await user.click(
    await screen.findByRole("button", { name: "Edit First task" }),
  );
  await user.clear(screen.getByLabelText("Title"));
  await user.type(screen.getByLabelText("Title"), "Edited task");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Edited task");
  expect(
    JSON.parse(
      String(
        fetcher.mock.calls.find(
          ([, options]) => options?.method === "PATCH",
        )?.[1]?.body,
      ),
    ),
  ).not.toHaveProperty("prompt");
  await user.click(screen.getByRole("checkbox", { name: "Auto-dispatch" }));
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: "Auto-dispatch" }),
    ).toBeChecked(),
  );
  await user.click(screen.getByRole("button", { name: "Retry Failed task" }));
  await user.click(
    await screen.findByRole("button", { name: "Move Failed task up" }),
  );
  expect(fetcher.mock.calls.some(([url]) => url === "/api/queue/order")).toBe(
    true,
  );
  await user.click(screen.getByRole("button", { name: "Run Edited task now" }));
  await user.click(
    await screen.findByRole("button", { name: "Cancel Edited task" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Delete Edited task" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Edited task")).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("button", { name: "Runs" }));
  expect(await screen.findByText("Edited task")).toBeInTheDocument();
  await user.click(screen.getByText("Redacted output preview"));
  expect(screen.getByText("[redacted stdout]")).toBeInTheDocument();
});
it("shows an API failure and recovers when the user retries", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: !fail,
      json: async () =>
        fail
          ? { error: "Local history could not be read." }
          : emptyAnalytics(7),
    })),
  );
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Local history could not be read.",
  );
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText(/No Claude activity/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("passes a ranked local start hour into the new task form", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.startsWith("/api/analytics")
          ? emptyAnalytics(30)
          : { tasks: [], autoDispatch: false },
    })),
  );
  render(<App />);
  await screen.findByText(/No Claude activity/);
  await userEvent.click(
    screen.getByRole("button", { name: "Capacity planner" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Schedule at 23:00" }),
  );
  expect(
    await screen.findByLabelText("Preferred five-hour window (Eastern)"),
  ).toHaveValue("23");
});

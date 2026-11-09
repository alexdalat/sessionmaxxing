import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { startDashboard } from "../server/main.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import type { Edition, HistoryData } from "../shared/types.js";
import {
  TEST_TIME_ZONE,
  TEST_WORKDIR_ROOT,
  taskInput,
  temporary,
  usageSnapshot,
} from "./helpers";

const { createHistoryReader } = vi.hoisted(() => ({
  createHistoryReader: vi.fn(),
}));
vi.mock("../server/history.js", () => ({ createHistoryReader }));

const emptyHistory = async (): Promise<HistoryData> => ({
  events: [],
  health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
});
const NOT_FOUND = { error: "Route not found." };

beforeEach(() => {
  createHistoryReader.mockReturnValue(emptyHistory);
  vi.stubEnv("SESSIONMAXXING_HOST", undefined);
  vi.stubEnv("SESSIONMAXXING_PORT", undefined);
  vi.stubEnv("SESSIONMAXXING_EDITION", undefined);
  vi.stubEnv("SESSIONMAXXING_IN_DOCKER", undefined);
  vi.stubEnv("SESSIONMAXXING_ALLOWED_HOSTS", undefined);
  vi.stubEnv("HOST", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const fetchUsage = async (at: Date) =>
  usageSnapshot({ fetchedAt: at.toISOString() });
const { tokens: _tokens, ...liteFields } = taskInput("");
const liteInput = (workdir: string) => ({ ...liteFields, workdir });

async function editionApp(edition: Edition | undefined, directory: string) {
  const queue = await QueueStore.open(directory, TEST_WORKDIR_ROOT, edition);
  const runner = await Runner.open(queue, directory);
  const usage = new UsageMonitor(
    fetchUsage,
    await UsageHistoryStore.open(directory),
  );
  const app = await createApp({
    timeZone: TEST_TIME_ZONE,
    edition,
    queue,
    runner,
    usage,
    settings: await DispatchSettingsStore.open(directory),
    loadHistory: vi.fn(emptyHistory),
  });
  return { app, queue };
}

it("starts the lite edition with no analytics, plan score or transcript reads while the usage monitor records samples", async () => {
  vi.stubEnv("SESSIONMAXXING_EDITION", "lite");
  const temp = await temporary();
  const loadHistory = vi.fn(emptyHistory);
  const app = await startDashboard({
    port: 0,
    dataDirectory: temp.path,
    development: true,
    fetchUsage,
    loadHistory,
    timeZone: "Europe/Berlin",
    workdirRoot: temp.path,
  });
  try {
    expect((await app.inject("/api/environment")).json()).toEqual({
      timeZone: "Europe/Berlin",
      workdirRoot: temp.path,
      edition: "lite",
    });
    for (const url of ["/api/analytics", "/api/plan-score"]) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND);
    }
    expect((await app.inject("/api/usage")).statusCode).toBe(200);
    let samples = "";
    for (let attempt = 0; attempt < 100 && samples === ""; attempt++) {
      samples = await readFile(
        join(temp.path, "usage-samples.jsonl"),
        "utf8",
      ).catch(() => "");
      if (samples === "") await new Promise((done) => setTimeout(done, 10));
    }
    expect(samples.trim().split("\n").length).toBeGreaterThanOrEqual(1);
    expect(loadHistory).not.toHaveBeenCalled();
    expect(createHistoryReader).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("stores a lite task without a token cost and lists it with no session cost", async () => {
  const temp = await temporary();
  const { app, queue } = await editionApp("lite", temp.path);
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: liteInput(temp.path),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tokens).toBeNull();
    expect(queue.snapshot().tasks[0]?.tokens).toBeNull();
    const [listed] = (await app.inject("/api/queue")).json().tasks;
    expect(listed.tokens).toBeNull();
    expect(listed.sessionCostPercent).toBeNull();
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it.each([100_000, "auto"])(
  "refuses tokens %j on a lite task without estimating or storing anything",
  async (tokens) => {
    const temp = await temporary();
    const estimate = vi.fn();
    const sessionRates = vi.fn();
    const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT, "lite");
    const app = await createApp({
      timeZone: TEST_TIME_ZONE,
      edition: "lite",
      queue,
      runner: await Runner.open(queue, temp.path),
      estimate,
      sessionRates,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { ...liteInput(temp.path), tokens },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("lite");
      expect(estimate).not.toHaveBeenCalled();
      expect(sessionRates).not.toHaveBeenCalled();
      expect(queue.snapshot().tasks).toEqual([]);
    } finally {
      await app.close();
      await temp.cleanup();
    }
  },
);

it("reports the full edition and still requires tokens when no edition is given", async () => {
  const temp = await temporary();
  const { app } = await editionApp(undefined, temp.path);
  try {
    expect((await app.inject("/api/environment")).json()).toEqual({
      timeZone: TEST_TIME_ZONE,
      workdirRoot: TEST_WORKDIR_ROOT,
      edition: "full",
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: liteInput(temp.path),
    });
    expect(missing.statusCode).toBe(400);
    const priced = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { ...liteInput(temp.path), tokens: 100_000 },
    });
    expect(priced.statusCode).toBe(201);
    expect(priced.json().tokens).toBe(100_000);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("keeps the full analytics and plan-score routes", async () => {
  const temp = await temporary();
  const { app } = await editionApp("full", temp.path);
  try {
    expect((await app.inject("/api/analytics")).statusCode).toBe(200);
    expect((await app.inject("/api/plan-score")).statusCode).toBe(200);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

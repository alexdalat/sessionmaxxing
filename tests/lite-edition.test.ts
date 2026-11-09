import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type AppOptions, createApp } from "../server/app.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { startDashboard } from "../server/main.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import type { Edition, HistoryData } from "../shared/types.js";
import {
  SESSION_RATES,
  sessionRates,
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

async function editionApp(
  edition: Edition | undefined,
  directory: string,
  extra: Partial<AppOptions> = {},
) {
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
    ...extra,
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

it.each([50_000, "auto"])(
  "refuses tokens %j when a lite task is edited and leaves the task alone",
  async (tokens) => {
    const temp = await temporary();
    const estimate = vi.fn();
    const { app, queue } = await editionApp("lite", temp.path, { estimate });
    try {
      const { id } = await queue.create({
        ...liteInput(temp.path),
        tokens: null,
      });
      const response = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${id}`,
        payload: { tokens },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("lite");
      expect(queue.snapshot().tasks[0]?.tokens).toBeNull();
      expect(estimate).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await temp.cleanup();
    }
  },
);

it("edits a lite task title and keeps its tokens null", async () => {
  const temp = await temporary();
  const { app, queue } = await editionApp("lite", temp.path);
  try {
    const { id } = await queue.create({
      ...liteInput(temp.path),
      tokens: null,
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      payload: { title: "Renamed" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: "Renamed", tokens: null });
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("refuses to start the full edition on a queue.json holding a lite task and leaves the file unchanged", async () => {
  const temp = await temporary();
  try {
    const lite = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT, "lite");
    await lite.create({ ...liteInput(temp.path), tokens: null });
    const path = join(temp.path, "queue.json");
    const before = await readFile(path);
    await expect(
      QueueStore.open(temp.path, TEST_WORKDIR_ROOT, "full"),
    ).rejects.toThrow(/queue\.json.*lite/);
    expect((await readFile(path)).equals(before)).toBe(true);
  } finally {
    await temp.cleanup();
  }
});

it("loads a full queue.json in lite with its token numbers and keeps them through an edit", async () => {
  const temp = await temporary();
  try {
    const full = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT, "full");
    const { id } = await full.create({ ...taskInput(temp.path) });
    const lite = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT, "lite");
    expect(lite.snapshot().tasks[0]?.tokens).toBe(100_000);
    await lite.update(id, { title: "Renamed" });
    expect(lite.snapshot().tasks[0]).toMatchObject({
      title: "Renamed",
      tokens: 100_000,
    });
  } finally {
    await temp.cleanup();
  }
});

it("prices a stored token number in full at the fitted session rates", async () => {
  const temp = await temporary();
  const { app, queue } = await editionApp("full", temp.path, { sessionRates });
  try {
    await queue.create({ ...taskInput(temp.path) });
    const [listed] = (await app.inject("/api/queue")).json().tasks;
    expect(listed.sessionCostPercent).toBe(
      Math.round((100_000 / 1_000_000) * SESSION_RATES.opus * 10) / 10,
    );
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

const STATIC_FILES = [
  "index.html",
  "index.txt",
  "__next.__PAGE__.txt",
  "__next._full.txt",
  "__next._tree.txt",
  "icon.svg",
  "queue/index.html",
  "queue/index.txt",
  "runs/index.html",
  "analytics/index.html",
  "analytics/index.txt",
  "_next/static/app.js",
];

async function staticRoot(directory: string) {
  const root = join(directory, "static");
  for (const file of STATIC_FILES) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), `fixture ${file}`);
  }
  return root;
}

it.each([
  ["/", 302],
  ["/?x=1", 302],
])("redirects lite %s to the queue page", async (url, status) => {
  const temp = await temporary();
  const { app } = await editionApp("lite", temp.path, {
    staticRoot: await staticRoot(temp.path),
  });
  try {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(status);
    expect(response.headers.location).toBe("/queue/");
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it.each([
  "/queue/",
  "/runs/",
  "/queue/index.txt",
  "/__next._tree.txt",
  "/icon.svg",
  "/_next/static/app.js",
  "/api/queue",
])("serves lite %s", async (url) => {
  const temp = await temporary();
  const { app } = await editionApp("lite", temp.path, {
    staticRoot: await staticRoot(temp.path),
  });
  try {
    expect((await app.inject(url)).statusCode).toBe(200);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("redirects lite /queue to /queue/", async () => {
  const temp = await temporary();
  const { app } = await editionApp("lite", temp.path, {
    staticRoot: await staticRoot(temp.path),
  });
  try {
    const response = await app.inject("/queue");
    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe("/queue/");
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it.each([
  "/analytics",
  "/analytics/",
  "/analytics/index.html",
  "/analytics/index.txt",
  "/index.html",
  "/index.txt",
  "/__next.__PAGE__.txt",
  "/__next._full.txt",
  "/./analytics/",
  "/queue/../analytics/",
  "/%61nalytics/",
])("answers lite %s with the not-found error", async (url) => {
  const temp = await temporary();
  const { app } = await editionApp("lite", temp.path, {
    staticRoot: await staticRoot(temp.path),
  });
  try {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(NOT_FOUND);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("refuses lite //analytics/ without serving the analytics page", async () => {
  const temp = await temporary();
  const { app } = await editionApp("lite", temp.path, {
    staticRoot: await staticRoot(temp.path),
  });
  try {
    const response = await app.inject("//analytics/");
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("fixture analytics");
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it.each(["/", "/index.html", "/analytics/", "/analytics/index.txt"])(
  "serves full %s",
  async (url) => {
    const temp = await temporary();
    const { app } = await editionApp("full", temp.path, {
      staticRoot: await staticRoot(temp.path),
    });
    try {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("fixture");
    } finally {
      await app.close();
      await temp.cleanup();
    }
  },
);

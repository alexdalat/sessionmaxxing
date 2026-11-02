import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../server/app.js";
import type { CommitRun } from "../server/commit-message.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import type { EstimateRun } from "../server/estimate.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import {
  sessionRates,
  TEST_WORKDIR_ROOT,
  temporary,
  usageSnapshot,
} from "./helpers";

const APPROVED_ADDRESS = "192.0.2.10";
const APPROVED_NAME = "dashboard.example.test";
const APPROVED_IPV6 = "::1";
const APPROVED_HOSTS = [APPROVED_ADDRESS, APPROVED_NAME, APPROVED_IPV6];
const emptyHistory = async () => ({
  events: [],
  health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
});

it("returns task prompts and working directories to the browser while edits preserve their stored execution directory", async () => {
  const { temporary, taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const runner = await Runner.open(queue, temp.path);
  const app = await createApp({ queue, runner });
  const submitted = taskInput(temp.path);
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: submitted,
    });
    expect(created.statusCode).toBe(201);
    const createdJson = created.json();
    expect(createdJson.workdir).toBe(temp.path);
    expect(createdJson.prompt).toBe(submitted.prompt);
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.json().id}`,
      payload: { title: "Updated" },
    });
    expect(response.statusCode).toBe(200);
    const responseJson = response.json();
    expect(responseJson.workdir).toBe(temp.path);
    expect(responseJson.prompt).toBe(submitted.prompt);
    const queueJson = (await app.inject("/api/queue")).json();
    expect(queueJson.tasks[0].workdir).toBe(temp.path);
    expect(queueJson.tasks[0].prompt).toBe(submitted.prompt);
    expect((await queue.claim(created.json().id)).workdir).toBe(temp.path);
    await queue.finish(created.json().id, "completed");
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("accepts localhost and the listed hosts without credentials", async () => {
  const app = await createApp({
    allowedHosts: APPROVED_HOSTS,
    loadHistory: emptyHistory,
  });
  try {
    for (const hostname of [
      "localhost",
      "127.0.0.1",
      APPROVED_ADDRESS,
      APPROVED_NAME,
      "[::1]",
    ]) {
      for (const host of [hostname, `${hostname}:4317`]) {
        for (const headers of [
          { host },
          { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" },
        ]) {
          const response = await app.inject({
            url: "/api/analytics",
            headers,
          });
          expect(response.statusCode, JSON.stringify(headers)).toBe(200);
          expect(response.headers["cache-control"]).toBe("no-store");
          expect(response.headers["set-cookie"]).toBeUndefined();
        }
      }
    }
  } finally {
    await app.close();
  }
});

it("matches approved hosts case-insensitively", async () => {
  const app = await createApp({
    allowedHosts: APPROVED_HOSTS,
    loadHistory: emptyHistory,
  });
  try {
    const host = "DASHBOARD.EXAMPLE.TEST:4317";
    const response = await app.inject({
      url: "/api/analytics",
      headers: { host, origin: `http://${host}` },
    });
    expect(response.statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it("approves only localhost when no hosts are listed", async () => {
  const app = await createApp({ loadHistory: emptyHistory });
  try {
    const rejected = await app.inject({
      url: "/api/analytics",
      headers: { host: `${APPROVED_ADDRESS}:4317` },
    });
    expect(rejected.statusCode).toBe(403);
    const accepted = await app.inject({
      url: "/api/analytics",
      headers: { host: "localhost:4317" },
    });
    expect(accepted.statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it("never approves an unspecified address, even when it is listed", async () => {
  const app = await createApp({
    allowedHosts: [...APPROVED_HOSTS, "0.0.0.0", "::", "[::]"],
    loadHistory: emptyHistory,
  });
  try {
    for (const host of ["0.0.0.0:4317", "0.0.0.0", "[::]:4317", "[::2]:4317"]) {
      const response = await app.inject({
        url: "/api/analytics",
        headers: { host },
      });
      expect(response.statusCode, host).toBe(403);
    }
  } finally {
    await app.close();
  }
});

it("rejects unapproved hosts and origins even when forwarded headers claim a trusted host", async () => {
  const app = await createApp({ allowedHosts: APPROVED_HOSTS });
  const host = `${APPROVED_ADDRESS}:4317`;
  try {
    const rejectedHeaders = [
      ...[
        "0.0.0.0:4317",
        "192.0.2.11:4317",
        `${APPROVED_ADDRESS}.evil.example:4317`,
        `${APPROVED_NAME}.evil.example:4317`,
        "other.example.test:4317",
        `user@${APPROVED_ADDRESS}:4317`,
        `${APPROVED_ADDRESS}:4317/path`,
        `${APPROVED_ADDRESS}:4317,localhost:4317`,
        "[::2]:4317",
      ].map((host) => ({ host })),
      ...[
        "",
        "null",
        `https://${host}`,
        `http://${APPROVED_ADDRESS}:4318`,
        `http://${host}/`,
        `http://${host}.evil.example`,
        `http://${APPROVED_NAME}:4317`,
        "http://localhost:4317",
      ].map((origin) => ({ host, origin })),
      { host, origin: `http://${host}`, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of rejectedHeaders) {
      const response = await app.inject({
        url: "/api/unknown",
        headers: {
          ...headers,
          "x-forwarded-host": "localhost:4317",
          "x-forwarded-proto": "http",
        },
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(403);
      expect(response.json().error).toMatch(/hosts and origins/);
    }
  } finally {
    await app.close();
  }
});

it("serves aggregated history through a validated, local-only API with safe errors", async () => {
  const app = await createApp({
    loadHistory: async () => ({
      events: [],
      health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
    }),
    now: () => new Date("2026-09-06T12:00:00Z"),
  });
  try {
    const response = await app.inject("/api/analytics?days=14");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      days: 14,
      timeZone: "America/New_York",
      daily: expect.any(Array),
    });
    expect(response.json().daily).toHaveLength(14);
    expect((await app.inject("/api/analytics?days=8")).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          url: "/api/analytics",
          headers: { host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/analytics",
          headers: { origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject("/api/unknown")).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
it("creates, edits, reorders, runs, cancels, retries and deletes through validated routes while returning prompts and workdirs", async () => {
  const { temporary, taskInput, fakeChild } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const child = fakeChild();
  const runner = await Runner.open(queue, temp.path, { launch: () => child });
  const app = await createApp({
    queue,
    runner,
    allowedHosts: [APPROVED_NAME],
  });
  const submitted = taskInput(temp.path);
  try {
    const create = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: {
        host: `${APPROVED_NAME}:4317`,
        origin: `http://${APPROVED_NAME}:4317`,
      },
      payload: submitted,
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().prompt).toBe(submitted.prompt);
    expect(create.json().workdir).toBe(temp.path);
    const task = create.json();
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/tasks/${task.id}`,
          payload: { title: "Edited" },
        })
      ).json().title,
    ).toBe("Edited");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/queue/order",
          payload: { ids: [task.id] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/queue/auto",
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject("/api/queue")).json().autoDispatch).toBe(true);
    expect(
      (await app.inject({ method: "POST", url: `/api/tasks/${task.id}/run` }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/tasks/${task.id}`,
          payload: { title: "No" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/tasks/${task.id}/cancel`,
        })
      ).statusCode,
    ).toBe(200);
    child.emit("close", null);
    await runner.waitForIdle();
    const runs = await app.inject("/api/runs");
    expect(runs.json().runs[0].status).toBe("cancelled");
    expect(runs.json().runs[0].prompt).toBe(submitted.prompt);
    expect(runs.body).not.toMatch(/workdir|env/);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}` }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: {
            ...taskInput(temp.path),
            extra: "SECRET",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: taskInput("/etc"),
        })
      ).json().error,
    ).toMatch(/directory/);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/tasks/not-an-id" }))
        .statusCode,
    ).toBe(400);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});
it("rejects a task body that still names a provider", async () => {
  const { temporary, taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const runner = await Runner.open(queue, temp.path);
  const app = await createApp({ queue, runner });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { ...taskInput(temp.path), provider: "claude" },
    });
    expect(created.statusCode).toBe(400);
    expect(queue.snapshot().tasks).toEqual([]);

    const task = await queue.create(taskInput(temp.path));
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { provider: "claude" },
    });
    expect(patched.statusCode).toBe(400);
    expect(queue.snapshot().tasks).toEqual([task]);
  } finally {
    await app.close();
    await runner.close();
    await temp.cleanup();
  }
});
it("serves the production client locally, protects API errors, and does not fall back to HTML for unknown API routes", async () => {
  const { temporary } = await import("./helpers");
  const { writeFile } = await import("node:fs/promises");
  const temp = await temporary();
  await writeFile(
    `${temp.path}/index.html`,
    "<!doctype html><title>Capacity</title>",
  );
  const app = await createApp({
    staticRoot: temp.path,
    allowedHosts: [APPROVED_NAME],
    loadHistory: async () => {
      throw new Error("PRIVATE /home/user/credential SECRET");
    },
  });
  try {
    const index = await app.inject({
      url: "/",
      headers: { host: `${APPROVED_NAME}:4317` },
    });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("<title>Capacity</title>");
    expect(index.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    const failed = await app.inject("/api/analytics");
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toMatch(/PRIVATE|credential|SECRET/);
    expect((await app.inject("/api/missing")).statusCode).toBe(404);
    expect((await app.inject("/data/queue.json")).statusCode).toBe(404);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});
it("serves a route directory's index.html for deep links", async () => {
  const { temporary } = await import("./helpers");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const temp = await temporary();
  await writeFile(
    `${temp.path}/index.html`,
    "<!doctype html><title>Capacity</title>",
  );
  await mkdir(`${temp.path}/runs`);
  await writeFile(
    `${temp.path}/runs/index.html`,
    "<!doctype html><title>Runs</title>",
  );
  const app = await createApp({ staticRoot: temp.path });
  try {
    const runs = await app.inject("/runs/");
    expect(runs.statusCode).toBe(200);
    expect(runs.body).toBe("<!doctype html><title>Runs</title>");
  } finally {
    await app.close();
    await temp.cleanup();
  }
});
it("redirects a route without a trailing slash to its directory", async () => {
  const { temporary } = await import("./helpers");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const temp = await temporary();
  await writeFile(
    `${temp.path}/index.html`,
    "<!doctype html><title>Capacity</title>",
  );
  await mkdir(`${temp.path}/runs`);
  await writeFile(
    `${temp.path}/runs/index.html`,
    "<!doctype html><title>Runs</title>",
  );
  const app = await createApp({ staticRoot: temp.path });
  try {
    const redirected = await app.inject("/runs");
    expect(redirected.statusCode).toBe(301);
    expect(redirected.headers.location).toBe("/runs/");
    const missing = await app.inject("/nonexistent/");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Route not found." });
  } finally {
    await app.close();
    await temp.cleanup();
  }
});
it("preserves an unscheduled null window and rejects coerced body values", async () => {
  const { temporary, taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const runner = await Runner.open(queue, temp.path);
  const app = await createApp({ queue, runner });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: taskInput(temp.path),
    });
    expect(response.json().preferredWindowStart).toBeNull();
    expect(response.json().earliestStart).toBeNull();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/queue/auto",
          payload: { enabled: "true" },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("fills session windows from local transcripts for stretches no official sample covered", async () => {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  const usage = new UsageMonitor(
    async (at) => usageSnapshot({ fetchedAt: at.toISOString() }),
    await UsageHistoryStore.open(temp.path, now),
    () => now,
  );
  const app = await createApp({
    usage,
    now: () => now,
    loadHistory: async () => ({
      events: [
        "2026-09-05T02:00:00Z",
        "2026-09-05T02:01:00Z",
        "2026-09-06T11:30:00Z",
      ].map((timestamp) => ({
        timestamp,
        project: "demo",
        model: "claude-opus-4-6",
        source: "local" as const,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })),
      health: { files: 1, lines: 3, warnings: 0, historyEntries: 0 },
    }),
  });
  try {
    await app.inject({ method: "POST", url: "/api/usage/refresh" });
    expect((await app.inject("/api/usage")).json().windows).toEqual([
      {
        start: "2026-09-05T02:00:00.000Z",
        end: "2026-09-05T07:00:00.000Z",
        peakPercent: null,
        activeMinutes: 2,
        samples: 0,
      },
      {
        start: "2026-09-06T11:09:00.000Z",
        end: "2026-09-06T16:09:00.000Z",
        peakPercent: 16,
        activeMinutes: 1,
        samples: 1,
      },
    ]);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("serves official usage with sample history, refreshes on demand, and validates dispatch settings", async () => {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  let calls = 0;
  const usage = new UsageMonitor(
    async (at) => {
      calls++;
      return usageSnapshot({ fetchedAt: at.toISOString() });
    },
    await UsageHistoryStore.open(temp.path, now),
    () => now,
  );
  const settings = await DispatchSettingsStore.open(temp.path);
  const app = await createApp({
    usage,
    settings,
    now: () => now,
    sessionRates,
    loadHistory: async () => ({
      events: [],
      health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
    }),
  });
  try {
    expect((await app.inject("/api/usage")).json()).toEqual({
      snapshot: null,
      error: null,
      samples: [],
      windows: [],
    });
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/usage/refresh",
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      snapshot: usageSnapshot(),
      error: null,
      windows: [
        {
          start: "2026-09-06T11:09:00.000Z",
          end: "2026-09-06T16:09:00.000Z",
          peakPercent: 16,
          activeMinutes: 0,
          samples: 1,
        },
      ],
    });
    expect(refreshed.body).not.toMatch(/token|Bearer/i);
    expect(calls).toBe(1);
    const planning = await app.inject("/api/dispatch-settings");
    expect(planning.json()).toMatchObject({
      settings: {
        autoApply: false,
        keepSessionActive: false,
        sessionReservePercent: 25,
        weeklyMarginPercent: 10,
      },
      gate: { status: "ready" },
    });
    expect(planning.json()).not.toHaveProperty("providers");
    const saved = await app.inject({
      method: "PUT",
      url: "/api/dispatch-settings",
      payload: {
        autoApply: true,
        keepSessionActive: false,
        sessionReservePercent: 90,
        busyHoursReservePercent: 90,
        weeklyMarginPercent: 0,
        quietStartHours: 8,
        maxConcurrentRuns: 1,
        runWeeklyCostPercent: 3,
      },
    });
    expect(saved.json().gate.status).toBe("waiting");
    expect(saved.json().quiet).toMatchObject({
      startHours: [0, 1, 2, 3, 4, 5, 6, 7],
      nowHour: 8,
      active: false,
    });
    expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual({
      autoApply: true,
      keepSessionActive: false,
      sessionReservePercent: 90,
      busyHoursReservePercent: 90,
      weeklyMarginPercent: 0,
      quietStartHours: 8,
      maxConcurrentRuns: 1,
      runWeeklyCostPercent: 3,
    });
    const valid = {
      autoApply: false,
      keepSessionActive: false,
      sessionReservePercent: 10,
      busyHoursReservePercent: 100,
      weeklyMarginPercent: 0,
      quietStartHours: 8,
      maxConcurrentRuns: 2,
      runWeeklyCostPercent: 3,
    };
    for (const payload of [
      { ...valid, sessionReservePercent: 91 },
      { ...valid, sessionReservePercent: "10" },
      { ...valid, busyHoursReservePercent: 101 },
      { ...valid, busyHoursReservePercent: "50" },
      { ...valid, quietStartHours: 0 },
      { ...valid, quietStartHours: 2.5 },
      { ...valid, maxConcurrentRuns: 0 },
      { ...valid, maxConcurrentRuns: 5 },
      { ...valid, maxConcurrentRuns: 1.5 },
      { ...valid, runWeeklyCostPercent: -1 },
      { ...valid, autoApply: "yes" },
      { sessionReservePercent: 10, weeklyMarginPercent: 0 },
      { ...valid, extra: 1 },
    ])
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/dispatch-settings",
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/dispatch-settings",
          payload: valid,
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject("/api/usage?days=7")).statusCode).toBe(400);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("scores the plan from recorded samples over the last twenty-eight Eastern days", async () => {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  const usage = new UsageMonitor(
    async (at) => usageSnapshot({ fetchedAt: at.toISOString() }),
    await UsageHistoryStore.open(temp.path, now),
    () => now,
  );
  const app = await createApp({
    usage,
    now: () => now,
    loadHistory: async () => ({
      events: [],
      health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
    }),
  });
  try {
    await app.inject({ method: "POST", url: "/api/usage/refresh" });
    const score = (await app.inject("/api/plan-score")).json();
    // The only window runs 11:09Z to 16:09Z at 16%, so 51 of today's 8
    // elapsed Eastern hours are covered: 16 x 0.85 / 8 = 1.7.
    expect(score.days).toHaveLength(28);
    const noMinutes = {
      sources: { local: 0, dispatched: 0, unknown: 0 },
      models: {},
    };
    expect(score.days.at(-1)).toEqual({
      date: "2026-09-06",
      coverage: 1.7,
      ...noMinutes,
    });
    expect(score.days.at(-2)).toEqual({
      date: "2026-09-05",
      coverage: null,
      ...noMinutes,
    });
    expect(score.weeks).toEqual([
      {
        start: "2026-09-06T07:53:00.000Z",
        end: "2026-09-13T07:53:00.000Z",
        percent: 2,
        score: 82,
        complete: false,
      },
    ]);
    expect(score.sessionCoverage).toBe(2);
    expect(score.weeklyScore).toBe(82);
    expect(score.score).toBe(42);
    expect(score.generatedAt).toBe("2026-09-06T12:00:00.000Z");
    expect((await app.inject("/api/plan-score?days=7")).statusCode).toBe(400);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("serves the snapshot persisted before a restart when the usage fetch fails", async () => {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  const snapshot = usageSnapshot();
  try {
    await (await UsageHistoryStore.open(temp.path, now)).record(snapshot);
    const usage = new UsageMonitor(
      async () => {
        throw new Error("Claude Code OAuth token expired.");
      },
      await UsageHistoryStore.open(temp.path, now),
      () => now,
    );
    const app = await createApp({
      usage,
      settings: await DispatchSettingsStore.open(temp.path),
      now: () => now,
      loadHistory: async () => ({
        events: [],
        health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
      }),
    });
    try {
      expect((await app.inject("/api/usage")).json()).toMatchObject({
        snapshot,
        error: null,
      });
      expect(
        (
          await app.inject({ method: "POST", url: "/api/usage/refresh" })
        ).json(),
      ).toMatchObject({ snapshot, error: "Claude Code OAuth token expired." });
    } finally {
      await app.close();
    }
  } finally {
    await temp.cleanup();
  }
});

it("computes quiet start hours from local history for the planning snapshot and caches them", async () => {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  let loads = 0;
  const usage = new UsageMonitor(
    async (at) => usageSnapshot({ fetchedAt: at.toISOString() }),
    await UsageHistoryStore.open(temp.path, now),
    () => now,
  );
  const app = await createApp({
    usage,
    settings: await DispatchSettingsStore.open(temp.path),
    now: () => now,
    sessionRates,
    loadHistory: async () => {
      loads++;
      return {
        events: Array.from({ length: 30 }, (_, day) => ({
          timestamp: new Date(
            Date.parse("2026-08-07T14:00:00Z") + day * 86_400_000,
          ).toISOString(),
          project: "demo",
          model: "claude-opus-5",
          source: "local" as const,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        })),
        health: { files: 1, lines: 30, warnings: 0, historyEntries: 0 },
      };
    },
  });
  try {
    expect(
      (await app.inject("/api/dispatch-settings")).json().quiet.startHours,
    ).toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    const quiet = (await app.inject("/api/dispatch-settings")).json().quiet;
    expect(quiet.startHours).toHaveLength(8);
    expect(quiet.startHours).not.toContain(10);
    expect(quiet.startHours).not.toContain(6);
    expect(quiet.error).toBeNull();
    await app.inject("/api/dispatch-settings");
    expect(loads).toBe(1);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("leaves finished tasks out of the active queue", async () => {
  const { taskInput, fakeChild } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const child = fakeChild();
  const runner = await Runner.open(queue, temp.path, { launch: () => child });
  const app = await createApp({ queue, runner });
  try {
    const titles = ["Finished", "Waiting"];
    for (const title of titles)
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { ...taskInput(temp.path), title },
      });
    const [finished] = (await app.inject("/api/queue")).json().tasks;
    await app.inject({ method: "POST", url: `/api/tasks/${finished.id}/run` });
    child.emit("close", 0, null);
    await runner.waitForIdle();
    const title = (task: { title: string }) => task.title;
    expect((await app.inject("/api/queue")).json().tasks.map(title)).toEqual(
      titles,
    );
    expect(
      (await app.inject("/api/queue?active=true")).json().tasks.map(title),
    ).toEqual(["Waiting"]);
    expect((await app.inject("/api/queue?active=false")).statusCode).toBe(400);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("returns only the newest runs up to the limit with the full count", async () => {
  const { taskInput, fakeChild } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  let clock = Date.parse("2026-10-27T12:00:00Z");
  let child = fakeChild();
  const runner = await Runner.open(queue, temp.path, {
    launch: () => child,
    now: () => new Date(clock),
  });
  const app = await createApp({ queue, runner });
  try {
    for (const title of ["Older", "Newer"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { ...taskInput(temp.path), title },
      });
      await app.inject({
        method: "POST",
        url: `/api/tasks/${created.json().id}/run`,
      });
      child.emit("close", 0, null);
      await runner.waitForIdle();
      child = fakeChild();
      clock += 60_000;
    }
    const page = (await app.inject("/api/runs?limit=1")).json();
    expect(page.runs.map((run: { title: string }) => run.title)).toEqual([
      "Newer",
    ]);
    expect(page.total).toBe(2);
    expect((await app.inject("/api/runs?limit=0")).statusCode).toBe(400);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("never exposes the session id of a dispatched run through the runs route", async () => {
  const { taskInput, fakeChild } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const child = fakeChild();
  const runner = await Runner.open(queue, temp.path, { launch: () => child });
  const app = await createApp({ queue, runner });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: taskInput(temp.path),
    });
    const started = await app.inject({
      method: "POST",
      url: `/api/tasks/${created.json().id}/run`,
    });
    expect(started.statusCode).toBe(200);
    expect(Object.keys(started.json())).not.toContain("sessionId");
    const [sessionId] = [...runner.dispatchedSessions()];
    expect(sessionId).toBeDefined();
    const runs = (await app.inject("/api/runs")).json().runs;
    expect(runs).toHaveLength(1);
    expect(Object.keys(runs[0])).not.toContain("sessionId");
    expect(JSON.stringify(runs)).not.toContain(sessionId);
    child.emit("close", 0, null);
    await runner.waitForIdle();
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("reports activity per source in the analytics route", async () => {
  const app = await createApp({
    now: () => new Date("2026-09-06T12:00:00Z"),
    loadHistory: async () => ({
      events: [
        {
          timestamp: "2026-09-06T10:00:00.000Z",
          project: "demo",
          model: "claude-opus-4-6",
          source: "dispatched" as const,
          inputTokens: 1,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          timestamp: "2026-09-06T11:00:00.000Z",
          project: "demo",
          model: "claude-opus-4-6",
          source: "local" as const,
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
      health: { files: 1, lines: 2, warnings: 0, historyEntries: 0 },
    }),
  });
  try {
    expect((await app.inject("/api/analytics")).json().sources).toEqual([
      // One uncached input token is worth a fifth of an Opus output token.
      { source: "local", activeMinutes: 1, responses: 1, tokens: 2.2 },
      { source: "dispatched", activeMinutes: 1, responses: 1, tokens: 5.2 },
      { source: "unknown", activeMinutes: 0, responses: 0, tokens: 0 },
    ]);
  } finally {
    await app.close();
  }
});

it("migrates a saved quiet-hours flag into a busy-hours reserve", async () => {
  const temp = await temporary();
  const path = join(temp.path, "dispatch-settings.json");
  const legacy = {
    sessionReservePercent: 40,
    weeklyMarginPercent: 5,
    quietStartHours: 6,
  };
  try {
    await writeFile(path, JSON.stringify({ ...legacy, quietHoursOnly: true }));
    expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual({
      autoApply: false,
      keepSessionActive: false,
      sessionReservePercent: 40,
      busyHoursReservePercent: 100,
      weeklyMarginPercent: 5,
      quietStartHours: 6,
      maxConcurrentRuns: 2,
      runWeeklyCostPercent: 3,
    });
    expect(await readFile(path, "utf8")).not.toMatch(/quietHoursOnly/);
    await writeFile(path, JSON.stringify({ ...legacy, quietHoursOnly: false }));
    expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual({
      autoApply: false,
      keepSessionActive: false,
      sessionReservePercent: 40,
      busyHoursReservePercent: 40,
      weeklyMarginPercent: 5,
      quietStartHours: 6,
      maxConcurrentRuns: 2,
      runWeeklyCostPercent: 3,
    });
    expect(await readFile(path, "utf8")).not.toMatch(/quietHoursOnly/);
  } finally {
    await temp.cleanup();
  }
});

it("rejects tokens outside the allowed range and requires them on create", async () => {
  const { taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const runner = await Runner.open(queue, temp.path);
  const app = await createApp({ queue, runner });
  const post = (payload: object) =>
    app.inject({ method: "POST", url: "/api/tasks", payload });
  try {
    const { tokens: _tokens, ...withoutTokens } = taskInput(temp.path);
    expect((await post(withoutTokens)).statusCode).toBe(400);
    for (const tokens of [0, 4_999, 10_000_001, 25.5, "25000", null])
      expect((await post({ ...withoutTokens, tokens })).statusCode).toBe(400);
    const created = await post({ ...withoutTokens, tokens: 10_000_000 });
    expect(created.statusCode).toBe(201);
    expect(created.json().tokens).toBe(10_000_000);
    // Without a planner no rates are known, so the derived percent stays null.
    expect(created.json().sessionCostPercent).toBeNull();
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/tasks/${created.json().id}`,
          payload: { tokens: 4_999 },
        })
      ).statusCode,
    ).toBe(400);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.json().id}`,
      payload: { tokens: 7_000 },
    });
    expect(patched.json().tokens).toBe(7_000);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("stamps a run as reviewed and clears the needs-review flag on its task", async () => {
  const { temporary, taskInput, fakeChild } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const { gitIn } = await import("../server/git.js");
  const temp = await temporary();
  const workdir = join(temp.path, "repo");
  await mkdir(workdir);
  const git = gitIn(workdir);
  await git(["init", "-b", "main"]);
  await writeFile(`${workdir}/notes.md`, "one\n");
  await git(["add", "notes.md"]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "first",
  ]);
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const child = fakeChild();
  const runner = await Runner.open(queue, temp.path, { launch: () => child });
  const app = await createApp({ queue, runner });
  try {
    const task = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: taskInput(workdir),
      })
    ).json();
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/run` });
    await writeFile(`${workdir}/notes.md`, "one\ntwo\n");
    child.emit("close", 0, null);
    await runner.waitForIdle();
    const run = (await app.inject("/api/runs")).json().runs[0];
    expect(run.changes.files).toEqual([
      { path: "notes.md", added: 1, removed: 0 },
    ]);
    expect(run.reviewedAt).toBeNull();
    expect((await app.inject("/api/queue")).json().tasks[0].review).toBe(
      "needed",
    );
    expect((await app.inject("/api/runs/pending-review")).json()).toEqual({
      pending: 1,
    });
    const stamped = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/reviewed`,
    });
    expect(stamped.statusCode).toBe(200);
    expect(Date.parse(stamped.json().reviewedAt)).toBeGreaterThan(0);
    expect((await app.inject("/api/runs")).json().runs[0].reviewedAt).toBe(
      stamped.json().reviewedAt,
    );
    expect((await app.inject("/api/queue")).json().tasks[0].review).toBeNull();
    expect((await app.inject("/api/runs/pending-review")).json()).toEqual({
      pending: 0,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/runs/${"f".repeat(24)}/reviewed`,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("stores the estimated tokens when a task is created or edited with auto", async () => {
  const { taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const runner = await Runner.open(queue, temp.path);
  const estimated: string[] = [];
  const app = await createApp({
    queue,
    runner,
    estimate: async (task) => {
      estimated.push(task.title);
      return task.title === "Edited" ? 62_000 : 31_000;
    },
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { ...taskInput(temp.path), tokens: "auto" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tokens).toBe(31_000);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.json().id}`,
      payload: { title: "Edited", tokens: "auto" },
    });
    expect(patched.json().tokens).toBe(62_000);
    expect(estimated).toEqual(["Fix a test", "Edited"]);
    expect(queue.snapshot().tasks[0].tokens).toBe(62_000);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("hands the estimator what earlier runs were estimated to produce", async () => {
  const { taskInput, fakeChild } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const child = fakeChild();
  const runner = await Runner.open(queue, temp.path, { launch: () => child });
  const histories: EstimateRun[][] = [];
  const app = await createApp({
    queue,
    runner,
    estimate: async (_task, history) => {
      histories.push(history);
      return 31_000;
    },
  });
  const submitted = { ...taskInput(temp.path), tokens: 210_000 };
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: submitted,
    });
    await app.inject({
      method: "POST",
      url: `/api/tasks/${created.json().id}/run`,
    });
    child.emit("close", 0, null);
    await runner.waitForIdle();
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { ...taskInput(temp.path), tokens: "auto" },
    });
    expect(histories.at(-1)).toEqual([
      {
        title: submitted.title,
        promptLength: submitted.prompt.length,
        model: created.json().model,
        durationMs: expect.any(Number),
        tokens: null,
        estimatedTokens: 210_000,
      },
    ]);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("refuses to queue an auto-token task when the estimate fails", async () => {
  const { taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const runner = await Runner.open(queue, temp.path);
  const app = await createApp({
    queue,
    runner,
    estimate: async () => {
      throw new Error("Claude session is exhausted");
    },
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { ...taskInput(temp.path), tokens: "auto" },
    });
    expect(created.statusCode).toBe(500);
    expect(created.json().error).toBe("Claude session is exhausted");
    expect(queue.snapshot().tasks).toEqual([]);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("suggests recent and prefix-matched work directories", async () => {
  const { taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const runner = await Runner.open(queue, temp.path);
  const app = await createApp({ queue, runner });
  try {
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: taskInput(temp.path),
    });
    const suggestions = await app.inject("/api/workdirs");
    expect(suggestions.statusCode).toBe(200);
    const { recent, matches } = suggestions.json();
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every((path: string) => path.startsWith("/home/user"))).toBe(
      true,
    );
    expect(matches).toEqual([]);
    const typed = await app.inject(
      `/api/workdirs?q=${encodeURIComponent(`${temp.path}/`)}`,
    );
    expect(typed.json().matches).toEqual([
      `${temp.path}/deploy`,
      `${temp.path}/runs`,
    ]);
    expect((await app.inject("/api/workdirs?days=7")).statusCode).toBe(400);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("fits the session rates from official samples and local transcripts, and prices each task with them", async () => {
  const { taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  const sample = (at: string, session: number, resetsAt: string) =>
    JSON.stringify({
      at,
      session,
      sessionResetsAt: resetsAt,
      weekly: 10,
      weeklyResetsAt: "2026-09-13T00:00:00.000Z",
      fable: null,
    });
  await writeFile(
    join(temp.path, "usage-samples.jsonl"),
    `${[
      sample("2026-09-06T02:00:00.000Z", 40, "2026-09-06T05:00:00.000Z"),
      sample("2026-09-06T07:00:00.000Z", 20, "2026-09-06T10:00:00.000Z"),
    ].join("\n")}\n`,
  );
  const event = (timestamp: string, outputTokens: number) => ({
    timestamp,
    project: "demo",
    model: "claude-opus-5",
    source: "local" as const,
    inputTokens: 0,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  const usage = new UsageMonitor(
    async (at) => usageSnapshot({ fetchedAt: at.toISOString() }),
    await UsageHistoryStore.open(temp.path, now),
    () => now,
  );
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const runner = await Runner.open(queue, temp.path);
  const app = await createApp({
    queue,
    runner,
    usage,
    settings: await DispatchSettingsStore.open(temp.path),
    now: () => now,
    loadHistory: async () => ({
      events: [
        event("2026-09-06T01:00:00.000Z", 1_500_000),
        event("2026-09-06T06:00:00.000Z", 750_000),
      ],
      health: { files: 2, lines: 2, warnings: 0, historyEntries: 0 },
    }),
  });
  try {
    await usage.refresh();
    const planning = (await app.inject("/api/dispatch-settings")).json();
    // Both windows spent 40% per 1.5M Opus tokens; the families the
    // sample never covered are priced off Opus at their list-price ratio.
    expect(planning.rates).toEqual({
      fable: 53.3,
      opus: 26.7,
      sonnet: 10.7,
      haiku: 5.3,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { ...taskInput(temp.path), tokens: 150_000 },
    });
    expect(created.json().sessionCostPercent).toBe(4);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

/** A finished run that edited notes.md and added added.ts next to other.md, which was already dirty. */
async function finishedRun(suggestCommit: (run: CommitRun) => Promise<string>) {
  const { taskInput, fakeChild } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const { gitIn } = await import("../server/git.js");
  const temp = await temporary();
  const workdir = join(temp.path, "repo");
  await mkdir(workdir);
  const git = gitIn(workdir);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await writeFile(`${workdir}/notes.md`, "one\n");
  await writeFile(`${workdir}/other.md`, "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "first"]);
  await writeFile(`${workdir}/other.md`, "base\nwip\n");
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const child = fakeChild();
  const runner = await Runner.open(queue, temp.path, { launch: () => child });
  const app = await createApp({ queue, runner, suggestCommit });
  const task = (
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: taskInput(workdir),
    })
  ).json();
  await app.inject({ method: "POST", url: `/api/tasks/${task.id}/run` });
  await writeFile(`${workdir}/notes.md`, "one\ntwo\n");
  await writeFile(`${workdir}/added.ts`, "export {};\n");
  child.emit("close", 0, null);
  await runner.waitForIdle();
  const run = (await app.inject("/api/runs")).json().runs[0];
  return {
    app,
    git,
    run,
    cleanup: async () => {
      await app.close();
      await temp.cleanup();
    },
  };
}

it("suggests a commit message from the run's title and changed files", async () => {
  const asked: CommitRun[] = [];
  const { app, run, cleanup } = await finishedRun(async (commitRun) => {
    asked.push(commitRun);
    return "feat: add the second note";
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/commit-message`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "feat: add the second note" });
    expect(asked).toEqual([
      {
        title: "Fix a test",
        summary: null,
        files: [
          { path: "added.ts", added: 0, removed: 0 },
          { path: "notes.md", added: 1, removed: 0 },
        ],
      },
    ]);
  } finally {
    await cleanup();
  }
});

it("reports a failed suggestion as a bad gateway with the model's error", async () => {
  const { app, run, cleanup } = await finishedRun(async () => {
    throw new Error(
      "Could not suggest a commit message: Credit balance is too low",
    );
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/commit-message`,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe(
      "Could not suggest a commit message: Credit balance is too low",
    );
  } finally {
    await cleanup();
  }
});

it("commits only the run's files with the edited message and marks the run reviewed", async () => {
  const { app, git, run, cleanup } = await finishedRun(
    async () => "feat: add the second note",
  );
  try {
    const committed = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/commit`,
      payload: { message: "  fix: keep the second note  " },
    });
    expect(committed.statusCode).toBe(200);
    expect(Date.parse(committed.json().reviewedAt)).toBeGreaterThan(0);
    expect(await git(["log", "-1", "--format=%s"])).toBe(
      "fix: keep the second note\n",
    );
    expect(await git(["show", "--name-status", "--format=", "HEAD"])).toBe(
      "A\tadded.ts\nM\tnotes.md\n",
    );
    expect(await git(["status", "--porcelain"])).toBe(" M other.md\n");
    expect((await app.inject("/api/runs/pending-review")).json()).toEqual({
      pending: 0,
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/commit`,
      payload: { message: "fix: again" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("This run has nothing left to commit.");
  } finally {
    await cleanup();
  }
});

it("refuses a multi-line or blank commit message and leaves the work uncommitted", async () => {
  const { app, git, run, cleanup } = await finishedRun(
    async () => "feat: add the second note",
  );
  try {
    for (const message of ["feat: one\nsecond line", "   "]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/runs/${run.id}/commit`,
        payload: { message },
      });
      expect(response.statusCode).toBe(400);
    }
    expect((await git(["rev-list", "--count", "HEAD"])).trim()).toBe("1");
    expect(
      (await app.inject("/api/runs")).json().runs[0].reviewedAt,
    ).toBeNull();
  } finally {
    await cleanup();
  }
});

it("surfaces git's error when the run's files were committed outside the dashboard", async () => {
  const { app, git, run, cleanup } = await finishedRun(
    async () => "feat: add the second note",
  );
  try {
    await git(["add", "notes.md", "added.ts"]);
    await git(["commit", "-m", "by hand"]);
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/commit`,
      payload: { message: "feat: add the second note" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/^Could not commit: git /);
    expect(
      (await app.inject("/api/runs")).json().runs[0].reviewedAt,
    ).toBeNull();
  } finally {
    await cleanup();
  }
});

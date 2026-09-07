import { expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import { temporary, usageSnapshot } from "./helpers";

it("returns task prompts and working directories to the browser while edits preserve their stored execution directory", async () => {
  const { temporary, taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path);
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

it("accepts localhost and Tailscale dashboard requests without credentials", async () => {
  const app = await createApp({
    loadHistory: async () => ({
      events: [],
      health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
    }),
  });
  try {
    for (const hostname of [
      "localhost",
      "127.0.0.1",
      "192.0.2.10",
      "dashboard.example.ts.net",
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

it("rejects unapproved hosts and origins even when forwarded headers claim a trusted host", async () => {
  const app = await createApp();
  const host = "192.0.2.10:4317";
  try {
    const rejectedHeaders = [
      ...[
        "0.0.0.0:4317",
        "192.168.1.10:4317",
        "192.0.2.11:4317",
        "192.0.2.10.evil.example:4317",
        "dashboard.example.ts.net.evil.example:4317",
        "other.example.ts.net:4317",
        "user@192.0.2.10:4317",
        "192.0.2.10:4317/path",
        "192.0.2.10:4317,localhost:4317",
      ].map((host) => ({ host })),
      ...[
        "",
        "null",
        "https://192.0.2.10:4317",
        "http://192.0.2.10:4318",
        "http://192.0.2.10:4317/",
        "http://192.0.2.10:4317.evil.example",
        "http://dashboard.example.ts.net:4317",
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
  const queue = await QueueStore.open(temp.path);
  const child = fakeChild();
  const runner = await Runner.open(queue, temp.path, { launch: () => child });
  const app = await createApp({ queue, runner });
  const submitted = taskInput(temp.path);
  try {
    const create = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: {
        host: "dashboard.example.ts.net:4317",
        origin: "http://dashboard.example.ts.net:4317",
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
    expect(runs.body).not.toMatch(/PRIVATE|prompt|workdir|env/);
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
            provider: "bad",
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
    loadHistory: async () => {
      throw new Error("PRIVATE /home/user/credential SECRET");
    },
  });
  try {
    const index = await app.inject({
      url: "/",
      headers: { host: "dashboard.example.ts.net:4317" },
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
  const queue = await QueueStore.open(temp.path);
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
      settings: { sessionReservePercent: 25, weeklyMarginPercent: 10 },
      providers: { claude: { status: "ready" } },
    });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/dispatch-settings",
      payload: {
        sessionReservePercent: 90,
        weeklyMarginPercent: 0,
        quietHoursOnly: false,
        quietStartHours: 8,
      },
    });
    expect(saved.json().providers.claude.status).toBe("waiting");
    expect(saved.json().quiet).toMatchObject({
      startHours: [0, 1, 2, 3, 4, 5, 6, 7],
      nowHour: 8,
      active: false,
    });
    expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual({
      sessionReservePercent: 90,
      weeklyMarginPercent: 0,
      quietHoursOnly: false,
      quietStartHours: 8,
    });
    const valid = {
      sessionReservePercent: 10,
      weeklyMarginPercent: 0,
      quietHoursOnly: true,
      quietStartHours: 8,
    };
    for (const payload of [
      { ...valid, sessionReservePercent: 91 },
      { ...valid, sessionReservePercent: "10" },
      { ...valid, quietStartHours: 0 },
      { ...valid, quietStartHours: 2.5 },
      { ...valid, quietHoursOnly: "yes" },
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
    expect((await app.inject("/api/usage?days=7")).statusCode).toBe(400);
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
    loadHistory: async () => {
      loads++;
      return {
        events: Array.from({ length: 30 }, (_, day) => ({
          timestamp: new Date(
            Date.parse("2026-08-07T14:00:00Z") + day * 86_400_000,
          ).toISOString(),
          project: "demo",
          model: "claude-opus-5",
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

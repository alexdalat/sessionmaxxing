import { expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import { temporary, usageSnapshot } from "./helpers";

it("keeps task working directories private while edits preserve their stored execution directory", async () => {
  const { temporary, taskInput } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path);
  const runner = await Runner.open(queue, temp.path);
  const app = await createApp({ queue, runner });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: taskInput(temp.path),
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toMatch(/\/home|workdir|PRIVATE|prompt/);
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.json().id}`,
      payload: { title: "Updated" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/\/home|workdir|PRIVATE|prompt/);
    expect((await app.inject("/api/queue")).body).not.toMatch(
      /\/home|workdir|PRIVATE|prompt/,
    );
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
it("creates, edits, reorders, runs, cancels, retries and deletes through validated routes without returning prompts", async () => {
  const { temporary, taskInput, fakeChild } = await import("./helpers");
  const { QueueStore } = await import("../server/queue.js");
  const { Runner } = await import("../server/runner.js");
  const temp = await temporary();
  const queue = await QueueStore.open(temp.path);
  const child = fakeChild();
  const runner = await Runner.open(queue, temp.path, { launch: () => child });
  const app = await createApp({ queue, runner });
  try {
    const create = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: {
        host: "dashboard.example.ts.net:4317",
        origin: "http://dashboard.example.ts.net:4317",
      },
      payload: taskInput(temp.path),
    });
    expect(create.statusCode).toBe(201);
    expect(create.body).not.toContain("prompt");
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
  const app = await createApp({ usage, settings, now: () => now });
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
      windows: [{ peakPercent: 16 }],
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
      payload: { sessionReservePercent: 90, weeklyMarginPercent: 0 },
    });
    expect(saved.json().providers.claude.status).toBe("waiting");
    expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual({
      sessionReservePercent: 90,
      weeklyMarginPercent: 0,
    });
    for (const payload of [
      { sessionReservePercent: 91, weeklyMarginPercent: 0 },
      { sessionReservePercent: "10", weeklyMarginPercent: 0 },
      { sessionReservePercent: 10 },
      { sessionReservePercent: 10, weeklyMarginPercent: 0, extra: 1 },
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

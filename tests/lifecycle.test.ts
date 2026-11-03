import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startDashboard } from "../server/main.js";
import { temporary, usageSnapshot } from "./helpers";

vi.mock("../server/history.js", () => ({
  createHistoryReader: () => async () => ({
    events: [],
    health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
  }),
}));

beforeEach(() => {
  vi.stubEnv("SESSIONMAXXING_HOST", undefined);
  vi.stubEnv("SESSIONMAXXING_PORT", undefined);
  vi.stubEnv("SESSIONMAXXING_EDITION", undefined);
  vi.stubEnv("SESSIONMAXXING_ALLOWED_HOSTS", undefined);
  vi.stubEnv("HOST", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const fetchUsage = async (at: Date) =>
  usageSnapshot({ fetchedAt: at.toISOString() });
async function quietHoursReady(
  app: Awaited<ReturnType<typeof startDashboard>>,
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await app.inject("/api/dispatch-settings")).json().quiet.startHours)
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Quiet hours were never computed.");
}

it("uses the persistent runtime data directory for dispatch settings and usage samples", async () => {
  const temp = await temporary();
  const app = await startDashboard({
    port: 0,
    dataDirectory: temp.path,
    development: true,
    fetchUsage,
  });
  try {
    const response = await app.inject({
      method: "PUT",
      url: "/api/dispatch-settings",
      payload: {
        autoApply: false,
        keepSessionActive: false,
        sessionReservePercent: 30,
        weeklyMarginPercent: 5,
        busyHoursReservePercent: 100,
        quietStartHours: 6,
        maxConcurrentRuns: 2,
        runWeeklyCostPercent: 3,
      },
    });
    expect(response.statusCode).toBe(200);
    const { DispatchSettingsStore } = await import(
      "../server/dispatch-settings.js"
    );
    expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual(
      response.json().settings,
    );
    await app.inject({ method: "POST", url: "/api/usage/refresh" });
    const { UsageHistoryStore } = await import("../server/usage-history.js");
    expect(
      (await UsageHistoryStore.open(temp.path)).recent(new Date()),
    ).toHaveLength(1);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it.each([undefined, "127.0.0.1"])(
  "binds loopback with SESSIONMAXXING_HOST=%s, owns an exclusive runtime lock, and releases it on server shutdown",
  async (host) => {
    vi.stubEnv("SESSIONMAXXING_HOST", host);
    const temp = await temporary();
    const options = {
      port: 0,
      dataDirectory: temp.path,
      development: true,
      fetchUsage,
      loadHistory: async () => ({
        events: [],
        health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
      }),
    };
    try {
      const app = await startDashboard(options);
      try {
        expect(app.server.address()).toMatchObject({ address: "127.0.0.1" });
        await expect(startDashboard(options)).rejects.toThrow(
          join(temp.path, "server.lock"),
        );
        expect((await app.inject("/api/queue")).json()).toMatchObject({
          autoDispatch: false,
          tasks: [],
        });
      } finally {
        await app.close();
      }
      const restarted = await startDashboard(options);
      await restarted.close();
    } finally {
      await temp.cleanup();
    }
  },
);

it("creates the data directory and every missing parent with mode 0700", async () => {
  const temp = await temporary();
  const levels = [join(temp.path, "a"), join(temp.path, "a", "b")];
  const dataDirectory = join(levels[1], "c");
  try {
    const app = await startDashboard({
      port: 0,
      dataDirectory,
      development: true,
      fetchUsage,
    });
    try {
      for (const level of [...levels, dataDirectory])
        expect((await stat(level)).mode & 0o777).toBe(0o700);
    } finally {
      await app.close();
    }
  } finally {
    await temp.cleanup();
  }
});

it("binds all container interfaces when SESSIONMAXXING_HOST is explicitly 0.0.0.0 and still validates requests", async () => {
  vi.stubEnv("SESSIONMAXXING_HOST", "0.0.0.0");
  vi.stubEnv("SESSIONMAXXING_ALLOWED_HOSTS", "192.0.2.10");
  const temp = await temporary();
  try {
    const app = await startDashboard({
      port: 0,
      dataDirectory: temp.path,
      development: true,
      fetchUsage,
    });
    try {
      expect(app.server.address()).toMatchObject({ address: "0.0.0.0" });
      await quietHoursReady(app);
      const allowed = await app.inject({
        url: "/api/queue",
        headers: {
          host: "192.0.2.10:4317",
          origin: "http://192.0.2.10:4317",
        },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({
        autoDispatch: false,
        tasks: [],
        runnerError: null,
        planning: (await app.inject("/api/dispatch-settings")).json(),
        sessionKeeper: { lastStartedAt: null, error: null },
      });
      const denied = await app.inject({
        url: "/api/queue",
        headers: { host: "192.0.2.11:4317" },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  } finally {
    await temp.cleanup();
  }
});

it("ignores the shell's HOST and binds loopback", async () => {
  vi.stubEnv("HOST", "0.0.0.0");
  const temp = await temporary();
  try {
    const app = await startDashboard({
      port: 0,
      dataDirectory: temp.path,
      development: true,
      fetchUsage,
    });
    try {
      expect(app.server.address()).toMatchObject({ address: "127.0.0.1" });
    } finally {
      await app.close();
    }
  } finally {
    await temp.cleanup();
  }
});

it("rejects an out-of-range SESSIONMAXXING_PORT before touching runtime state", async () => {
  vi.stubEnv("SESSIONMAXXING_PORT", "70000");
  const temp = await temporary();
  const dataDirectory = join(temp.path, "runtime");
  try {
    await expect(
      startDashboard({ dataDirectory, development: true, fetchUsage }).then(
        (app) => app.close(),
      ),
    ).rejects.toThrow(
      "SESSIONMAXXING_PORT must be an integer from 1 to 65535.",
    );
    await expect(access(dataDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await temp.cleanup();
  }
});

it("rejects unsupported SESSIONMAXXING_HOST values before touching runtime state", async () => {
  const temp = await temporary();
  const dataDirectory = join(temp.path, "runtime");
  try {
    for (const host of ["", "localhost", "example.test", "0.0.0.0 "]) {
      vi.stubEnv("SESSIONMAXXING_HOST", host);
      await expect(
        startDashboard({
          port: 0,
          dataDirectory,
          development: true,
          fetchUsage,
        }).then((app) => app.close()),
      ).rejects.toThrow("SESSIONMAXXING_HOST");
      await expect(access(dataDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  } finally {
    await temp.cleanup();
  }
});

it("rejects an unsupported SESSIONMAXXING_EDITION before touching runtime state and starts with full", async () => {
  const temp = await temporary();
  const dataDirectory = join(temp.path, "runtime");
  try {
    vi.stubEnv("SESSIONMAXXING_EDITION", "lite");
    await expect(
      startDashboard({
        port: 0,
        dataDirectory,
        development: true,
        fetchUsage,
      }).then((app) => app.close()),
    ).rejects.toThrow("SESSIONMAXXING_EDITION");
    await expect(access(dataDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    vi.stubEnv("SESSIONMAXXING_EDITION", "full");
    const app = await startDashboard({
      port: 0,
      dataDirectory,
      development: true,
      fetchUsage,
    });
    await app.close();
  } finally {
    await temp.cleanup();
  }
});

it("rejects a malformed SESSIONMAXXING_ALLOWED_HOSTS entry before touching runtime state", async () => {
  vi.stubEnv("SESSIONMAXXING_ALLOWED_HOSTS", "dashboard.example.test:4317");
  const temp = await temporary();
  const dataDirectory = join(temp.path, "runtime");
  try {
    await expect(
      startDashboard({
        port: 0,
        dataDirectory,
        development: true,
        fetchUsage,
      }).then((app) => app.close()),
    ).rejects.toThrow(
      /SESSIONMAXXING_ALLOWED_HOSTS.*"dashboard\.example\.test:4317"/,
    );
    await expect(access(dataDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await temp.cleanup();
  }
});

it("wires persisted dispatch settings and live usage planning into the dashboard lifecycle", async () => {
  const temp = await temporary();
  const app = await startDashboard({
    port: 0,
    dataDirectory: temp.path,
    development: true,
    fetchUsage,
  });
  try {
    await quietHoursReady(app);
    const response = await app.inject("/api/dispatch-settings");
    expect(response.statusCode).toBe(200);
    const { DispatchSettingsStore } = await import(
      "../server/dispatch-settings.js"
    );
    expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual(
      response.json().settings,
    );
    expect((await app.inject("/api/queue")).json().planning).toEqual(
      response.json(),
    );
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("serves the configured time zone and work-directory root", async () => {
  const temp = await temporary();
  const app = await startDashboard({
    port: 0,
    dataDirectory: temp.path,
    development: true,
    fetchUsage,
    timeZone: "Europe/Berlin",
    workdirRoot: temp.path,
  });
  try {
    expect((await app.inject("/api/environment")).json()).toEqual({
      timeZone: "Europe/Berlin",
      workdirRoot: temp.path,
    });
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("rejects an invalid SESSIONMAXXING_WORKDIR_ROOT before creating the data directory", async () => {
  const temp = await temporary();
  const dataDirectory = join(temp.path, "data");
  vi.stubEnv("SESSIONMAXXING_WORKDIR_ROOT", join(temp.path, "missing"));
  try {
    await expect(
      startDashboard({
        port: 0,
        dataDirectory,
        development: true,
        fetchUsage,
        timeZone: "Europe/Berlin",
      }),
    ).rejects.toThrow("SESSIONMAXXING_WORKDIR_ROOT");
    await expect(access(dataDirectory)).rejects.toThrow();
  } finally {
    await temp.cleanup();
  }
});

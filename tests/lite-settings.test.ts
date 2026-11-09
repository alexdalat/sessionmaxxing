import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import {
  DispatchSettingsStore,
  validateSettings,
} from "../server/dispatch-settings.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type HistoryData,
} from "../shared/types.js";
import {
  TEST_TIME_ZONE,
  TEST_WORKDIR_ROOT,
  temporary,
  usageSnapshot,
} from "./helpers";

const EIGHT_KEYS = {
  autoApply: true,
  keepSessionActive: false,
  sessionReservePercent: 40,
  busyHoursReservePercent: 60,
  weeklyMarginPercent: 5,
  quietStartHours: 6,
  maxConcurrentRuns: 3,
  runWeeklyCostPercent: 4,
};
const HOLD_DEFAULT = 10;
const emptyHistory = async (): Promise<HistoryData> => ({
  events: [],
  health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
});

describe("runSessionHoldPercent validation", () => {
  it.each([0, 10.5, 100])("accepts %j", (value) => {
    expect(() =>
      validateSettings({
        ...DEFAULT_DISPATCH_SETTINGS,
        runSessionHoldPercent: value,
      }),
    ).not.toThrow();
  });

  it.each([-1, 101, "10", null, Number.NaN])("rejects %j", (value) => {
    expect(() =>
      validateSettings({
        ...DEFAULT_DISPATCH_SETTINGS,
        runSessionHoldPercent: value,
      }),
    ).toThrow(/Dispatch settings need/);
  });

  it("rejects settings that lack the key", () => {
    const { runSessionHoldPercent: _hold, ...eight } =
      DEFAULT_DISPATCH_SETTINGS;
    expect(() => validateSettings(eight)).toThrow(/Dispatch settings need/);
  });

  it("names the hold in the validation message", () => {
    expect(() =>
      validateSettings({ ...DEFAULT_DISPATCH_SETTINGS, autoApply: 1 }),
    ).toThrow(/session hold from 0 to 100%/);
  });
});

describe("dispatch-settings.json migration", () => {
  it("opens an eight-key file with the default hold and rewrites it with nine keys", async () => {
    const temp = await temporary();
    const path = join(temp.path, "dispatch-settings.json");
    try {
      await writeFile(path, JSON.stringify(EIGHT_KEYS));
      expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual({
        ...EIGHT_KEYS,
        runSessionHoldPercent: HOLD_DEFAULT,
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        ...EIGHT_KEYS,
        runSessionHoldPercent: HOLD_DEFAULT,
      });
    } finally {
      await temp.cleanup();
    }
  });

  it("drops a stored runSessionCostPercent and still adds the hold", async () => {
    const temp = await temporary();
    const path = join(temp.path, "dispatch-settings.json");
    try {
      await writeFile(
        path,
        JSON.stringify({ ...EIGHT_KEYS, runSessionCostPercent: 20 }),
      );
      const settings = (await DispatchSettingsStore.open(temp.path)).snapshot();
      expect(settings).toEqual({
        ...EIGHT_KEYS,
        runSessionHoldPercent: HOLD_DEFAULT,
      });
      expect(await readFile(path, "utf8")).not.toMatch(/runSessionCostPercent/);
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps a stored hold of its own", async () => {
    const temp = await temporary();
    const path = join(temp.path, "dispatch-settings.json");
    try {
      await writeFile(
        path,
        JSON.stringify({ ...EIGHT_KEYS, runSessionHoldPercent: 35 }),
      );
      expect(
        (await DispatchSettingsStore.open(temp.path)).snapshot()
          .runSessionHoldPercent,
      ).toBe(35);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("PUT /api/dispatch-settings with the hold", () => {
  async function liteApp(directory: string) {
    const queue = await QueueStore.open(directory, TEST_WORKDIR_ROOT, "lite");
    const runner = await Runner.open(queue, directory);
    const usage = new UsageMonitor(
      async () => usageSnapshot(),
      await UsageHistoryStore.open(directory),
    );
    return createApp({
      timeZone: TEST_TIME_ZONE,
      edition: "lite",
      queue,
      runner,
      usage,
      settings: await DispatchSettingsStore.open(directory),
      loadHistory: vi.fn(emptyHistory),
    });
  }
  const put = (
    app: Awaited<ReturnType<typeof liteApp>>,
    payload: Record<string, unknown>,
  ) => app.inject({ method: "PUT", url: "/api/dispatch-settings", payload });

  it("answers 400 when the key is missing", async () => {
    const temp = await temporary();
    const app = await liteApp(temp.path);
    try {
      const { runSessionHoldPercent: _hold, ...eight } =
        DEFAULT_DISPATCH_SETTINGS;
      expect((await put(app, eight)).statusCode).toBe(400);
    } finally {
      await app.close();
      await temp.cleanup();
    }
  });

  it.each([-1, 101, "10"])("answers 400 for a hold of %j", async (value) => {
    const temp = await temporary();
    const app = await liteApp(temp.path);
    try {
      const response = await put(app, {
        ...DEFAULT_DISPATCH_SETTINGS,
        runSessionHoldPercent: value,
      });
      expect(response.statusCode).toBe(400);
      expect(
        (await DispatchSettingsStore.open(temp.path)).snapshot()
          .runSessionHoldPercent,
      ).toBe(HOLD_DEFAULT);
    } finally {
      await app.close();
      await temp.cleanup();
    }
  });

  it("stores the sent hold and keeps the reserve and quiet hours unchanged", async () => {
    const temp = await temporary();
    const app = await liteApp(temp.path);
    const sent = {
      ...DEFAULT_DISPATCH_SETTINGS,
      busyHoursReservePercent: 55,
      quietStartHours: 5,
      runSessionHoldPercent: 17,
    };
    try {
      expect((await put(app, sent)).statusCode).toBe(200);
      expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual(
        sent,
      );
    } finally {
      await app.close();
      await temp.cleanup();
    }
  });
});

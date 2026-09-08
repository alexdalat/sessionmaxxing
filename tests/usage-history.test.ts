import { access, readFile, stat, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  HISTORY_DAYS,
  mergeSessionWindows,
  sessionWindows,
  toSample,
  UsageHistoryStore,
} from "../server/usage-history.js";
import type { ActivityEvent, UsageSample } from "../shared/types.js";
import { temporary, usageSnapshot } from "./helpers";

const sample = (
  at: string,
  session: number,
  sessionResetsAt: string | null,
): UsageSample => ({
  at,
  session,
  sessionResetsAt,
  weekly: 10,
  weeklyResetsAt: "2026-09-13T07:53:00.000Z",
  fable: null,
});

it("groups samples into five-hour windows by reset time, keeping each window's peak", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const windows = sessionWindows(
    [
      sample("2026-08-29T10:00:00Z", 90, "2026-08-29T14:00:00.000Z"),
      sample("2026-09-05T01:00:00Z", 12, "2026-09-05T05:00:00.000Z"),
      sample("2026-09-05T02:00:00Z", 40, "2026-09-05T05:00:00.000Z"),
      sample("2026-09-05T03:00:00Z", 33, "2026-09-05T05:00:00.000Z"),
      sample("2026-09-05T06:00:00Z", 0, null),
      sample("2026-09-05T07:00:00Z", 40, "2026-09-05T05:00:00.000Z"),
      sample("2026-09-06T11:00:00Z", 8, "2026-09-06T15:30:00.000Z"),
    ],
    now,
  );
  expect(windows).toEqual([
    {
      start: "2026-09-05T00:00:00.000Z",
      end: "2026-09-05T05:00:00.000Z",
      peakPercent: 40,
      activeMinutes: 0,
      samples: 3,
    },
    {
      start: "2026-09-06T10:30:00.000Z",
      end: "2026-09-06T15:30:00.000Z",
      peakPercent: 8,
      activeMinutes: 0,
      samples: 1,
    },
  ]);
});

it("merges samples whose reset time differs by milliseconds into one window", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const windows = sessionWindows(
    [
      sample("2026-09-06T02:04:00Z", 10, "2026-09-06T02:09:59.783Z"),
      sample("2026-09-06T02:05:00Z", 25, "2026-09-06T02:09:59.815Z"),
      sample("2026-09-06T02:06:00Z", 18, "2026-09-06T02:09:59.851Z"),
    ],
    now,
  );
  expect(windows).toHaveLength(1);
  expect(windows[0].samples).toBe(3);
  expect(windows[0].peakPercent).toBe(25);
});

it("keeps reset times a full five-hour block apart in separate windows", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const windows = sessionWindows(
    [
      sample("2026-09-05T21:00:00Z", 30, "2026-09-06T02:09:59.783Z"),
      sample("2026-09-06T03:00:00Z", 45, "2026-09-06T07:09:59.815Z"),
    ],
    now,
  );
  expect(windows).toHaveLength(2);
});

it("keeps windows older than the seven-day default when asked for more days", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const samples = [
    sample("2026-08-20T10:00:00Z", 55, "2026-08-20T14:00:00.000Z"),
    sample("2026-09-05T01:00:00Z", 12, "2026-09-05T05:00:00.000Z"),
  ];
  expect(sessionWindows(samples, now).map((w) => w.peakPercent)).toEqual([12]);
  expect(sessionWindows(samples, now, 30).map((w) => w.peakPercent)).toEqual([
    55, 12,
  ]);
});

const event = (timestamp: string): ActivityEvent => ({
  timestamp,
  project: "demo",
  model: "claude-opus-4-6",
  source: "local",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});
const sampledWindow = (activeMinutes = 0) => ({
  start: "2026-09-06T07:00:00.000Z",
  end: "2026-09-06T12:00:00.000Z",
  peakPercent: 20,
  activeMinutes,
  samples: 2,
});

it("adds a window inferred from local activity when no sampled window overlaps it", () => {
  expect(
    mergeSessionWindows(
      [sampledWindow()],
      [
        event("2026-09-04T01:00:00Z"),
        event("2026-09-04T01:00:30Z"),
        event("2026-09-04T01:02:00Z"),
      ],
      new Date("2026-09-06T12:00:00Z"),
    ),
  ).toEqual([
    {
      start: "2026-09-04T01:00:00.000Z",
      end: "2026-09-04T06:00:00.000Z",
      peakPercent: null,
      activeMinutes: 2,
      samples: 0,
    },
    sampledWindow(),
  ]);
});

it("drops an inferred block that overlaps a sampled window and gives that window its active minutes", () => {
  expect(
    mergeSessionWindows(
      [sampledWindow()],
      [
        event("2026-09-06T08:00:00Z"),
        event("2026-09-06T08:00:40Z"),
        event("2026-09-06T09:30:00Z"),
      ],
      new Date("2026-09-06T12:00:00Z"),
    ),
  ).toEqual([sampledWindow(2)]);
});

it("ignores activity older than the seven-day window", () => {
  expect(
    mergeSessionWindows(
      [],
      [event("2026-08-28T10:00:00Z"), event("2026-08-28T10:01:00Z")],
      new Date("2026-09-06T12:00:00Z"),
    ),
  ).toEqual([]);
});

it("infers two windows from events more than five hours apart", () => {
  expect(
    mergeSessionWindows(
      [],
      [event("2026-09-05T00:00:00Z"), event("2026-09-05T06:00:00Z")],
      new Date("2026-09-06T12:00:00Z"),
    ),
  ).toEqual([
    {
      start: "2026-09-05T00:00:00.000Z",
      end: "2026-09-05T05:00:00.000Z",
      peakPercent: null,
      activeMinutes: 1,
      samples: 0,
    },
    {
      start: "2026-09-05T06:00:00.000Z",
      end: "2026-09-05T11:00:00.000Z",
      peakPercent: null,
      activeMinutes: 1,
      samples: 0,
    },
  ]);
});

it("reports no active minutes for sampled windows when there is no local activity", () => {
  expect(
    mergeSessionWindows(
      [sampledWindow(99)],
      [],
      new Date("2026-09-06T12:00:00Z"),
    ),
  ).toEqual([sampledWindow(0)]);
});

it("persists samples as private JSONL, drops samples older than ninety days on open, and rejects corrupt lines", async () => {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  try {
    const store = await UsageHistoryStore.open(temp.path, now);
    const ancient = usageSnapshot({ fetchedAt: "2026-05-01T00:00:00.000Z" });
    const old = usageSnapshot({ fetchedAt: "2026-08-01T00:00:00.000Z" });
    const fresh = usageSnapshot();
    await store.record(ancient);
    await store.record(old);
    await store.record(fresh);
    const path = `${temp.path}/usage-samples.jsonl`;
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(3);
    const reopened = await UsageHistoryStore.open(temp.path, now);
    expect(reopened.recent(now, HISTORY_DAYS)).toEqual([
      toSample(old),
      toSample(fresh),
    ]);
    expect(reopened.recent(now)).toEqual([toSample(fresh)]);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    await writeFile(path, '{"at":"nope"}\n');
    await expect(UsageHistoryStore.open(temp.path)).rejects.toThrow(
      /unreadable sample/,
    );
  } finally {
    await temp.cleanup();
  }
});

const SNAPSHOT_PATH = "usage-snapshot.json";

it("restores the last snapshot on reopen while its weekly window is still open", async () => {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  try {
    const store = await UsageHistoryStore.open(temp.path, now);
    expect(store.snapshot()).toBeNull();
    const snapshot = usageSnapshot();
    await store.record(snapshot);
    const path = `${temp.path}/${SNAPSHOT_PATH}`;
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const reopened = await UsageHistoryStore.open(temp.path, now);
    expect(reopened.snapshot()).toEqual(snapshot);
  } finally {
    await temp.cleanup();
  }
});

it("drops a snapshot whose weekly window has already reset and removes its file", async () => {
  const temp = await temporary();
  try {
    const store = await UsageHistoryStore.open(
      temp.path,
      new Date("2026-09-06T12:00:00Z"),
    );
    await store.record(usageSnapshot());
    const reopened = await UsageHistoryStore.open(
      temp.path,
      new Date("2026-09-13T09:00:00Z"),
    );
    expect(reopened.snapshot()).toBeNull();
    await expect(access(`${temp.path}/${SNAPSHOT_PATH}`)).rejects.toThrow();
  } finally {
    await temp.cleanup();
  }
});

it("rejects a corrupt snapshot file instead of starting with no usage", async () => {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  const path = `${temp.path}/${SNAPSHOT_PATH}`;
  try {
    await writeFile(path, "{not json");
    await expect(UsageHistoryStore.open(temp.path, now)).rejects.toThrow(
      /not valid JSON/,
    );
    await writeFile(
      path,
      JSON.stringify({ ...usageSnapshot(), weekly: { percent: "lots" } }),
    );
    await expect(UsageHistoryStore.open(temp.path, now)).rejects.toThrow(
      /unreadable snapshot/,
    );
  } finally {
    await temp.cleanup();
  }
});

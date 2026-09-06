import { readFile, stat, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  sessionWindows,
  toSample,
  UsageHistoryStore,
} from "../server/usage-history.js";
import type { UsageSample } from "../shared/types.js";
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
      samples: 3,
    },
    {
      start: "2026-09-06T10:30:00.000Z",
      end: "2026-09-06T15:30:00.000Z",
      peakPercent: 8,
      samples: 1,
    },
  ]);
});

it("persists samples as private JSONL, drops samples older than fourteen days on open, and rejects corrupt lines", async () => {
  const temp = await temporary();
  try {
    const store = await UsageHistoryStore.open(
      temp.path,
      new Date("2026-09-06T12:00:00Z"),
    );
    const old = toSample(
      usageSnapshot({ fetchedAt: "2026-08-01T00:00:00.000Z" }),
    );
    const fresh = toSample(usageSnapshot());
    await store.add(old);
    await store.add(fresh);
    const path = `${temp.path}/usage-samples.jsonl`;
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    const reopened = await UsageHistoryStore.open(
      temp.path,
      new Date("2026-09-06T12:00:00Z"),
    );
    expect(reopened.recent(new Date("2026-09-06T12:00:00Z"))).toEqual([fresh]);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
    await writeFile(path, '{"at":"nope"}\n');
    await expect(UsageHistoryStore.open(temp.path)).rejects.toThrow(
      /unreadable sample/,
    );
  } finally {
    await temp.cleanup();
  }
});

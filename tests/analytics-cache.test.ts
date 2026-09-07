import { expect, it } from "vitest";
import {
  analyticsCacheKey,
  readCachedAnalytics,
  writeCachedAnalytics,
} from "../app/analyticsCache.js";
import { aggregate } from "../server/analytics.js";
import type { ActivityEvent } from "../shared/types.js";

function fakeStorage(entries: [string, string][] = []) {
  const map = new Map(entries);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

const event: ActivityEvent = {
  timestamp: "2026-09-05T14:31:02.104Z",
  project: "-home-user-workspace-claude-capacity-dashboard",
  model: "claude-opus-4-5-20251101",
  inputTokens: 12,
  outputTokens: 431,
  cacheReadTokens: 118_402,
  cacheCreationTokens: 2_311,
};

const analytics = aggregate(
  {
    events: [event],
    health: { files: 1, lines: 1, warnings: 0, historyEntries: 0 },
  },
  7,
  new Date("2026-09-05T20:00:00.000Z"),
);

it("returns the analytics that were written for the same range", () => {
  const storage = fakeStorage();
  writeCachedAnalytics(storage, 7, analytics);
  expect(readCachedAnalytics(storage, 7)).toEqual(analytics);
});

it("returns undefined when nothing was cached for that range", () => {
  const storage = fakeStorage();
  writeCachedAnalytics(storage, 7, analytics);
  expect(readCachedAnalytics(storage, 30)).toBeUndefined();
});

it("drops a corrupt entry and reports a miss", () => {
  const storage = fakeStorage([[analyticsCacheKey(14), "{not json"]]);
  expect(readCachedAnalytics(storage, 14)).toBeUndefined();
  expect(storage.map.has(analyticsCacheKey(14))).toBe(false);
});

it("keys each range separately", () => {
  const storage = fakeStorage();
  writeCachedAnalytics(storage, 7, analytics);
  writeCachedAnalytics(storage, 90, { ...analytics, days: 90 });
  expect(analyticsCacheKey(7)).not.toBe(analyticsCacheKey(90));
  expect(readCachedAnalytics(storage, 7)?.days).toBe(7);
  expect(readCachedAnalytics(storage, 90)?.days).toBe(90);
});

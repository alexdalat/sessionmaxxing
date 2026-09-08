import type { Analytics, RangeDays } from "@/shared/types";

const CACHE_VERSION = "v1";

type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function analyticsCacheKey(days: RangeDays) {
  return `analytics:${CACHE_VERSION}:${days}`;
}

export function readCachedAnalytics(
  storage: CacheStorage,
  days: RangeDays,
): Analytics | undefined {
  const key = analyticsCacheKey(days);
  const raw = storage.getItem(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as Analytics;
  } catch {
    storage.removeItem(key);
    return undefined;
  }
}

export function writeCachedAnalytics(
  storage: CacheStorage,
  days: RangeDays,
  analytics: Analytics,
) {
  storage.setItem(analyticsCacheKey(days), JSON.stringify(analytics));
}

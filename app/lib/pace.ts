import {
  MINUTE_MS,
  resetMinute,
  type UsageSample,
  type UsageSnapshot,
  WEEK_MINUTES,
  WEEKLY_HARD_CEILING_PERCENT,
} from "@/shared/types";
import { easternDay } from "./time";

const WEEK_MS = WEEK_MINUTES * MINUTE_MS;
const DAY_MS = 86_400_000;
const round = (value: number) => Math.round(value * 10) / 10;

export interface PacePoint {
  t: number;
  weekly?: number;
  fable?: number;
  pace: number;
  ceiling: number;
}
/** Samples inside the current weekly window plus the linear pace to its reset. */
export function paceSeries(
  samples: UsageSample[],
  snapshot: UsageSnapshot,
  marginPercent: number,
): PacePoint[] | null {
  if (snapshot.weekly.resetsAt === null) return null;
  const reset = Date.parse(snapshot.weekly.resetsAt);
  const week = resetMinute(snapshot.weekly.resetsAt);
  const start = reset - WEEK_MS;
  const paceAt = (t: number) =>
    round(Math.min(1, Math.max(0, (t - start) / WEEK_MS)) * 100);
  const ceilingAt = (t: number) =>
    Math.min(WEEKLY_HARD_CEILING_PERCENT, round(paceAt(t) + marginPercent));
  const points: PacePoint[] = samples
    .filter(
      (sample) =>
        sample.weeklyResetsAt !== null &&
        resetMinute(sample.weeklyResetsAt) === week,
    )
    .map((sample) => {
      const t = Date.parse(sample.at);
      return {
        t,
        weekly: sample.weekly,
        ...(sample.fable === null ? {} : { fable: sample.fable }),
        pace: paceAt(t),
        ceiling: ceilingAt(t),
      };
    });
  const lastSampleT = points.length
    ? points[points.length - 1].t
    : Number.NEGATIVE_INFINITY;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  const nowPoint: PacePoint | null =
    fetchedAt > lastSampleT && fetchedAt < reset
      ? {
          t: fetchedAt,
          weekly: snapshot.weekly.percent,
          ...(snapshot.fable === null ? {} : { fable: snapshot.fable.percent }),
          pace: paceAt(fetchedAt),
          ceiling: ceilingAt(fetchedAt),
        }
      : null;
  return [
    { t: start, pace: 0, ceiling: ceilingAt(start) },
    ...points,
    ...(nowPoint ? [nowPoint] : []),
    { t: reset, pace: 100, ceiling: ceilingAt(reset) },
  ].sort((a, b) => a.t - b.t);
}

/** Eastern midnights inside [start, end], one tick per calendar day. */
export function dayTicks(start: number, end: number): number[] {
  const ticks: number[] = [];
  for (let t = start; t <= end + DAY_MS; t += DAY_MS) {
    const midnight = t - easternDay(t).fraction * DAY_MS;
    if (midnight >= start && midnight <= end && !ticks.includes(midnight))
      ticks.push(midnight);
  }
  return ticks;
}

import { localParts, localStart, shiftDate } from "@/shared/local-time";
import {
  MINUTE_MS,
  resetMinute,
  type UsageSample,
  type UsageSnapshot,
  WEEK_MINUTES,
  WEEKLY_HARD_CEILING_PERCENT,
} from "@/shared/types";

const WEEK_MS = WEEK_MINUTES * MINUTE_MS;
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

/** Local midnights inside [start, end], one tick per calendar day. */
export function dayTicks(
  start: number,
  end: number,
  timeZone: string,
): number[] {
  const ticks: number[] = [];
  const lastDate = localParts(end, timeZone).date;
  for (
    let date = localParts(start, timeZone).date;
    date <= lastDate;
    date = shiftDate(date, 1)
  ) {
    const midnight = localStart(date, 0, timeZone);
    if (midnight >= start && midnight <= end) ticks.push(midnight);
  }
  return ticks;
}

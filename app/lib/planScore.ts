import {
  type Breakdown,
  OTHER_SERIES,
  type Partitioned,
  partitionKeys,
  partitionShares,
} from "@/app/lib/activitySeries";
import { localStart } from "@/shared/local-time";
import type { ActivitySource, CoverageDay, PlanScore } from "@/shared/types";

const LOCAL_NOON_HOUR = 12;
const UNATTRIBUTED_SOURCE: ActivitySource = "unknown";

export interface ScoreRow {
  date: string;
  coverage: number | null;
  weekly: number | null;
  [series: string]: number | string | null;
}

function unattributedKey(breakdown: Breakdown) {
  return breakdown === "source" ? UNATTRIBUTED_SOURCE : OTHER_SERIES;
}

function splitCoverage(
  day: Partitioned,
  breakdown: Breakdown,
  keys: string[],
  coverage: number,
) {
  const split: Record<string, number> = Object.fromEntries(
    keys.map((key) => [key, 0]),
  );
  if (coverage === 0) return split;
  const shares = partitionShares(day, breakdown, keys);
  const total = Object.values(shares).reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    split[unattributedKey(breakdown)] = coverage;
    return split;
  }
  let largest = keys[0];
  for (const key of keys) {
    split[key] = Math.round((coverage * shares[key]) / total);
    if (shares[key] > shares[largest]) largest = key;
  }
  const rounded = Object.values(split).reduce((sum, value) => sum + value, 0);
  split[largest] = Math.round((split[largest] + coverage - rounded) * 10) / 10;
  return split;
}

/** One row per sampled day: its session coverage split by owner, and the score of the week containing it. */
export function scoreSeries(
  plan: PlanScore,
  breakdown: Breakdown,
  timeZone: string,
): { keys: string[]; rows: ScoreRow[] } {
  const keys = partitionKeys(plan.days, breakdown);
  const unattributed = unattributedKey(breakdown);
  const needsUnattributed = (day: CoverageDay) =>
    day.coverage !== null &&
    day.coverage > 0 &&
    Object.values(partitionShares(day, breakdown, keys)).every(
      (minutes) => minutes === 0,
    );
  if (!keys.includes(unattributed) && plan.days.some(needsUnattributed))
    keys.push(unattributed);
  const rows = plan.days.map((day) => {
    const midday = localStart(day.date, LOCAL_NOON_HOUR, timeZone);
    const week = plan.weeks.find(
      (candidate) =>
        midday >= Date.parse(candidate.start) &&
        midday < Date.parse(candidate.end),
    );
    const row: ScoreRow = {
      date: day.date,
      coverage: day.coverage,
      weekly: week ? week.score : null,
    };
    if (day.coverage !== null)
      Object.assign(row, splitCoverage(day, breakdown, keys, day.coverage));
    return row;
  });
  return { keys, rows };
}

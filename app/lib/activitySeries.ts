import {
  ACTIVITY_SOURCE_COLORS,
  FABLE_COLOR,
  MODEL_SERIES_COLORS,
  MUTED_COLOR,
} from "@/app/lib/chart";
import { modelLabel } from "@/app/lib/models";
import {
  ACTIVITY_SOURCE_LABELS,
  ACTIVITY_SOURCES,
  type ActivitySource,
  type DailyActivity,
  FABLE_MODEL,
} from "@/shared/types";

export type Breakdown = "source" | "model";
export const BREAKDOWNS: { value: Breakdown; label: string }[] = [
  { value: "source", label: "Source" },
  { value: "model", label: "Model" },
];
export const MAX_MODEL_SERIES = 4;
export const OTHER_SERIES = "Other";

export interface ActivityRow {
  date: string;
  responses: number;
  activeMinutes: number;
  [series: string]: number | string;
}

/** A day whose active minutes are already split by owner: both DailyActivity and CoverageDay. */
export interface Partitioned {
  date: string;
  sources: Record<ActivitySource, number>;
  models: Record<string, number>;
}

function modelKeys(daily: Partitioned[]) {
  const totals = new Map<string, number>();
  for (const day of daily)
    for (const [model, minutes] of Object.entries(day.models))
      totals.set(model, (totals.get(model) ?? 0) + minutes);
  const ranked = [...totals]
    .sort((a, b) => b[1] - a[1])
    .map(([model]) => model);
  const top = ranked.slice(0, MAX_MODEL_SERIES);
  const folded = ranked.slice(MAX_MODEL_SERIES);
  const otherMinutes = folded.reduce(
    (sum, model) => sum + (totals.get(model) ?? 0),
    0,
  );
  return otherMinutes > 0 ? [...top, OTHER_SERIES] : top;
}

export function partitionKeys(days: Partitioned[], breakdown: Breakdown) {
  return breakdown === "source" ? [...ACTIVITY_SOURCES] : modelKeys(days);
}

/** Active minutes of `day` per key, with the models outside `keys` folded into Other. */
export function partitionShares(
  day: Partitioned,
  breakdown: Breakdown,
  keys: string[],
) {
  const named = new Set(keys);
  const shares: Record<string, number> = {};
  for (const key of keys)
    shares[key] =
      key === OTHER_SERIES
        ? Object.entries(day.models)
            .filter(([model]) => !named.has(model))
            .reduce((sum, [, value]) => sum + value, 0)
        : breakdown === "source"
          ? day.sources[key as ActivitySource]
          : (day.models[key] ?? 0);
  return shares;
}

export function activitySeries(daily: DailyActivity[], breakdown: Breakdown) {
  const keys = partitionKeys(daily, breakdown);
  const rows = daily.map((day) => {
    const row: ActivityRow = {
      date: day.date,
      responses: day.responses,
      activeMinutes: day.activeMinutes,
      ...partitionShares(day, breakdown, keys),
    };
    return row;
  });
  return { keys, rows };
}

export function seriesLabel(breakdown: Breakdown, key: string) {
  return breakdown === "source"
    ? ACTIVITY_SOURCE_LABELS[key as ActivitySource]
    : modelLabel(key);
}

export function seriesColor(breakdown: Breakdown, key: string, index: number) {
  if (breakdown === "source")
    return ACTIVITY_SOURCE_COLORS[key as ActivitySource];
  if (FABLE_MODEL.test(key)) return FABLE_COLOR;
  if (key === OTHER_SERIES) return MUTED_COLOR;
  return MODEL_SERIES_COLORS[index % MODEL_SERIES_COLORS.length];
}

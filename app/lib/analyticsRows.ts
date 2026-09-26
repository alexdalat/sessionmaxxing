import {
  ACTIVITY_SOURCE_LABELS,
  EXTERNAL_SOURCE_LABEL,
  type HeatCell,
  type SourceActivity,
} from "@/shared/types";

export const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US").format(value);

export interface SourceRow {
  label: string;
  responses: number;
  activeMinutes: number;
  tokens: number;
  measured: boolean;
}

export function sourceRows(sources: SourceActivity[]): SourceRow[] {
  const measured = sources
    .filter((entry) => entry.source !== "unknown" || entry.responses > 0)
    .map(({ source, activeMinutes, responses, tokens }) => ({
      label: ACTIVITY_SOURCE_LABELS[source],
      responses,
      activeMinutes,
      tokens,
      measured: true,
    }));
  return [
    ...measured,
    {
      label: EXTERNAL_SOURCE_LABEL,
      responses: 0,
      activeMinutes: 0,
      tokens: 0,
      measured: false,
    },
  ];
}

const WEEKDAYS = 7;
const HOURS_PER_DAY = 24;
export interface HeatmapTotals {
  /** Active minutes per weekday, Sunday first. */
  days: number[];
  /** Active minutes per hour of the day. */
  hours: number[];
  total: number;
}
export function heatmapTotals(heatmap: HeatCell[]): HeatmapTotals {
  const days = new Array<number>(WEEKDAYS).fill(0);
  const hours = new Array<number>(HOURS_PER_DAY).fill(0);
  let total = 0;
  for (const cell of heatmap) {
    days[cell.day] += cell.activeMinutes;
    hours[cell.hour] += cell.activeMinutes;
    total += cell.activeMinutes;
  }
  return { days, hours, total };
}

import { localParts, weekdayIndex } from "@/shared/local-time";

const MINUTES_PER_DAY = 24 * 60;
/** Local calendar date plus the fraction of that day already elapsed. */
export function localDay(time: string | number, timeZone: string) {
  const { date, hour, minute } = localParts(time, timeZone);
  return { date, fraction: (hour * 60 + minute) / MINUTES_PER_DAY };
}
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Local weekday (0 = Sunday) and hour of the clock time, matching the heatmap grid. */
export function localCell(time: string | number, timeZone: string) {
  const { day, hour } = localParts(time, timeZone);
  return { day, hour };
}
export const weekdayOf = (date: string) => WEEKDAY_NAMES[weekdayIndex(date)];
export const WEEKDAYS = WEEKDAY_NAMES;

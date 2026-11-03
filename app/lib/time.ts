import { localParts } from "@/shared/local-time";
import { TIME_ZONE } from "@/shared/types";

const MINUTES_PER_DAY = 24 * 60;
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function fixedZoneParts(time: string | number) {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(time)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}
/** Local calendar date plus the fraction of that day already elapsed. */
export function localDay(time: string | number, timeZone: string) {
  const { date, hour, minute } = localParts(time, timeZone);
  return { date, fraction: (hour * 60 + minute) / MINUTES_PER_DAY };
}
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekdayIndex = (date: string) =>
  new Date(`${date}T12:00:00Z`).getUTCDay();
/** Eastern weekday (0 = Sunday) and hour of the clock time, matching the heatmap grid. */
export function easternCell(time: string | number) {
  const { date, hour } = fixedZoneParts(time);
  return { day: weekdayIndex(date), hour };
}
export const weekdayOf = (date: string) => WEEKDAY_NAMES[weekdayIndex(date)];
export const WEEKDAYS = WEEKDAY_NAMES;

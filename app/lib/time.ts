import { TIME_ZONE } from "@/shared/types";

const MINUTES_PER_DAY = 24 * 60;
const DAY_MS = 86_400_000;
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const localClock = (time: string | number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(time));

/** Eastern calendar date plus the fraction of that day already elapsed. */
export function easternDay(time: string | number) {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(time)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    fraction:
      (Number(parts.hour) * 60 + Number(parts.minute)) / MINUTES_PER_DAY,
  };
}
export const shiftDate = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
export const weekdayOf = (date: string) =>
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(`${date}T12:00:00Z`).getUTCDay()
  ];

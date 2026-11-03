import { hourLabel, type SessionWindow } from "@/shared/types";
import { localDay } from "./time";

const HOURS = 24;
const MINUTES_PER_DAY = HOURS * 60;

/** Clock label for a fraction of a local day, to the minute: 0.5 → 12:00 PM. */
export function clockOfFraction(fraction: number) {
  const minutes = Math.round(
    Math.min(1, Math.max(0, fraction)) * MINUTES_PER_DAY,
  );
  const hours = Math.floor(minutes / 60) % HOURS;
  const [clock, meridiem] = hourLabel(hours).split(" ");
  return `${clock}:${String(minutes % 60).padStart(2, "0")} ${meridiem}`;
}

interface Segment {
  date: string;
  from: number;
  to: number;
  window: SessionWindow;
}
export function daySegments(
  windows: SessionWindow[],
  timeZone: string,
): Segment[] {
  return windows.flatMap((window) => {
    const start = localDay(window.start, timeZone);
    const end = localDay(window.end, timeZone);
    if (start.date === end.date)
      return [
        { date: start.date, from: start.fraction, to: end.fraction, window },
      ];
    return [
      { date: start.date, from: start.fraction, to: 1, window },
      { date: end.date, from: 0, to: end.fraction, window },
    ];
  });
}

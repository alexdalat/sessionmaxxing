import { INK, PAPER } from "@/app/lib/palette";
import { BLOCK_MINUTES, hourLabel, type SessionWindow } from "@/shared/types";
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

const PERCENT_SCALE = 100;

export const WINDOW_ALPHA_STEPS = [
  { from: 0, alpha: 0.18, label: INK },
  { from: 25, alpha: 0.4, label: INK },
  { from: 50, alpha: 0.75, label: PAPER },
  { from: 75, alpha: 1, label: PAPER },
] as const;

export function quantizeWindowAlpha(percent: number) {
  return WINDOW_ALPHA_STEPS.reduce(
    (chosen, step) => (percent >= step.from ? step : chosen),
    WINDOW_ALPHA_STEPS[0],
  );
}

export function windowPercent(window: SessionWindow) {
  return (
    window.peakPercent ?? (window.activeMinutes / BLOCK_MINUTES) * PERCENT_SCALE
  );
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

import {
  type DispatchSettings,
  hourLabel,
  type QuietHours,
  quietHoursOnly,
} from "@/shared/types";

/** Collapses sorted hours into ranges, wrapping past midnight: 10 PM–7 AM, 12 PM. */
export function describeHours(hours: number[]) {
  if (hours.length === 0) return "none";
  if (hours.length === 24) return "all day";
  const set = new Set(hours);
  const starts = hours.filter((h) => !set.has((h + 23) % 24));
  return starts
    .map((start) => {
      let end = start;
      while (set.has((end + 1) % 24)) end = (end + 1) % 24;
      return start === end
        ? hourLabel(start)
        : `${hourLabel(start)}–${hourLabel(end)}`;
    })
    .join(", ");
}
export function quietSummary(quiet: QuietHours, settings: DispatchSettings) {
  if (quiet.startHours === null)
    return `Quiet hours not computed yet${quiet.error ? ` (${quiet.error})` : ""}`;
  const budgets = quietHoursOnly(settings)
    ? ""
    : ` keep ${settings.sessionReservePercent}% · other hours keep ${settings.busyHoursReservePercent}%`;
  const list = `Quiet hours ${describeHours(quiet.startHours)}${budgets}`;
  if (quiet.active) return `${list} · open now`;
  return `${list} · opens ${quiet.nextStartHour === null ? "never" : hourLabel(quiet.nextStartHour)}`;
}

const GREEN_HUE = 145;
/** Green at zero, amber midway, red at or past the ceiling. */
export function usageHue(percent: number, ceiling: number) {
  const ratio = ceiling > 0 ? Math.min(1, Math.max(0, percent / ceiling)) : 1;
  return Math.round(GREEN_HUE * (1 - ratio));
}

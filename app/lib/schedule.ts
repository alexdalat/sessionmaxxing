import { fromLocalInput, toLocalInput, zoneName } from "@/shared/local-time";
import { BLOCK_MINUTES, hourLabel } from "@/shared/types";

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const BLOCK_HOURS = BLOCK_MINUTES / MINUTES_PER_HOUR;

export const windowRangeLabel = (start: number, timeZone: string, at: number) =>
  `${hourLabel(start)} → ${hourLabel((start + BLOCK_HOURS) % HOURS_PER_DAY)} ${zoneName(timeZone, at)}`;

export const earliestStartInput = (
  earliestStart: string | null,
  timeZone: string,
) => (earliestStart === null ? "" : toLocalInput(earliestStart, timeZone));

export const earliestStartFromInput = (value: string, timeZone: string) =>
  value === "" ? null : fromLocalInput(value, timeZone);

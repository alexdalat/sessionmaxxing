const QUARTER_HOUR_MS = 900_000;
const DAY_MS = 86_400_000;
const MS_PER_SECOND = 1000;
const NOON_SUFFIX = "T12:00:00Z";
const DATE_LENGTH = "YYYY-MM-DD".length;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

export function localParts(time: Date | string | number, timeZone: string) {
  const instant = new Date(time).getTime();
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    day: weekdayIndex(date),
    // Wall clock minus instant stays exact for +05:30, +05:45, +10:30 and across DST.
    offsetMs: wall - Math.floor(instant / MS_PER_SECOND) * MS_PER_SECOND,
  };
}

/** Instant of a local wall time; a nonexistent time moves forward by the gap and an ambiguous one takes the earlier instant. */
export function localStart(
  date: string,
  hour: number,
  timeZone: string,
  minute = 0,
): number {
  const wall = Date.parse(
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
  );
  // The matching instant lies within [wall - 14 h, wall + 12 h]; sampling a day either side sees the offset before and after any transition that can matter.
  const offsets = new Set(
    [-DAY_MS, DAY_MS].map(
      (shift) => localParts(wall + shift, timeZone).offsetMs,
    ),
  );
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .sort((a, b) => a - b);
  return (
    candidates.find((candidate) => {
      const parts = localParts(candidate, timeZone);
      return (
        parts.date === date && parts.hour === hour && parts.minute === minute
      );
    }) ?? candidates[candidates.length - 1]
  );
}

/** First local hour boundary strictly after `at`; real zone offsets are multiples of 15 minutes, so stepping that grid finds it. */
export function nextLocalHour(at: number, timeZone: string): number {
  let step = (Math.floor(at / QUARTER_HOUR_MS) + 1) * QUARTER_HOUR_MS;
  while (localParts(step, timeZone).minute !== 0) step += QUARTER_HOUR_MS;
  return step;
}

export const shiftDate = (date: string, days: number) =>
  new Date(Date.parse(`${date}${NOON_SUFFIX}`) + days * DAY_MS)
    .toISOString()
    .slice(0, DATE_LENGTH);

export const weekdayIndex = (date: string) =>
  new Date(`${date}${NOON_SUFFIX}`).getUTCDay();

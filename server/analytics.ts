import {
  ACTIVITY_SOURCES,
  type ActivityEvent,
  type ActivitySource,
  type Analytics,
  BLOCK_MINUTES,
  type ClaudeBudgets,
  type ClaudeBudgetWindow,
  FABLE_MODEL,
  type HistoryData,
  type RangeDays,
  TIME_ZONE,
  type UsageSnapshot,
  WEEK_MINUTES,
} from "../shared/types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});
export function localParts(time: Date | string | number) {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(time)).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    hour: Number(parts.hour),
    day: new Date(`${date}T12:00:00Z`).getUTCDay(),
  };
}
export function shiftDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
function countTimes(times: number[]) {
  return {
    responses: times.length,
    activeMinutes: new Set(times.map((time) => Math.floor(time / MINUTE_MS)))
      .size,
  };
}
function count(events: ActivityEvent[]) {
  return countTimes(events.map((e) => Date.parse(e.timestamp)));
}
function mix(events: ActivityEvent[], key: "model" | "project") {
  const values = new Map<string, number>();
  for (const event of events)
    values.set(event[key], (values.get(event[key]) ?? 0) + 1);
  return [...values]
    .map(([name, responses]) => ({ name, responses }))
    .sort((a, b) => b.responses - a.responses);
}
export function aggregate(
  history: HistoryData,
  days: RangeDays,
  now = new Date(),
  official: UsageSnapshot | null = null,
): Analytics {
  const today = localParts(now).date;
  const dates = Array.from({ length: days }, (_, i) =>
    shiftDate(today, i - days + 1),
  );
  const decorated = history.events
    .map((event) => ({ event, ...localParts(event.timestamp) }))
    .filter(
      (e) =>
        e.date >= dates[0] && Date.parse(e.event.timestamp) <= now.getTime(),
    );
  const events = decorated.map((e) => e.event);
  const block = currentBlock(history.events, now);
  return {
    claudeBudgets: claudeBudgets(history.events, now, block, official),
    currentBlock: block,
    opportunities: opportunities(history.events, now),
    days,
    timeZone: TIME_ZONE,
    generatedAt: now.toISOString(),
    daily: dates.map((date) => ({
      date,
      ...count(decorated.filter((e) => e.date === date).map((e) => e.event)),
    })),
    heatmap: Array.from({ length: 168 }, (_, i) => ({
      day: Math.floor(i / 24),
      hour: i % 24,
      ...count(
        decorated
          .filter((e) => e.day === Math.floor(i / 24) && e.hour === i % 24)
          .map((e) => e.event),
      ),
    })),
    totals: {
      ...count(events),
      inputTokens: events.reduce((n, e) => n + e.inputTokens, 0),
      outputTokens: events.reduce((n, e) => n + e.outputTokens, 0),
      cacheReadTokens: events.reduce((n, e) => n + e.cacheReadTokens, 0),
      cacheCreationTokens: events.reduce(
        (n, e) => n + e.cacheCreationTokens,
        0,
      ),
    },
    models: mix(events, "model"),
    projects: mix(events, "project"),
    sources: ACTIVITY_SOURCES.map((source) => {
      const matching = events.filter((event) => event.source === source);
      return {
        source,
        ...count(matching),
        outputTokens: matching.reduce((n, e) => n + e.outputTokens, 0),
      };
    }),
    health: history.health,
  };
}

const HOUR_MS = 60 * MINUTE_MS;
const BLOCK_MS = BLOCK_MINUTES * MINUTE_MS;
const WEEK_MS = WEEK_MINUTES * MINUTE_MS;
function futureReset(usage: { resetsAt: string | null }, now: Date) {
  const reset = usage.resetsAt === null ? NaN : Date.parse(usage.resetsAt);
  return reset > now.getTime() ? reset : undefined;
}
function budgetWindow(
  events: ActivityEvent[],
  now: Date,
  window: { start: number; end: number; basis: ClaudeBudgetWindow["basis"] },
): ClaudeBudgetWindow {
  const totals = count(
    events.filter((event) => {
      const time = Date.parse(event.timestamp);
      return (
        time >= window.start && time <= Math.min(window.end, now.getTime())
      );
    }),
  );
  return {
    windowStart: new Date(window.start).toISOString(),
    windowEnd: new Date(window.end).toISOString(),
    basis: window.basis,
    ...totals,
  };
}
function claudeBudgets(
  events: ActivityEvent[],
  now: Date,
  block: ReturnType<typeof currentBlock>,
  official: UsageSnapshot | null,
): ClaudeBudgets {
  const sessionReset = official && futureReset(official.session, now);
  const weeklyReset = official && futureReset(official.weekly, now);
  const fableReset =
    (official?.fable && futureReset(official.fable, now)) || weeklyReset;
  const session = sessionReset
    ? budgetWindow(events, now, {
        start: sessionReset - BLOCK_MS,
        end: sessionReset,
        basis: "official-reset",
      })
    : block
      ? budgetWindow(events, now, {
          start: Date.parse(block.start),
          end: Date.parse(block.end),
          basis: "inferred",
        })
      : {
          windowStart: null,
          windowEnd: null,
          basis: "none" as const,
          activeMinutes: 0,
          responses: 0,
        };
  const week = (reset: number | undefined | null) =>
    reset
      ? { start: reset - WEEK_MS, end: reset, basis: "official-reset" as const }
      : {
          start: now.getTime() - WEEK_MS,
          end: now.getTime(),
          basis: "rolling" as const,
        };
  return {
    session: { ...session, utilization: session.activeMinutes / BLOCK_MINUTES },
    weekly: budgetWindow(events, now, week(weeklyReset)),
    fable: budgetWindow(
      events.filter((event) => FABLE_MODEL.test(event.model)),
      now,
      week(fableReset),
    ),
  };
}
const PLANNER_DAYS = 30;
// Choose the earlier occurrence in a fold; move a nonexistent start forward across a DST gap.
export function localStart(date: string, hour: number): number {
  const rough = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const offsets = [
    ...new Set(
      [-12, 12].map((delta) => {
        const instant = rough + delta * HOUR_MS;
        const part = localParts(instant);
        return (
          Date.parse(
            `${part.date}T${String(part.hour).padStart(2, "0")}:00:00Z`,
          ) - instant
        );
      }),
    ),
  ];
  const candidates = offsets
    .map((offset) => rough - offset)
    .sort((a, b) => a - b);
  return (
    candidates.find((candidate) => {
      const part = localParts(candidate);
      return part.date === date && part.hour === hour;
    }) ?? candidates[candidates.length - 1]
  );
}
// Quiet hours describe when the person is not using Claude Code, so dispatched
// and unattributed activity must not make a window look busy.
const INTERACTIVE_SOURCE: ActivitySource = "local";
function opportunities(events: ActivityEvent[], now: Date) {
  const today = localParts(now).date;
  const earliest = localStart(shiftDate(today, -PLANNER_DAYS - 1), 0);
  const recent = events
    .filter((e) => e.source === INTERACTIVE_SOURCE)
    .map((e) => Date.parse(e.timestamp))
    .filter((time) => time >= earliest && time <= now.getTime());
  return Array.from({ length: 24 }, (_, startHour) => {
    let activeMinutes = 0;
    let responses = 0;
    const lastDate =
      localStart(today, startHour) + BLOCK_MS <= now.getTime()
        ? today
        : localStart(shiftDate(today, -1), startHour) + BLOCK_MS <=
            now.getTime()
          ? shiftDate(today, -1)
          : shiftDate(today, -2);
    const dates = Array.from({ length: PLANNER_DAYS }, (_, i) =>
      shiftDate(lastDate, i - PLANNER_DAYS + 1),
    );
    for (const date of dates) {
      const start = localStart(date, startHour);
      const totals = countTimes(
        recent.filter((time) => time >= start && time < start + BLOCK_MS),
      );
      activeMinutes += totals.activeMinutes;
      responses += totals.responses;
    }
    return {
      startHour,
      endHour: (startHour + 5) % 24,
      averageActiveMinutes: activeMinutes / PLANNER_DAYS,
      averageResponses: responses / PLANNER_DAYS,
      utilization: activeMinutes / PLANNER_DAYS / BLOCK_MINUTES,
      samples: PLANNER_DAYS,
      estimated: true as const,
    };
  }).sort(
    (a, b) =>
      a.averageActiveMinutes - b.averageActiveMinutes ||
      a.averageResponses - b.averageResponses ||
      a.startHour - b.startHour,
  );
}

export interface ActivityBlock {
  start: number;
  end: number;
  events: ActivityEvent[];
}
export function activityBlocks(
  events: ActivityEvent[],
  now: Date,
): ActivityBlock[] {
  const past = events
    .filter((e) => Date.parse(e.timestamp) <= now.getTime())
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const blocks: ActivityBlock[] = [];
  for (const event of past) {
    const time = Date.parse(event.timestamp);
    const open = blocks[blocks.length - 1];
    if (open && time < open.end) open.events.push(event);
    else {
      const start = Math.floor(time / MINUTE_MS) * MINUTE_MS;
      blocks.push({ start, end: start + BLOCK_MS, events: [event] });
    }
  }
  return blocks;
}

export function activeMinutes(events: ActivityEvent[]) {
  return count(events).activeMinutes;
}

function currentBlock(events: ActivityEvent[], now: Date) {
  const blocks = activityBlocks(events, now);
  const block = blocks[blocks.length - 1];
  if (!block || now.getTime() >= block.end) return null;
  const totals = count(block.events);
  return {
    start: new Date(block.start).toISOString(),
    end: new Date(block.end).toISOString(),
    elapsedMinutes: Math.floor((now.getTime() - block.start) / MINUTE_MS),
    ...totals,
    utilization: totals.activeMinutes / BLOCK_MINUTES,
    remainingMinutes: BLOCK_MINUTES - totals.activeMinutes,
    estimated: true as const,
  };
}

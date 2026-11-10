import { localParts, localStart, shiftDate } from "../shared/local-time.js";
import {
  ACTIVITY_SOURCES,
  type ActivityEvent,
  type ActivitySource,
  type CoverageDay,
  MINUTE_MS,
  PLAN_SCORE_COVERAGE_DAYS,
  PLAN_SCORE_DAYS,
  type PlanScore,
  resetMinute,
  type UsageSample,
  WEEK_MINUTES,
  type WeekScore,
} from "../shared/types.js";
import { partitionMinutes } from "./analytics.js";
import { sessionWindows } from "./usage-history.js";

const HOUR_MS = 60 * MINUTE_MS;
const WEEK_MS = WEEK_MINUTES * MINUTE_MS;
const FULL_PERCENT = 100;

function overlapMs(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function eventsByDate(events: ActivityEvent[], now: Date, timeZone: string) {
  const dates = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    if (Date.parse(event.timestamp) > now.getTime()) continue;
    const { date } = localParts(event.timestamp, timeZone);
    const onDate = dates.get(date);
    if (onDate) onDate.push(event);
    else dates.set(date, [event]);
  }
  return dates;
}

function dayMinutes(events: ActivityEvent[]) {
  const sources = partitionMinutes(events, "source");
  return {
    sources: Object.fromEntries(
      ACTIVITY_SOURCES.map((source) => [source, sources.get(source) ?? 0]),
    ) as Record<ActivitySource, number>,
    models: Object.fromEntries(partitionMinutes(events, "model")),
  };
}

function coverageDays(
  samples: UsageSample[],
  now: Date,
  events: ActivityEvent[],
  timeZone: string,
): { days: CoverageDay[]; rangeStart: number } {
  const spans: { start: number; end: number; peakPercent: number }[] = [];
  for (const window of sessionWindows(samples, now, PLAN_SCORE_DAYS + 1)) {
    if (window.peakPercent === null) continue;
    spans.push({
      start: Date.parse(window.start),
      end: Math.min(Date.parse(window.end), now.getTime()),
      peakPercent: window.peakPercent,
    });
  }
  const earliest = samples.length
    ? Math.min(...samples.map((sample) => Date.parse(sample.at)))
    : Number.POSITIVE_INFINITY;
  const today = localParts(now, timeZone).date;
  const byDate = eventsByDate(events, now, timeZone);
  const days: CoverageDay[] = [];
  let rangeStart = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PLAN_SCORE_DAYS; i++) {
    const date = shiftDate(today, i - PLAN_SCORE_DAYS + 1);
    const start = localStart(date, 0, timeZone);
    if (i === 0) rangeStart = start;
    const dayEnd = localStart(shiftDate(date, 1), 0, timeZone);
    const end = Math.min(dayEnd, now.getTime());
    const minutes = dayMinutes(byDate.get(date) ?? []);
    if (dayEnd < earliest) {
      days.push({ date, coverage: null, ...minutes });
      continue;
    }
    const elapsedHours = (end - start) / HOUR_MS;
    const percentHours = spans.reduce(
      (total, span) =>
        total +
        (span.peakPercent * overlapMs(span.start, span.end, start, end)) /
          HOUR_MS,
      0,
    );
    days.push({
      date,
      coverage:
        elapsedHours > 0
          ? Math.round((percentHours / elapsedHours) * 10) / 10
          : 0,
      ...minutes,
    });
  }
  return { days, rangeStart };
}

function weekScores(
  samples: UsageSample[],
  now: Date,
  rangeStart: number,
): WeekScore[] {
  const groups = new Map<number, { end: number; percent: number }>();
  for (const sample of samples) {
    if (sample.weeklyResetsAt === null) continue;
    const key = resetMinute(sample.weeklyResetsAt);
    const current = groups.get(key);
    if (current) current.percent = Math.max(current.percent, sample.weekly);
    else
      groups.set(key, {
        end: Date.parse(sample.weeklyResetsAt),
        percent: sample.weekly,
      });
  }
  const latestReset = samples.findLast(
    (sample) => sample.weeklyResetsAt !== null,
  )?.weeklyResetsAt;
  const currentKey = latestReset ? resetMinute(latestReset) : null;
  const scores: WeekScore[] = [];
  for (const [key, { end, percent }] of groups) {
    const start = end - WEEK_MS;
    if (start >= now.getTime() || end <= rangeStart) continue;
    const complete = end <= now.getTime();
    // An open window the meter no longer reports came from another account or reset schedule.
    if (!complete && key !== currentKey) continue;
    const pacePercent = ((now.getTime() - start) / WEEK_MS) * FULL_PERCENT;
    scores.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      percent,
      complete,
      score: complete
        ? percent
        : Math.min(
            FULL_PERCENT,
            Math.round((percent / Math.max(pacePercent, 1)) * FULL_PERCENT),
          ),
    });
  }
  return scores.sort((a, b) => a.start.localeCompare(b.start));
}

/** How close usage came to filling every five-hour window and the weekly limit. */
export function planScore(
  samples: UsageSample[],
  now: Date,
  events: ActivityEvent[],
  timeZone: string,
): PlanScore {
  const { days, rangeStart } = coverageDays(samples, now, events, timeZone);
  const weeks = weekScores(samples, now, rangeStart);
  const covered = days
    .slice(-PLAN_SCORE_COVERAGE_DAYS)
    .map((day) => day.coverage)
    .filter((coverage): coverage is number => coverage !== null);
  const sessionCoverage = covered.length
    ? Math.round(
        covered.reduce((sum, value) => sum + value, 0) / covered.length,
      )
    : null;
  const current = weeks.find(
    (week) =>
      Date.parse(week.start) <= now.getTime() &&
      now.getTime() < Date.parse(week.end),
  );
  const weeklyScore = current ? current.score : null;
  return {
    score:
      sessionCoverage === null || weeklyScore === null
        ? null
        : Math.round((sessionCoverage + weeklyScore) / 2),
    sessionCoverage,
    weeklyScore,
    days,
    weeks,
    generatedAt: now.toISOString(),
  };
}

import { expect, it } from "vitest";
import { planScore as planScoreInZone } from "../server/plan-score.js";
import {
  type ActivityEvent,
  PLAN_SCORE_DAYS,
  type UsageSample,
} from "../shared/types.js";
import { TEST_TIME_ZONE } from "./helpers.js";

const KOLKATA = "Asia/Kolkata";

const planScore = (
  samples: UsageSample[],
  now: Date,
  events: ActivityEvent[],
) => planScoreInZone(samples, now, events, TEST_TIME_ZONE);

const NOW = new Date("2026-09-06T12:00:00Z");
const WEEKLY_RESETS_AT = "2026-09-13T07:53:00.000Z";

const sample = (
  at: string,
  session: number,
  sessionResetsAt: string | null,
  patch: Partial<UsageSample> = {},
): UsageSample => ({
  at,
  session,
  sessionResetsAt,
  weekly: 10,
  weeklyResetsAt: WEEKLY_RESETS_AT,
  fable: null,
  ...patch,
});

const NO_MINUTES = {
  sources: { local: 0, dispatched: 0, unknown: 0 },
  models: {},
};

const event = (
  timestamp: string,
  extra: Partial<ActivityEvent> = {},
): ActivityEvent => ({
  timestamp,
  project: "demo",
  model: "claude-opus-4-6",
  source: "local",
  inputTokens: 2,
  outputTokens: 3,
  cacheReadTokens: 5,
  cacheCreationTokens: 1,
  ...extra,
});

const coverageOf = (samples: UsageSample[], date: string) =>
  planScore(samples, NOW, []).days.find((day) => day.date === date)?.coverage;

it("scores a date by the share of its hours a window's peak covers", () => {
  expect(
    coverageOf(
      [sample("2026-09-05T10:00:00Z", 80, "2026-09-05T14:00:00.000Z")],
      "2026-09-05",
    ),
  ).toBe(16.7);
});

it("splits a window straddling local midnight across both dates", () => {
  const samples = [
    sample("2026-09-06T03:00:00Z", 60, "2026-09-06T07:00:00.000Z"),
  ];
  expect(coverageOf(samples, "2026-09-05")).toBe(5);
  expect(coverageOf(samples, "2026-09-06")).toBe(22.5);
});

it("counts only the elapsed part of today and of a window still running", () => {
  expect(
    coverageOf(
      [sample("2026-09-06T11:00:00Z", 90, "2026-09-06T15:00:00.000Z")],
      "2026-09-06",
    ),
  ).toBe(22.5);
});

it("leaves dates before the first sample null and scores later empty dates zero", () => {
  const { days } = planScore(
    [sample("2026-09-05T10:00:00Z", 80, "2026-09-05T14:00:00.000Z")],
    NOW,
    [],
  );
  expect(days).toHaveLength(PLAN_SCORE_DAYS);
  expect(days[0]).toEqual({
    date: "2026-08-10",
    coverage: null,
    ...NO_MINUTES,
  });
  expect(days.at(-1)).toEqual({
    date: "2026-09-06",
    coverage: 0,
    ...NO_MINUTES,
  });
  expect(days.find((day) => day.date === "2026-09-04")?.coverage).toBeNull();
});

it("scores a finished week at its final weekly percent", () => {
  const finished = "2026-09-01T00:00:00.000Z";
  const { weeks } = planScore(
    [
      sample("2026-08-28T00:00:00Z", 0, null, {
        weekly: 40,
        weeklyResetsAt: finished,
      }),
      sample("2026-08-30T00:00:00Z", 0, null, {
        weekly: 62,
        weeklyResetsAt: finished,
      }),
    ],
    NOW,
    [],
  );
  expect(weeks).toEqual([
    {
      start: "2026-08-25T00:00:00.000Z",
      end: finished,
      percent: 62,
      score: 62,
      complete: true,
    },
  ]);
});

// A week that is 10% elapsed: reset is seven days after now minus 16.8 hours.
const OPEN_WEEK_RESETS_AT = "2026-09-12T19:12:00.000Z";
const openWeekScore = (weekly: number) =>
  planScore(
    [
      sample("2026-09-06T11:00:00Z", 0, null, {
        weekly,
        weeklyResetsAt: OPEN_WEEK_RESETS_AT,
      }),
    ],
    NOW,
    [],
  ).weeklyScore;

it("scores the open week by used percent over elapsed pace, capped at 100", () => {
  expect(openWeekScore(5)).toBe(50);
  expect(openWeekScore(20)).toBe(100);
});

it("scores the week the latest sample reports when an older open week also contains now", () => {
  const staleResetsAt = "2026-09-09T00:00:00.000Z";
  const { weeks, weeklyScore } = planScore(
    [
      sample("2026-09-06T08:00:00Z", 0, null, {
        weekly: 60,
        weeklyResetsAt: staleResetsAt,
      }),
      sample("2026-09-06T11:00:00Z", 0, null, {
        weekly: 5,
        weeklyResetsAt: OPEN_WEEK_RESETS_AT,
      }),
    ],
    NOW,
    [],
  );
  expect(weeklyScore).toBe(50);
  expect(weeks.map((week) => week.end)).toEqual([OPEN_WEEK_RESETS_AT]);
});

it("averages session coverage and the current week's score", () => {
  const score = planScore(
    [
      sample("2026-09-05T10:00:00Z", 80, "2026-09-05T14:00:00.000Z", {
        weekly: 5,
        weeklyResetsAt: OPEN_WEEK_RESETS_AT,
      }),
    ],
    NOW,
    [],
  );
  expect(score.sessionCoverage).toBe(8);
  expect(score.weeklyScore).toBe(50);
  expect(score.score).toBe(29);
});

it("reports no score at all before any sample exists", () => {
  const score = planScore([], NOW, []);
  expect(score.score).toBeNull();
  expect(score.sessionCoverage).toBeNull();
  expect(score.weeklyScore).toBeNull();
  expect(score.weeks).toEqual([]);
  expect(score.days.every((day) => day.coverage === null)).toBe(true);
  expect(score.generatedAt).toBe("2026-09-06T12:00:00.000Z");
});

it("plan score days carry the minutes of local events on that local date", () => {
  const { days } = planScore(
    [sample("2026-09-04T10:00:00Z", 40, "2026-09-04T14:00:00.000Z")],
    NOW,
    [
      event("2026-09-04T14:00:00Z"),
      event("2026-09-04T14:01:00Z", {
        source: "dispatched",
        model: "claude-fable-5-1",
      }),
      event("2026-09-05T14:00:00Z", {
        source: "unknown",
        model: "claude-fable-5-1",
      }),
      event("2026-09-05T14:00:30Z", {
        source: "unknown",
        model: "claude-fable-5-1",
      }),
    ],
  );
  const on = (date: string) => days.find((day) => day.date === date);
  expect(on("2026-09-04")).toMatchObject({
    sources: { local: 1, dispatched: 1, unknown: 0 },
    models: { "claude-opus-4-6": 1, "claude-fable-5-1": 1 },
  });
  expect(on("2026-09-05")).toMatchObject({
    sources: { local: 0, dispatched: 0, unknown: 1 },
    models: { "claude-fable-5-1": 1 },
  });
  expect(on("2026-09-06")).toMatchObject(NO_MINUTES);
});

it("leaves events after now out of the day they fall on", () => {
  const { days } = planScore([], NOW, [event("2026-09-06T13:00:00Z")]);
  expect(days.at(-1)).toMatchObject(NO_MINUTES);
});

it("splits a window across local days whose midnight falls on a half hour", () => {
  // Kolkata midnight is 18:30Z, so 16:00Z to 21:00Z puts 2.5 hours in each of 2026-09-06 and 2026-09-07.
  const { days } = planScoreInZone(
    [sample("2026-09-06T16:00:00Z", 100, "2026-09-06T21:00:00.000Z")],
    new Date("2026-09-07T18:30:00Z"),
    [],
    KOLKATA,
  );
  expect(days.find((day) => day.date === "2026-09-06")?.coverage).toBe(10.4);
  expect(days.find((day) => day.date === "2026-09-07")?.coverage).toBe(10.4);
});

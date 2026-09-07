import { expect, it } from "vitest";
import {
  planDispatch,
  taskGate,
  USAGE_PREDATES_RUN_REASON,
  weeklyPace,
} from "../server/dispatch.js";
import type { QuietRanking } from "../server/quiet-hours.js";
import { DEFAULT_DISPATCH_SETTINGS } from "../shared/types.js";
import { usageSnapshot } from "./helpers";

const now = new Date("2026-09-06T12:00:00Z");
const plan = (
  snapshot: ReturnType<typeof usageSnapshot> | null,
  error: string | null = null,
  settings = DEFAULT_DISPATCH_SETTINGS,
  ranking?: QuietRanking,
) => planDispatch(settings, { snapshot, error }, now, ranking);

it("measures weekly pace as the elapsed share of the seven-day window", () => {
  expect(weeklyPace("2026-09-13T12:00:00Z", now)).toBe(0);
  expect(weeklyPace("2026-09-10T00:00:00Z", now)).toBe(50);
  expect(weeklyPace("2026-09-06T12:00:01Z", now)).toBe(100);
  expect(weeklyPace("2026-09-06T12:00:00Z", now)).toBeNull();
  expect(weeklyPace(null, now)).toBeNull();
});

it("waits while official usage is missing or stale and says why", () => {
  expect(
    plan(null, "Claude Code credentials not found.").providers.claude,
  ).toEqual({
    status: "waiting",
    reason: "Official usage unavailable: Claude Code credentials not found.",
  });
  expect(plan(null).providers.claude.reason).toMatch(/not fetched yet/);
  const stale = plan(
    usageSnapshot({ fetchedAt: "2026-09-06T11:40:00Z" }),
    "Anthropic usage endpoint returned HTTP 503.",
  );
  expect(stale.providers.claude).toEqual({
    status: "waiting",
    reason:
      "Official usage is 20 min old (Anthropic usage endpoint returned HTTP 503.)",
  });
  expect(stale.usageError).toMatch(/503/);
});

it("holds Claude tasks when the session exceeds its ceiling and treats an expired session window as empty", () => {
  const busy = plan(
    usageSnapshot({
      session: { percent: 80, resetsAt: "2026-09-06T13:00:00Z" },
    }),
  );
  expect(busy.session).toEqual({
    percent: 80,
    ceiling: 75,
    pace: null,
    ok: false,
  });
  expect(busy.providers.claude).toEqual({
    status: "waiting",
    reason: "Session at 80%, above the 75% ceiling",
  });
  const expired = plan(
    usageSnapshot({
      session: { percent: 80, resetsAt: "2026-09-06T11:00:00Z" },
    }),
  );
  expect(expired.session.percent).toBe(0);
  expect(expired.providers.claude.status).toBe("ready");
  expect(
    plan(usageSnapshot(), null, {
      ...DEFAULT_DISPATCH_SETTINGS,
      sessionReservePercent: 90,
    }).providers.claude.reason,
  ).toMatch(/Session at 16%, above the 10% ceiling/);
});

it("holds Claude tasks once weekly usage runs ahead of pace plus margin, capped at the hard ceiling", () => {
  const halfway = "2026-09-10T00:00:00Z";
  const ahead = plan(
    usageSnapshot({ weekly: { percent: 61, resetsAt: halfway } }),
  );
  expect(ahead.weekly).toEqual({
    percent: 61,
    ceiling: 60,
    pace: 50,
    ok: false,
  });
  expect(ahead.providers.claude.reason).toBe(
    "Weekly at 61%, above the 60% ceiling (pace 50% + 10% margin)",
  );
  const ready = plan(
    usageSnapshot({ weekly: { percent: 59, resetsAt: halfway } }),
  );
  expect(ready.providers.claude).toEqual({
    status: "ready",
    reason: "Session 16% of 75% · Weekly 59% of 60%",
  });
  const lateWeek = plan(
    usageSnapshot({
      weekly: { percent: 96, resetsAt: "2026-09-06T13:00:00Z" },
    }),
  );
  expect(lateWeek.weekly.ceiling).toBe(95);
  expect(lateWeek.providers.claude.status).toBe("waiting");
  expect(
    plan(usageSnapshot({ weekly: { percent: 0, resetsAt: null } })).weekly,
  ).toEqual({ percent: 0, ceiling: 95, pace: null, ok: true });
});

it("gates Fable-model tasks on the Fable window, leaves Codex ungated, and mirrors task status", () => {
  const planning = plan(
    usageSnapshot({ fable: { percent: 70, resetsAt: "2026-09-10T00:00:00Z" } }),
  );
  expect(planning.fable).toEqual({
    percent: 70,
    ceiling: 60,
    pace: 50,
    ok: false,
  });
  const base = {
    status: "pending" as const,
    provider: "claude" as const,
    preferredWindowStart: 9,
    earliestStart: null,
  };
  expect(taskGate({ ...base, model: "opus" }, planning, now).status).toBe(
    "ready",
  );
  expect(
    taskGate({ ...base, model: "claude-fable-5-1" }, planning, now),
  ).toEqual({
    status: "waiting",
    reason: "Fable weekly at 70%, above the 60% ceiling",
  });
  expect(
    taskGate(
      { ...base, provider: "codex", model: "gpt-6-astra" },
      planning,
      now,
    ),
  ).toEqual({
    status: "ready",
    reason: "Codex runs do not touch Claude usage",
  });
  expect(
    taskGate({ ...base, status: "running", model: "opus" }, planning, now),
  ).toMatchObject({ status: "running" });
  expect(
    taskGate({ ...base, status: "failed", model: "opus" }, planning, now),
  ).toEqual({ status: "finished", reason: "failed" });
  const noFable = plan(usageSnapshot({ fable: null }));
  expect(noFable.fable).toBeNull();
  expect(
    taskGate({ ...base, model: "claude-fable-5-1" }, noFable, now).status,
  ).toBe("ready");
});

it("ranks quiet start hours, marks whether now is inside one, and names the next one", () => {
  const ranking = {
    ranking: [3, 2, 1, 0, 23, 22, 21, 20, 4, 5, 6],
    error: null,
  };
  const eightAm = plan(
    usageSnapshot(),
    null,
    {
      ...DEFAULT_DISPATCH_SETTINGS,
      quietStartHours: 8,
    },
    ranking,
  );
  expect(eightAm.quiet).toEqual({
    startHours: [0, 1, 2, 3, 20, 21, 22, 23],
    error: null,
    nowHour: 8,
    active: false,
    nextStartHour: 20,
  });
  const task = {
    status: "pending" as const,
    provider: "claude" as const,
    model: "opus",
    preferredWindowStart: null,
    earliestStart: null,
  };
  expect(taskGate(task, eightAm, now)).toEqual({
    status: "waiting",
    reason: "Outside quiet hours · next 8 PM",
  });
  expect(
    taskGate({ ...task, preferredWindowStart: 9 }, eightAm, now).status,
  ).toBe("ready");
  expect(
    taskGate({ ...task, provider: "codex", model: "gpt-6-astra" }, eightAm, now)
      .status,
  ).toBe("ready");
  const notComputed = plan(usageSnapshot(), null, DEFAULT_DISPATCH_SETTINGS, {
    ranking: null,
    error: "Local history could not be read.",
  });
  expect(taskGate(task, notComputed, now)).toEqual({
    status: "waiting",
    reason: "Quiet hours not computed yet (Local history could not be read.)",
  });
  const off = plan(
    usageSnapshot(),
    null,
    {
      ...DEFAULT_DISPATCH_SETTINGS,
      quietHoursOnly: false,
    },
    ranking,
  );
  expect(taskGate(task, off, now).status).toBe("ready");
  const midnight = planDispatch(
    DEFAULT_DISPATCH_SETTINGS,
    { snapshot: usageSnapshot(), error: null },
    new Date("2026-09-06T05:30:00Z"),
    ranking,
  );
  expect(midnight.quiet).toMatchObject({
    nowHour: 1,
    active: true,
    nextStartHour: 2,
  });
  expect(
    taskGate(task, midnight, new Date("2026-09-06T05:30:00Z")).status,
  ).toBe("ready");
});

it("distrusts official usage fetched before the last run ended", () => {
  const snapshot = usageSnapshot({ fetchedAt: "2026-09-06T11:55:00Z" });
  const predates = planDispatch(
    DEFAULT_DISPATCH_SETTINGS,
    { snapshot, error: null },
    now,
    undefined,
    "2026-09-06T11:56:00Z",
  );
  expect(predates.providers.claude).toEqual({
    status: "waiting",
    reason: USAGE_PREDATES_RUN_REASON,
  });
  expect(predates.providers.codex.status).toBe("ready");
  const fresh = planDispatch(
    DEFAULT_DISPATCH_SETTINGS,
    { snapshot, error: null },
    now,
    undefined,
    "2026-09-06T11:55:00Z",
  );
  expect(fresh.providers.claude.status).toBe("ready");
});

it("holds a task until its earliest start time and names that time", () => {
  const planning = plan(usageSnapshot());
  const task = {
    status: "pending" as const,
    provider: "claude" as const,
    model: "opus",
    preferredWindowStart: 9,
    earliestStart: "2026-09-08T02:00:00Z",
  };
  expect(taskGate(task, planning, now)).toEqual({
    status: "waiting",
    reason: "Starts after Sep 7, 10:00 PM EDT",
  });
  expect(
    taskGate({ ...task, earliestStart: "2026-09-05T02:00:00Z" }, planning, now)
      .status,
  ).toBe("ready");
});

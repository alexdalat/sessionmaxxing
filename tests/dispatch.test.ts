import { expect, it } from "vitest";
import {
  costsAhead,
  expectedSessionCost,
  planDispatch,
  runReservation,
  taskGate,
  USAGE_PREDATES_RUN_REASON,
  weeklyPace,
} from "../server/dispatch.js";
import type { QuietRanking } from "../server/quiet-hours.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchLoad,
  EMPTY_LOAD,
} from "../shared/types.js";
import { SESSION_RATES, usageSnapshot } from "./helpers";

const now = new Date("2026-09-06T12:00:00Z");
const calibration = { rates: SESSION_RATES, error: null };
const plan = (
  snapshot: ReturnType<typeof usageSnapshot> | null,
  error: string | null = null,
  settings = DEFAULT_DISPATCH_SETTINGS,
  ranking?: QuietRanking,
  load: DispatchLoad = EMPTY_LOAD,
) =>
  planDispatch(settings, { snapshot, error }, now, ranking, load, calibration);

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
      "Official usage is 20 min old · refresh to retry (Anthropic usage endpoint returned HTTP 503.)",
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
    reserved: 0,
    ok: false,
  });
  expect(busy.providers.claude).toEqual({
    status: "waiting",
    reason: "Session 80%, over the 75% queue cutoff",
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
  ).toMatch(/Session 16%, over the 10% queue cutoff/);
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
    reserved: 0,
    ok: false,
  });
  expect(ahead.providers.claude.reason).toBe(
    "Weekly 61%, over the 60% queue cutoff (pace 50% + 10% margin)",
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
  ).toEqual({ percent: 0, ceiling: 95, pace: null, reserved: 0, ok: true });
});

it("gates Fable-model tasks on the Fable window, leaves Codex ungated, and mirrors task status", () => {
  const planning = plan(
    usageSnapshot({ fable: { percent: 70, resetsAt: "2026-09-10T00:00:00Z" } }),
  );
  expect(planning.fable).toEqual({
    percent: 70,
    ceiling: 60,
    pace: 50,
    reserved: 0,
    ok: false,
  });
  const base = {
    id: "a".repeat(24),
    status: "pending" as const,
    provider: "claude" as const,
    preferredWindowStart: 8,
    earliestStart: null,
    tokens: 100_000,
  };
  expect(taskGate({ ...base, model: "opus" }, planning, now, []).status).toBe(
    "ready",
  );
  expect(
    taskGate({ ...base, model: "claude-fable-5-1" }, planning, now, []),
  ).toEqual({
    status: "waiting",
    reason: "Fable weekly 70%, over the 60% queue cutoff",
    eligibleAt: "2026-09-07T12:00:00.000Z",
  });
  expect(
    taskGate(
      { ...base, provider: "codex", model: "gpt-6-astra" },
      planning,
      now,
      [],
    ),
  ).toEqual({
    status: "ready",
    reason: "Codex tasks never wait on Claude usage",
    eligibleAt: now.toISOString(),
  });
  expect(
    taskGate({ ...base, status: "running", model: "opus" }, planning, now, []),
  ).toMatchObject({ status: "running", eligibleAt: null });
  expect(
    taskGate({ ...base, status: "failed", model: "opus" }, planning, now, []),
  ).toEqual({ status: "finished", reason: "failed", eligibleAt: null });
  const noFable = plan(usageSnapshot({ fable: null }));
  expect(noFable.fable).toBeNull();
  expect(
    taskGate({ ...base, model: "claude-fable-5-1" }, noFable, now, []).status,
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
    id: "a".repeat(24),
    status: "pending" as const,
    provider: "claude" as const,
    model: "opus",
    preferredWindowStart: null,
    earliestStart: null,
    tokens: 100_000,
  };
  expect(taskGate(task, eightAm, now, [])).toEqual({
    status: "waiting",
    reason: "Outside quiet hours · next 8 PM",
    eligibleAt: "2026-09-07T00:00:00.000Z",
  });
  expect(
    taskGate({ ...task, preferredWindowStart: 8 }, eightAm, now, []).status,
  ).toBe("ready");
  expect(
    taskGate(
      { ...task, provider: "codex", model: "gpt-6-astra" },
      eightAm,
      now,
      [],
    ).status,
  ).toBe("ready");
  const notComputed = plan(usageSnapshot(), null, DEFAULT_DISPATCH_SETTINGS, {
    ranking: null,
    error: "Local history could not be read.",
  });
  expect(taskGate(task, notComputed, now, [])).toEqual({
    status: "waiting",
    reason: "Quiet hours not computed yet (Local history could not be read.)",
    eligibleAt: null,
  });
  const off = plan(
    usageSnapshot(),
    null,
    {
      ...DEFAULT_DISPATCH_SETTINGS,
      busyHoursReservePercent: 25,
    },
    ranking,
  );
  expect(taskGate(task, off, now, []).status).toBe("ready");
  const midnight = planDispatch(
    DEFAULT_DISPATCH_SETTINGS,
    { snapshot: usageSnapshot(), error: null },
    new Date("2026-09-06T05:30:00Z"),
    ranking,
    EMPTY_LOAD,
    calibration,
  );
  expect(midnight.quiet).toMatchObject({
    nowHour: 1,
    active: true,
    nextStartHour: 2,
  });
  expect(
    taskGate(task, midnight, new Date("2026-09-06T05:30:00Z"), []).status,
  ).toBe("ready");
});

it("distrusts official usage fetched before the last run ended", () => {
  const snapshot = usageSnapshot({ fetchedAt: "2026-09-06T11:55:00Z" });
  const predates = planDispatch(
    DEFAULT_DISPATCH_SETTINGS,
    { snapshot, error: null },
    now,
    undefined,
    { ...EMPTY_LOAD, lastRunEndedAt: "2026-09-06T11:56:00Z" },
    calibration,
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
    { ...EMPTY_LOAD, lastRunEndedAt: "2026-09-06T11:55:00Z" },
    calibration,
  );
  expect(fresh.providers.claude.status).toBe("ready");
});

it("holds a task until its earliest start time and names that time", () => {
  const planning = plan(usageSnapshot());
  const task = {
    id: "a".repeat(24),
    status: "pending" as const,
    provider: "claude" as const,
    model: "opus",
    preferredWindowStart: 8,
    earliestStart: "2026-09-08T02:00:00Z",
    tokens: 100_000,
  };
  expect(taskGate(task, planning, now, [])).toEqual({
    status: "waiting",
    reason: "Starts after Sep 7, 10:00 PM EDT",
    eligibleAt: "2026-09-08T12:00:00.000Z",
  });
  expect(
    taskGate(
      { ...task, earliestStart: "2026-09-05T02:00:00Z" },
      planning,
      now,
      [],
    ).status,
  ).toBe("ready");
});

const pending = {
  id: "a".repeat(24),
  status: "pending" as const,
  provider: "claude" as const,
  model: "opus",
  preferredWindowStart: null,
  earliestStart: null,
  tokens: 100_000,
};
const quietRanking = { ranking: [3, 2, 1, 0, 23, 22, 21, 20], error: null };

it("becomes eligible at its earliest start, or at the next quiet hour after it", () => {
  const fiveAmWednesday = "2026-09-09T09:00:00Z";
  const noQuiet = plan(usageSnapshot(), null, {
    ...DEFAULT_DISPATCH_SETTINGS,
    busyHoursReservePercent: 25,
  });
  expect(
    taskGate({ ...pending, earliestStart: fiveAmWednesday }, noQuiet, now, [])
      .eligibleAt,
  ).toBe("2026-09-09T09:00:00.000Z");
  const quiet = plan(
    usageSnapshot(),
    null,
    DEFAULT_DISPATCH_SETTINGS,
    quietRanking,
  );
  expect(
    taskGate({ ...pending, earliestStart: fiveAmWednesday }, quiet, now, [])
      .eligibleAt,
  ).toBe("2026-09-10T00:00:00.000Z");
  const smallHours = plan(
    usageSnapshot(),
    null,
    { ...DEFAULT_DISPATCH_SETTINGS, quietStartHours: 3 },
    quietRanking,
  );
  expect(
    taskGate(
      { ...pending, earliestStart: fiveAmWednesday },
      smallHours,
      now,
      [],
    ).eligibleAt,
  ).toBe("2026-09-10T05:00:00.000Z");
});

it("holds a task outside its preferred window, naming the window and its next start", () => {
  const planning = plan(usageSnapshot());
  expect(
    taskGate({ ...pending, preferredWindowStart: 13 }, planning, now, []),
  ).toEqual({
    status: "waiting",
    reason: "Outside window 1 PM → 6 PM",
    eligibleAt: "2026-09-06T17:00:00.000Z",
  });
  expect(
    taskGate({ ...pending, preferredWindowStart: 22 }, planning, now, []),
  ).toMatchObject({
    reason: "Outside window 10 PM → 3 AM",
    eligibleAt: "2026-09-07T02:00:00.000Z",
  });
  expect(
    taskGate({ ...pending, preferredWindowStart: 4 }, planning, now, []),
  ).toMatchObject({ status: "ready", eligibleAt: now.toISOString() });
});

it("marks a task that can start right now as eligible now", () => {
  const planning = plan(usageSnapshot(), null, {
    ...DEFAULT_DISPATCH_SETTINGS,
    busyHoursReservePercent: 25,
  });
  expect(taskGate(pending, planning, now, [])).toEqual({
    status: "ready",
    reason: "Session 16% of 75% · Weekly 2% of 12.5%",
    eligibleAt: now.toISOString(),
  });
});

const splitReserves = {
  ...DEFAULT_DISPATCH_SETTINGS,
  sessionReservePercent: 10,
  busyHoursReservePercent: 70,
  quietStartHours: 2,
};
const busySession = usageSnapshot({
  session: { percent: 40, resetsAt: "2026-09-06T16:09:00.000Z" },
});

it("holds the session to the busy-hours reserve outside quiet hours", () => {
  const planning = plan(busySession, null, splitReserves, {
    ranking: [0, 1, 8, 9],
    error: null,
  });
  expect(planning.quiet.active).toBe(false);
  expect(planning.session).toEqual({
    percent: 40,
    ceiling: 30,
    pace: null,
    reserved: 0,
    ok: false,
  });
  expect(planning.providers.claude).toEqual({
    status: "waiting",
    reason: "Session 40%, over the 30% queue cutoff (busy hours)",
  });
  expect(taskGate(pending, planning, now, [])).toEqual({
    status: "waiting",
    reason: "Session 40%, over the 30% queue cutoff (busy hours)",
    eligibleAt: "2026-09-06T16:09:00.000Z",
  });
});

it("holds the session to the quiet-hours reserve inside quiet hours", () => {
  const planning = plan(busySession, null, splitReserves, {
    ranking: [8, 9, 0, 1],
    error: null,
  });
  expect(planning.quiet.active).toBe(true);
  expect(planning.session).toEqual({
    percent: 40,
    ceiling: 90,
    pace: null,
    reserved: 0,
    ok: true,
  });
  expect(taskGate(pending, planning, now, [])).toEqual({
    status: "ready",
    reason: "Session 40% of 90% · Weekly 2% of 12.5%",
    eligibleAt: now.toISOString(),
  });
});

it("applies the busy-hours reserve while the quiet ranking is still null", () => {
  const planning = plan(busySession, null, splitReserves);
  expect(planning.quiet.startHours).toBeNull();
  expect(planning.session.ceiling).toBe(30);
  expect(planning.providers.claude).toEqual({
    status: "waiting",
    reason: "Session 40%, over the 30% queue cutoff (busy hours)",
  });
});

it("keeps a task without a preferred window waiting for quiet hours when the busy reserve is full", () => {
  const planning = plan(
    busySession,
    null,
    { ...DEFAULT_DISPATCH_SETTINGS, quietStartHours: 8 },
    quietRanking,
  );
  expect(planning.session.ceiling).toBe(75);
  expect(taskGate(pending, planning, now, [])).toEqual({
    status: "waiting",
    reason: "Outside quiet hours · next 8 PM",
    eligibleAt: "2026-09-07T00:00:00.000Z",
  });
});

const halfSpent = usageSnapshot({
  session: { percent: 60, resetsAt: "2026-09-06T16:09:00.000Z" },
});
const anyHour = { ...DEFAULT_DISPATCH_SETTINGS, busyHoursReservePercent: 25 };

it("waits when session percent plus the expected cost of the task exceeds the cutoff", () => {
  const planning = plan(halfSpent, null, anyHour);
  expect(planning.providers.claude.status).toBe("ready");
  expect(taskGate({ ...pending, tokens: 150_000 }, planning, now, [])).toEqual({
    status: "waiting",
    reason: "Session 60% + 20.7% expected, over the 75% queue cutoff",
    eligibleAt: "2026-09-06T16:09:00.000Z",
  });
  expect(
    taskGate({ ...pending, tokens: 100_000 }, planning, now, []).status,
  ).toBe("ready");
  // The same tokens cost far more on Fable than on Opus.
  expect(
    taskGate(
      { ...pending, model: "claude-fable-5-1", tokens: 100_000 },
      planning,
      now,
      [],
    ).reason,
  ).toBe("Session 60% + 35.7% expected, over the 75% queue cutoff");
});

it("counts what running tasks hold on top of the expected cost of the task", () => {
  const load = {
    ...EMPTY_LOAD,
    running: 1,
    claudeRuns: 1,
    reserved: { session: 10, weekly: 3, fable: 0 },
  };
  const planning = plan(halfSpent, null, anyHour, undefined, load);
  expect(planning.providers.claude.status).toBe("ready");
  expect(taskGate(pending, planning, now, [])).toMatchObject({
    status: "waiting",
    reason:
      "Session 60% + 10% held for running tasks + 13.8% expected, over the 75% queue cutoff",
  });
  expect(
    taskGate(pending, plan(halfSpent, null, anyHour), now, []).status,
  ).toBe("ready");
});

it("reserves the expected session cost of the task that is running", () => {
  expect(runReservation(pending, 13.8, DEFAULT_DISPATCH_SETTINGS)).toEqual({
    session: 13.8,
    weekly: DEFAULT_DISPATCH_SETTINGS.runWeeklyCostPercent,
    fable: 0,
  });
  expect(
    runReservation(
      { ...pending, model: "claude-fable-5-1" },
      35.7,
      DEFAULT_DISPATCH_SETTINGS,
    ),
  ).toEqual({
    session: 35.7,
    weekly: DEFAULT_DISPATCH_SETTINGS.runWeeklyCostPercent,
    fable: DEFAULT_DISPATCH_SETTINGS.runWeeklyCostPercent,
  });
  expect(
    runReservation(
      { ...pending, provider: "codex", model: "gpt-6-astra" },
      13.8,
      DEFAULT_DISPATCH_SETTINGS,
    ),
  ).toEqual({ session: 0, weekly: 0, fable: 0 });
});

it("admits no Claude task while the session rates are unknown", () => {
  const planning = planDispatch(
    anyHour,
    { snapshot: halfSpent, error: null },
    now,
    undefined,
    EMPTY_LOAD,
    { rates: null, error: "Local history could not be read." },
  );
  expect(planning.rates).toBeNull();
  expect(planning.providers.claude).toEqual({
    status: "waiting",
    reason:
      "Session cost calibration unavailable: Local history could not be read.",
  });
  expect(taskGate(pending, planning, now, [])).toMatchObject({
    status: "waiting",
    eligibleAt: null,
  });
  expect(planning.providers.codex.status).toBe("ready");
});

it("predicts the session reset, shifted to the next quiet hour, for a task without headroom", () => {
  const planning = plan(
    usageSnapshot({
      session: { percent: 80, resetsAt: "2026-09-06T16:09:00.000Z" },
    }),
    null,
    DEFAULT_DISPATCH_SETTINGS,
    quietRanking,
  );
  expect(taskGate(pending, planning, now, []).eligibleAt).toBe(
    "2026-09-07T00:00:00.000Z",
  );
});

it("predicts when the rising weekly pace ceiling clears the measured percent", () => {
  const planning = plan(
    usageSnapshot({
      weekly: { percent: 70, resetsAt: "2026-09-10T00:00:00Z" },
    }),
    null,
    anyHour,
  );
  expect(planning.weekly).toMatchObject({ ceiling: 60, pace: 50, ok: false });
  expect(taskGate(pending, planning, now, [])).toMatchObject({
    status: "waiting",
    eligibleAt: "2026-09-07T04:48:00.000Z",
  });
});

it("predicts the weekly reset when usage is past the hard ceiling the pace never reaches", () => {
  const planning = plan(
    usageSnapshot({
      weekly: { percent: 96, resetsAt: "2026-09-10T00:00:00Z" },
    }),
    null,
    anyHour,
  );
  expect(taskGate(pending, planning, now, []).eligibleAt).toBe(
    "2026-09-10T00:00:00.000Z",
  );
});

it("cannot predict a start for a blocked bucket with no known reset", () => {
  const planning = plan(
    usageSnapshot({ session: { percent: 90, resetsAt: null } }),
    null,
    anyHour,
  );
  expect(taskGate(pending, planning, now, []).eligibleAt).toBeNull();
  expect(
    taskGate(
      { ...pending, provider: "codex", model: "gpt-6-astra" },
      planning,
      now,
      [],
    ).eligibleAt,
  ).toBe(now.toISOString());
});

it("uses the largest measured cost from previous runs of the same task", () => {
  const otherTask = "b".repeat(24);
  const runs = [
    { taskId: pending.id, status: "completed" as const, sessionCostPercent: 8 },
    {
      taskId: pending.id,
      status: "completed" as const,
      sessionCostPercent: 30,
    },
    {
      taskId: pending.id,
      status: "completed" as const,
      sessionCostPercent: null,
    },
    { taskId: otherTask, status: "completed" as const, sessionCostPercent: 90 },
  ];
  const small = { ...pending, tokens: 20_000 };
  expect(expectedSessionCost(small, runs, SESSION_RATES)).toBe(30);
  expect(
    expectedSessionCost({ ...small, id: otherTask }, runs, SESSION_RATES),
  ).toBe(90);
  expect(expectedSessionCost(small, [], SESSION_RATES)).toBe(2.8);
  expect(expectedSessionCost(small, [], null)).toBeNull();
  const planning = plan(halfSpent, null, anyHour);
  expect(taskGate(small, planning, now, runs)).toMatchObject({
    status: "waiting",
    reason: "Session 60% + 30% expected, over the 75% queue cutoff",
  });
  expect(taskGate(small, planning, now, []).status).toBe("ready");
});

it("ignores the cost of failed and cancelled runs", () => {
  const runs = [
    {
      taskId: pending.id,
      status: "failed" as const,
      sessionCostPercent: 100.1,
    },
    {
      taskId: pending.id,
      status: "cancelled" as const,
      sessionCostPercent: 89,
    },
  ];
  const small = { ...pending, tokens: 20_000 };
  expect(expectedSessionCost(small, runs, SESSION_RATES)).toBe(2.8);
  expect(
    expectedSessionCost(
      small,
      [
        ...runs,
        {
          taskId: pending.id,
          status: "completed" as const,
          sessionCostPercent: 12,
        },
      ],
      SESSION_RATES,
    ),
  ).toBe(12);
});

it("starts a task larger than the whole cutoff only in an empty session", () => {
  const runs = [
    {
      taskId: pending.id,
      status: "completed" as const,
      sessionCostPercent: 100.1,
    },
  ];
  const fresh = plan(
    usageSnapshot({
      session: { percent: 0, resetsAt: "2026-09-06T16:09:00.000Z" },
    }),
    null,
    anyHour,
  );
  expect(taskGate(pending, fresh, now, runs).status).toBe("ready");
  const touched = plan(
    usageSnapshot({
      session: { percent: 1, resetsAt: "2026-09-06T16:09:00.000Z" },
    }),
    null,
    anyHour,
  );
  expect(taskGate(pending, touched, now, runs)).toMatchObject({
    status: "waiting",
    reason: "Session 1% + 100.1% expected, over the 75% queue cutoff",
    eligibleAt: "2026-09-06T16:09:00.000Z",
  });
});

it("counts only the pending Claude tasks queued ahead of the task", () => {
  const tasks = [
    { ...pending, id: "b".repeat(24) },
    { ...pending, id: "c".repeat(24), status: "running" as const },
    { ...pending, id: "d".repeat(24), provider: "codex" as const },
    { ...pending, id: "e".repeat(24), tokens: 150_000 },
    pending,
    { ...pending, id: "f".repeat(24) },
  ];
  expect(costsAhead(pending.id, tasks, [], SESSION_RATES)).toEqual([
    13.8, 20.7,
  ]);
  expect(costsAhead(pending.id, tasks, [], null)).toEqual([]);
});

it("pushes the start to the session window the queue ahead leaves room in", () => {
  const planning = plan(halfSpent, null, anyHour);
  expect(taskGate(pending, planning, now, [], []).eligibleAt).toBe(
    now.toISOString(),
  );
  // 60% spent plus one 13.8% task ahead leaves no room until the window resets.
  expect(taskGate(pending, planning, now, [], [13.8]).eligibleAt).toBe(
    "2026-09-06T16:09:00.000Z",
  );
  // A 70% task ahead fills the reset window too, so this one waits five hours more.
  expect(taskGate(pending, planning, now, [], [13.8, 70]).eligibleAt).toBe(
    "2026-09-06T21:09:00.000Z",
  );
});

it("cannot predict a start behind a full queue with no known session reset", () => {
  const planning = plan(
    usageSnapshot({ session: { percent: 60, resetsAt: null } }),
    null,
    anyHour,
  );
  expect(taskGate(pending, planning, now, [], []).eligibleAt).toBe(
    now.toISOString(),
  );
  expect(taskGate(pending, planning, now, [], [13.8]).eligibleAt).toBeNull();
});

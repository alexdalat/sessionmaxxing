import { expect, it } from "vitest";
import {
  costsAhead,
  eligibleAt,
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
import { SESSION_RATES, TEST_TIME_ZONE, usageSnapshot } from "./helpers";

const now = new Date("2026-09-06T12:00:00Z");
const calibration = { rates: SESSION_RATES, error: null };
const plan = (
  snapshot: ReturnType<typeof usageSnapshot> | null,
  error: string | null = null,
  settings = DEFAULT_DISPATCH_SETTINGS,
  ranking?: QuietRanking,
  load: DispatchLoad = EMPTY_LOAD,
) =>
  planDispatch(
    settings,
    { snapshot, error },
    now,
    TEST_TIME_ZONE,
    ranking,
    load,
    calibration,
  );

it("measures weekly pace as the elapsed share of the seven-day window", () => {
  expect(weeklyPace("2026-09-13T12:00:00Z", now)).toBe(0);
  expect(weeklyPace("2026-09-10T00:00:00Z", now)).toBe(50);
  expect(weeklyPace("2026-09-06T12:00:01Z", now)).toBe(100);
  expect(weeklyPace("2026-09-06T12:00:00Z", now)).toBeNull();
  expect(weeklyPace(null, now)).toBeNull();
});

it("waits while official usage is missing or stale and says why", () => {
  expect(plan(null, "Claude Code credentials not found.").gate).toEqual({
    status: "waiting",
    reason: "Official usage unavailable: Claude Code credentials not found.",
  });
  expect(plan(null).gate.reason).toMatch(/not fetched yet/);
  const stale = plan(
    usageSnapshot({ fetchedAt: "2026-09-06T11:40:00Z" }),
    "Anthropic usage endpoint returned HTTP 503.",
  );
  expect(stale.gate).toEqual({
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
  expect(busy.gate).toEqual({
    status: "waiting",
    reason: "Session 80%, over the 75% queue cutoff",
  });
  const expired = plan(
    usageSnapshot({
      session: { percent: 80, resetsAt: "2026-09-06T11:00:00Z" },
    }),
  );
  expect(expired.session.percent).toBe(0);
  expect(expired.gate.status).toBe("ready");
  expect(
    plan(usageSnapshot(), null, {
      ...DEFAULT_DISPATCH_SETTINGS,
      sessionReservePercent: 90,
    }).gate.reason,
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
  expect(ahead.gate.reason).toBe(
    "Weekly 61%, over the 60% queue cutoff (pace 50% + 10% margin)",
  );
  const ready = plan(
    usageSnapshot({ weekly: { percent: 59, resetsAt: halfway } }),
  );
  expect(ready.gate).toEqual({
    status: "ready",
    reason: "Session 16% of 75% · Weekly 59% of 60%",
  });
  const lateWeek = plan(
    usageSnapshot({
      weekly: { percent: 96, resetsAt: "2026-09-06T13:00:00Z" },
    }),
  );
  expect(lateWeek.weekly.ceiling).toBe(95);
  expect(lateWeek.gate.status).toBe("waiting");
  expect(
    plan(usageSnapshot({ weekly: { percent: 0, resetsAt: null } })).weekly,
  ).toEqual({ percent: 0, ceiling: 95, pace: null, reserved: 0, ok: true });
});

it("gates Fable-model tasks on the Fable window and mirrors task status", () => {
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
    TEST_TIME_ZONE,
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
    TEST_TIME_ZONE,
    undefined,
    { ...EMPTY_LOAD, lastRunEndedAt: "2026-09-06T11:56:00Z" },
    calibration,
  );
  expect(predates.gate).toEqual({
    status: "waiting",
    reason: USAGE_PREDATES_RUN_REASON,
  });
  const fresh = planDispatch(
    DEFAULT_DISPATCH_SETTINGS,
    { snapshot, error: null },
    now,
    TEST_TIME_ZONE,
    undefined,
    { ...EMPTY_LOAD, lastRunEndedAt: "2026-09-06T11:55:00Z" },
    calibration,
  );
  expect(fresh.gate.status).toBe("ready");
});

it("holds a task until its earliest start time and names that time", () => {
  const planning = plan(usageSnapshot());
  const task = {
    id: "a".repeat(24),
    status: "pending" as const,
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
  model: "opus",
  preferredWindowStart: null,
  earliestStart: null,
  tokens: 100_000,
  dependsOn: [] as string[],
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
  expect(planning.gate).toEqual({
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
  expect(planning.gate).toEqual({
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
  expect(planning.gate.status).toBe("ready");
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
  expect(planning.gate.status).toBe("ready");
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
});

it("admits no Claude task while the session rates are unknown", () => {
  const planning = planDispatch(
    anyHour,
    { snapshot: halfSpent, error: null },
    now,
    TEST_TIME_ZONE,
    undefined,
    EMPTY_LOAD,
    { rates: null, error: "Local history could not be read." },
  );
  expect(planning.rates).toBeNull();
  expect(planning.gate).toEqual({
    status: "waiting",
    reason:
      "Session cost calibration unavailable: Local history could not be read.",
  });
  expect(taskGate(pending, planning, now, [])).toMatchObject({
    status: "waiting",
    eligibleAt: null,
  });
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

it("leaves out tasks queued ahead that wait on the task, directly or through a chain", () => {
  const child = { ...pending, id: "b".repeat(24), dependsOn: [pending.id] };
  const grandchild = {
    ...pending,
    id: "c".repeat(24),
    tokens: 150_000,
    dependsOn: [child.id],
  };
  const independent = { ...pending, id: "d".repeat(24), tokens: 200_000 };
  expect(
    costsAhead(
      pending.id,
      [child, grandchild, independent, pending],
      [],
      SESSION_RATES,
    ),
  ).toEqual([27.5]);
});

it("sizes each future window with the reserve of the hour it opens in", () => {
  const settings = {
    ...DEFAULT_DISPATCH_SETTINGS,
    sessionReservePercent: 20,
    busyHoursReservePercent: 60,
    quietStartHours: 1,
  };
  const noonQuiet = { ranking: [12, 3, 2, 1], error: null };
  const planning = plan(
    usageSnapshot({
      session: { percent: 90, resetsAt: "2026-09-06T16:00:00.000Z" },
    }),
    null,
    settings,
    noonQuiet,
  );
  // 49.6% ahead plus 13.8% overflows the 40% busy cutoff but fits the 80% quiet one.
  expect(eligibleAt(pending, planning, now, [], [49.6])).toBe(
    "2026-09-06T16:00:00.000Z",
  );
});

const splitNight = {
  ...DEFAULT_DISPATCH_SETTINGS,
  sessionReservePercent: 20,
  busyHoursReservePercent: 60,
  quietStartHours: 4,
};
const smallHoursQuiet = { ranking: [0, 1, 2, 3], error: null };
const elevenThirtyPm = new Date("2026-09-07T03:30:00Z");
const windowFromElevenThirty = "2026-09-07T08:30:00Z";
const priced = [
  {
    taskId: pending.id,
    status: "completed" as const,
    sessionCostPercent: 41.5,
  },
];
const planAt = (at: Date, sessionPercent: number) =>
  planDispatch(
    splitNight,
    {
      snapshot: usageSnapshot({
        fetchedAt: at.toISOString(),
        session: { percent: sessionPercent, resetsAt: windowFromElevenThirty },
      }),
      error: null,
    },
    at,
    TEST_TIME_ZONE,
    smallHoursQuiet,
    EMPTY_LOAD,
    calibration,
  );

it("estimates a start at the quiet hour inside the open window whose cutoff fits", () => {
  // 11:30 PM busy cutoff is 40%: 2% + 41.5% (capped at 40%) overflows it; the 12 AM quiet cutoff is 80%.
  expect(
    taskGate(pending, planAt(elevenThirtyPm, 2), elevenThirtyPm, priced),
  ).toEqual({
    status: "waiting",
    reason:
      "Session 2% + 41.5% expected, over the 40% queue cutoff (busy hours)",
    eligibleAt: "2026-09-07T04:00:00.000Z",
  });
});

it("is admitted by the live gate at the estimated quiet hour and not a minute before", () => {
  const minuteBefore = new Date("2026-09-07T03:59:00Z");
  const midnight = new Date("2026-09-07T04:00:00Z");
  expect(
    taskGate(pending, planAt(minuteBefore, 2), minuteBefore, priced).status,
  ).toBe("waiting");
  expect(taskGate(pending, planAt(midnight, 2), midnight, priced)).toEqual({
    status: "ready",
    reason: "Session 2% of 80% · Weekly 2% of 22%",
    eligibleAt: midnight.toISOString(),
  });
});

it("lets the work queued ahead take its share of the window before the quiet hour", () => {
  // The 2% task ahead starts at 11:30 PM; this one then overflows the 40% busy cutoff until 12 AM.
  expect(
    eligibleAt(pending, planAt(elevenThirtyPm, 0), elevenThirtyPm, priced, [2]),
  ).toBe("2026-09-07T04:00:00.000Z");
});

it("waits for the next window when no hour before the reset fits the task", () => {
  // 50% + 41.5% overflows the 80% quiet cutoff from 12 to 4 AM and the 40% busy one at 4 AM;
  // the window resets at 4:30 AM, where 41.5% capped at the 40% busy cutoff fits an empty session.
  expect(
    taskGate(pending, planAt(elevenThirtyPm, 50), elevenThirtyPm, priced),
  ).toMatchObject({
    status: "waiting",
    eligibleAt: "2026-09-07T08:30:00.000Z",
  });
});

it("holds the work queued ahead to quiet hours too when the queue runs only in them", () => {
  const planning = plan(
    usageSnapshot({
      session: { percent: 30, resetsAt: "2026-09-06T11:00:00Z" },
    }),
    null,
    { ...DEFAULT_DISPATCH_SETTINGS, quietStartHours: 4 },
    smallHoursQuiet,
  );
  // The 60% task ahead starts at 12 AM and opens a window until 5 AM; 60% + 20.7% overflows the
  // 75% cutoff in it, and 5 AM is not a quiet hour, so this one waits for 12 AM the next night.
  expect(
    eligibleAt({ ...pending, tokens: 150_000 }, planning, now, [], [60]),
  ).toBe("2026-09-08T04:00:00.000Z");
});

it("places a preferred window that opens in busy hours only where its cutoff fits", () => {
  const planning = plan(busySession, null, splitReserves, {
    ranking: [8, 9],
    error: null,
  });
  // 8 AM is quiet (90% cutoff), but the 10 AM window opens in busy hours, where 40% + 13.8% overflows
  // the 30% cutoff until the session resets at 12:09 PM, still inside the window.
  expect(
    taskGate({ ...pending, preferredWindowStart: 10 }, planning, now, []),
  ).toMatchObject({
    status: "waiting",
    eligibleAt: "2026-09-06T16:09:00.000Z",
  });
});

it("waits for the weekly ceiling to clear what running tasks hold on top of the measured percent", () => {
  const load = {
    ...EMPTY_LOAD,
    running: 1,
    claudeRuns: 1,
    reserved: { session: 0, weekly: 3, fable: 0 },
  };
  const planning = plan(
    usageSnapshot({
      weekly: { percent: 57, resetsAt: "2026-09-10T12:00:00Z" },
    }),
    null,
    anyHour,
    undefined,
    load,
  );
  // 57% + 3% held needs the pace-plus-10% ceiling at 60%, a pace of 50%: half of the week from Sep 3, 12:00 UTC.
  expect(taskGate(pending, planning, now, [])).toMatchObject({
    status: "waiting",
    eligibleAt: "2026-09-07T00:00:00.000Z",
  });
});

const KOLKATA = "Asia/Kolkata";
const planIn = (
  timeZone: string,
  at: Date,
  snapshot: ReturnType<typeof usageSnapshot>,
  settings = DEFAULT_DISPATCH_SETTINGS,
  ranking?: QuietRanking,
) =>
  planDispatch(
    settings,
    { snapshot, error: null },
    at,
    timeZone,
    ranking,
    EMPTY_LOAD,
    calibration,
  );

it("reads quiet hours in the zone it was given and carries that zone on the snapshot", () => {
  // 2026-09-06T12:00Z is 17:30 in Kolkata.
  const planning = planIn(KOLKATA, now, usageSnapshot());
  expect(planning.timeZone).toBe(KOLKATA);
  expect(planning.quiet.nowHour).toBe(17);
});

it("steps the eligible-time walk on local hours in a half-hour zone", () => {
  // Kolkata hour 23 starts at 17:30Z; the session resets at 16:09Z, before any quiet start hour.
  const planning = planIn(
    KOLKATA,
    now,
    usageSnapshot(),
    { ...DEFAULT_DISPATCH_SETTINGS, quietStartHours: 1 },
    { ranking: [23, 0, 1], error: null },
  );
  expect(eligibleAt(pending, planning, now, [])).toBe(
    "2026-09-06T17:30:00.000Z",
  );
});

it("opens a preferred window at its local start hour in a half-hour zone", () => {
  const planning = planIn(KOLKATA, now, usageSnapshot(), {
    ...DEFAULT_DISPATCH_SETTINGS,
    busyHoursReservePercent: 25,
  });
  const windowed = { ...pending, preferredWindowStart: 22 };
  expect(taskGate(windowed, planning, now, [])).toMatchObject({
    status: "waiting",
    reason: "Outside window 10 PM → 3 AM",
    eligibleAt: "2026-09-06T16:30:00.000Z",
  });
});

it("starts a quiet hour after a spring-forward gap at the first instant it exists", () => {
  // 01:00 EST is 06:00Z; 02:00 does not exist, so local hour 3 begins at 07:00Z.
  const springNow = new Date("2026-03-08T05:30:00Z");
  const planning = planIn(
    TEST_TIME_ZONE,
    springNow,
    usageSnapshot({
      fetchedAt: "2026-03-08T05:30:00.000Z",
      session: { percent: 0, resetsAt: "2026-03-08T00:00:00.000Z" },
      weekly: { percent: 2, resetsAt: "2026-03-13T07:53:00.000Z" },
      fable: { percent: 2, resetsAt: "2026-03-13T07:53:00.000Z" },
    }),
    { ...DEFAULT_DISPATCH_SETTINGS, quietStartHours: 1 },
    { ranking: [3, 0, 1], error: null },
  );
  expect(eligibleAt(pending, planning, springNow, [])).toBe(
    "2026-03-08T07:00:00.000Z",
  );
});

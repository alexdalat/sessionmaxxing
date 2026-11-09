import { describe, expect, it } from "vitest";
import {
  planDispatch,
  planLite,
  taskGate,
  USAGE_PREDATES_RUN_REASON,
} from "../server/dispatch.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchLoad,
  type DispatchSettings,
  EMPTY_LOAD,
  type PublicTask,
  USAGE_STALE_MS,
} from "../shared/types.js";
import { SESSION_RATES, TEST_TIME_ZONE, usageSnapshot } from "./helpers";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const now = new Date("2026-09-06T12:00:00Z");
// Three and a half days into a seven-day window: pace 50, so the default margin of 10 gives a ceiling of 60.
const HALF_WEEK_RESET = "2026-09-10T00:00:00Z";
const usage = (patch: Parameters<typeof usageSnapshot>[0] = {}) =>
  usageSnapshot({
    weekly: { percent: 2, resetsAt: HALF_WEEK_RESET },
    ...patch,
  });
const session = (percent: number, resetsAt = "2026-09-06T16:09:00Z") => ({
  session: { percent, resetsAt },
});
const weekly = (percent: number, resetsAt = HALF_WEEK_RESET) => ({
  weekly: { percent, resetsAt },
});
const holding = (session: number, weekly = 0): DispatchLoad => ({
  ...EMPTY_LOAD,
  reserved: { session, weekly, fable: 0 },
});
const lite = (
  snapshot: ReturnType<typeof usageSnapshot> | null,
  error: string | null = null,
  settings: DispatchSettings = DEFAULT_DISPATCH_SETTINGS,
  load: DispatchLoad = EMPTY_LOAD,
  at = now,
) => planLite(settings, { snapshot, error }, at, TEST_TIME_ZONE, load);

describe("the lite usage gate", () => {
  it("waits while every run slot is busy", () => {
    const planning = lite(usage(), null, DEFAULT_DISPATCH_SETTINGS, {
      ...EMPTY_LOAD,
      running: 2,
    });
    expect(planning.gate).toEqual({
      status: "waiting",
      reason: "All 2 run slots busy",
    });
  });

  it("names a single busy slot in the singular", () => {
    const planning = lite(
      usage(),
      null,
      { ...DEFAULT_DISPATCH_SETTINGS, maxConcurrentRuns: 1 },
      { ...EMPTY_LOAD, running: 1 },
    );
    expect(planning.gate.reason).toBe("All 1 run slot busy");
  });

  it("checks the slots before official usage", () => {
    const planning = lite(null, null, DEFAULT_DISPATCH_SETTINGS, {
      ...EMPTY_LOAD,
      running: 2,
    });
    expect(planning.gate.reason).toBe("All 2 run slots busy");
  });

  it("waits with the fetch error when no snapshot exists", () => {
    expect(lite(null, "Claude Code credentials not found.").gate).toEqual({
      status: "waiting",
      reason: "Official usage unavailable: Claude Code credentials not found.",
    });
  });

  it("waits with a not-fetched message when no snapshot and no error exist", () => {
    expect(lite(null).gate.reason).toBe(
      "Official usage unavailable: not fetched yet",
    );
  });

  it("waits when the snapshot is older than the stale limit and keeps the fetch error", () => {
    const fetchedAt = new Date(
      now.getTime() - USAGE_STALE_MS - MINUTE_MS,
    ).toISOString();
    const planning = lite(
      usage({ fetchedAt }),
      "Anthropic usage endpoint returned HTTP 503.",
    );
    expect(planning.gate).toEqual({
      status: "waiting",
      reason:
        "Official usage is 16 min old · refresh to retry (Anthropic usage endpoint returned HTTP 503.)",
    });
  });

  it("accepts a snapshot exactly as old as the stale limit", () => {
    const fetchedAt = new Date(now.getTime() - USAGE_STALE_MS).toISOString();
    expect(lite(usage({ fetchedAt })).gate.status).toBe("ready");
  });

  it("waits with the post-run reason when the snapshot predates the last run", () => {
    const planning = lite(
      usage({ fetchedAt: "2026-09-06T11:50:00Z" }),
      null,
      DEFAULT_DISPATCH_SETTINGS,
      { ...EMPTY_LOAD, lastRunEndedAt: "2026-09-06T11:55:00Z" },
    );
    expect(planning.gate).toEqual({
      status: "waiting",
      reason: USAGE_PREDATES_RUN_REASON,
    });
  });

  it("trusts a snapshot fetched after the last run ended", () => {
    const planning = lite(
      usage({ fetchedAt: "2026-09-06T11:58:00Z" }),
      null,
      DEFAULT_DISPATCH_SETTINGS,
      { ...EMPTY_LOAD, lastRunEndedAt: "2026-09-06T11:55:00Z" },
    );
    expect(planning.gate.status).toBe("ready");
  });

  it("waits when the session is over 100 minus the reserve", () => {
    const planning = lite(usage(session(80)));
    expect(planning.session).toMatchObject({ percent: 80, ceiling: 75 });
    expect(planning.gate).toEqual({
      status: "waiting",
      reason: "Session 80%, over the 75% queue cutoff",
    });
  });

  it("is ready with the session exactly at its cutoff and waits one point over", () => {
    expect(lite(usage(session(75))).gate.status).toBe("ready");
    expect(lite(usage(session(76))).gate.reason).toBe(
      "Session 76%, over the 75% queue cutoff",
    );
  });

  it("is ready with the session at 70 and nothing held", () => {
    expect(lite(usage(session(70))).gate.status).toBe("ready");
  });

  it("counts session points held for running tasks against the cutoff", () => {
    const planning = lite(
      usage(session(70)),
      null,
      DEFAULT_DISPATCH_SETTINGS,
      holding(10),
    );
    expect(planning.gate).toEqual({
      status: "waiting",
      reason:
        "Session 70% + 10% held for running tasks, over the 75% queue cutoff",
    });
  });

  it("treats an expired session window as empty", () => {
    const planning = lite(usage(session(99, "2026-09-06T11:00:00Z")));
    expect(planning.session.percent).toBe(0);
    expect(planning.gate.status).toBe("ready");
  });

  it("follows sessionReservePercent for the session cutoff", () => {
    const settings = {
      ...DEFAULT_DISPATCH_SETTINGS,
      sessionReservePercent: 50,
    };
    const planning = lite(usage(session(60)), null, settings);
    expect(planning.session.ceiling).toBe(50);
    expect(planning.gate.reason).toBe("Session 60%, over the 50% queue cutoff");
  });

  it("waits when the weekly window is over pace plus margin", () => {
    const planning = lite(usage(weekly(61)));
    expect(planning.weekly).toMatchObject({
      percent: 61,
      ceiling: 60,
      pace: 50,
    });
    expect(planning.gate).toEqual({
      status: "waiting",
      reason: "Weekly 61%, over the 60% queue cutoff (pace 50% + 10% margin)",
    });
  });

  it("is ready with weekly exactly at pace plus margin", () => {
    expect(lite(usage(weekly(60))).gate.status).toBe("ready");
  });

  it("counts weekly points held for running tasks against the ceiling", () => {
    const planning = lite(
      usage(weekly(58)),
      null,
      DEFAULT_DISPATCH_SETTINGS,
      holding(0, 3),
    );
    expect(planning.gate.reason).toBe(
      "Weekly 58% + 3% held for running tasks, over the 60% queue cutoff (pace 50% + 10% margin)",
    );
  });

  it("never lets the weekly ceiling pass 95", () => {
    const settings = { ...DEFAULT_DISPATCH_SETTINGS, weeklyMarginPercent: 50 };
    // 1.4 days before the reset is 80% of the way through the window.
    const resetsAt = "2026-09-07T21:36:00Z";
    expect(lite(usage(weekly(94, resetsAt)), null, settings).gate.status).toBe(
      "ready",
    );
    const over = lite(usage(weekly(96, resetsAt)), null, settings);
    expect(over.weekly).toMatchObject({ ceiling: 95, pace: 80 });
    expect(over.gate.reason).toBe(
      "Weekly 96%, over the 95% queue cutoff (pace 80% + 50% margin)",
    );
  });

  it("reports session before weekly when both are over", () => {
    expect(lite(usage({ ...session(80), ...weekly(61) })).gate.reason).toMatch(
      /^Session 80%/,
    );
  });

  it("describes both buckets when ready", () => {
    expect(lite(usage()).gate).toEqual({
      status: "ready",
      reason: "Session 16% of 75% · Weekly 2% of 60%",
    });
  });

  it("includes held points in the ready reason", () => {
    expect(
      lite(usage(), null, DEFAULT_DISPATCH_SETTINGS, holding(5, 3)).gate.reason,
    ).toBe(
      "Session 16% + 5% held for running tasks of 75% · Weekly 2% + 3% held for running tasks of 60%",
    );
  });

  it("ignores busy-hours reserve and quiet start hours at every hour of the day", () => {
    const settings = {
      ...DEFAULT_DISPATCH_SETTINGS,
      busyHoursReservePercent: 100,
      quietStartHours: 0,
    };
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(now.getTime() + hour * HOUR_MS);
      const planning = lite(
        usage({
          fetchedAt: at.toISOString(),
          ...session(16, new Date(at.getTime() + 4 * HOUR_MS).toISOString()),
          ...weekly(
            2,
            new Date(at.getTime() + 3.5 * 24 * HOUR_MS).toISOString(),
          ),
        }),
        null,
        settings,
        EMPTY_LOAD,
        at,
      );
      expect(planning.gate.status).toBe("ready");
      expect(planning.session.ceiling).toBe(75);
    }
  });

  it("keeps the session cutoff at 100 minus sessionReservePercent when the busy-hours reserve differs", () => {
    const settings = {
      ...DEFAULT_DISPATCH_SETTINGS,
      busyHoursReservePercent: 40,
    };
    const planning = lite(usage(session(70)), null, settings);
    expect(planning.session.ceiling).toBe(75);
    expect(planning.gate.status).toBe("ready");
  });

  it("returns lite planning with no rates, quiet hours or Fable bucket", () => {
    const planning = lite(usage());
    expect(planning.edition).toBe("lite");
    expect(planning).not.toHaveProperty("rates");
    expect(planning).not.toHaveProperty("quiet");
    expect(planning).not.toHaveProperty("fable");
    expect(planning.timeZone).toBe(TEST_TIME_ZONE);
    expect(planning.settings).toEqual(DEFAULT_DISPATCH_SETTINGS);
  });

  it("carries the usage snapshot and the fetch error through", () => {
    const snapshot = usage();
    const planning = lite(snapshot, "HTTP 503");
    expect(planning.usage).toBe(snapshot);
    expect(planning.usageError).toBe("HTTP 503");
    expect(lite(null).usage).toBeNull();
  });

  it("words every shared check the way the full gate does", () => {
    const cases: [
      ReturnType<typeof usageSnapshot> | null,
      string | null,
      DispatchLoad,
    ][] = [
      [null, "Claude Code credentials not found.", EMPTY_LOAD],
      [null, null, EMPTY_LOAD],
      [usage({ fetchedAt: "2026-09-06T11:40:00Z" }), "HTTP 503", EMPTY_LOAD],
      [
        usage({ fetchedAt: "2026-09-06T11:50:00Z" }),
        null,
        { ...EMPTY_LOAD, lastRunEndedAt: "2026-09-06T11:55:00Z" },
      ],
      [usage(session(80)), null, EMPTY_LOAD],
      [usage(session(70)), null, holding(10)],
      [usage(weekly(61)), null, EMPTY_LOAD],
      [usage(weekly(58)), null, holding(0, 3)],
      [usage(), null, { ...EMPTY_LOAD, running: 2 }],
      [usage(), null, EMPTY_LOAD],
    ];
    for (const [snapshot, error, load] of cases) {
      const full = planDispatch(
        DEFAULT_DISPATCH_SETTINGS,
        { snapshot, error },
        now,
        TEST_TIME_ZONE,
        { ranking: null, error: null },
        load,
        { rates: SESSION_RATES, error: null },
      );
      expect(
        lite(snapshot, error, DEFAULT_DISPATCH_SETTINGS, load).gate,
      ).toEqual(full.gate);
    }
  });

  it("does not wait on calibration or a per-task expected cost", () => {
    expect(lite(usage(session(74))).gate.status).toBe("ready");
  });
});

describe("taskGate on lite planning", () => {
  const readyPlanning = lite(usage());
  const task = (patch: Partial<PublicTask> = {}) => ({
    id: "t1",
    status: "pending" as const,
    model: "sonnet",
    preferredWindowStart: null,
    earliestStart: null,
    tokens: null,
    ...patch,
  });

  it("gives a ready task no eligible time", () => {
    expect(taskGate(task(), readyPlanning, now, [])).toEqual({
      status: "ready",
      reason: "Session 16% of 75% · Weekly 2% of 60%",
      eligibleAt: null,
    });
  });

  it("gives a task that waits on usage no eligible time", () => {
    const gate = taskGate(task(), lite(usage(session(80))), now, []);
    expect(gate).toEqual({
      status: "waiting",
      reason: "Session 80%, over the 75% queue cutoff",
      eligibleAt: null,
    });
  });

  it("holds a task before its earliest start", () => {
    const gate = taskGate(
      task({ earliestStart: "2026-09-06T18:00:00Z" }),
      readyPlanning,
      now,
      [],
    );
    expect(gate.status).toBe("waiting");
    expect(gate.reason).toMatch(/^Starts after /);
    expect(gate.eligibleAt).toBeNull();
  });

  it("holds a task outside its preferred window", () => {
    // 12:00Z is 8 AM in Toronto; the window opens at 8 PM and closes at 1 AM.
    const gate = taskGate(
      task({ preferredWindowStart: 20 }),
      readyPlanning,
      now,
      [],
    );
    expect(gate).toEqual({
      status: "waiting",
      reason: "Outside window 8 PM → 1 AM",
      eligibleAt: null,
    });
  });

  it("admits a task inside its preferred window", () => {
    const gate = taskGate(
      task({ preferredWindowStart: 6 }),
      readyPlanning,
      now,
      [],
    );
    expect(gate.status).toBe("ready");
  });

  it("admits a Fable task while the snapshot's Fable window is full", () => {
    const planning = lite(
      usage({ fable: { percent: 100, resetsAt: HALF_WEEK_RESET } }),
    );
    expect(taskGate(task({ model: "fable" }), planning, now, []).status).toBe(
      "ready",
    );
  });

  it("admits a task whatever token cost it carries", () => {
    const huge = taskGate(
      task({ tokens: 1_000_000_000 }),
      readyPlanning,
      now,
      [],
    );
    expect(huge.status).toBe("ready");
    expect(
      taskGate(task({ tokens: null }), readyPlanning, now, []).status,
    ).toBe("ready");
  });

  it("reports running and finished tasks as in the full gate", () => {
    expect(
      taskGate(task({ status: "running" }), readyPlanning, now, []),
    ).toEqual({ status: "running", reason: "Running now", eligibleAt: null });
    expect(
      taskGate(task({ status: "completed" }), readyPlanning, now, []),
    ).toEqual({ status: "finished", reason: "completed", eligibleAt: null });
  });
});

import { expect, it } from "vitest";
import { planDispatch, taskGate, weeklyPace } from "../server/dispatch.js";
import { DEFAULT_DISPATCH_SETTINGS } from "../shared/types.js";
import { usageSnapshot } from "./helpers";

const now = new Date("2026-09-06T12:00:00Z");
const plan = (
  snapshot: ReturnType<typeof usageSnapshot> | null,
  error: string | null = null,
  settings = DEFAULT_DISPATCH_SETTINGS,
) => planDispatch(settings, { snapshot, error }, now);

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
      sessionReservePercent: 90,
      weeklyMarginPercent: 10,
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
  const base = { status: "pending" as const, provider: "claude" as const };
  expect(taskGate({ ...base, model: "opus" }, planning).status).toBe("ready");
  expect(taskGate({ ...base, model: "claude-fable-5-1" }, planning)).toEqual({
    status: "waiting",
    reason: "Fable weekly at 70%, above the 60% ceiling",
  });
  expect(
    taskGate({ ...base, provider: "codex", model: "gpt-6-astra" }, planning),
  ).toEqual({
    status: "ready",
    reason: "Codex runs do not touch Claude usage",
  });
  expect(
    taskGate({ ...base, status: "running", model: "opus" }, planning),
  ).toMatchObject({ status: "running" });
  expect(
    taskGate({ ...base, status: "failed", model: "opus" }, planning),
  ).toEqual({ status: "finished", reason: "failed" });
  const noFable = plan(usageSnapshot({ fable: null }));
  expect(noFable.fable).toBeNull();
  expect(taskGate({ ...base, model: "claude-fable-5-1" }, noFable).status).toBe(
    "ready",
  );
});

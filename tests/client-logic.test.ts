import { expect, it } from "vitest";
import { describeHours, quietSummary, usageHue } from "../app/DispatchPanel";
import { allowedStartHours } from "../app/QuietHoursStrip";
import { displayOrder } from "../app/queueOrder";
import { clockOfFraction } from "../app/SessionWindows";
import { modelOptions } from "../app/TaskForm";
import { easternDay } from "../app/time";
import { dayTicks, paceSeries } from "../app/WeeklyPace";
import type {
  Opportunity,
  PublicTask,
  TaskGate,
  UsageSample,
} from "../shared/types.js";
import { FABLE_MODEL, PROVIDER_MODELS, planLabel } from "../shared/types.js";
import { usageSnapshot } from "./helpers";

const samples: UsageSample[] = [
  {
    at: "2026-09-06T12:00:00.000Z",
    session: 16,
    sessionResetsAt: "2026-09-06T16:09:00.000Z",
    weekly: 2,
    weeklyResetsAt: "2026-09-13T07:53:00.000Z",
    fable: 4,
  },
];

it("pace series ends the usage lines at the snapshot fetch time", () => {
  const snapshot = usageSnapshot({
    fetchedAt: "2026-09-06T14:00:00.000Z",
    weekly: { percent: 22, resetsAt: "2026-09-13T07:53:00.000Z" },
    fable: { percent: 7, resetsAt: "2026-09-13T07:53:00.000Z" },
  });
  const points = paceSeries(samples, snapshot, 10);
  const nowPoint = points?.find(
    (point) => point.t === Date.parse(snapshot.fetchedAt),
  );
  expect(nowPoint?.weekly).toBe(22);
  expect(nowPoint?.fable).toBe(7);
  expect(points?.at(-1)?.pace).toBe(100);
});

it("pace series keeps samples whose weekly reset differs from the snapshot by sub-second jitter", () => {
  const jittered = (at: string, weeklyResetsAt: string): UsageSample => ({
    at,
    session: 10,
    sessionResetsAt: null,
    weekly: 30,
    weeklyResetsAt,
    fable: null,
  });
  const points = paceSeries(
    [
      jittered("2026-09-02T12:00:00.000Z", "2026-09-06T08:00:00.000Z"),
      jittered("2026-09-08T12:00:00.000Z", "2026-09-13T07:59:59.356Z"),
      jittered("2026-09-09T12:00:00.000Z", "2026-09-13T08:00:01.008Z"),
    ],
    usageSnapshot({
      fetchedAt: "2026-09-10T00:00:00.000Z",
      weekly: { percent: 40, resetsAt: "2026-09-13T08:00:00.500Z" },
    }),
    10,
  );
  expect(
    points
      ?.filter((point) => point.weekly !== undefined)
      .map((point) => point.t),
  ).toEqual([
    Date.parse("2026-09-08T12:00:00.000Z"),
    Date.parse("2026-09-09T12:00:00.000Z"),
    Date.parse("2026-09-10T00:00:00.000Z"),
  ]);
});

it("describes quiet start hours as wrapped ranges", () => {
  expect(describeHours([0, 1, 2, 3, 20, 21, 22, 23])).toBe("8 PM–3 AM");
  expect(describeHours([1, 2, 5, 12])).toBe("1 AM–2 AM, 5 AM, 12 PM");
  expect(describeHours([])).toBe("none");
});

it("usage hue runs from green at zero to red at the ceiling and clamps past it", () => {
  expect(usageHue(0, 80)).toBe(145);
  expect(usageHue(40, 80)).toBe(73);
  expect(usageHue(80, 80)).toBe(0);
  expect(usageHue(120, 80)).toBe(0);
  expect(usageHue(5, 0)).toBe(0);
});

it("quiet summary names the ranges and whether quiet hours are in effect", () => {
  const quiet = {
    startHours: [23, 0, 1, 2, 3, 4, 5, 6],
    error: null,
    nowHour: 23,
    active: true,
    nextStartHour: 0,
  };
  expect(quietSummary(quiet, true)).toBe("Quiet hours 11 PM–6 AM · in effect");
  expect(
    quietSummary(
      { ...quiet, nowHour: 14, active: false, nextStartHour: 23 },
      true,
    ),
  ).toBe("Quiet hours 11 PM–6 AM · next 11 PM");
  expect(quietSummary(quiet, false)).toBe("Quiet hours off");
});

it("day ticks land on each Eastern midnight inside the weekly window", () => {
  const start = Date.parse("2026-09-06T07:53:00.000Z");
  const end = Date.parse("2026-09-13T07:53:00.000Z");
  const ticks = dayTicks(start, end);
  expect(ticks.map((t) => easternDay(t).date)).toEqual([
    "2026-09-07",
    "2026-09-08",
    "2026-09-09",
    "2026-09-10",
    "2026-09-11",
    "2026-09-12",
    "2026-09-13",
  ]);
  for (const t of ticks) expect(easternDay(t).fraction).toBe(0);
});

it("clock of a day fraction reads to the minute with 12-hour labels", () => {
  expect(clockOfFraction(0)).toBe("12:00 AM");
  expect(clockOfFraction(0.5)).toBe("12:00 PM");
  expect(clockOfFraction((13 * 60 + 5) / 1440)).toBe("1:05 PM");
  expect(clockOfFraction(1)).toBe("12:00 AM");
  expect(clockOfFraction(-0.2)).toBe("12:00 AM");
});

it("keeps the provider list when the current model is one of its options", () => {
  expect(modelOptions("claude", "sonnet")).toEqual(PROVIDER_MODELS.claude);
});

it("appends an unknown current model as its own option", () => {
  const options = modelOptions("claude", "claude-3-5-sonnet-20241022");
  expect(options).toEqual([
    ...PROVIDER_MODELS.claude,
    {
      value: "claude-3-5-sonnet-20241022",
      label: "claude-3-5-sonnet-20241022",
    },
  ]);
});

it("offers no Claude models for the codex provider", () => {
  const values = modelOptions("codex").map((option) => option.value);
  expect(values).not.toContain("opus");
  expect(values).not.toContain("fable");
  expect(values).toContain("gpt-6-astra");
});

it("dispatches the Fable weekly rule for the Fable option value", () => {
  const fable = PROVIDER_MODELS.claude[0];
  expect(fable.label).toBe("Fable 5.1");
  expect(FABLE_MODEL.test(fable.value)).toBe(true);
});

const QUIET_RANKING = [
  4, 3, 5, 2, 6, 1, 7, 0, 8, 23, 9, 22, 10, 21, 11, 20, 12, 19, 13, 18, 14, 17,
  15, 16,
];
const ranking: Opportunity[] = QUIET_RANKING.map((startHour, index) => ({
  startHour,
  endHour: (startHour + 5) % 24,
  averageActiveMinutes: index * 5,
  averageResponses: index,
  utilization: index / QUIET_RANKING.length,
  samples: 30,
  estimated: true,
}));

it("allows the quietest start hours up to the configured count", () => {
  expect([...allowedStartHours(ranking, 3)]).toEqual([4, 3, 5]);
});

it("allows no start hours for a count of zero or below", () => {
  expect(allowedStartHours(ranking, 0).size).toBe(0);
  expect(allowedStartHours(ranking, -3).size).toBe(0);
});

it("allows every ranked hour for a count above 24", () => {
  expect(allowedStartHours(ranking, 40)).toEqual(new Set(QUIET_RANKING));
});

it("names the known subscription plans", () => {
  expect(planLabel("pro")).toBe("Claude Pro");
  expect(planLabel("max")).toBe("Claude Max");
});

it("capitalizes an unknown plan and falls back to Claude when none is known", () => {
  expect(planLabel("team")).toBe("Claude Team");
  expect(planLabel(null)).toBe("Claude");
});

const queued = (
  id: string,
  status: PublicTask["status"],
  gate: TaskGate["status"],
): PublicTask => ({
  id,
  title: id,
  prompt: "do the thing",
  workdir: "/home/user/workspace/claude-capacity-dashboard",
  provider: "claude",
  model: "opus",
  priority: 0,
  status,
  createdAt: "2026-09-06T12:00:00.000Z",
  earliestStart: null,
  preferredWindowStart: null,
  maxTurns: 40,
  gate: { status: gate, reason: gate },
});

it("shows running tasks, then ready, then waiting, then finished", () => {
  const order = displayOrder([
    queued("done", "completed", "finished"),
    queued("held", "pending", "waiting"),
    queued("next", "pending", "ready"),
    queued("active", "running", "running"),
  ]);
  expect(order.map((task) => task.id)).toEqual([
    "active",
    "next",
    "held",
    "done",
  ]);
});

it("orders waiting tasks by earliest start, soonest first, with unscheduled ones ahead", () => {
  const order = displayOrder([
    {
      ...queued("later", "pending", "waiting"),
      earliestStart: "2026-09-09T03:27:00.000Z",
    },
    {
      ...queued("tonight", "pending", "waiting"),
      earliestStart: "2026-09-08T03:00:00.000Z",
    },
    queued("anytime", "pending", "waiting"),
  ]);
  expect(order.map((task) => task.id)).toEqual(["anytime", "tonight", "later"]);
});

it("keeps the server order within a group", () => {
  const order = displayOrder([
    queued("ready-a", "pending", "ready"),
    queued("cancelled", "cancelled", "finished"),
    queued("ready-b", "pending", "ready"),
    queued("failed", "failed", "finished"),
  ]);
  expect(order.map((task) => task.id)).toEqual([
    "ready-a",
    "ready-b",
    "cancelled",
    "failed",
  ]);
});

it("orders an empty queue as an empty list", () => {
  expect(displayOrder([])).toEqual([]);
});

import { describe, expect, it } from "vitest";
import { activitySeries, type Breakdown } from "../app/lib/activitySeries";
import { heatmapTotals, sourceRows } from "../app/lib/analyticsRows";
import {
  describeHours,
  quietSummary,
  usageHue,
} from "../app/lib/dispatchSummary";
import { modelOptions } from "../app/lib/models";
import { dayTicks, paceSeries } from "../app/lib/pace";
import { scoreSeries } from "../app/lib/planScore";
import { displayOrder, movedPast, moveTarget } from "../app/lib/queueOrder";
import { queuePreview, waitNote } from "../app/lib/queuePreview";
import { allowedStartHours } from "../app/lib/quietHours";
import { clockOfFraction } from "../app/lib/sessionWindows";
import { easternCell, easternDay } from "../app/lib/time";
import type {
  ActivitySource,
  ChangedFile,
  CoverageDay,
  DailyActivity,
  HeatCell,
  Opportunity,
  PlanScore as PlanScoreData,
  PublicTask,
  Run,
  SourceActivity,
  TaskGate,
  UsageSample,
} from "../shared/types.js";
import {
  ACTIVITY_SOURCES,
  DEFAULT_DISPATCH_SETTINGS,
  FABLE_MODEL,
  formatTokens,
  needsReview,
  PROVIDER_MODELS,
  planLabel,
} from "../shared/types.js";
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

it("quiet summary names the ranges, when they open, and the two session reserves", () => {
  const quiet = {
    startHours: [23, 0, 1, 2, 3, 4, 5, 6],
    error: null,
    nowHour: 23,
    active: true,
    nextStartHour: 0,
  };
  expect(quietSummary(quiet, DEFAULT_DISPATCH_SETTINGS)).toBe(
    "Quiet hours 11 PM–6 AM · open now",
  );
  expect(
    quietSummary(
      { ...quiet, nowHour: 14, active: false, nextStartHour: 23 },
      DEFAULT_DISPATCH_SETTINGS,
    ),
  ).toBe("Quiet hours 11 PM–6 AM · opens 11 PM");
  expect(
    quietSummary(quiet, {
      ...DEFAULT_DISPATCH_SETTINGS,
      sessionReservePercent: 10,
      busyHoursReservePercent: 70,
    }),
  ).toBe("Quiet hours 11 PM–6 AM keep 10% · other hours keep 70% · open now");
  expect(
    quietSummary(
      { ...quiet, startHours: null, error: "Local history could not be read." },
      DEFAULT_DISPATCH_SETTINGS,
    ),
  ).toBe("Quiet hours not computed yet (Local history could not be read.)");
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
  eligibleAt: string | null = null,
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
  finishedAt: null,
  review: null,
  earliestStart: null,
  preferredWindowStart: null,
  maxTurns: 40,
  tokens: 100_000,
  dependsOn: [],
  sessionCostPercent: 13.8,
  gate: { status: gate, reason: gate, eligibleAt },
});

describe("queuePreview", () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");
  it("lists every unfinished task in dispatch order with a wait countdown", () => {
    const rows = queuePreview(
      [
        queued("done", "completed", "finished"),
        queued("later", "pending", "waiting", "2026-09-06T14:30:00.000Z"),
        queued("soon", "pending", "waiting", "2026-09-06T12:05:00.000Z"),
        queued("go", "pending", "ready"),
        queued("busy", "running", "running"),
        queued("someday", "pending", "waiting", null),
      ],
      now,
    );
    expect(rows.map((row) => [row.id, row.state, row.note])).toEqual([
      ["busy", "running", "running"],
      ["go", "ready", "ready"],
      ["soon", "waiting", "in 5m"],
      ["later", "waiting", "in 2h 30m"],
      ["someday", "waiting", "waiting"],
    ]);
  });
  it("says waiting when the eligible instant has passed, is unknown, or is under a minute away", () => {
    const rows = queuePreview(
      [
        queued("past", "pending", "waiting", "2026-09-06T11:00:00.000Z"),
        queued("unknown", "pending", "waiting", null),
        queued("seconds", "pending", "waiting", "2026-09-06T12:00:20.000Z"),
      ],
      now,
    );
    expect(rows.map((row) => row.note)).toEqual([
      "waiting",
      "waiting",
      "waiting",
    ]);
  });
  it("is empty when every task is finished", () => {
    expect(queuePreview([queued("done", "failed", "finished")], now)).toEqual(
      [],
    );
  });
});

describe("waitNote", () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");
  it("counts down to the slot of a waiting task", () => {
    expect(
      waitNote(
        queued("later", "pending", "waiting", "2026-09-06T21:55:00.000Z"),
        now,
      ),
    ).toBe("in 9h 55m");
  });
  it("has nothing to say for ready, running, or unknowable tasks", () => {
    expect(waitNote(queued("go", "pending", "ready"), now)).toBeNull();
    expect(waitNote(queued("busy", "running", "running"), now)).toBeNull();
    expect(waitNote(queued("someday", "pending", "waiting", null), now)).toBe(
      null,
    );
  });
});

it("shows running tasks, then ready, then waiting, and leaves finished ones to their own section", () => {
  const order = displayOrder([
    queued("done", "completed", "finished"),
    queued("held", "pending", "waiting"),
    queued("next", "pending", "ready"),
    queued("active", "running", "running"),
  ]);
  expect(order.map((task) => task.id)).toEqual(["active", "next", "held"]);
});

it("sorts waiting tasks by when they become eligible, unknown starts last in priority order", () => {
  const order = displayOrder([
    queued("unknown-first", "pending", "waiting"),
    queued("later", "pending", "waiting", "2026-09-09T03:27:00.000Z"),
    queued("unknown-second", "pending", "waiting"),
    queued("tonight", "pending", "waiting", "2026-09-08T03:00:00.000Z"),
  ]);
  expect(order.map((task) => task.id)).toEqual([
    "tonight",
    "later",
    "unknown-first",
    "unknown-second",
  ]);
});

it("keeps the server order within a group", () => {
  const order = displayOrder([
    queued("ready-a", "pending", "ready"),
    queued("cancelled", "cancelled", "finished"),
    queued("ready-b", "pending", "ready"),
    queued("failed", "failed", "finished"),
  ]);
  expect(order.map((task) => task.id)).toEqual(["ready-a", "ready-b"]);
});

it("orders an empty queue as an empty list", () => {
  expect(displayOrder([])).toEqual([]);
});

describe("move targets", () => {
  const tasks = [
    queued("ready-a", "pending", "ready"),
    queued("held-a", "pending", "waiting"),
    queued("ready-b", "pending", "ready"),
    queued("held-b", "pending", "waiting"),
    queued("done", "completed", "finished"),
  ];
  const ordered = displayOrder(tasks);
  const byId = (id: string) =>
    tasks.find((task) => task.id === id) as PublicTask;

  it("points at the on-screen neighbour inside the same gate group", () => {
    expect(moveTarget(ordered, byId("ready-b"), -1)?.id).toBe("ready-a");
    expect(moveTarget(ordered, byId("ready-a"), 1)?.id).toBe("ready-b");
    expect(moveTarget(ordered, byId("held-b"), -1)?.id).toBe("held-a");
  });

  it("has no target at the top or bottom of a group", () => {
    expect(moveTarget(ordered, byId("ready-a"), -1)).toBeUndefined();
    expect(moveTarget(ordered, byId("ready-b"), 1)).toBeUndefined();
    expect(moveTarget(ordered, byId("held-a"), -1)).toBeUndefined();
    expect(moveTarget(ordered, byId("held-b"), 1)).toBeUndefined();
    expect(moveTarget(ordered, byId("done"), -1)).toBeUndefined();
  });

  it("has no target between waiting tasks that become eligible at different times", () => {
    const staggered = displayOrder([
      queued("tonight", "pending", "waiting", "2026-09-08T03:00:00.000Z"),
      queued("later", "pending", "waiting", "2026-09-09T03:00:00.000Z"),
    ]);
    expect(moveTarget(staggered, staggered[0], 1)).toBeUndefined();
    expect(moveTarget(staggered, staggered[1], -1)).toBeUndefined();
  });

  it("points at a waiting neighbour that becomes eligible in the same minute", () => {
    const together = displayOrder([
      queued("first", "pending", "waiting", "2026-09-08T03:00:00.000Z"),
      queued("second", "pending", "waiting", "2026-09-08T03:00:20.000Z"),
    ]);
    expect(moveTarget(together, together[0], 1)?.id).toBe("second");
    expect(moveTarget(together, together[1], -1)?.id).toBe("first");
  });

  it("moves a task past its neighbour without disturbing tasks from other groups", () => {
    const ids = ["ready-a", "held-a", "ready-b", "held-b"];
    expect(movedPast(ids, "ready-b", "ready-a", -1)).toEqual([
      "ready-b",
      "ready-a",
      "held-a",
      "held-b",
    ]);
    expect(movedPast(ids, "held-a", "held-b", 1)).toEqual([
      "ready-a",
      "ready-b",
      "held-b",
      "held-a",
    ]);
  });
});

describe("source rows", () => {
  const sources = (unknownResponses: number): SourceActivity[] => [
    { source: "local", activeMinutes: 120, responses: 340, tokens: 9100 },
    {
      source: "dispatched",
      activeMinutes: 45,
      responses: 88,
      tokens: 4200,
    },
    {
      source: "unknown",
      activeMinutes: unknownResponses ? 12 : 0,
      responses: unknownResponses,
      tokens: unknownResponses ? 700 : 0,
    },
  ];

  it("hides the unattributed row when it has no responses", () => {
    expect(sourceRows(sources(0)).map((row) => row.label)).toEqual([
      "Local Claude Code",
      "Dispatched tasks",
      "Other",
    ]);
  });

  it("shows the unattributed row with its counts when it has responses", () => {
    const rows = sourceRows(sources(17));
    expect(rows[2]).toEqual({
      label: "Unattributed",
      responses: 17,
      activeMinutes: 12,
      tokens: 700,
      measured: true,
    });
  });

  it("ends with an unmeasured Other row carrying no counts", () => {
    for (const rows of [sourceRows(sources(0)), sourceRows(sources(17))]) {
      expect(rows.at(-1)).toEqual({
        label: "Other",
        responses: 0,
        activeMinutes: 0,
        tokens: 0,
        measured: false,
      });
      expect(rows.slice(0, -1).every((row) => row.measured)).toBe(true);
    }
  });
});

describe("plan score series", () => {
  const coverageDay = (
    date: string,
    coverage: number | null,
    sources: Partial<Record<ActivitySource, number>> = {},
    models: Record<string, number> = {},
  ): CoverageDay => ({
    date,
    coverage,
    sources: { local: 0, dispatched: 0, unknown: 0, ...sources },
    models,
  });
  const plan: PlanScoreData = {
    score: 71,
    sessionCoverage: 62,
    weeklyScore: 80,
    days: [
      coverageDay(
        "2026-08-30",
        40.5,
        { local: 30, dispatched: 10 },
        { "claude-opus-4-6": 30, "claude-fable-5-1": 10 },
      ),
      coverageDay("2026-08-31", null),
      coverageDay(
        "2026-09-02",
        88,
        { local: 60, dispatched: 20, unknown: 20 },
        {
          "claude-opus-4-6": 60,
          "claude-fable-5-1": 20,
          "claude-haiku-4-5": 20,
        },
      ),
      coverageDay("2026-09-06", 12.5),
    ],
    weeks: [
      {
        start: "2026-08-24T07:53:00.000Z",
        end: "2026-08-31T07:53:00.000Z",
        percent: 64,
        score: 64,
        complete: true,
      },
      {
        start: "2026-08-31T07:53:00.000Z",
        end: "2026-09-07T07:53:00.000Z",
        percent: 45,
        score: 80,
        complete: false,
      },
    ],
    generatedAt: "2026-09-06T14:00:00.000Z",
  };

  const rowFor = (breakdown: Breakdown, date: string) =>
    scoreSeries(plan, breakdown).rows.find((row) => row.date === date);

  it("gives each day its coverage and the score of the week containing it", () => {
    expect(rowFor("source", "2026-08-30")).toMatchObject({
      coverage: 40.5,
      weekly: 64,
    });
    expect(rowFor("source", "2026-09-02")).toMatchObject({
      coverage: 88,
      weekly: 80,
    });
  });

  it("scores a date after the last week as null weekly", () => {
    const { rows } = scoreSeries(
      { ...plan, days: [coverageDay("2026-09-09", 30, { local: 5 })] },
      "source",
    );
    expect(rows).toEqual([
      {
        date: "2026-09-09",
        coverage: 30,
        weekly: null,
        local: 30,
        dispatched: 0,
        unknown: 0,
      },
    ]);
  });

  it("splits coverage across sources in proportion to minutes and sums back to coverage", () => {
    const row = rowFor("source", "2026-09-02");
    expect(row).toMatchObject({ local: 52, dispatched: 18, unknown: 18 });
    expect(
      [...ACTIVITY_SOURCES].reduce(
        (sum, source) => sum + Number(row?.[source]),
        0,
      ),
    ).toBeCloseTo(88);
  });

  it("splits coverage across models and folds the unnamed ones", () => {
    const { keys } = scoreSeries(plan, "model");
    expect(keys).toEqual([
      "claude-opus-4-6",
      "claude-fable-5-1",
      "claude-haiku-4-5",
      "Other",
    ]);
    expect(rowFor("model", "2026-09-02")).toMatchObject({
      "claude-opus-4-6": 52,
      "claude-fable-5-1": 18,
      "claude-haiku-4-5": 18,
      Other: 0,
    });
  });

  it("puts coverage with no local minutes on Unattributed", () => {
    expect(rowFor("source", "2026-09-06")).toMatchObject({
      coverage: 12.5,
      local: 0,
      dispatched: 0,
      unknown: 12.5,
    });
    expect(rowFor("model", "2026-09-06")).toMatchObject({
      "claude-opus-4-6": 0,
      Other: 12.5,
    });
  });

  it("leaves null-coverage days without series fields", () => {
    expect(rowFor("source", "2026-08-31")).toEqual({
      date: "2026-08-31",
      coverage: null,
      weekly: 80,
    });
  });
});

describe("activity series", () => {
  const day = (
    date: string,
    models: Record<string, number>,
  ): DailyActivity => ({
    date,
    activeMinutes: Object.values(models).reduce((sum, n) => sum + n, 0),
    responses: 0,
    sources: { local: 0, dispatched: 0, unknown: 0 },
    models,
  });

  it("folds models beyond the top four into Other and zero-fills missing keys", () => {
    const { keys, rows } = activitySeries(
      [
        day("2026-09-01", {
          "claude-fable-5-1": 30,
          "claude-opus-4-6": 20,
          "claude-sonnet-4-5": 10,
        }),
        day("2026-09-02", {
          "claude-fable-5-1": 5,
          "claude-haiku-4-5": 9,
          "claude-legacy-3": 4,
          "claude-legacy-2": 3,
        }),
      ],
      "model",
    );
    expect(keys).toEqual([
      "claude-fable-5-1",
      "claude-opus-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "Other",
    ]);
    expect(rows[0]).toEqual({
      date: "2026-09-01",
      responses: 0,
      activeMinutes: 60,
      "claude-fable-5-1": 30,
      "claude-opus-4-6": 20,
      "claude-sonnet-4-5": 10,
      "claude-haiku-4-5": 0,
      Other: 0,
    });
    expect(rows[1]).toMatchObject({
      "claude-fable-5-1": 5,
      "claude-opus-4-6": 0,
      Other: 7,
    });
  });

  it("by source keeps ACTIVITY_SOURCES order", () => {
    const { keys, rows } = activitySeries(
      [
        {
          date: "2026-09-01",
          activeMinutes: 7,
          responses: 12,
          sources: { dispatched: 3, unknown: 1, local: 3 },
          models: { "claude-opus-4-6": 7 },
        },
      ],
      "source",
    );
    expect(keys).toEqual([...ACTIVITY_SOURCES]);
    expect(rows).toEqual([
      {
        date: "2026-09-01",
        responses: 12,
        activeMinutes: 7,
        local: 3,
        dispatched: 3,
        unknown: 1,
      },
    ]);
  });
});

const finishedRun = (
  changes: Run["changes"],
  reviewedAt: string | null = null,
): Run => ({
  id: "a".repeat(24),
  taskId: "b".repeat(24),
  title: "Fix a test",
  prompt: "Rename the parser.",
  estimatedTokens: 120_000,
  model: "opus",
  status: "completed",
  startedAt: "2026-09-06T12:00:00.000Z",
  endedAt: "2026-09-06T12:20:00.000Z",
  durationMs: 1_200_000,
  exitCode: 0,
  error: null,
  tokens: { fable: 0, opus: 87_000, sonnet: 0, haiku: 0 },
  sessionCostPercent: 12,
  summary: "Renamed the parser.",
  changes,
  deploy: null,
  reviewedAt,
  preview: [],
});
const changed: ChangedFile[] = [
  { path: "server/parser.ts", added: 4, removed: 2 },
];

it("needs review for uncommitted changes and for commits on a feature branch, not after review or for commits on main", () => {
  expect(
    needsReview(finishedRun({ branch: "main", commits: 0, files: changed })),
  ).toBe(true);
  expect(
    needsReview(finishedRun({ branch: "rename", commits: 2, files: changed })),
  ).toBe(true);
  expect(
    needsReview(finishedRun({ branch: "main", commits: 2, files: changed })),
  ).toBe(false);
  expect(
    needsReview(finishedRun({ branch: "master", commits: 1, files: changed })),
  ).toBe(false);
  expect(
    needsReview(finishedRun({ branch: "main", commits: 0, files: [] })),
  ).toBe(false);
  expect(
    needsReview(
      finishedRun(
        { branch: "main", commits: 0, files: changed },
        "2026-09-06T13:00:00.000Z",
      ),
    ),
  ).toBe(false);
  expect(needsReview(finishedRun(null))).toBe(false);
});

describe("formatTokens", () => {
  it("shows thousands below a million and tenths of a million above", () => {
    expect(formatTokens(50_000)).toBe("50k");
    expect(formatTokens(4_999)).toBe("5k");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_450_000)).toBe("2.5M");
  });
});

describe("heatmapTotals", () => {
  const cell = (
    day: number,
    hour: number,
    activeMinutes: number,
  ): HeatCell => ({
    day,
    hour,
    activeMinutes,
    responses: activeMinutes * 2,
    averageActiveMinutes: activeMinutes,
    sources: { local: activeMinutes, dispatched: 0, unknown: 0 },
    models: [],
    projects: [],
    tokens: 0,
  });

  it("sums active minutes per weekday, per hour and overall", () => {
    const totals = heatmapTotals([
      cell(1, 2, 5),
      cell(1, 3, 7),
      cell(4, 2, 1),
      cell(6, 23, 0),
    ]);
    expect(totals.days).toEqual([0, 12, 0, 0, 1, 0, 0]);
    expect(totals.hours).toEqual([
      0, 0, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(totals.total).toBe(13);
  });

  it("reports zero rows and columns for an empty heatmap", () => {
    const totals = heatmapTotals([]);
    expect(totals.days).toHaveLength(7);
    expect(totals.hours).toHaveLength(24);
    expect(totals.total).toBe(0);
  });
});

describe("easternCell", () => {
  it("maps an instant to its Eastern weekday and hour across DST", () => {
    expect(easternCell("2026-09-06T12:00:00Z")).toEqual({ day: 0, hour: 8 });
    expect(easternCell("2026-01-15T03:30:00Z")).toEqual({ day: 3, hour: 22 });
  });
});

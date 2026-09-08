import { expect, it } from "vitest";
import { activityBlocks, aggregate } from "../server/analytics.js";
import type { ActivityEvent, HistoryData } from "../shared/types.js";

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
const history = (events: ActivityEvent[]): HistoryData => ({
  events,
  health: { files: 1, lines: events.length, warnings: 0, historyEntries: 0 },
});
it("aggregates selected Eastern calendar days with distinct real minutes through the fall DST fold", () => {
  const result = aggregate(
    history([
      event("2026-11-01T05:30:00Z"),
      event("2026-11-01T05:30:30Z"),
      event("2026-11-01T06:30:00Z"),
      event("2026-10-31T03:59:00Z"),
      event("2026-11-01T18:00:00Z"),
    ]),
    7,
    new Date("2026-11-01T17:00:00Z"),
  );
  expect(result.days).toBe(7);
  expect(result.daily).toHaveLength(7);
  expect(result.daily.at(-1)).toMatchObject({
    date: "2026-11-01",
    activeMinutes: 2,
    responses: 3,
  });
  expect(result.heatmap).toHaveLength(168);
  expect(
    result.heatmap.find((cell) => cell.day === 0 && cell.hour === 1),
  ).toMatchObject({ activeMinutes: 2, responses: 3 });
  expect(result.totals).toMatchObject({
    responses: 4,
    activeMinutes: 3,
    inputTokens: 8,
    outputTokens: 12,
    cacheReadTokens: 20,
    cacheCreationTokens: 4,
  });
  expect(result.models).toEqual([{ name: "claude-opus-4-6", responses: 4 }]);
  expect(result.projects).toEqual([{ name: "demo", responses: 4 }]);
  expect(result.health.warnings).toBe(0);
});
it("ranks all 24 five-hour opportunities over 30 complete local dates, including midnight and spring DST", () => {
  const now = new Date("2026-03-10T16:00:00Z");
  const result = aggregate(
    history([
      event("2026-03-08T06:30:00Z"), // 01:30 EST
      event("2026-03-08T07:30:00Z"), // 03:30 EDT
      event("2026-03-08T09:59:00Z"), // inside 00:00 + five elapsed hours
      event("2026-03-08T10:00:00Z"), // exclusive end
      event("2026-03-09T03:30:00Z"), // 23:30 EDT
      event("2026-03-09T05:30:00Z"), // 01:30 EDT
    ]),
    7,
    now,
  );
  expect(result.opportunities).toHaveLength(24);
  expect(result.opportunities.find((w) => w.startHour === 0)).toMatchObject({
    averageActiveMinutes: 4 / 30,
    averageResponses: 4 / 30,
    samples: 30,
    estimated: true,
  });
  expect(
    result.opportunities.find((w) => w.startHour === 23)?.averageResponses,
  ).toBe(4 / 30);
  expect(result.opportunities[0].averageActiveMinutes).toBe(0);
  expect(result.opportunities).toEqual(
    aggregate(
      history([
        event("2026-03-08T06:30:00Z"),
        event("2026-03-08T07:30:00Z"),
        event("2026-03-08T09:59:00Z"),
        event("2026-03-08T10:00:00Z"),
        event("2026-03-09T03:30:00Z"),
        event("2026-03-09T05:30:00Z"),
      ]),
      90,
      now,
    ).opportunities,
  );
});
it("infers a five elapsed-hour block anchored to activity, expires it, and labels utilization as an estimate", () => {
  const data = history([
    event("2026-11-01T04:30:00Z"),
    event("2026-11-01T05:30:00Z"),
    event("2026-11-01T06:30:00Z"),
    event("2026-11-01T06:30:45Z"),
  ]);
  const current = aggregate(
    data,
    7,
    new Date("2026-11-01T07:30:00Z"),
  ).currentBlock;
  expect(current).toMatchObject({
    start: "2026-11-01T04:30:00.000Z",
    end: "2026-11-01T09:30:00.000Z",
    elapsedMinutes: 180,
    activeMinutes: 3,
    responses: 4,
    utilization: 0.01,
    remainingMinutes: 297,
    estimated: true,
  });
  expect(
    aggregate(data, 7, new Date("2026-11-01T09:30:00Z")).currentBlock,
  ).toBeNull();
  data.events.push(event("2026-11-01T09:30:00Z"));
  expect(
    aggregate(data, 7, new Date("2026-11-01T09:31:00Z")).currentBlock
      ?.activeMinutes,
  ).toBe(1);
  expect(aggregate(history([]), 7).currentBlock).toBeNull();
});
it("includes today's already-completed five-hour window in the latest 30 planner samples", () => {
  const result = aggregate(
    history([event("2026-09-06T05:00:00Z")]),
    30,
    new Date("2026-09-06T16:00:00Z"),
  );
  expect(
    result.opportunities.find((window) => window.startHour === 0),
  ).toMatchObject({
    averageActiveMinutes: 1 / 30,
    averageResponses: 1 / 30,
    samples: 30,
  });
});
it("excludes incomplete overnight opportunities so their partial activity cannot look artificially quiet", () => {
  const data = history([event("2026-09-06T03:30:00Z")]);
  const result = aggregate(data, 7, new Date("2026-09-06T05:30:00Z"));
  expect(result.opportunities.find((w) => w.startHour === 23)).toMatchObject({
    samples: 30,
    averageResponses: 0,
  });
});
it("estimates Claude session, weekly and Fable windows from official reset times, else inferred or rolling windows", () => {
  const now = new Date("2026-09-06T22:00:00Z");
  const data = history([
    event("2026-09-06T07:00:00Z"),
    event("2026-09-06T10:00:00Z", { model: "claude-fable-5-1" }),
    event("2026-09-06T21:30:00Z"),
    event("2026-09-06T21:30:30Z"),
    event("2026-09-06T21:45:00Z", { model: "claude-fable-5-1" }),
    event("2026-09-06T22:30:00Z"),
  ]);
  const official = {
    fetchedAt: "2026-09-06T21:53:00.000Z",
    plan: "max",
    session: { percent: 16, resetsAt: "2026-09-07T02:09:00.000Z" },
    weekly: { percent: 2, resetsAt: "2026-09-13T07:53:00.000Z" },
    fable: { percent: 0, resetsAt: null },
  };
  const withOfficial = aggregate(data, 7, now, official);
  expect(withOfficial.claudeBudgets).toEqual({
    session: {
      windowStart: "2026-09-06T21:09:00.000Z",
      windowEnd: "2026-09-07T02:09:00.000Z",
      basis: "official-reset",
      activeMinutes: 2,
      responses: 3,
      utilization: 2 / 300,
    },
    weekly: {
      windowStart: "2026-09-06T07:53:00.000Z",
      windowEnd: "2026-09-13T07:53:00.000Z",
      basis: "official-reset",
      activeMinutes: 3,
      responses: 4,
    },
    fable: {
      windowStart: "2026-09-06T07:53:00.000Z",
      windowEnd: "2026-09-13T07:53:00.000Z",
      basis: "official-reset",
      activeMinutes: 2,
      responses: 2,
    },
  });
  const fallback = aggregate(data, 7, now).claudeBudgets;
  expect(fallback.session).toEqual({
    windowStart: "2026-09-06T21:30:00.000Z",
    windowEnd: "2026-09-07T02:30:00.000Z",
    basis: "inferred",
    activeMinutes: 2,
    responses: 3,
    utilization: 2 / 300,
  });
  expect(fallback.weekly).toEqual({
    windowStart: "2026-08-30T22:00:00.000Z",
    windowEnd: "2026-09-06T22:00:00.000Z",
    basis: "rolling",
    activeMinutes: 4,
    responses: 5,
  });
  expect(fallback.fable).toMatchObject({
    basis: "rolling",
    activeMinutes: 2,
    responses: 2,
  });
  const expired = aggregate(data, 7, now, {
    ...official,
    session: { percent: 16, resetsAt: "2026-09-06T21:00:00.000Z" },
    weekly: { percent: 2, resetsAt: "2026-09-06T21:59:59.000Z" },
  }).claudeBudgets;
  expect(expired.session.basis).toBe("inferred");
  expect(expired.weekly.basis).toBe("rolling");
  expect(expired.fable.basis).toBe("rolling");
  expect(aggregate(history([]), 7, now).claudeBudgets.session).toEqual({
    windowStart: null,
    windowEnd: null,
    basis: "none",
    activeMinutes: 0,
    responses: 0,
    utilization: 0,
  });
});

it("opens a new activity block for an event exactly five hours after the block start", () => {
  const blocks = activityBlocks(
    [event("2026-09-06T00:00:30Z"), event("2026-09-06T05:00:00Z")],
    new Date("2026-09-06T12:00:00Z"),
  );
  expect(blocks.map((block) => new Date(block.start).toISOString())).toEqual([
    "2026-09-06T00:00:00.000Z",
    "2026-09-06T05:00:00.000Z",
  ]);
});

it("keeps an event one minute before the block end inside the same block", () => {
  const blocks = activityBlocks(
    [event("2026-09-06T00:00:30Z"), event("2026-09-06T04:59:00Z")],
    new Date("2026-09-06T12:00:00Z"),
  );
  expect(blocks).toHaveLength(1);
  expect(blocks[0].events).toHaveLength(2);
  expect(new Date(blocks[0].end).toISOString()).toBe(
    "2026-09-06T05:00:00.000Z",
  );
});

it("sums each activity source over the selected range and always reports every source", () => {
  const result = aggregate(
    history([
      event("2026-09-06T10:00:00Z", { source: "dispatched", outputTokens: 3 }),
      event("2026-09-06T10:00:30Z", { source: "dispatched", outputTokens: 5 }),
      event("2026-09-06T11:00:00Z", { source: "local", outputTokens: 7 }),
      event("2026-07-01T10:00:00Z", {
        source: "dispatched",
        outputTokens: 100,
      }),
      event("2026-09-06T13:00:00Z", { source: "local", outputTokens: 50 }),
    ]),
    7,
    new Date("2026-09-06T12:00:00Z"),
  );
  expect(result.sources).toEqual([
    { source: "local", activeMinutes: 1, responses: 1, outputTokens: 7 },
    { source: "dispatched", activeMinutes: 1, responses: 2, outputTokens: 8 },
    { source: "unknown", activeMinutes: 0, responses: 0, outputTokens: 0 },
  ]);
});

it("ranks quiet hours from interactive activity only, so dispatched and unattributed runs cannot make a window look busy", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const busy = [
    event("2026-09-05T05:00:00Z", { source: "dispatched" }),
    event("2026-09-05T05:01:00Z", { source: "dispatched" }),
    event("2026-09-05T05:02:00Z", { source: "unknown" }),
  ];
  const withoutInteractive = aggregate(history(busy), 30, now);
  expect(
    withoutInteractive.opportunities.every((w) => w.averageActiveMinutes === 0),
  ).toBe(true);
  const withInteractive = aggregate(
    history([...busy, event("2026-09-05T05:03:00Z", { source: "local" })]),
    30,
    now,
  );
  const covering = withInteractive.opportunities.filter(
    (w) => w.averageActiveMinutes > 0,
  );
  expect(covering.length).toBeGreaterThan(0);
  expect(covering.every((w) => w.averageActiveMinutes === 1 / 30)).toBe(true);
});

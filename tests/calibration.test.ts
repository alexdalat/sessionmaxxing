import { expect, it } from "vitest";
import {
  fitSessionRates,
  sessionPercent,
  type WindowTokens,
  windowTokens,
} from "../server/calibration.js";
import type { ActivityEvent, SessionWindow } from "../shared/types.js";
import windows from "./fixtures/session-windows.json" with { type: "json" };

const measured = windows as WindowTokens[];
const tokens = (patch: Partial<WindowTokens["outputTokens"]>) => ({
  fable: 0,
  opus: 0,
  sonnet: 0,
  haiku: 0,
  ...patch,
});
/** Runs whose five-hour window held nothing else, so the meter reading is the run's own cost. */
const soloRuns = [
  { tokens: tokens({ opus: 112_000 }), meter: 14 },
  { tokens: tokens({ opus: 61_000 }), meter: 8 },
  { tokens: tokens({ opus: 70_000 }), meter: 9 },
  { tokens: tokens({ opus: 55_000, sonnet: 17_000 }), meter: 12 },
  { tokens: tokens({ opus: 5_000, haiku: 15_000 }), meter: 4 },
];
const TOLERANCE = 4;
const round = (value: number) => Math.round(value * 10) / 10;

it("prices the runs whose meter reading was not shared with other work", () => {
  const rates = fitSessionRates(measured);
  if (rates === null) throw new Error("the fixture should fit");
  for (const run of soloRuns)
    expect(
      Math.abs(sessionPercent(run.tokens, rates) - run.meter),
    ).toBeLessThanOrEqual(TOLERANCE);
});

it("charges Fable more than Opus per output token", () => {
  const rates = fitSessionRates(measured);
  if (rates === null) throw new Error("the fixture should fit");
  expect(rates.fable).toBeGreaterThan(rates.opus * 2);
});

it("ignores a window the meter censored at 100%", () => {
  const rates = fitSessionRates(measured);
  const censored = fitSessionRates([
    ...measured,
    { peakPercent: 100, outputTokens: tokens({ fable: 900_000 }) },
  ]);
  expect(censored).toEqual(rates);
});

it("ignores a window too small for the meter's rounding", () => {
  const rates = fitSessionRates(measured);
  const tiny = fitSessionRates([
    ...measured,
    { peakPercent: 7, outputTokens: tokens({ opus: 400_000 }) },
  ]);
  expect(tiny).toEqual(rates);
});

it("prices a family with no measured usage off the fitted one at their list-price ratio", () => {
  const rates = fitSessionRates([
    { peakPercent: 40, outputTokens: tokens({ opus: 200_000 }) },
    { peakPercent: 60, outputTokens: tokens({ opus: 300_000 }) },
  ]);
  expect(rates).toEqual({ fable: 400, opus: 200, sonnet: 80, haiku: 40 });
});

it("prices a family off the fitted one rather than trust a fit from a sliver of usage", () => {
  const rates = fitSessionRates([
    {
      peakPercent: 40,
      outputTokens: tokens({ opus: 200_000, sonnet: 20_000 }),
    },
    {
      peakPercent: 60,
      outputTokens: tokens({ opus: 300_000, sonnet: 10_000 }),
    },
  ]);
  if (rates === null) throw new Error("opus should fit");
  expect(rates.sonnet).toBe(round(rates.opus * 0.4));
});

/** Windows whose halves all stay inside the fitted range, so only the plan changes. */
const scalable: WindowTokens[] = [
  { peakPercent: 80, outputTokens: tokens({ fable: 200_000, opus: 60_000 }) },
  { peakPercent: 44, outputTokens: tokens({ opus: 300_000 }) },
  { peakPercent: 62, outputTokens: tokens({ haiku: 150_000, opus: 90_000 }) },
  { peakPercent: 36, outputTokens: tokens({ sonnet: 120_000, fable: 50_000 }) },
];

it("halves every rate when the same tokens reach half the meter on a bigger plan", () => {
  const rates = fitSessionRates(scalable);
  const bigger = fitSessionRates(
    scalable.map((window) => ({
      ...window,
      peakPercent: window.peakPercent / 2,
    })),
  );
  if (rates === null || bigger === null)
    throw new Error("both fits should succeed");
  for (const family of ["fable", "opus", "sonnet", "haiku"] as const)
    expect(Math.abs(bigger[family] - rates[family] / 2)).toBeLessThan(0.1);
});

it("has no rates to report without a usable window", () => {
  expect(fitSessionRates([])).toBeNull();
  expect(
    fitSessionRates([
      { peakPercent: 100, outputTokens: tokens({ opus: 500_000 }) },
      { peakPercent: 3, outputTokens: tokens({ opus: 20_000 }) },
    ]),
  ).toBeNull();
  expect(
    fitSessionRates([{ peakPercent: 40, outputTokens: tokens({}) }]),
  ).toBeNull();
});

const event = (
  timestamp: string,
  model: string,
  outputTokens: number,
): ActivityEvent => ({
  timestamp,
  project: "demo",
  model,
  source: "local",
  inputTokens: 0,
  outputTokens,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});
const window = (start: string, end: string, peak: number): SessionWindow => ({
  start,
  end,
  peakPercent: peak,
  activeMinutes: 0,
  samples: 1,
});

it("sums the output tokens each window holds, by family", () => {
  const measuredWindows = windowTokens(
    [
      window("2026-09-06T00:00:00Z", "2026-09-06T05:00:00Z", 30),
      window("2026-09-06T05:00:00Z", "2026-09-06T10:00:00Z", 50),
      { ...window("2026-09-06T10:00:00Z", "2026-09-06T15:00:00Z", 0) },
    ],
    [
      event("2026-09-05T23:59:00Z", "claude-opus-5", 500),
      event("2026-09-06T00:00:00Z", "claude-opus-5", 1_000),
      event("2026-09-06T04:59:00Z", "claude-fable-5-1", 2_000),
      event("2026-09-06T05:00:00Z", "claude-opus-5", 4_000),
      event("2026-09-06T06:00:00Z", "Unknown model", 8_000),
      event("2026-09-06T09:00:00Z", "claude-haiku-4-5-20251001", 300),
    ],
  );
  expect(measuredWindows).toEqual([
    { peakPercent: 30, outputTokens: tokens({ opus: 1_000, fable: 2_000 }) },
    { peakPercent: 50, outputTokens: tokens({ opus: 4_000, haiku: 300 }) },
    { peakPercent: 0, outputTokens: tokens({}) },
  ]);
});

it("leaves out a window no official sample covered", () => {
  expect(
    windowTokens(
      [
        {
          ...window("2026-09-06T00:00:00Z", "2026-09-06T05:00:00Z", 0),
          peakPercent: null,
        },
      ],
      [event("2026-09-06T01:00:00Z", "claude-opus-5", 1_000)],
    ),
  ).toEqual([]);
});

import { expect, it } from "vitest";
import {
  fitSessionRates,
  sessionPercent,
  type WindowTokens,
  windowTokens,
} from "../server/calibration.js";
import type {
  ActivityEvent,
  SessionWindow,
  TokenUsage,
} from "../shared/types.js";
import windows from "./fixtures/session-windows.json" with { type: "json" };

const measured = windows as WindowTokens[];
const tokens = (patch: Partial<WindowTokens["tokens"]>) => ({
  fable: 0,
  opus: 0,
  sonnet: 0,
  haiku: 0,
  ...patch,
});
/** Meter points the fit may miss by on average; the meter itself only reports whole percents. */
const MEAN_TOLERANCE = 10;
const round = (value: number) => Math.round(value * 10) / 10;

it("prices the fitted windows close to what the meter read", () => {
  const rates = fitSessionRates(measured);
  if (rates === null) throw new Error("the fixture should fit");
  const fitted = measured.filter(
    (window) => window.peakPercent >= 8 && window.peakPercent < 100,
  );
  const meanError =
    fitted.reduce(
      (sum, window) =>
        sum +
        Math.abs(sessionPercent(window.tokens, rates) - window.peakPercent),
      0,
    ) / fitted.length;
  expect(meanError).toBeLessThanOrEqual(MEAN_TOLERANCE);
});

it("charges Fable more than Opus per weighted token", () => {
  const rates = fitSessionRates(measured);
  if (rates === null) throw new Error("the fixture should fit");
  expect(rates.fable).toBeGreaterThan(rates.opus * 2);
});

it("ignores a window the meter censored at 100%", () => {
  const rates = fitSessionRates(measured);
  const censored = fitSessionRates([
    ...measured,
    { peakPercent: 100, tokens: tokens({ fable: 900_000 }) },
  ]);
  expect(censored).toEqual(rates);
});

it("ignores a window too small for the meter's rounding", () => {
  const rates = fitSessionRates(measured);
  const tiny = fitSessionRates([
    ...measured,
    { peakPercent: 7, tokens: tokens({ opus: 400_000 }) },
  ]);
  expect(tiny).toEqual(rates);
});

it("prices a family with no measured usage off the fitted one at their list-price ratio", () => {
  const rates = fitSessionRates([
    { peakPercent: 40, tokens: tokens({ opus: 1_000_000 }) },
    { peakPercent: 60, tokens: tokens({ opus: 1_500_000 }) },
  ]);
  expect(rates).toEqual({ fable: 80, opus: 40, sonnet: 16, haiku: 8 });
});

it("prices a family off the fitted one rather than trust a fit from a sliver of usage", () => {
  const rates = fitSessionRates([
    {
      peakPercent: 40,
      tokens: tokens({ opus: 1_000_000, sonnet: 100_000 }),
    },
    {
      peakPercent: 60,
      tokens: tokens({ opus: 1_500_000, sonnet: 50_000 }),
    },
  ]);
  if (rates === null) throw new Error("opus should fit");
  expect(rates.sonnet).toBe(round(rates.opus * 0.4));
});

it("fits a plan whose windows hold far fewer than a million weighted tokens", () => {
  const rates = fitSessionRates([
    { peakPercent: 40, tokens: tokens({ opus: 20_000 }) },
    { peakPercent: 60, tokens: tokens({ opus: 30_000 }) },
  ]);
  expect(rates).toEqual({ fable: 4000, opus: 2000, sonnet: 800, haiku: 400 });
});

it("caps a cheaper family's fitted rate at its list-price ratio to the anchor", () => {
  const rates = fitSessionRates([
    { peakPercent: 40, tokens: tokens({ opus: 10_000_000 }) },
    { peakPercent: 30, tokens: tokens({ haiku: 3_000_000 }) },
    { peakPercent: 60, tokens: tokens({ opus: 15_000_000 }) },
  ]);
  if (rates === null) throw new Error("opus should fit");
  expect(rates.haiku).toBe(round(rates.opus * 0.2));
});

/** Windows whose halves all stay inside the fitted range, so only the plan changes. */
const scalable: WindowTokens[] = [
  { peakPercent: 80, tokens: tokens({ fable: 1_000_000, opus: 300_000 }) },
  { peakPercent: 44, tokens: tokens({ opus: 1_500_000 }) },
  { peakPercent: 62, tokens: tokens({ haiku: 750_000, opus: 450_000 }) },
  { peakPercent: 36, tokens: tokens({ sonnet: 600_000, fable: 250_000 }) },
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
      { peakPercent: 100, tokens: tokens({ opus: 2_500_000 }) },
      { peakPercent: 3, tokens: tokens({ opus: 100_000 }) },
    ]),
  ).toBeNull();
  expect(fitSessionRates([{ peakPercent: 40, tokens: tokens({}) }])).toBeNull();
});

const event = (
  timestamp: string,
  model: string,
  outputTokens: number,
  input: Partial<TokenUsage> = {},
): ActivityEvent => ({
  timestamp,
  project: "demo",
  model,
  source: "local",
  inputTokens: 0,
  outputTokens,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  ...input,
});
const window = (start: string, end: string, peak: number): SessionWindow => ({
  start,
  end,
  peakPercent: peak,
  activeMinutes: 0,
  samples: 1,
});

it("sums the weighted tokens each window holds, by family", () => {
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
    { peakPercent: 30, tokens: tokens({ opus: 1_000, fable: 2_000 }) },
    { peakPercent: 50, tokens: tokens({ opus: 4_000, haiku: 300 }) },
    { peakPercent: 0, tokens: tokens({}) },
  ]);
});

it("weights input, cache writes and cache reads at their list price relative to output", () => {
  const usage = {
    inputTokens: 1_000,
    cacheCreationTokens: 1_000,
    cacheReadTokens: 1_000,
  };
  expect(
    windowTokens(
      [window("2026-09-06T00:00:00Z", "2026-09-06T05:00:00Z", 30)],
      [
        event("2026-09-06T01:00:00Z", "claude-opus-5", 0, usage),
        event("2026-09-06T02:00:00Z", "claude-fable-5-1", 100, usage),
      ],
    ),
  ).toEqual([{ peakPercent: 30, tokens: tokens({ opus: 470, fable: 555 }) }]);
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

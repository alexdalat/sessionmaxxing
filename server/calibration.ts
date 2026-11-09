import {
  type ActivityEvent,
  emptyWeightedTokens,
  FAMILY_PRICING,
  MODEL_FAMILIES,
  type ModelFamily,
  modelFamily,
  type SessionRates,
  type SessionWindow,
  type WeightedTokens,
  weightedTokens,
} from "../shared/types.js";

/** Days of official samples the fit uses, short enough that a plan change re-calibrates within two weeks. */
export const CALIBRATION_DAYS = 14;
export const SESSION_RATES_TTL_MS = 10 * 60_000;
const MILLION = 1_000_000;
const FULL_PERCENT = 100;
/** Below this peak the meter's own rounding is a large share of the reading. */
const MIN_PEAK_PERCENT = 8;
/**
 * Share of the sample's weighted tokens a family needs before its own fitted rate is
 * trusted; a share, so a smaller plan with fewer tokens per window still calibrates.
 */
const MIN_FAMILY_SHARE = 0.1;
/** The ratio a family with too little usage is priced at. */
const familyPrice = (family: ModelFamily) =>
  FAMILY_PRICING[family].outputTokens;
const MAX_PASSES = 500;
const CONVERGED = 1e-6;

/** One five-hour window: the peak the meter reported and the weighted tokens consumed inside it. */
export interface WindowTokens {
  peakPercent: number;
  tokens: WeightedTokens;
}
export interface SessionCalibration {
  rates: SessionRates | null;
  error: string | null;
}

const round = (value: number) => Math.round(value * 10) / 10;

export function windowTokens(
  windows: SessionWindow[],
  events: ActivityEvent[],
): WindowTokens[] {
  const spans = windows.flatMap((window) =>
    window.peakPercent === null
      ? []
      : [
          {
            peakPercent: window.peakPercent,
            start: Date.parse(window.start),
            end: Date.parse(window.end),
            tokens: emptyWeightedTokens(),
          },
        ],
  );
  for (const event of events) {
    const family = modelFamily(event.model);
    if (family === null) continue;
    const at = Date.parse(event.timestamp);
    for (const span of spans)
      if (at >= span.start && at < span.end)
        span.tokens[family] += weightedTokens(event, family);
  }
  return spans.map(({ peakPercent, tokens }) => ({ peakPercent, tokens }));
}

/**
 * Non-negative least squares by coordinate descent: peak percent ≈ Σ tokens × rate.
 * Windows the meter censored at 100% would drag every rate down, and tiny windows
 * are mostly rounding, so both stay out of the fit.
 */
export function fitSessionRates(windows: WindowTokens[]): SessionRates | null {
  const usable = windows.filter(
    (window) =>
      window.peakPercent >= MIN_PEAK_PERCENT &&
      window.peakPercent < FULL_PERCENT,
  );
  if (usable.length === 0) return null;
  const rows = usable.map((window) => ({
    peak: window.peakPercent,
    millions: MODEL_FAMILIES.map((family) => window.tokens[family] / MILLION),
  }));
  const fitted = MODEL_FAMILIES.map(() => 0);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = 0;
    MODEL_FAMILIES.forEach((_family, index) => {
      let numerator = 0;
      let denominator = 0;
      for (const row of rows) {
        const others = row.millions.reduce(
          (sum, tokens, other) =>
            other === index ? sum : sum + tokens * fitted[other],
          0,
        );
        numerator += row.millions[index] * (row.peak - others);
        denominator += row.millions[index] ** 2;
      }
      const next = denominator > 0 ? Math.max(0, numerator / denominator) : 0;
      moved = Math.max(moved, Math.abs(next - fitted[index]));
      fitted[index] = next;
    });
    if (moved < CONVERGED) break;
  }
  // A family the sample barely covers, or one the fit pushed to zero, gets no rate of
  // its own; it is priced off the best-covered family at their list-price ratio.
  const mass = MODEL_FAMILIES.map((_family, index) =>
    rows.reduce((sum, row) => sum + row.millions[index], 0),
  );
  const totalMass = mass.reduce((sum, each) => sum + each, 0);
  const fittedIndexes = MODEL_FAMILIES.map((_family, index) => index).filter(
    (index) => fitted[index] > 0 && mass[index] >= totalMass * MIN_FAMILY_SHARE,
  );
  if (fittedIndexes.length === 0) return null;
  const anchor = fittedIndexes.reduce((best, index) =>
    mass[index] > mass[best] ? index : best,
  );
  const anchorPrice = familyPrice(MODEL_FAMILIES[anchor]);
  const rates = {} as SessionRates;
  // A cheaper family's small sample soaks up usage the transcripts never saw (claude.ai
  // chat, other devices), so its rate is capped at its list-price ratio to the anchor.
  MODEL_FAMILIES.forEach((family, index) => {
    const listRate = (fitted[anchor] * familyPrice(family)) / anchorPrice;
    const ownRate =
      familyPrice(family) < anchorPrice
        ? Math.min(fitted[index], listRate)
        : fitted[index];
    rates[family] = round(fittedIndexes.includes(index) ? ownRate : listRate);
  });
  return rates;
}

export function sessionPercent(
  tokens: WeightedTokens,
  rates: SessionRates,
): number {
  return round(
    MODEL_FAMILIES.reduce(
      (percent, family) => percent + (tokens[family] / MILLION) * rates[family],
      0,
    ),
  );
}

/** The rate charged for one Claude model; an unrecognized model pays the largest rate. */
function modelRate(model: string, rates: SessionRates): number {
  const family: ModelFamily | null = modelFamily(model);
  return family === null
    ? Math.max(...MODEL_FAMILIES.map((each) => rates[each]))
    : rates[family];
}

/** Caches the fitted rates so the scheduler never refits from transcripts on every tick. */
export class SessionRatesCache {
  private state: SessionCalibration = { rates: null, error: null };
  private computedAt = Number.NEGATIVE_INFINITY;
  private inflight?: Promise<void>;
  constructor(
    private load: () => Promise<SessionRates | null>,
    private now: () => Date = () => new Date(),
    private ttlMs = SESSION_RATES_TTL_MS,
  ) {}

  current(): SessionCalibration {
    if (this.now().getTime() - this.computedAt >= this.ttlMs)
      void this.refresh();
    return structuredClone(this.state);
  }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.load()
      .then((rates) => {
        this.state = { rates, error: null };
      })
      .catch((error: unknown) => {
        this.state = {
          rates: this.state.rates,
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        this.computedAt = this.now().getTime();
        this.inflight = undefined;
      });
    return this.inflight;
  }
}

/** Session percent `tokens` weighted tokens cost when a run of `model` consumes them. */
export function modelSessionPercent(
  tokens: number,
  model: string,
  rates: SessionRates,
): number {
  return round((tokens / MILLION) * modelRate(model, rates));
}

import {
  PLAN_SCORE_DAYS,
  type UsageReport,
  type UsageSample,
  type UsageState,
} from "../shared/types.js";
import type { FetchUsage } from "./claude-usage.js";
import { sessionWindows, type UsageHistoryStore } from "./usage-history.js";

export const USAGE_POLL_MS = 5 * 60_000;
export const USAGE_MIN_REFRESH_MS = 30_000;

/** Polls Anthropic's usage endpoint, keeps the last good snapshot, and records samples. */
export class UsageMonitor {
  private state: UsageState;
  private inflight?: Promise<UsageState>;
  private timer?: ReturnType<typeof setInterval>;
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  constructor(
    private fetchUsage: FetchUsage,
    private history: UsageHistoryStore,
    private now: () => Date = () => new Date(),
  ) {
    this.state = { snapshot: history.snapshot(), error: null };
  }

  current(): UsageState {
    return structuredClone(this.state);
  }

  report(): UsageReport {
    const now = this.now();
    const samples = this.history.recent(now);
    return {
      ...this.current(),
      samples,
      windows: sessionWindows(samples, now),
    };
  }

  /** One extra day so a session window straddling the first plan-score date is complete. */
  samples(now: Date): UsageSample[] {
    return this.history.recent(now, PLAN_SCORE_DAYS + 1);
  }

  /** Fetches now unless a fetch is in flight or one finished within the minimum interval. */
  refresh(): Promise<UsageState> {
    if (this.inflight) return this.inflight;
    if (this.now().getTime() - this.lastFetchAt < USAGE_MIN_REFRESH_MS)
      return Promise.resolve(this.current());
    this.inflight = this.fetchOnce().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchOnce(): Promise<UsageState> {
    const now = this.now();
    this.lastFetchAt = now.getTime();
    try {
      const snapshot = await this.fetchUsage(now);
      this.state = { snapshot, error: null };
      await this.history.record(snapshot);
    } catch (error) {
      this.state = {
        snapshot: this.state.snapshot,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return this.current();
  }

  start(intervalMs = USAGE_POLL_MS) {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

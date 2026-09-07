export const QUIET_HOURS_TTL_MS = 10 * 60_000;

export interface QuietRanking {
  /** All 24 local start hours, quietest first, or null until computed. */
  ranking: number[] | null;
  error: string | null;
}

/** Caches the quiet-window ranking so the scheduler never re-reads transcripts on every tick. */
export class QuietHoursCache {
  private state: QuietRanking = { ranking: null, error: null };
  private computedAt = Number.NEGATIVE_INFINITY;
  private inflight?: Promise<void>;
  constructor(
    private load: () => Promise<number[]>,
    private now: () => Date = () => new Date(),
    private ttlMs = QUIET_HOURS_TTL_MS,
  ) {}

  current(): QuietRanking {
    if (this.now().getTime() - this.computedAt >= this.ttlMs)
      void this.refresh();
    return structuredClone(this.state);
  }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.load()
      .then((ranking) => {
        this.state = { ranking, error: null };
      })
      .catch((error: unknown) => {
        this.state = {
          ranking: this.state.ranking,
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

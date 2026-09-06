import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BLOCK_MINUTES,
  type SessionWindow,
  type UsageSample,
  type UsageSnapshot,
} from "../shared/types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
export const HISTORY_DAYS = 14;
export const WINDOW_DAYS = 7;
const BLOCK_MS = BLOCK_MINUTES * MINUTE_MS;

export function toSample(snapshot: UsageSnapshot): UsageSample {
  return {
    at: snapshot.fetchedAt,
    session: snapshot.session.percent,
    sessionResetsAt: snapshot.session.resetsAt,
    weekly: snapshot.weekly.percent,
    weeklyResetsAt: snapshot.weekly.resetsAt,
    fable: snapshot.fable?.percent ?? null,
  };
}

/** Peak session utilization per five-hour window observed over the last seven days. */
export function sessionWindows(
  samples: UsageSample[],
  now: Date,
): SessionWindow[] {
  const since = now.getTime() - WINDOW_DAYS * DAY_MS;
  const windows = new Map<string, SessionWindow>();
  for (const sample of samples) {
    const at = Date.parse(sample.at);
    if (at < since || sample.sessionResetsAt === null) continue;
    const reset = Date.parse(sample.sessionResetsAt);
    if (reset <= at) continue;
    const current = windows.get(sample.sessionResetsAt);
    if (current) {
      current.peakPercent = Math.max(current.peakPercent, sample.session);
      current.samples++;
    } else
      windows.set(sample.sessionResetsAt, {
        start: new Date(reset - BLOCK_MS).toISOString(),
        end: sample.sessionResetsAt,
        peakPercent: sample.session,
        samples: 1,
      });
  }
  return [...windows.values()].sort((a, b) => a.start.localeCompare(b.start));
}

function isSample(value: unknown): value is UsageSample {
  const s = value as UsageSample;
  return (
    s !== null &&
    typeof s === "object" &&
    Number.isFinite(Date.parse(s.at)) &&
    typeof s.session === "number" &&
    typeof s.weekly === "number" &&
    (s.sessionResetsAt === null || typeof s.sessionResetsAt === "string") &&
    (s.weeklyResetsAt === null || typeof s.weeklyResetsAt === "string") &&
    (s.fable === null || typeof s.fable === "number")
  );
}

export class UsageHistoryStore {
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    private path: string,
    private samples: UsageSample[],
  ) {}

  static async open(directory: string, now = new Date()) {
    const path = join(directory, "usage-samples.jsonl");
    let lines: string[] = [];
    try {
      lines = (await readFile(path, "utf8")).split("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(path, "", { mode: 0o600 });
    }
    const cutoff = now.getTime() - HISTORY_DAYS * DAY_MS;
    const samples: UsageSample[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed: unknown = JSON.parse(line);
      if (!isSample(parsed))
        throw new Error("usage-samples.jsonl holds an unreadable sample.");
      if (Date.parse(parsed.at) >= cutoff) samples.push(parsed);
    }
    samples.sort((a, b) => a.at.localeCompare(b.at));
    if (samples.length !== lines.filter((line) => line.trim()).length)
      await writeFile(
        path,
        samples
          .map((sample) => JSON.stringify(sample))
          .join("\n")
          .concat("\n"),
        { mode: 0o600 },
      );
    return new UsageHistoryStore(path, samples);
  }

  recent(now: Date, days = WINDOW_DAYS): UsageSample[] {
    const since = now.getTime() - days * DAY_MS;
    return this.samples.filter((sample) => Date.parse(sample.at) >= since);
  }

  async add(sample: UsageSample) {
    const operation = this.chain.then(async () => {
      await appendFile(this.path, `${JSON.stringify(sample)}\n`, {
        mode: 0o600,
      });
      this.samples.push(sample);
    });
    this.chain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

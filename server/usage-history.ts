import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActivityEvent,
  BLOCK_MINUTES,
  MINUTE_MS,
  type OfficialUsage,
  resetMinute,
  type SessionWindow,
  type UsageSample,
  type UsageSnapshot,
} from "../shared/types.js";
import { activeMinutes, activityBlocks } from "./analytics.js";

const DAY_MS = 86_400_000;
export const HISTORY_DAYS = 90;
export const WINDOW_DAYS = 7;
const BLOCK_MS = BLOCK_MINUTES * MINUTE_MS;
const SAMPLES_FILE = "usage-samples.jsonl";
const SNAPSHOT_FILE = "usage-snapshot.json";

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

export function sessionWindows(
  samples: UsageSample[],
  now: Date,
  days = WINDOW_DAYS,
): SessionWindow[] {
  const since = now.getTime() - days * DAY_MS;
  const windows = new Map<number, SessionWindow & { peakPercent: number }>();
  for (const sample of samples) {
    const at = Date.parse(sample.at);
    if (at < since || sample.sessionResetsAt === null) continue;
    const reset = Date.parse(sample.sessionResetsAt);
    if (reset <= at) continue;
    const bucket = resetMinute(sample.sessionResetsAt);
    const current = windows.get(bucket);
    if (current) {
      current.peakPercent = Math.max(current.peakPercent, sample.session);
      current.samples++;
    } else
      windows.set(bucket, {
        start: new Date(reset - BLOCK_MS).toISOString(),
        end: sample.sessionResetsAt,
        peakPercent: sample.session,
        activeMinutes: 0,
        samples: 1,
      });
  }
  return [...windows.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/** Fills sampled windows with local active minutes and adds windows inferred from activity alone. */
export function mergeSessionWindows(
  sampled: SessionWindow[],
  events: ActivityEvent[],
  now: Date,
): SessionWindow[] {
  const since = now.getTime() - WINDOW_DAYS * DAY_MS;
  const recent = events.filter((event) => Date.parse(event.timestamp) >= since);
  const spans = sampled.map((window) => ({
    start: Date.parse(window.start),
    end: Date.parse(window.end),
  }));
  const merged = sampled.map((window, index) => ({
    ...window,
    activeMinutes: activeMinutes(
      recent.filter((event) => {
        const at = Date.parse(event.timestamp);
        return at >= spans[index].start && at <= spans[index].end;
      }),
    ),
  }));
  for (const block of activityBlocks(recent, now)) {
    const overlaps = spans.some(
      (span) => block.start < span.end && block.end > span.start,
    );
    if (overlaps) continue;
    merged.push({
      start: new Date(block.start).toISOString(),
      end: new Date(block.end).toISOString(),
      peakPercent: null,
      activeMinutes: activeMinutes(block.events),
      samples: 0,
    });
  }
  return merged.sort((a, b) => a.start.localeCompare(b.start));
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

function isUsage(value: unknown): value is OfficialUsage {
  const usage = value as OfficialUsage;
  return (
    usage !== null &&
    typeof usage === "object" &&
    typeof usage.percent === "number" &&
    (usage.resetsAt === null ||
      (typeof usage.resetsAt === "string" &&
        Number.isFinite(Date.parse(usage.resetsAt))))
  );
}

function isSnapshot(value: unknown): value is UsageSnapshot {
  const snapshot = value as UsageSnapshot;
  return (
    snapshot !== null &&
    typeof snapshot === "object" &&
    typeof snapshot.fetchedAt === "string" &&
    Number.isFinite(Date.parse(snapshot.fetchedAt)) &&
    (snapshot.plan === null ||
      snapshot.plan === undefined ||
      typeof snapshot.plan === "string") &&
    isUsage(snapshot.session) &&
    isUsage(snapshot.weekly) &&
    (snapshot.fable === null || isUsage(snapshot.fable))
  );
}

async function readSnapshot(path: string, now: Date) {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${SNAPSHOT_FILE} is not valid JSON.`);
  }
  if (!isSnapshot(parsed))
    throw new Error(`${SNAPSHOT_FILE} holds an unreadable snapshot.`);
  if (
    parsed.weekly.resetsAt === null ||
    Date.parse(parsed.weekly.resetsAt) <= now.getTime()
  ) {
    await rm(path);
    return null;
  }
  // Snapshots written before `plan` existed are our own prior format, so a
  // missing key reads as an unknown plan rather than a corrupt file.
  return { ...parsed, plan: parsed.plan ?? null };
}

export class UsageHistoryStore {
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    private path: string,
    private snapshotPath: string,
    private samples: UsageSample[],
    private latest: UsageSnapshot | null,
  ) {}

  static async open(directory: string, now = new Date()) {
    const path = join(directory, SAMPLES_FILE);
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
        throw new Error(`${SAMPLES_FILE} holds an unreadable sample.`);
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
    const snapshotPath = join(directory, SNAPSHOT_FILE);
    return new UsageHistoryStore(
      path,
      snapshotPath,
      samples,
      await readSnapshot(snapshotPath, now),
    );
  }

  snapshot(): UsageSnapshot | null {
    return this.latest;
  }

  recent(now: Date, days = WINDOW_DAYS): UsageSample[] {
    const since = now.getTime() - days * DAY_MS;
    return this.samples.filter((sample) => Date.parse(sample.at) >= since);
  }

  async record(snapshot: UsageSnapshot) {
    const sample = toSample(snapshot);
    const operation = this.chain.then(async () => {
      await appendFile(this.path, `${JSON.stringify(sample)}\n`, {
        mode: 0o600,
      });
      this.samples.push(sample);
      await writeFile(this.snapshotPath, JSON.stringify(snapshot), {
        mode: 0o600,
      });
      this.latest = snapshot;
    });
    this.chain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

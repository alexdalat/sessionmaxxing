import {
  type BucketGate,
  type DispatchGate,
  type DispatchSettings,
  FABLE_MODEL,
  hourLabel,
  localTimestamp,
  type OfficialUsage,
  type PlanningSnapshot,
  type PublicTask,
  type QuietHours,
  type TaskGate,
  type UsageState,
  WEEK_MINUTES,
  WEEKLY_HARD_CEILING_PERCENT,
} from "../shared/types.js";
import { localParts } from "./analytics.js";
import type { QuietRanking } from "./quiet-hours.js";

const MINUTE_MS = 60_000;
const WEEK_MS = WEEK_MINUTES * MINUTE_MS;
export const USAGE_STALE_MS = 15 * MINUTE_MS;
export const USAGE_PREDATES_RUN_REASON =
  "Official usage predates the last run; refreshing before the next dispatch";
const FULL = 100;
const round = (value: number) => Math.round(value * 10) / 10;

function sessionGate(
  usage: OfficialUsage | undefined,
  reservePercent: number,
  now: Date,
): BucketGate {
  const ceiling = FULL - reservePercent;
  if (!usage) return { percent: null, ceiling, pace: null, ok: false };
  const expired =
    usage.resetsAt !== null && Date.parse(usage.resetsAt) <= now.getTime();
  const percent = expired ? 0 : usage.percent;
  return { percent, ceiling, pace: null, ok: percent <= ceiling };
}

/** Linear pace through the seven-day window: the share of the week already elapsed. */
export function weeklyPace(resetsAt: string | null, now: Date): number | null {
  if (resetsAt === null) return null;
  const reset = Date.parse(resetsAt);
  if (reset <= now.getTime()) return null;
  const elapsed = (now.getTime() - (reset - WEEK_MS)) / WEEK_MS;
  return round(Math.min(1, Math.max(0, elapsed)) * FULL);
}

function weeklyGate(
  usage: OfficialUsage | undefined | null,
  marginPercent: number,
  now: Date,
): BucketGate {
  if (!usage)
    return {
      percent: null,
      ceiling: WEEKLY_HARD_CEILING_PERCENT,
      pace: null,
      ok: false,
    };
  const pace = weeklyPace(usage.resetsAt, now);
  const ceiling =
    pace === null
      ? WEEKLY_HARD_CEILING_PERCENT
      : Math.min(WEEKLY_HARD_CEILING_PERCENT, round(pace + marginPercent));
  const percent = pace === null && usage.resetsAt !== null ? 0 : usage.percent;
  return { percent, ceiling, pace, ok: percent <= ceiling };
}

const describe = (name: string, gate: BucketGate) =>
  `${name} ${gate.percent}% of ${gate.ceiling}%`;

const HOURS_PER_DAY = 24;
export function quietHours(
  ranking: QuietRanking,
  count: number,
  now: Date,
): QuietHours {
  const nowHour = localParts(now).hour;
  const startHours =
    ranking.ranking === null
      ? null
      : [...ranking.ranking.slice(0, count)].sort((a, b) => a - b);
  const active = startHours?.includes(nowHour) ?? false;
  const nextStartHour =
    startHours === null || startHours.length === 0
      ? null
      : (startHours.find((hour) => hour > nowHour) ?? startHours[0]);
  return {
    startHours,
    error: ranking.error,
    nowHour,
    active,
    nextStartHour,
  };
}
export function hoursUntil(fromHour: number, toHour: number) {
  return (toHour - fromHour + HOURS_PER_DAY) % HOURS_PER_DAY || HOURS_PER_DAY;
}

export function planDispatch(
  settings: DispatchSettings,
  usage: UsageState,
  now: Date,
  ranking: QuietRanking = { ranking: null, error: null },
  lastRunEndedAt: string | null = null,
): PlanningSnapshot {
  const snapshot = usage.snapshot;
  const session = sessionGate(
    snapshot?.session,
    settings.sessionReservePercent,
    now,
  );
  const weekly = weeklyGate(
    snapshot?.weekly,
    settings.weeklyMarginPercent,
    now,
  );
  const fable = snapshot?.fable
    ? weeklyGate(snapshot.fable, settings.weeklyMarginPercent, now)
    : null;
  const ageMs = snapshot
    ? now.getTime() - Date.parse(snapshot.fetchedAt)
    : Number.POSITIVE_INFINITY;
  let claude: DispatchGate;
  if (!snapshot)
    claude = {
      status: "waiting",
      reason: `Official usage unavailable: ${usage.error ?? "not fetched yet"}`,
    };
  else if (ageMs > USAGE_STALE_MS)
    claude = {
      status: "waiting",
      reason: `Official usage is ${Math.round(ageMs / MINUTE_MS)} min old${usage.error ? ` (${usage.error})` : ""}`,
    };
  else if (
    lastRunEndedAt !== null &&
    Date.parse(snapshot.fetchedAt) < Date.parse(lastRunEndedAt)
  )
    claude = {
      status: "waiting",
      reason: USAGE_PREDATES_RUN_REASON,
    };
  else if (!session.ok)
    claude = {
      status: "waiting",
      reason: `Session at ${session.percent}%, above the ${session.ceiling}% ceiling`,
    };
  else if (!weekly.ok)
    claude = {
      status: "waiting",
      reason: `Weekly at ${weekly.percent}%, above the ${weekly.ceiling}% ceiling${weekly.pace === null ? "" : ` (pace ${weekly.pace}% + ${settings.weeklyMarginPercent}% margin)`}`,
    };
  else
    claude = {
      status: "ready",
      reason: `${describe("Session", session)} · ${describe("Weekly", weekly)}`,
    };
  return {
    settings,
    usage: snapshot,
    usageError: usage.error,
    session,
    weekly,
    fable,
    quiet: quietHours(ranking, settings.quietStartHours, now),
    providers: {
      claude,
      codex: {
        status: "ready",
        reason: "Codex runs do not touch Claude usage",
      },
    },
  };
}

export function taskGate(
  task: Pick<
    PublicTask,
    "status" | "provider" | "model" | "preferredWindowStart" | "earliestStart"
  >,
  planning: PlanningSnapshot,
  now: Date,
): TaskGate {
  if (task.status === "running")
    return { status: "running", reason: "Running now" };
  if (task.status !== "pending")
    return { status: "finished", reason: task.status };
  if (
    task.earliestStart !== null &&
    Date.parse(task.earliestStart) > now.getTime()
  )
    return {
      status: "waiting",
      reason: `Starts after ${localTimestamp(task.earliestStart)}`,
    };
  const provider = planning.providers[task.provider];
  const { quiet, settings } = planning;
  if (
    task.provider === "claude" &&
    provider.status === "ready" &&
    settings.quietHoursOnly &&
    task.preferredWindowStart === null
  ) {
    if (quiet.startHours === null)
      return {
        status: "waiting",
        reason: `Quiet hours not computed yet${quiet.error ? ` (${quiet.error})` : ""}`,
      };
    if (!quiet.active)
      return {
        status: "waiting",
        reason:
          quiet.nextStartHour === null
            ? "No quiet start hours configured"
            : `Outside quiet hours · next ${hourLabel(quiet.nextStartHour)}`,
      };
  }
  const fable = planning.fable;
  if (
    task.provider === "claude" &&
    provider.status === "ready" &&
    fable &&
    FABLE_MODEL.test(task.model) &&
    !fable.ok
  )
    return {
      status: "waiting",
      reason: `Fable weekly at ${fable.percent}%, above the ${fable.ceiling}% ceiling`,
    };
  return provider;
}

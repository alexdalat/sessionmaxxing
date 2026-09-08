import {
  BLOCK_MINUTES,
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
  quietHoursOnly,
  type TaskGate,
  type UsageState,
  WEEK_MINUTES,
  WEEKLY_HARD_CEILING_PERCENT,
} from "../shared/types.js";
import { localParts, localStart, shiftDate } from "./analytics.js";
import type { QuietRanking } from "./quiet-hours.js";

const MINUTE_MS = 60_000;
const WEEK_MS = WEEK_MINUTES * MINUTE_MS;
const WINDOW_MS = BLOCK_MINUTES * MINUTE_MS;
const WINDOW_HOURS = BLOCK_MINUTES / 60;
export const USAGE_STALE_MS = 15 * MINUTE_MS;
export const USAGE_PREDATES_RUN_REASON =
  "Refreshing official usage after the last run";
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

/** Naming the reserve only helps when quiet and busy hours get different budgets. */
function reserveLabel(settings: DispatchSettings, busyHours: boolean) {
  if (
    quietHoursOnly(settings) ||
    settings.sessionReservePercent === settings.busyHoursReservePercent
  )
    return "";
  return busyHours ? " (busy hours)" : " (quiet hours)";
}

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
  const quiet = quietHours(ranking, settings.quietStartHours, now);
  const busyHours = !quiet.active && !quietHoursOnly(settings);
  const session = sessionGate(
    snapshot?.session,
    busyHours
      ? settings.busyHoursReservePercent
      : settings.sessionReservePercent,
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
      reason: `Official usage is ${Math.round(ageMs / MINUTE_MS)} min old · refresh to retry${usage.error ? ` (${usage.error})` : ""}`,
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
      reason: `Session ${session.percent}%, over the ${session.ceiling}% queue cutoff${reserveLabel(settings, busyHours)}`,
    };
  else if (!weekly.ok)
    claude = {
      status: "waiting",
      reason: `Weekly ${weekly.percent}%, over the ${weekly.ceiling}% queue cutoff${weekly.pace === null ? "" : ` (pace ${weekly.pace}% + ${settings.weeklyMarginPercent}% margin)`}`,
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
    quiet,
    providers: {
      claude,
      codex: {
        status: "ready",
        reason: "Codex tasks never wait on Claude usage",
      },
    },
  };
}

type GateTask = Pick<
  PublicTask,
  "status" | "provider" | "model" | "preferredWindowStart" | "earliestStart"
>;

/** The window opening at `hour` that is still open at `at`, searching yesterday through tomorrow. */
function windowStartAt(hour: number, at: number): number {
  const date = localParts(at).date;
  const starts = [-1, 0, 1].map((days) =>
    localStart(shiftDate(date, days), hour),
  );
  return starts.find((start) => start + WINDOW_MS > at) ?? starts[2];
}

const insideWindow = (hour: number, at: number) =>
  windowStartAt(hour, at) <= at;

/** Earliest instant the time-based gates open, ignoring usage; null when unknowable. */
export function eligibleAt(
  task: Pick<GateTask, "provider" | "preferredWindowStart" | "earliestStart">,
  planning: PlanningSnapshot,
  now: Date,
): string | null {
  const base = Math.max(
    now.getTime(),
    task.earliestStart === null ? 0 : Date.parse(task.earliestStart),
  );
  if (task.preferredWindowStart !== null)
    return new Date(
      Math.max(base, windowStartAt(task.preferredWindowStart, base)),
    ).toISOString();
  const { quiet, settings } = planning;
  if (task.provider !== "claude" || !quietHoursOnly(settings))
    return new Date(base).toISOString();
  const startHours = quiet.startHours;
  if (startHours === null || startHours.length === 0) return null;
  const { date, hour } = localParts(base);
  if (startHours.includes(hour)) return new Date(base).toISOString();
  const next = startHours.find((start) => start > hour);
  return new Date(
    next === undefined
      ? localStart(shiftDate(date, 1), startHours[0])
      : localStart(date, next),
  ).toISOString();
}

export function taskGate(
  task: GateTask,
  planning: PlanningSnapshot,
  now: Date,
): TaskGate {
  if (task.status === "running")
    return { status: "running", reason: "Running now", eligibleAt: null };
  if (task.status !== "pending")
    return { status: "finished", reason: task.status, eligibleAt: null };
  const eligible = eligibleAt(task, planning, now);
  if (
    task.earliestStart !== null &&
    Date.parse(task.earliestStart) > now.getTime()
  )
    return {
      status: "waiting",
      reason: `Starts after ${localTimestamp(task.earliestStart)}`,
      eligibleAt: eligible,
    };
  if (
    task.preferredWindowStart !== null &&
    !insideWindow(task.preferredWindowStart, now.getTime())
  )
    return {
      status: "waiting",
      reason: `Outside window ${hourLabel(task.preferredWindowStart)} → ${hourLabel(
        (task.preferredWindowStart + WINDOW_HOURS) % HOURS_PER_DAY,
      )}`,
      eligibleAt: eligible,
    };
  const provider = planning.providers[task.provider];
  const { quiet, settings } = planning;
  if (
    task.provider === "claude" &&
    provider.status === "ready" &&
    quietHoursOnly(settings) &&
    task.preferredWindowStart === null
  ) {
    if (quiet.startHours === null)
      return {
        status: "waiting",
        reason: `Quiet hours not computed yet${quiet.error ? ` (${quiet.error})` : ""}`,
        eligibleAt: eligible,
      };
    if (!quiet.active)
      return {
        status: "waiting",
        reason:
          quiet.nextStartHour === null
            ? "No quiet start hours configured"
            : `Outside quiet hours · next ${hourLabel(quiet.nextStartHour)}`,
        eligibleAt: eligible,
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
      reason: `Fable weekly ${fable.percent}%, over the ${fable.ceiling}% queue cutoff`,
      eligibleAt: eligible,
    };
  return { ...provider, eligibleAt: eligible };
}

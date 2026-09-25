import {
  BLOCK_MINUTES,
  type BucketGate,
  type ClaudeBucket,
  type DispatchGate,
  type DispatchLoad,
  type DispatchSettings,
  EMPTY_LOAD,
  FABLE_MODEL,
  hourLabel,
  localTimestamp,
  type OfficialUsage,
  type PlanningSnapshot,
  type PublicTask,
  type QuietHours,
  quietHoursOnly,
  type Run,
  type SessionRates,
  type Task,
  type TaskGate,
  type UsageState,
  WEEK_MINUTES,
  WEEKLY_HARD_CEILING_PERCENT,
} from "../shared/types.js";
import { localParts, localStart, shiftDate } from "./analytics.js";
import { modelSessionPercent, type SessionCalibration } from "./calibration.js";
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
  reserved: number,
  now: Date,
): BucketGate {
  const ceiling = FULL - reservePercent;
  if (!usage)
    return { percent: null, ceiling, pace: null, reserved, ok: false };
  const expired =
    usage.resetsAt !== null && Date.parse(usage.resetsAt) <= now.getTime();
  const percent = expired ? 0 : usage.percent;
  return {
    percent,
    ceiling,
    pace: null,
    reserved,
    ok: percent + reserved <= ceiling,
  };
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
  reserved: number,
  now: Date,
): BucketGate {
  if (!usage)
    return {
      percent: null,
      ceiling: WEEKLY_HARD_CEILING_PERCENT,
      pace: null,
      reserved,
      ok: false,
    };
  const pace = weeklyPace(usage.resetsAt, now);
  const ceiling =
    pace === null
      ? WEEKLY_HARD_CEILING_PERCENT
      : Math.min(WEEKLY_HARD_CEILING_PERCENT, round(pace + marginPercent));
  const percent = pace === null && usage.resetsAt !== null ? 0 : usage.percent;
  return {
    percent,
    ceiling,
    pace,
    reserved,
    ok: percent + reserved <= ceiling,
  };
}

const held = (gate: BucketGate) =>
  gate.reserved > 0 ? ` + ${round(gate.reserved)}% held for running tasks` : "";
const describe = (name: string, gate: BucketGate) =>
  `${name} ${gate.percent}%${held(gate)} of ${gate.ceiling}%`;
const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Points one run of `task` holds in each Claude bucket while it is active. */
export function runReservation(
  task: Pick<PublicTask, "provider" | "model">,
  expectedSessionPercent: number,
  settings: DispatchSettings,
): Record<ClaudeBucket, number> {
  if (task.provider !== "claude") return { session: 0, weekly: 0, fable: 0 };
  return {
    session: expectedSessionPercent,
    weekly: settings.runWeeklyCostPercent,
    fable: FABLE_MODEL.test(task.model) ? settings.runWeeklyCostPercent : 0,
  };
}
/** The load after one more run of `task` has started. */
export function withRun(
  load: DispatchLoad,
  task: Pick<PublicTask, "provider" | "model">,
  expectedSessionPercent: number,
  settings: DispatchSettings,
): DispatchLoad {
  const cost = runReservation(task, expectedSessionPercent, settings);
  return {
    ...load,
    running: load.running + 1,
    claudeRuns: load.claudeRuns + (task.provider === "claude" ? 1 : 0),
    reserved: {
      session: load.reserved.session + cost.session,
      weekly: load.reserved.weekly + cost.weekly,
      fable: load.reserved.fable + cost.fable,
    },
  };
}

const inBusyHours = (settings: DispatchSettings, quiet: QuietHours) =>
  !quiet.active && !quietHoursOnly(settings);

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
  load: DispatchLoad = EMPTY_LOAD,
  calibration: SessionCalibration = { rates: null, error: null },
): PlanningSnapshot {
  const snapshot = usage.snapshot;
  const { lastRunEndedAt } = load;
  const quiet = quietHours(ranking, settings.quietStartHours, now);
  const busyHours = inBusyHours(settings, quiet);
  const session = sessionGate(
    snapshot?.session,
    busyHours
      ? settings.busyHoursReservePercent
      : settings.sessionReservePercent,
    load.reserved.session,
    now,
  );
  const weekly = weeklyGate(
    snapshot?.weekly,
    settings.weeklyMarginPercent,
    load.reserved.weekly,
    now,
  );
  const fable = snapshot?.fable
    ? weeklyGate(
        snapshot.fable,
        settings.weeklyMarginPercent,
        load.reserved.fable,
        now,
      )
    : null;
  const ageMs = snapshot
    ? now.getTime() - Date.parse(snapshot.fetchedAt)
    : Number.POSITIVE_INFINITY;
  const slotsFull = load.running >= settings.maxConcurrentRuns;
  const slots: DispatchGate = {
    status: "waiting",
    reason: `All ${plural(settings.maxConcurrentRuns, "run slot")} busy`,
  };
  let claude: DispatchGate;
  if (slotsFull) claude = slots;
  else if (!snapshot)
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
  else if (calibration.rates === null)
    claude = {
      status: "waiting",
      reason: `Session cost calibration unavailable: ${calibration.error ?? "no five-hour window has been measured yet"}`,
    };
  else if (!session.ok)
    claude = {
      status: "waiting",
      reason: `Session ${session.percent}%${held(session)}, over the ${session.ceiling}% queue cutoff${reserveLabel(settings, busyHours)}`,
    };
  else if (!weekly.ok)
    claude = {
      status: "waiting",
      reason: `Weekly ${weekly.percent}%${held(weekly)}, over the ${weekly.ceiling}% queue cutoff${weekly.pace === null ? "" : ` (pace ${weekly.pace}% + ${settings.weeklyMarginPercent}% margin)`}`,
    };
  else
    claude = {
      status: "ready",
      reason: `${describe("Session", session)} · ${describe("Weekly", weekly)}`,
    };
  return {
    settings,
    rates: calibration.rates,
    usage: snapshot,
    usageError: usage.error,
    session,
    weekly,
    fable,
    quiet,
    load,
    providers: {
      claude,
      codex: slotsFull
        ? slots
        : {
            status: "ready",
            reason: "Codex tasks never wait on Claude usage",
          },
    },
  };
}

export type Dependency = Pick<Task, "id" | "title" | "status">;
export const dependencyReason = ({ title, status }: Dependency) => {
  if (status === "failed") return `Blocked: “${title}” failed`;
  if (status === "cancelled") return `Blocked: “${title}” was cancelled`;
  return `Waits for “${title}”`;
};
/**
 * The first dependency of `task` that has not completed; undefined when every
 * one has. A dependency that is no longer queued was deleted and holds nothing.
 */
export function blockingDependency(
  task: Pick<Task, "dependsOn">,
  tasks: readonly Dependency[],
): Dependency | undefined {
  for (const dependencyId of task.dependsOn) {
    const dependency = tasks.find(({ id }) => id === dependencyId);
    if (dependency && dependency.status !== "completed") return dependency;
  }
  return undefined;
}

type GateTask = Pick<
  PublicTask,
  | "id"
  | "status"
  | "provider"
  | "model"
  | "preferredWindowStart"
  | "earliestStart"
  | "tokens"
>;
type RunCost = Pick<Run, "taskId" | "status" | "sessionCostPercent">;

/**
 * The largest session percent this task's earlier completed runs cost, or its
 * expected tokens priced at the current rates; null while the rates are unknown.
 * Failed and cancelled runs are skipped: one that looped or redid work would
 * otherwise price the task out of every window.
 */
export function expectedSessionCost(
  task: Pick<Task, "id" | "model" | "tokens">,
  runs: readonly RunCost[],
  rates: SessionRates | null,
): number | null {
  let largest: number | null = null;
  for (const run of runs)
    if (
      run.taskId === task.id &&
      run.status === "completed" &&
      run.sessionCostPercent !== null &&
      (largest === null || run.sessionCostPercent > largest)
    )
      largest = run.sessionCostPercent;
  if (largest !== null) return largest;
  return rates === null
    ? null
    : modelSessionPercent(task.tokens, task.model, rates);
}

/** A task larger than the whole cutoff never fits a window, so it waits for an empty one instead of waiting forever. */
const fitCost = (expected: number, session: BucketGate) =>
  Math.min(expected, session.ceiling);

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

/** When the pace-based weekly ceiling rises past `percent`, or the window reset when it never does. */
function weeklyClearsAt(
  gate: BucketGate,
  resetsAt: string | null,
  marginPercent: number,
): number | null {
  if (resetsAt === null) return null;
  const reset = Date.parse(resetsAt);
  if (gate.percent === null || gate.percent > WEEKLY_HARD_CEILING_PERCENT)
    return reset;
  const neededPace = gate.percent - marginPercent;
  return Math.min(reset, reset - WEEK_MS + (neededPace / FULL) * WEEK_MS);
}

const overCeiling = (gate: BucketGate, cost: number) =>
  gate.percent !== null && gate.percent + cost > gate.ceiling;

/**
 * Start of the five-hour window this task lands in once every task queued ahead
 * has taken its share of the session ceiling; null when the reset is unknown.
 */
function sessionWindowStart(
  session: BucketGate,
  percent: number,
  resetsAt: string | null,
  ahead: readonly number[],
  expected: number,
  now: Date,
): number | null {
  let start = now.getTime();
  let used = percent + session.reserved;
  let reset = resetsAt === null ? null : Date.parse(resetsAt);
  for (const cost of [...ahead, expected].map((each) =>
    fitCost(each, session),
  )) {
    while (used + cost > session.ceiling) {
      if (reset === null) return null;
      start = Math.max(reset, now.getTime());
      reset = start + WINDOW_MS;
      used = 0;
    }
    used += cost;
  }
  return start;
}

/** Expected session cost of each pending Claude task queued ahead of `taskId`, in dispatch order. */
export function costsAhead(
  taskId: string,
  tasks: readonly GateTask[],
  runs: readonly RunCost[],
  rates: SessionRates | null,
): number[] {
  const costs: number[] = [];
  for (const task of tasks) {
    if (task.id === taskId) break;
    if (task.status !== "pending" || task.provider !== "claude") continue;
    const cost = expectedSessionCost(task, runs, rates);
    if (cost !== null) costs.push(cost);
  }
  return costs;
}

/** Earliest instant the usage buckets this task draws on hold enough headroom; null when unknowable. */
function usageClearsAt(
  task: Pick<GateTask, "id" | "provider" | "model" | "tokens">,
  planning: PlanningSnapshot,
  runs: readonly RunCost[],
  now: Date,
  ahead: readonly number[],
): number | null {
  const { usage, session, weekly, fable, settings, rates } = planning;
  if (task.provider !== "claude" || usage === null) return now.getTime();
  const expected = expectedSessionCost(task, runs, rates);
  if (expected === null) return null;
  const windowStart =
    session.percent === null
      ? now.getTime()
      : sessionWindowStart(
          session,
          session.percent,
          usage.session.resetsAt,
          ahead,
          expected,
          now,
        );
  if (windowStart === null) return null;
  let clears = Math.max(now.getTime(), windowStart);
  if (overCeiling(weekly, 0)) {
    const at = weeklyClearsAt(
      weekly,
      usage.weekly.resetsAt,
      settings.weeklyMarginPercent,
    );
    if (at === null) return null;
    clears = Math.max(clears, at);
  }
  if (fable && FABLE_MODEL.test(task.model) && overCeiling(fable, 0)) {
    const at = weeklyClearsAt(
      fable,
      usage.fable?.resetsAt ?? null,
      settings.weeklyMarginPercent,
    );
    if (at === null) return null;
    clears = Math.max(clears, at);
  }
  return clears;
}

/** Earliest instant every gate — schedule, quiet hours and usage — opens; null when unknowable. */
export function eligibleAt(
  task: Pick<
    GateTask,
    | "id"
    | "provider"
    | "model"
    | "preferredWindowStart"
    | "earliestStart"
    | "tokens"
  >,
  planning: PlanningSnapshot,
  now: Date,
  runs: readonly RunCost[],
  ahead: readonly number[] = [],
): string | null {
  const usageClears = usageClearsAt(task, planning, runs, now, ahead);
  if (usageClears === null) return null;
  const base = Math.max(
    now.getTime(),
    usageClears,
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
  runs: readonly RunCost[],
  ahead: readonly number[] = [],
): TaskGate {
  if (task.status === "running")
    return { status: "running", reason: "Running now", eligibleAt: null };
  if (task.status !== "pending")
    return { status: "finished", reason: task.status, eligibleAt: null };
  const eligible = eligibleAt(task, planning, now, runs, ahead);
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
      reason: `Fable weekly ${fable.percent}%${held(fable)}, over the ${fable.ceiling}% queue cutoff`,
      eligibleAt: eligible,
    };
  const { session } = planning;
  if (
    task.provider === "claude" &&
    provider.status === "ready" &&
    session.percent !== null
  ) {
    const expected = expectedSessionCost(task, runs, planning.rates);
    if (
      expected !== null &&
      session.percent + session.reserved + fitCost(expected, session) >
        session.ceiling
    )
      return {
        status: "waiting",
        reason: `Session ${session.percent}%${held(session)} + ${expected}% expected, over the ${session.ceiling}% queue cutoff${reserveLabel(settings, inBusyHours(settings, quiet))}`,
        eligibleAt: eligible,
      };
  }
  return { ...provider, eligibleAt: eligible };
}

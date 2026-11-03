import {
  localParts,
  localStart,
  localTimestamp,
  nextLocalHour,
  shiftDate,
} from "../shared/local-time.js";
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
  task: Pick<PublicTask, "model">,
  expectedSessionPercent: number,
  settings: DispatchSettings,
): Record<ClaudeBucket, number> {
  return {
    session: expectedSessionPercent,
    weekly: settings.runWeeklyCostPercent,
    fable: FABLE_MODEL.test(task.model) ? settings.runWeeklyCostPercent : 0,
  };
}
/** The load after one more run of `task` has started. */
export function withRun(
  load: DispatchLoad,
  task: Pick<PublicTask, "model">,
  expectedSessionPercent: number,
  settings: DispatchSettings,
): DispatchLoad {
  const cost = runReservation(task, expectedSessionPercent, settings);
  return {
    ...load,
    running: load.running + 1,
    claudeRuns: load.claudeRuns + 1,
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
  timeZone: string,
): QuietHours {
  const nowHour = localParts(now, timeZone).hour;
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
  timeZone: string,
  ranking: QuietRanking = { ranking: null, error: null },
  load: DispatchLoad = EMPTY_LOAD,
  calibration: SessionCalibration = { rates: null, error: null },
): PlanningSnapshot {
  const snapshot = usage.snapshot;
  const { lastRunEndedAt } = load;
  const quiet = quietHours(ranking, settings.quietStartHours, now, timeZone);
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
  let gate: DispatchGate;
  if (slotsFull) gate = slots;
  else if (!snapshot)
    gate = {
      status: "waiting",
      reason: `Official usage unavailable: ${usage.error ?? "not fetched yet"}`,
    };
  else if (ageMs > USAGE_STALE_MS)
    gate = {
      status: "waiting",
      reason: `Official usage is ${Math.round(ageMs / MINUTE_MS)} min old · refresh to retry${usage.error ? ` (${usage.error})` : ""}`,
    };
  else if (
    lastRunEndedAt !== null &&
    Date.parse(snapshot.fetchedAt) < Date.parse(lastRunEndedAt)
  )
    gate = {
      status: "waiting",
      reason: USAGE_PREDATES_RUN_REASON,
    };
  else if (calibration.rates === null)
    gate = {
      status: "waiting",
      reason: `Session cost calibration unavailable: ${calibration.error ?? "no five-hour window has been measured yet"}`,
    };
  else if (!session.ok)
    gate = {
      status: "waiting",
      reason: `Session ${session.percent}%${held(session)}, over the ${session.ceiling}% queue cutoff${reserveLabel(settings, busyHours)}`,
    };
  else if (!weekly.ok)
    gate = {
      status: "waiting",
      reason: `Weekly ${weekly.percent}%${held(weekly)}, over the ${weekly.ceiling}% queue cutoff${weekly.pace === null ? "" : ` (pace ${weekly.pace}% + ${settings.weeklyMarginPercent}% margin)`}`,
    };
  else
    gate = {
      status: "ready",
      reason: `${describe("Session", session)} · ${describe("Weekly", weekly)}`,
    };
  return {
    timeZone,
    settings,
    rates: calibration.rates,
    usage: snapshot,
    usageError: usage.error,
    session,
    weekly,
    fable,
    quiet,
    load,
    gate,
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
const fitCost = (expected: number, ceiling: number) =>
  Math.min(expected, ceiling);

/** The window opening at `hour` that is still open at `at`, searching yesterday through tomorrow. */
function windowStartAt(hour: number, at: number, timeZone: string): number {
  const date = localParts(at, timeZone).date;
  const starts = [-1, 0, 1].map((days) =>
    localStart(shiftDate(date, days), hour, timeZone),
  );
  return starts.find((start) => start + WINDOW_MS > at) ?? starts[2];
}

const insideWindow = (hour: number, at: number, timeZone: string) =>
  windowStartAt(hour, at, timeZone) <= at;

/** Expected session cost of each pending Claude task queued ahead of `taskId` that can run before it, in dispatch order. */
export function costsAhead(
  taskId: string,
  tasks: readonly (GateTask & Pick<PublicTask, "dependsOn">)[],
  runs: readonly RunCost[],
  rates: SessionRates | null,
): number[] {
  // A task that waits on this one, directly or through a chain, can never run before it.
  const after = new Set([taskId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks)
      if (!after.has(task.id) && task.dependsOn.some((id) => after.has(id))) {
        after.add(task.id);
        grew = true;
      }
  }
  const costs: number[] = [];
  for (const task of tasks) {
    if (task.id === taskId) break;
    if (task.status !== "pending" || after.has(task.id)) continue;
    const cost = expectedSessionCost(task, runs, rates);
    if (cost !== null) costs.push(cost);
  }
  return costs;
}

/** When the pace-based weekly ceiling rises past what the bucket uses and holds, or the window reset when it never does. */
function weeklyClearsAt(
  gate: BucketGate,
  resetsAt: string | null,
  marginPercent: number,
): number | null {
  if (resetsAt === null) return null;
  const reset = Date.parse(resetsAt);
  if (gate.percent === null) return reset;
  const needed = gate.percent + gate.reserved;
  if (needed > WEEKLY_HARD_CEILING_PERCENT) return reset;
  const neededPace = needed - marginPercent;
  return Math.min(reset, reset - WEEK_MS + (neededPace / FULL) * WEEK_MS);
}

const HOUR_MS = 60 * MINUTE_MS;
/** An idle or unknown session stays as it is until something starts, so one day covers every hour. */
const IDLE_HORIZON_MS = (HOURS_PER_DAY + 1) * HOUR_MS;

type Opens = (at: number) => boolean;
const always: Opens = () => true;
const inQuietHours =
  (quiet: QuietHours, timeZone: string): Opens =>
  (at) =>
    quiet.startHours?.includes(localParts(at, timeZone).hour) ?? false;

/** The schedule rules of the task itself: earliest start aside, its preferred window or the quiet-hours-only rule. */
function scheduleOpens(
  task: Pick<GateTask, "preferredWindowStart">,
  planning: PlanningSnapshot,
): Opens {
  const window = task.preferredWindowStart;
  if (window !== null)
    return (at) => insideWindow(window, at, planning.timeZone);
  if (quietHoursOnly(planning.settings))
    return inQuietHours(planning.quiet, planning.timeZone);
  return always;
}

/** The session cutoff the live gate applies at `at`. */
function cutoffAt(planning: PlanningSnapshot, now: number) {
  const { session, settings, quiet, timeZone } = planning;
  return (at: number) =>
    // At `now` the gate reads the snapshot's own ceiling; matching it keeps "ready now" in agreement.
    at === now
      ? session.ceiling
      : FULL -
        (quietHoursOnly(settings) || inQuietHours(quiet, timeZone)(at)
          ? settings.sessionReservePercent
          : settings.busyHoursReservePercent);
}

/** The first instant from `from` (itself, then each later hour boundary) before `until` where `opens` holds. */
function firstInstant(
  from: number,
  until: number,
  opens: Opens,
  timeZone: string,
) {
  for (let at = from; at < until; at = nextLocalHour(at, timeZone))
    if (opens(at)) return at;
  return null;
}

/**
 * The session as the estimate walks it: points used, the instant the next task
 * may start from, and when the open window resets. `end` is null while that is
 * unknown; an idle session has no open window and opens one at the next start.
 */
interface SessionState {
  from: number;
  used: number;
  end: number | null;
  idle: boolean;
}

/** The session once a task costing `cost` starts at the first instant it fits; null when it never does. */
function startInSession(
  state: SessionState,
  cost: number,
  opens: Opens,
  cutoff: (at: number) => number,
  timeZone: string,
): SessionState | null {
  let { from, used, end, idle } = state;
  const fits = (at: number) =>
    opens(at) && used + fitCost(cost, cutoff(at)) <= cutoff(at);
  const startAt = (at: number): SessionState => ({
    from: at,
    used: used + fitCost(cost, cutoff(at)),
    end: idle ? at + WINDOW_MS : end,
    idle: false,
  });
  if (end !== null) {
    const at = firstInstant(from, end, fits, timeZone);
    if (at !== null) return startAt(at);
    // Tasks running now are assumed finished by the reset, so the next window starts empty.
    from = Math.max(from, end);
    used = 0;
    end = null;
    idle = true;
  }
  const at = firstInstant(from, from + IDLE_HORIZON_MS, fits, timeZone);
  return at === null ? null : startAt(at);
}

/** Earliest instant every gate — schedule, quiet hours and usage — admits this task; null when unknowable. */
function startsAt(
  task: Pick<
    GateTask,
    "id" | "model" | "preferredWindowStart" | "earliestStart" | "tokens"
  >,
  planning: PlanningSnapshot,
  now: number,
  runs: readonly RunCost[],
  ahead: readonly number[],
): number | null {
  const opens = scheduleOpens(task, planning);
  const notBefore = Math.max(
    now,
    task.earliestStart === null ? 0 : Date.parse(task.earliestStart),
  );
  const { usage, session, weekly, fable, settings, rates, quiet, timeZone } =
    planning;
  if (usage === null)
    return firstInstant(
      notBefore,
      notBefore + IDLE_HORIZON_MS,
      opens,
      planning.timeZone,
    );
  const expected = expectedSessionCost(task, runs, rates);
  if (expected === null || session.percent === null) return null;
  const weeklyAt = weekly.ok
    ? now
    : weeklyClearsAt(
        weekly,
        usage.weekly.resetsAt,
        settings.weeklyMarginPercent,
      );
  if (weeklyAt === null) return null;
  const fableAt =
    fable && FABLE_MODEL.test(task.model) && !fable.ok
      ? weeklyClearsAt(
          fable,
          usage.fable?.resetsAt ?? null,
          settings.weeklyMarginPercent,
        )
      : now;
  if (fableAt === null) return null;
  const reset =
    usage.session.resetsAt === null ? null : Date.parse(usage.session.resetsAt);
  const expired = reset !== null && reset <= now;
  let state: SessionState = {
    from: Math.max(now, weeklyAt),
    used: session.percent + session.reserved,
    end: expired ? null : reset,
    idle: expired,
  };
  const cutoff = cutoffAt(planning, now);
  const aheadOpens = quietHoursOnly(settings)
    ? inQuietHours(quiet, timeZone)
    : always;
  for (const cost of ahead) {
    // A task ahead that can never start takes nothing from this one.
    state = startInSession(state, cost, aheadOpens, cutoff, timeZone) ?? state;
  }
  const started = startInSession(
    { ...state, from: Math.max(state.from, notBefore, fableAt) },
    expected,
    opens,
    cutoff,
    timeZone,
  );
  return started === null ? null : started.from;
}

/** Earliest instant the live gate would admit this task, as an ISO timestamp; null when unknowable. */
export function eligibleAt(
  task: Pick<
    GateTask,
    "id" | "model" | "preferredWindowStart" | "earliestStart" | "tokens"
  >,
  planning: PlanningSnapshot,
  now: Date,
  runs: readonly RunCost[],
  ahead: readonly number[] = [],
): string | null {
  const at = startsAt(task, planning, now.getTime(), runs, ahead);
  return at === null ? null : new Date(at).toISOString();
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
      reason: `Starts after ${localTimestamp(task.earliestStart, planning.timeZone)}`,
      eligibleAt: eligible,
    };
  if (
    task.preferredWindowStart !== null &&
    !insideWindow(task.preferredWindowStart, now.getTime(), planning.timeZone)
  )
    return {
      status: "waiting",
      reason: `Outside window ${hourLabel(task.preferredWindowStart)} → ${hourLabel(
        (task.preferredWindowStart + WINDOW_HOURS) % HOURS_PER_DAY,
      )}`,
      eligibleAt: eligible,
    };
  const { gate, quiet, settings } = planning;
  if (
    gate.status === "ready" &&
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
    gate.status === "ready" &&
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
  if (gate.status === "ready" && session.percent !== null) {
    const expected = expectedSessionCost(task, runs, planning.rates);
    if (
      expected !== null &&
      session.percent + session.reserved + fitCost(expected, session.ceiling) >
        session.ceiling
    )
      return {
        status: "waiting",
        reason: `Session ${session.percent}%${held(session)} + ${expected}% expected, over the ${session.ceiling}% queue cutoff${reserveLabel(settings, inBusyHours(settings, quiet))}`,
        eligibleAt: eligible,
      };
  }
  return { ...gate, eligibleAt: eligible };
}

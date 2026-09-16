export const TIME_ZONE = "America/New_York";
export const BLOCK_MINUTES = 300;
export const RANGE_DAYS = [7, 14, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];
/**
 * Where a Claude response came from. "dispatched" is proven by the session id
 * this dashboard assigned to a queued run; "local" is an interactive Claude Code
 * session on this machine; "unknown" is a headless or pre-provenance record.
 */
export const ACTIVITY_SOURCES = ["local", "dispatched", "unknown"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];
export const ACTIVITY_SOURCE_LABELS: Record<ActivitySource, string> = {
  local: "Local Claude Code",
  dispatched: "Dispatched tasks",
  unknown: "Unattributed",
};
/** Quota consumption the official API reports but no local transcript explains (claude.ai, laptop). */
export const EXTERNAL_SOURCE_LABEL = "Other";
export interface ActivityEvent {
  timestamp: string;
  project: string;
  model: string;
  source: ActivitySource;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
/** One assistant record plus the server-only provenance keys used to deduplicate and attribute it. */
export interface ParsedEvent {
  event: ActivityEvent;
  messageId: string | null;
  sessionId: string | null;
}
export interface ParseResult {
  events: ParsedEvent[];
  warnings: number;
  lines: number;
}
export interface ParseHealth {
  files: number;
  lines: number;
  warnings: number;
  historyEntries: number;
}
export interface HistoryData {
  events: ActivityEvent[];
  health: ParseHealth;
}
export interface ActivityCount {
  activeMinutes: number;
  responses: number;
}
export interface DailyActivity extends ActivityCount {
  date: string;
  /** Active minutes, each minute owned by one source; every source key is present. */
  sources: Record<ActivitySource, number>;
  /** Active minutes, each minute owned by one model; only models with minutes appear. */
  models: Record<string, number>;
}
export interface HeatCell extends ActivityCount {
  day: number;
  hour: number;
}
export interface Mix {
  name: string;
  responses: number;
}
export interface SourceActivity extends ActivityCount {
  source: ActivitySource;
  outputTokens: number;
}
export interface Analytics {
  claudeBudgets: ClaudeBudgets;
  currentBlock: CurrentBlock | null;
  opportunities: Opportunity[];
  days: RangeDays;
  timeZone: string;
  generatedAt: string;
  daily: DailyActivity[];
  heatmap: HeatCell[];
  totals: ActivityCount &
    Pick<
      ActivityEvent,
      "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"
    >;
  models: Mix[];
  projects: Mix[];
  /** Always one entry per ActivitySource, in ACTIVITY_SOURCES order, for the selected range. */
  sources: SourceActivity[];
  health: ParseHealth;
}

export const CLAUDE_BUCKETS = ["session", "weekly", "fable"] as const;
export type ClaudeBucket = (typeof CLAUDE_BUCKETS)[number];
export const CLAUDE_BUCKET_LABELS: Record<ClaudeBucket, string> = {
  session: "Session (5h)",
  weekly: "Weekly",
  fable: "Fable weekly",
};
export const WEEK_MINUTES = 7 * 24 * 60;
export const BUCKET_MINUTES: Record<ClaudeBucket, number> = {
  session: BLOCK_MINUTES,
  weekly: WEEK_MINUTES,
  fable: WEEK_MINUTES,
};
export const FABLE_MODEL = /fable/i;

export const MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
/** Output tokens a five-hour window consumed, split by the family that produced them. */
export type OutputTokens = Record<ModelFamily, number>;
/** Session percent one million output tokens of a family costs on the current plan. */
export type SessionRates = Record<ModelFamily, number>;
/** The family behind a model alias (`opus`) or identifier (`claude-fable-5-1`); null for Codex and unknown models. */
export function modelFamily(model: string): ModelFamily | null {
  const name = model.toLowerCase();
  return MODEL_FAMILIES.find((family) => name.includes(family)) ?? null;
}

export interface OfficialUsage {
  percent: number;
  resetsAt: string | null;
}
/** Anthropic's own rate-limit utilization for the signed-in Claude account. */
export interface UsageSnapshot {
  fetchedAt: string;
  plan: string | null;
  session: OfficialUsage;
  weekly: OfficialUsage;
  fable: OfficialUsage | null;
}
const PLAN_LABELS: Record<string, string> = {
  pro: "Claude Pro",
  max: "Claude Max",
};
export function planLabel(plan: string | null): string {
  if (plan === null) return "Claude";
  return (
    PLAN_LABELS[plan] ??
    `Claude ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`
  );
}
export interface UsageState {
  snapshot: UsageSnapshot | null;
  error: string | null;
}
export interface UsageSample {
  at: string;
  session: number;
  sessionResetsAt: string | null;
  weekly: number;
  weeklyResetsAt: string | null;
  fable: number | null;
}
export const MINUTE_MS = 60_000;
/**
 * Anthropic's usage endpoint returns `resets_at` with sub-second jitter between
 * polls of the same window, so samples are grouped by reset rounded to a minute.
 */
export function resetMinute(resetsAt: string): number {
  return Math.round(Date.parse(resetsAt) / MINUTE_MS);
}
export interface SessionWindow {
  start: string;
  end: string;
  /** Null when no official sample covered the window and it was inferred from local activity. */
  peakPercent: number | null;
  activeMinutes: number;
  samples: number;
}
export interface UsageReport extends UsageState {
  samples: UsageSample[];
  windows: SessionWindow[];
}

export type BudgetBasis = "official-reset" | "inferred" | "rolling" | "none";
export interface ClaudeBudgetWindow extends ActivityCount {
  windowStart: string | null;
  windowEnd: string | null;
  basis: BudgetBasis;
}
export interface ClaudeBudgets {
  session: ClaudeBudgetWindow & { utilization: number };
  weekly: ClaudeBudgetWindow;
  fable: ClaudeBudgetWindow;
}

export interface Opportunity {
  startHour: number;
  endHour: number;
  averageActiveMinutes: number;
  averageResponses: number;
  utilization: number;
  samples: number;
  estimated: true;
}

export interface CurrentBlock extends ActivityCount {
  start: string;
  end: string;
  elapsedMinutes: number;
  utilization: number;
  remainingMinutes: number;
  estimated: true;
}
export type Provider = "claude" | "codex";
export const PROVIDER_LABELS = {
  claude: "Claude",
  codex: "Codex",
} as const;
export const PROVIDER_MODELS: Record<
  Provider,
  readonly { value: string; label: string }[]
> = {
  claude: [
    { value: "fable", label: "Fable 5.1" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
  codex: [
    { value: "gpt-6-astra", label: "GPT-6 Astra" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  ],
};
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
/** Generous turn cap: dispatched runs regularly use 130+ turns and a looping run is cheaper than a truncated one. */
export const DEFAULT_MAX_TURNS = 500;
export const AUTO_OUTPUT_TOKENS = "auto";
export type OutputTokensInput = number | typeof AUTO_OUTPUT_TOKENS;
export const MIN_OUTPUT_TOKENS = 1_000;
export const MAX_OUTPUT_TOKENS = 2_000_000;
export interface TaskInput {
  title: string;
  prompt: string;
  workdir: string;
  provider: Provider;
  model?: string;
  priority: number;
  earliestStart: string | null;
  preferredWindowStart: number | null;
  maxTurns: number;
  /** A number, or "auto" to have the server estimate it from the prompt before the task is stored. */
  outputTokens: OutputTokensInput;
}
export interface Task extends Omit<TaskInput, "outputTokens"> {
  id: string;
  model: string;
  /** Output tokens the whole run is expected to produce, every model and subagent included. */
  outputTokens: number;
  status: TaskStatus;
  createdAt: string;
  /** When the task last left pending or running; null while queued or for tasks finished before this was tracked. */
  finishedAt: string | null;
}
export interface TaskGate {
  status: "ready" | "waiting" | "running" | "finished";
  reason: string;
  /** Earliest instant every gate — schedule, quiet hours and usage — opens; null when unknowable. */
  eligibleAt: string | null;
  /** Title of the running task holding a resource this task needs. */
  blockedBy?: string;
}
export type PublicTask = Task & {
  gate?: TaskGate;
  review: "needed" | null;
  /** `outputTokens` priced at the current session rates; null for Codex tasks and before calibration. */
  sessionCostPercent: number | null;
};
export interface WorkdirSuggestions {
  /** Absolute directories under the home root, most recently opened in Claude Code or queued first. */
  recent: string[];
  /** Absolute directories whose path starts with the typed prefix. */
  matches: string[];
}
export interface QueueSnapshot {
  planning?: PlanningSnapshot;
  sessionKeeper?: SessionKeeperState;
  tasks: PublicTask[];
  autoDispatch: boolean;
}
/** What the session keeper last did; session ids never reach the browser. */
export interface SessionKeeperState {
  lastStartedAt: string | null;
  error: string | null;
}
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}
export interface RunChanges {
  branch: string;
  commits: number;
  files: ChangedFile[];
}
export const DEPLOY_STATUSES = [
  "requested",
  "deploying",
  "succeeded",
  "failed",
] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];
export interface RunDeploy {
  status: DeployStatus;
  updatedAt: string;
}
export interface PendingReview {
  pending: number;
}
export interface Run {
  id: string;
  taskId: string;
  title: string;
  /** The prompt the run was dispatched with; null for runs recorded before prompts were stored. */
  prompt: string | null;
  /** What the task was estimated to produce when it started; null for runs recorded before estimates were tracked. */
  estimatedOutputTokens: number | null;
  provider: Provider;
  model: string;
  status: Exclude<TaskStatus, "pending">;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  exitCode: number | null;
  error: string | null;
  /** Output tokens the run's session produced; null for Codex runs and runs whose transcript held none. */
  outputTokens: OutputTokens | null;
  /** `outputTokens` priced at the current session rates; null when unmeasured or before calibration. */
  sessionCostPercent: number | null;
  /** The run's final assistant message; null for runs that ended without one. */
  summary: string | null;
  /** What the run left in its work directory; null when the work directory is not a git repository. */
  changes: RunChanges | null;
  /** Host redeploy of the run's Compose project; null when none was requested. */
  deploy: RunDeploy | null;
  reviewedAt: string | null;
  preview: string[];
}
const REVIEWED_ON_MERGE = ["main", "master"];
/** Whether a finished run left work a person still has to look at. */
export function needsReview(run: Run): boolean {
  if (run.changes === null || run.reviewedAt !== null) return false;
  const { files, commits, branch } = run.changes;
  return (
    (files.length > 0 && commits === 0) ||
    (commits > 0 && !REVIEWED_ON_MERGE.includes(branch))
  );
}

export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const HOURS_PER_HALF_DAY = 12;
const clockHour = (hour: number) =>
  hour % HOURS_PER_HALF_DAY || HOURS_PER_HALF_DAY;
export const hourLabel = (hour: number) =>
  `${clockHour(hour)} ${hour < HOURS_PER_HALF_DAY ? "AM" : "PM"}`;
export const localTimestamp = (time: string | number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(time));
export const shortHourLabel = (hour: number) =>
  `${clockHour(hour)}${hour < HOURS_PER_HALF_DAY ? "a" : "p"}`;

export interface DispatchSettings {
  /** Tell every dispatched task to commit its own work and redeploy the service instead of leaving it for review. */
  autoApply: boolean;
  /** Start a new five-hour session with a short Claude ping as soon as the previous window has ended. */
  keepSessionActive: boolean;
  sessionReservePercent: number;
  busyHoursReservePercent: number;
  weeklyMarginPercent: number;
  quietStartHours: number;
  maxConcurrentRuns: number;
  /** Weekly (and Fable weekly) points one Claude run is expected to consume. */
  runWeeklyCostPercent: number;
}
export const DEFAULT_DISPATCH_SETTINGS: DispatchSettings = {
  autoApply: false,
  keepSessionActive: false,
  sessionReservePercent: 25,
  busyHoursReservePercent: 100,
  weeklyMarginPercent: 10,
  quietStartHours: 8,
  maxConcurrentRuns: 2,
  runWeeklyCostPercent: 3,
};
export const MAX_SESSION_RESERVE_PERCENT = 90;
export const MAX_BUSY_HOURS_RESERVE_PERCENT = 100;
export const MAX_WEEKLY_MARGIN_PERCENT = 50;
export const MAX_QUIET_START_HOURS = 24;
export const MAX_CONCURRENT_RUNS = 4;
export const MAX_RUN_COST_PERCENT = 100;
/** A full busy-hours reserve leaves the queue no session budget outside quiet hours. */
export const quietHoursOnly = (settings: DispatchSettings) =>
  settings.busyHoursReservePercent >= MAX_BUSY_HOURS_RESERVE_PERCENT;
/** Local start hours whose five-hour window has historically been quiet enough for auto-dispatch. */
export interface QuietHours {
  startHours: number[] | null;
  error: string | null;
  nowHour: number;
  active: boolean;
  nextStartHour: number | null;
}
export const WEEKLY_HARD_CEILING_PERCENT = 95;
export interface BucketGate {
  percent: number | null;
  ceiling: number;
  pace: number | null;
  /** Points held for runs in progress; the bucket passes when percent + reserved ≤ ceiling. */
  reserved: number;
  ok: boolean;
}
/** What the runner is doing right now, as the planner needs to see it. */
export interface DispatchLoad {
  /** End time of the most recently finished run, so usage fetched before it is not trusted. */
  lastRunEndedAt: string | null;
  running: number;
  claudeRuns: number;
  reserved: Record<ClaudeBucket, number>;
}
export const EMPTY_LOAD: DispatchLoad = {
  lastRunEndedAt: null,
  running: 0,
  claudeRuns: 0,
  reserved: { session: 0, weekly: 0, fable: 0 },
};
export interface DispatchGate {
  status: "ready" | "waiting";
  reason: string;
}
export interface PlanningSnapshot {
  settings: DispatchSettings;
  /** Session percent per million output tokens, fitted on this machine; null until a window can be fitted. */
  rates: SessionRates | null;
  usage: UsageSnapshot | null;
  usageError: string | null;
  session: BucketGate;
  weekly: BucketGate;
  fable: BucketGate | null;
  quiet: QuietHours;
  load: DispatchLoad;
  providers: Record<Provider, DispatchGate>;
}

export const PLAN_SCORE_DAYS = 28;
export const PLAN_SCORE_COVERAGE_DAYS = 7;
/** Share of a Eastern day's session capacity that official samples show as used; null before sampling began. */
export interface CoverageDay {
  date: string;
  coverage: number | null;
  /** Active minutes, each minute owned by one source; every source key is present. */
  sources: Record<ActivitySource, number>;
  /** Active minutes, each minute owned by one model; only models with minutes appear. */
  models: Record<string, number>;
}
/** One official weekly window: final percent for finished weeks, on-pace score for the open one. */
export interface WeekScore {
  start: string;
  end: string;
  percent: number;
  score: number;
  complete: boolean;
}
export interface PlanScore {
  score: number | null;
  sessionCoverage: number | null;
  weeklyScore: number | null;
  days: CoverageDay[];
  weeks: WeekScore[];
  generatedAt: string;
}

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
export const TOKEN_KINDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
export type TokenUsage = Record<TokenKind, number>;
export interface ActivityEvent extends TokenUsage {
  timestamp: string;
  project: string;
  model: string;
  source: ActivitySource;
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
/** Active minutes owned by one model or project inside a heatmap cell. */
export interface HeatShare {
  name: string;
  activeMinutes: number;
}
export const HEATMAP_TOP_SHARES = 3;
export interface HeatCell extends ActivityCount {
  day: number;
  hour: number;
  /** Active minutes ÷ the number of times this weekday occurs in the selected range. */
  averageActiveMinutes: number;
  /** Active minutes, each minute owned by one source; every source key is present. */
  sources: Record<ActivitySource, number>;
  /** Up to HEATMAP_TOP_SHARES models by active minutes, largest first. */
  models: HeatShare[];
  /** Up to HEATMAP_TOP_SHARES projects by active minutes, largest first. */
  projects: HeatShare[];
  /** Weighted tokens of every response whose model family is known. */
  tokens: number;
}
export interface Mix {
  name: string;
  responses: number;
}
export interface SourceActivity extends ActivityCount {
  source: ActivitySource;
  tokens: number;
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
  totals: ActivityCount & TokenUsage;
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
/**
 * List price per million tokens of each kind (Fable at the Fable 5.1 cache-read
 * rate); the ratios weight a family's input against its output.
 */
export const FAMILY_PRICING: Record<ModelFamily, TokenUsage> = {
  fable: {
    inputTokens: 10,
    outputTokens: 50,
    cacheCreationTokens: 12.5,
    cacheReadTokens: 0.25,
  },
  opus: {
    inputTokens: 5,
    outputTokens: 25,
    cacheCreationTokens: 6.25,
    cacheReadTokens: 0.5,
  },
  sonnet: {
    inputTokens: 2,
    outputTokens: 10,
    cacheCreationTokens: 2.5,
    cacheReadTokens: 0.2,
  },
  haiku: {
    inputTokens: 1,
    outputTokens: 5,
    cacheCreationTokens: 1.25,
    cacheReadTokens: 0.1,
  },
};
/**
 * Everything a response consumed, in output tokens: input, cache writes and
 * cache reads count at their list-price ratio to the family's output price.
 */
export function weightedTokens(usage: TokenUsage, family: ModelFamily): number {
  const price = FAMILY_PRICING[family];
  return (
    TOKEN_KINDS.reduce((sum, kind) => sum + usage[kind] * price[kind], 0) /
    price.outputTokens
  );
}
/** Weighted tokens a run or a five-hour window consumed, split by the family that produced them. */
export type WeightedTokens = Record<ModelFamily, number>;
export const emptyWeightedTokens = (): WeightedTokens => ({
  fable: 0,
  opus: 0,
  sonnet: 0,
  haiku: 0,
});
const THOUSAND = 1_000;
const MILLION = 1_000_000;
export const formatTokens = (tokens: number) =>
  tokens >= MILLION
    ? `${(Math.round(tokens / (MILLION / 10)) / 10).toFixed(1)}M`
    : `${Math.round(tokens / THOUSAND)}k`;
/** Session percent one million weighted tokens of a family costs on the current plan. */
export type SessionRates = Record<ModelFamily, number>;
/** The family behind a model alias (`opus`) or identifier (`claude-fable-5-1`); null for unknown models. */
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
export const CLAUDE_MODELS: readonly { value: string; label: string }[] = [
  { value: "fable", label: "Fable 5.1" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet 5.5" },
  { value: "haiku", label: "Haiku" },
];
export const DEFAULT_MODEL = "sonnet";
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
/** Generous turn cap: dispatched runs regularly use 130+ turns and a looping run is cheaper than a truncated one. */
export const DEFAULT_MAX_TURNS = 500;
export const AUTO_TOKENS = "auto";
export type TokensInput = number | typeof AUTO_TOKENS;
export const MAX_DEPENDENCIES = 20;
export const MIN_TOKENS = 5_000;
export const MAX_TOKENS = 10_000_000;
export interface TaskInput {
  title: string;
  prompt: string;
  workdir: string;
  model?: string;
  priority: number;
  earliestStart: string | null;
  preferredWindowStart: number | null;
  maxTurns: number;
  /** Weighted tokens: a number, or "auto" to have the server estimate it from the prompt before the task is stored. Required in full, absent in lite. */
  tokens?: TokensInput;
  /** Ids of tasks that must complete before this one is dispatched. */
  dependsOn: string[];
}
export interface Task extends Omit<TaskInput, "tokens"> {
  id: string;
  model: string;
  /** Weighted tokens the whole run is expected to consume, every model and subagent included; null for a lite task. */
  tokens: number | null;
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
  /** Title of the task this one waits on: a running task holding a shared resource, or a dependency that has not completed. */
  blockedBy?: string;
}
export type PublicTask = Task & {
  gate?: TaskGate;
  review: "needed" | null;
  /** `tokens` priced at the current session rates; null before calibration. */
  sessionCostPercent: number | null;
};
export interface WorkdirSuggestions {
  /** Absolute directories under the work-directory root, most recently opened in Claude Code or queued first. */
  recent: string[];
  /** Absolute directories whose path starts with the typed prefix. */
  matches: string[];
}
export const EDITIONS = ["full", "lite"] as const;
export type Edition = (typeof EDITIONS)[number];
export interface Environment {
  /** IANA zone the server resolved from TZ. */
  timeZone: string;
  /** Absolute directory under which task work directories are accepted. */
  workdirRoot: string;
  /** Which edition the server runs. */
  edition: Edition;
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
export const RESTART_STATUSES = [
  "requested",
  "restarting",
  "succeeded",
  "failed",
] as const;
export type RestartStatus = (typeof RESTART_STATUSES)[number];
export interface RunRestart {
  status: RestartStatus;
  updatedAt: string;
  /** Output of a failed restart, null otherwise. */
  output: string | null;
}
export type RestartMethod =
  | { kind: "none" }
  | { kind: "compose" }
  | { kind: "command"; argv: string[] };
export const RESTART_ARGV_MAX = 64;
export const RESTART_ARG_MAX = 4096;
export interface PendingReview {
  pending: number;
}
export interface Run {
  id: string;
  taskId: string;
  title: string;
  /** The prompt the run was dispatched with; null for runs recorded before prompts were stored. */
  prompt: string | null;
  /** Weighted tokens the task was estimated to consume when it started; null for runs recorded before weighted estimates were tracked. */
  estimatedTokens: number | null;
  model: string;
  status: Exclude<TaskStatus, "pending">;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  exitCode: number | null;
  error: string | null;
  /** Weighted tokens the run's session consumed; null for runs whose transcript held none. */
  tokens: WeightedTokens | null;
  /** `tokens` priced at the current session rates; null when unmeasured or before calibration. */
  sessionCostPercent: number | null;
  /** The run's final assistant message; null for runs that ended without one. */
  summary: string | null;
  /** What the run left in its work directory; null when the work directory is not a git repository. */
  changes: RunChanges | null;
  /** Restart of the run's work directory; null when none was requested. */
  restart: RunRestart | null;
  reviewedAt: string | null;
  preview: string[];
}
export const COMMIT_SUBJECT_MAX = 72;
/** Room to edit past the suggested length; still one line. */
export const COMMIT_MESSAGE_MAX = 120;
export const CONVENTIONAL_SUBJECT =
  /^(feat|fix|refactor|perf|test|docs|chore|style|build|ci)(\([^()\r\n]+\))?!?: \S[^\r\n]*$/;
/** Whether a finished run left edits in its work directory that nothing has committed yet. */
export const needsCommit = <T extends Pick<Run, "reviewedAt" | "changes">>(
  run: T,
): run is T & { changes: RunChanges } =>
  run.reviewedAt === null &&
  run.changes !== null &&
  run.changes.files.length > 0 &&
  run.changes.commits === 0;
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
export const shortHourLabel = (hour: number) =>
  `${clockHour(hour)}${hour < HOURS_PER_HALF_DAY ? "a" : "p"}`;

export interface DispatchSettings {
  /** Tell every dispatched task to edit its work directory in place instead of leaving it for review; the dashboard restarts the directory afterwards. */
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
  /** Session points each running lite task holds; the full edition ignores it. */
  runSessionHoldPercent: number;
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
  runSessionHoldPercent: 10,
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
/** Official usage older than this blocks dispatch. */
export const USAGE_STALE_MS = 15 * MINUTE_MS;
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
export interface PlanningBase {
  /** The IANA zone every hour in this snapshot is read in. */
  timeZone: string;
  settings: DispatchSettings;
  usage: UsageSnapshot | null;
  usageError: string | null;
  session: BucketGate;
  weekly: BucketGate;
  load: DispatchLoad;
  gate: DispatchGate;
}
export interface FullPlanning extends PlanningBase {
  edition: "full";
  /** Session percent per million output tokens, fitted on this machine; null until a window can be fitted. */
  rates: SessionRates | null;
  fable: BucketGate | null;
  quiet: QuietHours;
}
export interface LitePlanning extends PlanningBase {
  edition: "lite";
}
export type PlanningSnapshot = FullPlanning | LitePlanning;

export const PLAN_SCORE_DAYS = 28;
export const PLAN_SCORE_COVERAGE_DAYS = 7;
/** Share of a local day's session capacity that official samples show as used; null before sampling began. */
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

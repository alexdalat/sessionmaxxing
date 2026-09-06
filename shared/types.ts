export const TIME_ZONE = "America/New_York";
export const BLOCK_MINUTES = 300;
export const RANGE_DAYS = [7, 14, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];
export interface ActivityEvent {
  timestamp: string;
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
export interface ParseResult {
  events: ActivityEvent[];
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
}
export interface HeatCell extends ActivityCount {
  day: number;
  hour: number;
}
export interface Mix {
  name: string;
  responses: number;
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

export interface OfficialUsage {
  percent: number;
  resetsAt: string | null;
}
/** Anthropic's own rate-limit utilization for the signed-in Claude Max account. */
export interface UsageSnapshot {
  fetchedAt: string;
  session: OfficialUsage;
  weekly: OfficialUsage;
  fable: OfficialUsage | null;
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
export interface SessionWindow {
  start: string;
  end: string;
  peakPercent: number;
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
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
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
}
export interface Task extends TaskInput {
  id: string;
  model: string;
  status: TaskStatus;
  createdAt: string;
}
export interface TaskGate {
  status: "ready" | "waiting" | "running" | "finished";
  reason: string;
}
export type PublicTask = Omit<Task, "prompt" | "workdir"> & {
  gate?: TaskGate;
};
export interface QueueSnapshot {
  planning?: PlanningSnapshot;
  tasks: PublicTask[];
  autoDispatch: boolean;
}
export interface Run {
  id: string;
  taskId: string;
  title: string;
  provider: Provider;
  model: string;
  status: Exclude<TaskStatus, "pending">;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  exitCode: number | null;
  error: string | null;
  preview: string[];
}

export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export interface DispatchSettings {
  sessionReservePercent: number;
  weeklyMarginPercent: number;
}
export const DEFAULT_DISPATCH_SETTINGS: DispatchSettings = {
  sessionReservePercent: 25,
  weeklyMarginPercent: 10,
};
export const MAX_SESSION_RESERVE_PERCENT = 90;
export const MAX_WEEKLY_MARGIN_PERCENT = 50;
export const WEEKLY_HARD_CEILING_PERCENT = 95;
export interface BucketGate {
  percent: number | null;
  ceiling: number;
  pace: number | null;
  ok: boolean;
}
export interface DispatchGate {
  status: "ready" | "waiting";
  reason: string;
}
export interface PlanningSnapshot {
  settings: DispatchSettings;
  usage: UsageSnapshot | null;
  usageError: string | null;
  session: BucketGate;
  weekly: BucketGate;
  fable: BucketGate | null;
  providers: Record<Provider, DispatchGate>;
}

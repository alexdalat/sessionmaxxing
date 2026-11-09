import { formatRemaining } from "@/app/lib/duration";
import {
  CLAUDE_BUCKET_LABELS,
  type ClaudeBucket,
  type PlanningBase,
  planLabel,
  USAGE_STALE_MS,
  type UsageSnapshot,
} from "@/shared/types";

const STRIP_BUCKETS = ["session", "weekly"] as const satisfies ClaudeBucket[];
export const NOT_STARTED = "not started";
const NO_PERCENT = "—";
const NOT_FETCHED = "Not fetched yet";

export type StripBucket = (typeof STRIP_BUCKETS)[number];
export type PaceTone = "under" | "over";

export interface StripRow {
  bucket: StripBucket;
  label: string;
  percentText: string;
  fill: number;
  ceiling: number;
  cutoffText: string;
  heldText: string | null;
  pace: number | null;
  paceText: string | null;
  paceTone: PaceTone | null;
  resetText: string;
  ariaLabel: string;
}

type StripPlanning = Pick<PlanningBase, "session" | "weekly" | "usage">;

const percentOf = (value: number) => `${Math.round(value)}%`;

function paceOf(
  bucket: StripBucket,
  percent: number | null,
  pace: number | null,
) {
  if (bucket !== "weekly" || pace === null) {
    return { pace: null, paceText: null, paceTone: null };
  }
  if (percent === null) return { pace, paceText: null, paceTone: null };
  const under = percent <= pace;
  return {
    pace,
    paceText: under
      ? `${percentOf(pace - percent)} under pace`
      : `${percentOf(percent - pace)} over pace`,
    paceTone: under ? ("under" as const) : ("over" as const),
  };
}

function resetTextOf(resetsAt: string | null | undefined, now: number) {
  const reset = resetsAt ? Date.parse(resetsAt) : null;
  return reset !== null && reset > now
    ? formatRemaining(reset - now)
    : NOT_STARTED;
}

export function usageStripRows(
  planning: StripPlanning,
  now: number,
): StripRow[] {
  return STRIP_BUCKETS.map((bucket) => {
    const gate = planning[bucket];
    const label = CLAUDE_BUCKET_LABELS[bucket];
    const percentText =
      gate.percent === null ? NO_PERCENT : percentOf(gate.percent);
    const resetText = resetTextOf(planning.usage?.[bucket].resetsAt, now);
    const cutoffText = `Cutoff ${percentOf(gate.ceiling)}`;
    const heldText =
      gate.reserved > 0 ? `Held ${percentOf(gate.reserved)}` : null;
    const pace = paceOf(bucket, gate.percent, gate.pace);
    const ariaLabel = [
      `${label}: ${gate.percent === null ? "unknown" : `${percentText} used`}`,
      resetText === NOT_STARTED ? "" : `resets in ${resetText}`,
      `queue cutoff ${percentOf(gate.ceiling)}`,
      gate.reserved > 0 ? `held ${percentOf(gate.reserved)}` : "",
      pace.pace === null ? "" : `pace ${percentOf(pace.pace)}`,
    ]
      .filter(Boolean)
      .join(". ");
    return {
      bucket,
      label,
      percentText,
      fill: Math.min(100, gate.percent ?? 0),
      ceiling: gate.ceiling,
      cutoffText,
      heldText,
      ...pace,
      resetText,
      ariaLabel,
    };
  });
}

export function fetchedLabel(usage: UsageSnapshot | null, now: number) {
  if (usage === null) return { text: NOT_FETCHED, stale: false };
  const age = now - Date.parse(usage.fetchedAt);
  return {
    text: `Fetched ${formatRemaining(age)} ago`,
    stale: age > USAGE_STALE_MS,
  };
}

export function stripHeading(usage: UsageSnapshot | null) {
  return `${planLabel(usage?.plan ?? null)} usage`;
}

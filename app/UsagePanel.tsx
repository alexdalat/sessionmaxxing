import {
  BLOCK_MINUTES,
  CLAUDE_BUCKET_LABELS,
  CLAUDE_BUCKETS,
  type ClaudeBucket,
  type ClaudeBudgets,
  type OfficialUsage,
  type PlanningSnapshot,
  planLabel,
  type UsageState,
} from "../shared/types";
import { formatRemaining } from "./duration";

const percent = (value: number) => `${Math.round(value)}%`;
function localLine(budgets: ClaudeBudgets, bucket: ClaudeBucket) {
  const window = budgets[bucket];
  if (window.basis === "none") return "No local activity yet";
  const scope = {
    "official-reset": "this window",
    inferred: "the inferred five-hour block",
    rolling: "the last 7 days",
  }[window.basis];
  return `${window.activeMinutes} active min · ${window.responses} responses in ${scope}${
    bucket === "session"
      ? ` (${percent((window.activeMinutes / BLOCK_MINUTES) * 100)} of ${BLOCK_MINUTES} min)`
      : ""
  }`;
}
function Row({
  bucket,
  usage,
  gate,
  budgets,
  now,
}: {
  bucket: ClaudeBucket;
  usage: OfficialUsage | null | undefined;
  gate: PlanningSnapshot["session"] | null | undefined;
  budgets: ClaudeBudgets;
  now: number;
}) {
  const label = CLAUDE_BUCKET_LABELS[bucket];
  const reset = usage?.resetsAt ? Date.parse(usage.resetsAt) : null;
  const remaining =
    reset !== null && reset > now ? formatRemaining(reset - now) : null;
  const value =
    usage === undefined ? null : usage === null ? null : usage.percent;
  const missing =
    usage === null ? "Not reported" : usage === undefined ? "—" : null;
  const description = [
    `${label}: ${value === null ? (missing ?? "unknown") : `${percent(value)} used`}`,
    remaining ? `resets in ${remaining}` : "",
    gate?.pace !== null && gate?.pace !== undefined
      ? `pace ${percent(gate.pace)}`
      : "",
    gate ? `auto-dispatch limit ${percent(gate.ceiling)}` : "",
    localLine(budgets, bucket),
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <div className="usage-row" data-bucket={bucket}>
      <div className="usage-head">
        <span className="usage-label">{label}</span>
        <span className="usage-percent metric">
          {value === null ? missing : percent(value)}
        </span>
        <span className="usage-reset">
          {remaining ? (
            <>
              <span aria-hidden="true">◷ </span>
              {remaining}
            </>
          ) : usage?.resetsAt === null && value !== null ? (
            "idle"
          ) : (
            ""
          )}
        </span>
      </div>
      <div className="usage-track" role="img" aria-label={description}>
        <div
          className="usage-fill"
          data-fill={bucket}
          style={{ width: `${Math.min(100, value ?? 0)}%` }}
        />
        {gate?.pace !== null && gate?.pace !== undefined && (
          <div
            className="usage-mark usage-pace"
            title={`Pace ${percent(gate.pace)}`}
            style={{ left: `${gate.pace}%` }}
          />
        )}
        {gate && (
          <div
            className="usage-mark usage-ceiling"
            title={`Auto-dispatch limit ${percent(gate.ceiling)}`}
            style={{ left: `${gate.ceiling}%` }}
          />
        )}
      </div>
      <p className="usage-local">
        {gate && gate.pace !== null && value !== null && (
          <span className={value <= gate.pace ? "usage-under" : "usage-over"}>
            {value <= gate.pace
              ? `${percent(gate.pace - value)} under pace`
              : `${percent(value - gate.pace)} over pace`}
            {" · "}
          </span>
        )}
        {localLine(budgets, bucket)}
      </p>
    </div>
  );
}

export function UsagePanel({
  usage,
  planning,
  budgets,
  now,
  busy,
  onRefresh,
}: {
  usage: UsageState | undefined;
  planning: PlanningSnapshot | undefined;
  budgets: ClaudeBudgets;
  now: number;
  busy: boolean;
  onRefresh: () => void;
}) {
  const snapshot = usage?.snapshot ?? null;
  const gates = planning
    ? {
        session: planning.session,
        weekly: planning.weekly,
        fable: planning.fable,
      }
    : undefined;
  const heading = `${planLabel(snapshot?.plan ?? null)} usage`;
  const buckets = CLAUDE_BUCKETS.filter(
    (bucket) => bucket !== "fable" || (snapshot?.fable ?? null) !== null,
  );
  return (
    <section className="panel usage-panel" aria-label={heading}>
      <div className="section-heading">
        <h2>{heading}</h2>
        <span className="usage-meta">
          <span className="muted">
            {snapshot
              ? `Fetched ${formatRemaining(now - Date.parse(snapshot.fetchedAt))} ago`
              : "Not fetched yet"}
          </span>
          <button type="button" onClick={onRefresh} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </span>
      </div>
      {usage?.error && (
        <p className="error" role="alert">
          {usage.error}
        </p>
      )}
      {buckets.map((bucket) => (
        <Row
          key={bucket}
          bucket={bucket}
          usage={snapshot ? snapshot[bucket] : undefined}
          gate={gates?.[bucket]}
          budgets={budgets}
          now={now}
        />
      ))}
      <ul className="usage-legend" aria-hidden="true">
        <li className="key-pace">Pace</li>
        <li className="key-ceiling">Auto-dispatch limit</li>
      </ul>
    </section>
  );
}

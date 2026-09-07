import type { Run } from "../shared/types";
import { ListSkeleton } from "./Skeleton";
import { localTimestamp } from "./time";
import { usePolling } from "./usePolling";
export function Runs() {
  const { data, error, reload } = usePolling<{
    runs: Run[];
    runnerError?: string;
  }>("/api/runs");
  return (
    <>
      {(error || data?.runnerError) && (
        <div role="alert" className="error">
          {error || data?.runnerError}{" "}
          <button type="button" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {!data && !error && <ListSkeleton />}
      <p className="muted">
        Updates every two seconds. Previews contain safe event summaries;
        generated text and arbitrary output are redacted.
      </p>
      {data && data.runs.length === 0 && (
        <div className="empty">
          <h2>No runs yet</h2>
          <p>Run a queued task to see its status and redacted output here.</p>
        </div>
      )}
      {data?.runs.map((run) => (
        <article className="panel" key={run.id}>
          <div className="section-heading">
            <h2>{run.title}</h2>
            <span className={`status ${run.status}`}>{run.status}</span>
          </div>
          <dl className="facts">
            <div>
              <dt>Provider / model</dt>
              <dd>
                {run.provider} · {run.model}
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{localTimestamp(run.startedAt)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{(run.durationMs / 1000).toFixed(1)} s</dd>
            </div>
            <div>
              <dt>Exit code</dt>
              <dd>{run.exitCode ?? "—"}</dd>
            </div>
          </dl>
          {run.endedAt && (
            <p className="muted">Ended {localTimestamp(run.endedAt)}</p>
          )}
          {run.error && <p className="warning">{run.error}</p>}
          <details>
            <summary>Redacted output preview</summary>
            <pre
              role="log"
              aria-live="off"
              className="run-preview"
              aria-label={`Output for ${run.title}`}
            >
              {run.preview.length
                ? run.preview.join("\n")
                : "Waiting for provider output…"}
            </pre>
          </details>
        </article>
      ))}
    </>
  );
}

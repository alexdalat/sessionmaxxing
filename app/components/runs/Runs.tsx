import { ListSkeleton } from "@/app/components/Skeletons";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { usePolling } from "@/app/hooks/usePolling";
import { localTimestamp, PROVIDER_LABELS, type Run } from "@/shared/types";

const statusVariants: Record<Run["status"], "success" | "warning" | "info"> = {
  running: "success",
  completed: "success",
  failed: "warning",
  cancelled: "warning",
};
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
          <Button type="button" variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      )}
      {!data && !error && <ListSkeleton />}
      {data && data.runs.length === 0 && (
        <div className="empty">
          <h2>No runs yet</h2>
          <p>Queued tasks appear here once they start.</p>
        </div>
      )}
      {data?.runs.map((run) => (
        <article className="panel" key={run.id}>
          <div className="section-heading">
            <h2>{run.title}</h2>
            <Badge variant={statusVariants[run.status]} className="capitalize">
              {run.status}
            </Badge>
          </div>
          <dl className="facts">
            <div>
              <dt>Model</dt>
              <dd>
                {PROVIDER_LABELS[run.provider]} · {run.model}
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
            <summary>Output</summary>
            <pre
              role="log"
              aria-live="off"
              className="run-preview"
              aria-label={`Output for ${run.title}`}
            >
              {run.preview.length ? run.preview.join("\n") : "No output yet"}
            </pre>
          </details>
        </article>
      ))}
    </>
  );
}

"use client";
import { Check, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { PageHeader } from "@/app/components/PageHeader";
import { ListSkeleton } from "@/app/components/Skeletons";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { useNotice } from "@/app/hooks/useNotice";
import { usePolling } from "@/app/hooks/usePolling";
import { api, QUEUE_CHANGED } from "@/app/lib/api";
import { formatDuration } from "@/app/lib/duration";
import { ACTION_LABELS } from "@/app/lib/labels";
import { localTimestamp } from "@/shared/local-time";
import {
  COMMIT_MESSAGE_MAX,
  formatTokens,
  MODEL_FAMILIES,
  needsCommit,
  needsReview,
  type RestartStatus,
  type Run,
  type WeightedTokens,
} from "@/shared/types";

const tokenTotal = (tokens: WeightedTokens | null) =>
  tokens === null
    ? "—"
    : formatTokens(
        MODEL_FAMILIES.reduce((sum, family) => sum + tokens[family], 0),
      );

const PAGE_SIZE = 20;
const SCROLL_MARGIN = "600px";

type BadgeVariant = "success" | "warning" | "info" | "destructive";
const statusBadges: Record<
  Run["status"],
  { label: string; variant: BadgeVariant }
> = {
  running: { label: "Running", variant: "success" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "warning" },
};
const restartBadges: Record<
  RestartStatus,
  { label: string; variant: BadgeVariant }
> = {
  requested: { label: "Restart queued", variant: "info" },
  restarting: { label: "Restarting", variant: "info" },
  succeeded: { label: "Restarted", variant: "success" },
  failed: { label: "Restart failed", variant: "destructive" },
};
function CommitForm({
  run,
  busy,
  onCommit,
  onError,
}: {
  run: Run;
  busy: boolean;
  onCommit: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [suggesting, setSuggesting] = useState(true);
  useEffect(() => {
    let current = true;
    api<{ message: string }>(`/api/runs/${run.id}/commit-message`, {
      method: "POST",
    })
      .then((suggestion) => {
        if (current) setMessage((typed) => typed || suggestion.message);
      })
      .catch((error: Error) => {
        if (current) onError(error.message);
      })
      .finally(() => {
        if (current) setSuggesting(false);
      });
    return () => {
      current = false;
    };
  }, [run.id, onError]);
  return (
    <form
      className="commit-form"
      onSubmit={(event) => {
        event.preventDefault();
        onCommit(message);
      }}
    >
      <Input
        aria-label="Commit message"
        value={message}
        maxLength={COMMIT_MESSAGE_MAX}
        placeholder={suggesting ? "Suggesting…" : "Commit message"}
        onChange={(event) => setMessage(event.target.value)}
      />
      <Button type="submit" disabled={busy || message.trim() === ""}>
        {ACTION_LABELS.commitChanges}
      </Button>
    </form>
  );
}
export function Runs() {
  const { timeZone, edition } = useEnvironment();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { data, error, reload } = usePolling<{
    runs: Run[];
    total: number;
    pending: number;
    runnerError?: string;
  }>(`/api/runs?limit=${limit}`);
  const sentinel = useRef<HTMLDivElement>(null);
  const loaded = data?.runs.length ?? 0;
  const hasMore = data !== undefined && loaded < data.total;
  useEffect(() => {
    const node = sentinel.current;
    if (!hasMore || !node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting)
          setLimit((current) =>
            loaded >= current ? current + PAGE_SIZE : current,
          );
      },
      { rootMargin: SCROLL_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loaded]);
  const [busyRun, setBusyRun] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useNotice();
  const [retried, setRetried] = useState<ReadonlySet<string>>(new Set());
  async function act(run: Run, path: string, message: string, body?: unknown) {
    setBusyRun(run.id);
    setActionError("");
    try {
      await api(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      reload();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : message);
      return false;
    } finally {
      setBusyRun("");
    }
  }
  const markReviewed = (run: Run) =>
    act(run, `/api/runs/${run.id}/reviewed`, "Could not mark the run.");
  const commit = (run: Run, message: string) =>
    act(run, `/api/runs/${run.id}/commit`, "Could not commit the run.", {
      message,
    });
  async function retry(run: Run) {
    setNotice("");
    const queued = await act(
      run,
      `/api/tasks/${run.taskId}/retry`,
      "Could not queue the task again.",
    );
    if (!queued) return;
    setRetried((ids) => new Set(ids).add(run.id));
    setNotice(`Queued ${run.title} again`);
    window.dispatchEvent(new Event(QUEUE_CHANGED));
  }
  const pending = data?.pending ?? 0;
  const errors = [error, actionError, data?.runnerError].filter(Boolean);
  return (
    <div className="page">
      <PageHeader
        title="Runs"
        status={
          data && (
            <>
              <span>
                {data.total} {data.total === 1 ? "run" : "runs"}
              </span>
              <span role="status" data-tone="attention">
                {pending > 0 && `${pending} need review`}
              </span>
            </>
          )
        }
      />
      {errors.length > 0 && (
        <div className="alert" role="alert">
          <div className="grid gap-2">
            {errors.map((message) => (
              <p className="error" key={message}>
                {message}
              </p>
            ))}
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={reload}>
            {ACTION_LABELS.reloadRuns}
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="toast">
          {notice}
        </p>
      )}
      {!data && !error && <ListSkeleton />}
      {data && data.runs.length === 0 && <p className="empty">No runs yet</p>}
      {data && data.runs.length > 0 && (
        <ol className="list">
          {data.runs.map((run) => {
            const status = statusBadges[run.status];
            const restart = run.restart && restartBadges[run.restart.status];
            const retryable =
              (run.status === "failed" || run.status === "cancelled") &&
              !retried.has(run.id);
            return (
              <li className="run" key={run.id}>
                <div className="run-head">
                  <div className="min-w-0">
                    <h2 className="run-title">{run.title}</h2>
                    <div className="run-states">
                      <Badge variant={status.variant}>{status.label}</Badge>
                      {needsReview(run) && (
                        <Badge variant="warning">Needs review</Badge>
                      )}
                      {restart && (
                        <Badge variant={restart.variant}>{restart.label}</Badge>
                      )}
                    </div>
                  </div>
                  {(needsReview(run) || retryable) && (
                    <div className="page-actions">
                      {needsReview(run) && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={busyRun === run.id}
                          onClick={() => void markReviewed(run)}
                        >
                          <Check />
                          {ACTION_LABELS.markRunReviewed}
                        </Button>
                      )}
                      {retryable && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={busyRun === run.id}
                          aria-label={`${ACTION_LABELS.retryRun}: ${run.title}`}
                          onClick={() => void retry(run)}
                        >
                          <RotateCcw />
                          {ACTION_LABELS.retryRun}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {needsCommit(run) && (
                  <CommitForm
                    run={run}
                    busy={busyRun === run.id}
                    onCommit={(message) => void commit(run, message)}
                    onError={setActionError}
                  />
                )}
                <dl className="facts">
                  <div>
                    <dt>Model</dt>
                    <dd>{run.model}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{localTimestamp(run.startedAt, timeZone)}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(run.durationMs)}</dd>
                  </div>
                  <div>
                    <dt>Exit code</dt>
                    <dd>{run.exitCode ?? "—"}</dd>
                  </div>
                  {edition === "full" && (
                    <>
                      <div>
                        <dt>Session cost</dt>
                        <dd>
                          {run.sessionCostPercent === null
                            ? "—"
                            : `${run.sessionCostPercent}%`}
                        </dd>
                      </div>
                      <div>
                        <dt>Tokens</dt>
                        <dd>{tokenTotal(run.tokens)}</dd>
                      </div>
                    </>
                  )}
                </dl>
                {run.error && <p className="error">{run.error}</p>}
                {run.summary && <pre className="summary">{run.summary}</pre>}
                {(run.prompt ||
                  run.restart?.output ||
                  (run.changes && run.changes.files.length > 0)) && (
                  <div className="disclosures">
                    {run.prompt && (
                      <details>
                        <summary>{ACTION_LABELS.showPrompt}</summary>
                        <pre className="code-block">{run.prompt}</pre>
                      </details>
                    )}
                    {run.restart?.output && (
                      <details>
                        <summary>{ACTION_LABELS.showRestartOutput}</summary>
                        <pre className="code-block">{run.restart.output}</pre>
                      </details>
                    )}
                    {run.changes && run.changes.files.length > 0 && (
                      <details>
                        <summary>{ACTION_LABELS.showChangedFiles}</summary>
                        {run.changes.commits > 0 && (
                          <p className="muted mt-2">
                            {run.changes.commits}{" "}
                            {run.changes.commits === 1 ? "commit" : "commits"}{" "}
                            on {run.changes.branch}
                          </p>
                        )}
                        <ul className="run-changes">
                          {run.changes.files.map((file) => (
                            <li key={file.path}>
                              <span>{file.path}</span>
                              {(file.added > 0 || file.removed > 0) && (
                                <span>
                                  <span className="added">+{file.added}</span>{" "}
                                  <span className="removed">
                                    −{file.removed}
                                  </span>
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {hasMore && <div className="scroll-sentinel" ref={sentinel} />}
    </div>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { ListSkeleton } from "@/app/components/Skeletons";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { useNotice } from "@/app/hooks/useNotice";
import { usePolling } from "@/app/hooks/usePolling";
import { api, QUEUE_CHANGED } from "@/app/lib/api";
import { localTimestamp } from "@/shared/local-time";
import {
  COMMIT_MESSAGE_MAX,
  type DeployStatus,
  formatTokens,
  MODEL_FAMILIES,
  needsCommit,
  needsReview,
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

type BadgeVariant = "success" | "warning" | "info";
const statusVariants: Record<Run["status"], BadgeVariant> = {
  running: "success",
  completed: "success",
  failed: "warning",
  cancelled: "warning",
};
const deployBadges: Record<
  DeployStatus,
  { label: string; variant: BadgeVariant }
> = {
  requested: { label: "Deploy queued", variant: "info" },
  deploying: { label: "Deploying", variant: "info" },
  succeeded: { label: "Deployed", variant: "success" },
  failed: { label: "Deploy failed", variant: "warning" },
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
      <Button type="submit" size="sm" disabled={busy || message.trim() === ""}>
        Commit
      </Button>
    </form>
  );
}
export function Runs() {
  const { timeZone } = useEnvironment();
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
    setNotice(`Queued ${run.title} again.`);
    window.dispatchEvent(new Event(QUEUE_CHANGED));
  }
  const pending = data?.pending ?? 0;
  return (
    <>
      {pending > 0 && (
        <p className="review-summary" role="status">
          <Badge variant="warning">{pending}</Badge> need review
        </p>
      )}
      {(error || actionError || data?.runnerError) && (
        <div role="alert" className="error">
          {error || actionError || data?.runnerError}{" "}
          <Button type="button" variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="toast">
          {notice}
        </p>
      )}
      {!data && !error && <ListSkeleton />}
      {data && data.runs.length === 0 && (
        <div className="empty">
          <h2>No runs yet</h2>
          <p>Queued tasks appear here once they start.</p>
        </div>
      )}
      {data?.runs.map((run) => (
        <article
          className={`panel${needsReview(run) ? " panel-review" : ""}`}
          key={run.id}
        >
          <div className="section-heading">
            <h2>{run.title}</h2>
            <span className="run-heading-tools">
              {needsReview(run) && (
                <>
                  <Badge variant="warning">Needs review</Badge>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyRun === run.id}
                    onClick={() => void markReviewed(run)}
                  >
                    Mark reviewed
                  </Button>
                </>
              )}
              {(run.status === "failed" || run.status === "cancelled") &&
                !retried.has(run.id) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyRun === run.id}
                    aria-label={`Retry ${run.title}`}
                    onClick={() => void retry(run)}
                  >
                    Retry
                  </Button>
                )}
              <Badge
                variant={statusVariants[run.status]}
                className="capitalize"
              >
                {run.status}
              </Badge>
              {run.deploy && (
                <Badge variant={deployBadges[run.deploy.status].variant}>
                  {deployBadges[run.deploy.status].label}
                </Badge>
              )}
            </span>
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
              <dd>{(run.durationMs / 1000).toFixed(1)} s</dd>
            </div>
            <div>
              <dt>Exit code</dt>
              <dd>{run.exitCode ?? "—"}</dd>
            </div>
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
          </dl>
          {run.endedAt && (
            <p className="muted">
              Ended {localTimestamp(run.endedAt, timeZone)}
            </p>
          )}
          {run.error && <p className="warning">{run.error}</p>}
          {run.summary && <pre className="summary">{run.summary}</pre>}
          {run.prompt && (
            <details>
              <summary>Prompt</summary>
              <pre className="task-prompt">{run.prompt}</pre>
            </details>
          )}
          {run.changes && run.changes.files.length > 0 && (
            <details>
              <summary>Changed files</summary>
              {run.changes.commits > 0 && (
                <p className="muted">
                  {run.changes.branch} · {run.changes.commits} commits
                </p>
              )}
              <ul className="run-changes">
                {run.changes.files.map((file) => (
                  <li key={file.path}>
                    <span>{file.path}</span>
                    {(file.added > 0 || file.removed > 0) && (
                      <span>
                        <span className="added">+{file.added}</span>{" "}
                        <span className="removed">−{file.removed}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </article>
      ))}
      {hasMore && <div ref={sentinel} />}
    </>
  );
}

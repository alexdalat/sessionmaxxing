import { useState } from "react";
import type { PublicTask, QueueSnapshot, TaskInput } from "../shared/types";
import { api } from "./api";
import { TaskForm } from "./TaskForm";
import { hour, localTimestamp } from "./time";
import { usePolling } from "./usePolling";

const gateLabels = {
  ready: "Ready",
  waiting: "Waiting for usage headroom",
  running: "Running",
  finished: "Finished",
};
export function TaskQueue({
  initialWindow,
  onOpenDispatch,
}: {
  initialWindow?: number;
  onOpenDispatch?: () => void;
}) {
  const {
    data,
    error: loadError,
    reload,
  } = usePolling<QueueSnapshot & { runnerError?: string }>("/api/queue");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<PublicTask>();
  async function mutate(
    path: string,
    method: string,
    message: string,
    body?: unknown,
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      setNotice(message);
      reload();
      return true;
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not update queue.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(input: TaskInput | Partial<TaskInput>) {
    const saved = await mutate(
      editing ? `/api/tasks/${editing.id}` : "/api/tasks",
      editing ? "PATCH" : "POST",
      editing ? "Task updated." : "Task added.",
      input,
    );
    if (saved) setEditing(undefined);
    return saved;
  }
  const pending = data?.tasks.filter((t) => t.status === "pending") ?? [];
  const running = data?.tasks.some((t) => t.status === "running");
  const visibleTasks =
    data?.tasks.filter(
      (task) =>
        filter === "all" ||
        (filter === "finished"
          ? !["pending", "running"].includes(task.status)
          : task.status === "pending" && task.gate?.status === filter),
    ) ?? [];
  function move(task: PublicTask, offset: number) {
    const ids = pending.map((t) => t.id);
    const index = ids.indexOf(task.id);
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    void mutate("/api/queue/order", "PUT", "Priority order updated.", { ids });
  }
  return (
    <>
      {(error || loadError || data?.runnerError) && (
        <div role="alert" className="error">
          {error || loadError || data?.runnerError}{" "}
          <button type="button" onClick={reload}>
            Refresh queue
          </button>
        </div>
      )}
      {!data && !loadError && <p role="status">Loading task queue…</p>}
      {notice && <p role="status">{notice}</p>}
      <section className="panel">
        <label className="toggle">
          <input
            type="checkbox"
            checked={data?.autoDispatch ?? false}
            disabled={!data || busy}
            onChange={(e) =>
              void mutate(
                "/api/queue/auto",
                "PUT",
                e.target.checked
                  ? "Auto-dispatch enabled."
                  : "Auto-dispatch disabled.",
                { enabled: e.target.checked },
              )
            }
          />
          Auto-dispatch
        </label>
        <p className="muted">
          Runs one Ready task at a time in its preferred window while this
          server is alive. Run now overrides usage headroom and schedule.
        </p>
        {data?.planning && (
          <p className="dispatch-reason">
            {data.planning.providers.claude.reason}
          </p>
        )}
        {onOpenDispatch && (
          <div className="actions">
            <button type="button" onClick={onOpenDispatch}>
              Dispatch settings
            </button>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="section-heading queue-heading">
          <h2>Queued tasks</h2>
          <label>
            Task filter
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All</option>
              <option value="ready">Ready</option>
              <option value="waiting">Waiting for headroom</option>
              <option value="finished">Finished</option>
            </select>
          </label>
          <span className="muted">
            {pending.length} pending · lower priority runs first
          </span>
        </div>
        {visibleTasks.length ? (
          visibleTasks.map((task) => (
            <article className="task-card" key={task.id}>
              <div>
                <h3>{task.title}</h3>
                <p>
                  {task.provider} · {task.model}
                </p>
                <span className={`status ${task.status}`}>{task.status}</span>
                <div className="task-schedule">
                  <span>Priority {task.priority}</span>
                  <span>
                    {task.preferredWindowStart === null
                      ? "Any time"
                      : `${hour(task.preferredWindowStart)} → ${hour((task.preferredWindowStart + 5) % 24)} Eastern`}
                  </span>
                  {task.earliestStart && (
                    <span>After {localTimestamp(task.earliestStart)}</span>
                  )}
                </div>
              </div>
              <div className="task-budget">
                <h3>Dispatch</h3>
                <strong>
                  {task.gate ? gateLabels[task.gate.status] : "Unavailable"}
                </strong>
                {task.gate && <span className="muted">{task.gate.reason}</span>}
              </div>
              <div className="task-actions">
                {task.status === "pending" && (
                  <>
                    <button
                      type="button"
                      disabled={busy || running}
                      aria-label={`Run ${task.title} now`}
                      onClick={() =>
                        void mutate(
                          `/api/tasks/${task.id}/run`,
                          "POST",
                          "Task started.",
                        )
                      }
                    >
                      Run now
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Edit ${task.title}`}
                      onClick={() => {
                        setEditing(task);
                        setNotice("");
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy || pending[0]?.id === task.id}
                      aria-label={`Move ${task.title} up`}
                      onClick={() => move(task, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={busy || pending.at(-1)?.id === task.id}
                      aria-label={`Move ${task.title} down`}
                      onClick={() => move(task, 1)}
                    >
                      ↓
                    </button>
                  </>
                )}
                {task.status === "running" && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Cancel ${task.title}`}
                    onClick={() =>
                      void mutate(
                        `/api/tasks/${task.id}/cancel`,
                        "POST",
                        "Cancellation requested. Waiting for the provider to exit.",
                      )
                    }
                  >
                    Cancel
                  </button>
                )}
                {task.status === "failed" && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Retry ${task.title}`}
                    onClick={() =>
                      void mutate(
                        `/api/tasks/${task.id}/retry`,
                        "POST",
                        "Task returned to pending.",
                      )
                    }
                  >
                    Retry
                  </button>
                )}
                {task.status !== "running" && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Delete ${task.title}`}
                    onClick={() =>
                      void mutate(
                        `/api/tasks/${task.id}`,
                        "DELETE",
                        "Task deleted.",
                      )
                    }
                  >
                    Delete
                  </button>
                )}
              </div>
            </article>
          ))
        ) : (
          <p>
            {data?.tasks.length
              ? "No tasks match this filter."
              : "No tasks yet. Add a task to begin."}
          </p>
        )}
      </section>
      <TaskForm
        key={editing?.id ?? `new-${initialWindow}`}
        task={editing}
        initialWindow={initialWindow}
        onSave={save}
        busy={busy}
        onCancel={editing ? () => setEditing(undefined) : undefined}
      />
    </>
  );
}

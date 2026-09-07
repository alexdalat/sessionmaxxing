"use client";
import { useState } from "react";
import type { PublicTask, QueueSnapshot, TaskInput } from "../shared/types";
import { api } from "./api";
import { DispatchSettingsDialog } from "./DispatchSettingsDialog";
import { displayOrder } from "./queueOrder";
import { TaskListSkeleton } from "./Skeleton";
import { TaskFormDialog } from "./TaskForm";
import { hour, localTimestamp } from "./time";
import { usePolling } from "./usePolling";

const gateLabels = {
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  finished: "Finished",
};
export function TaskQueue() {
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
  const [formOpen, setFormOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  async function mutate(
    path: string,
    method: string,
    message = "",
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
    if (saved) {
      setEditing(undefined);
      setFormOpen(false);
    }
    return saved;
  }
  function openAdd() {
    setEditing(undefined);
    setNotice("");
    setFormOpen(true);
  }
  function closeForm() {
    setFormOpen(false);
    setEditing(undefined);
  }
  const pending = data?.tasks.filter((t) => t.status === "pending") ?? [];
  const running = data?.tasks.some((t) => t.status === "running");
  const ordered = displayOrder(data?.tasks ?? []);
  const nextId = ordered.find(
    (task) => task.status === "pending" && task.gate?.status === "ready",
  )?.id;
  const visibleTasks = ordered.filter(
    (task) =>
      filter === "all" ||
      (filter === "finished"
        ? !["pending", "running"].includes(task.status)
        : task.status === "pending" && task.gate?.status === filter),
  );
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
      {notice && <p role="status">{notice}</p>}
      <section className="panel">
        <div className="section-heading queue-heading">
          <h2>Queued tasks</h2>
          <button
            type="button"
            role="switch"
            aria-checked={data?.autoDispatch ?? false}
            disabled={!data || busy}
            className="queue-switch"
            onClick={() =>
              void mutate("/api/queue/auto", "PUT", "", {
                enabled: !(data?.autoDispatch ?? false),
              })
            }
          >
            {data?.autoDispatch ? "Queue on" : "Queue off"}
          </button>
          <span className="queue-tools">
            <select
              aria-label="Task filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All</option>
              <option value="ready">Ready</option>
              <option value="waiting">Waiting</option>
              <option value="finished">Finished</option>
            </select>
            <button
              type="button"
              disabled={!data?.planning}
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </button>
            <button type="button" className="primary" onClick={openAdd}>
              Add task
            </button>
          </span>
        </div>
        {!data && !loadError ? (
          <TaskListSkeleton />
        ) : visibleTasks.length ? (
          visibleTasks.map((task) => (
            <article className="task-card" key={task.id}>
              <div>
                <div className="task-title">
                  <h3>{task.title}</h3>
                  <span className={`status ${task.status}`}>{task.status}</span>
                  {task.id === nextId && (
                    <span className="gate gate-ready">Next</span>
                  )}
                </div>
                <p>
                  {task.provider} · {task.model}
                </p>
                <p className="muted task-workdir">{task.workdir}</p>
                <details>
                  <summary>Prompt</summary>
                  <pre className="task-prompt">{task.prompt}</pre>
                </details>
                <div className="task-schedule">
                  <span>Priority {task.priority}</span>
                  <span>max {task.maxTurns} turns</span>
                  <span>
                    {task.preferredWindowStart === null
                      ? "Any quiet hour"
                      : `${hour(task.preferredWindowStart)} → ${hour((task.preferredWindowStart + 5) % 24)} Eastern`}
                  </span>
                  {task.earliestStart && (
                    <span>After {localTimestamp(task.earliestStart)}</span>
                  )}
                </div>
              </div>
              <div className="task-budget">
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
                        setFormOpen(true);
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
                {(task.status === "failed" || task.status === "cancelled") && (
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
      <TaskFormDialog
        key={editing?.id ?? "new"}
        open={formOpen}
        task={editing}
        onSave={save}
        busy={busy}
        onClose={closeForm}
      />
      {data?.planning && (
        <DispatchSettingsDialog
          key={String(settingsOpen)}
          open={settingsOpen}
          settings={data.planning.settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={reload}
        />
      )}
    </>
  );
}

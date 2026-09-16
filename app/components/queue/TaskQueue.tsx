"use client";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { DispatchSettingsDialog } from "@/app/components/DispatchSettingsDialog";
import { QueueBadges } from "@/app/components/QueueBadges";
import { TaskListSkeleton } from "@/app/components/Skeletons";
import { Button } from "@/app/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { useClock } from "@/app/hooks/useClock";
import { usePolling } from "@/app/hooks/usePolling";
import { api } from "@/app/lib/api";
import { displayOrder, movedPast, moveTarget } from "@/app/lib/queueOrder";
import type { PublicTask, QueueSnapshot, TaskInput } from "@/shared/types";
import { TaskCard } from "./TaskCard";
import { TaskFormDialog } from "./TaskForm";

const LEAVE_MS = 240;
const NOTICE_MS = 4000;
type Confirmation = { kind: "delete" | "run"; task: PublicTask };
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
  const [confirm, setConfirm] = useState<Confirmation>();
  const now = useClock();
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const tasks = data?.tasks;
    if (!tasks) return;
    setLeaving((ids) => {
      const remaining = new Set(
        [...ids].filter((id) => tasks.some((task) => task.id === id)),
      );
      return remaining.size === ids.size ? ids : remaining;
    });
  }, [data]);
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
  async function remove(task: PublicTask) {
    setLeaving((ids) => new Set(ids).add(task.id));
    await new Promise((resolve) => setTimeout(resolve, LEAVE_MS));
    const deleted = await mutate(
      `/api/tasks/${task.id}`,
      "DELETE",
      "Task deleted.",
    );
    if (!deleted)
      setLeaving((ids) => {
        const kept = new Set(ids);
        kept.delete(task.id);
        return kept;
      });
  }
  function runConfirmed({ kind, task }: Confirmation) {
    setConfirm(undefined);
    if (kind === "delete") void remove(task);
    else void mutate(`/api/tasks/${task.id}/run`, "POST", "Task started.");
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
  const slotsFull =
    data?.planning !== undefined &&
    data.planning.load.running >= data.planning.settings.maxConcurrentRuns;
  const ordered = displayOrder(data?.tasks ?? []);
  const nextId = ordered.find((task) => task.status === "pending")?.id;
  const visibleTasks = ordered.filter(
    (task) =>
      filter === "all" ||
      (task.status === "pending" && task.gate?.status === filter),
  );
  function move(task: PublicTask, offset: -1 | 1) {
    const neighbor = moveTarget(ordered, task, offset);
    if (!neighbor) return;
    const ids = movedPast(
      pending.map((t) => t.id),
      task.id,
      neighbor.id,
      offset,
    );
    void mutate("/api/queue/order", "PUT", "Order updated.", { ids });
  }
  const taskCard = (task: PublicTask) => {
    const isLeaving = leaving.has(task.id);
    return (
      <TaskCard
        key={task.id}
        task={task}
        isNext={task.id === nextId}
        isLeaving={isLeaving}
        now={now}
      >
        <div className="task-actions">
          {task.status === "pending" && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  busy ||
                  slotsFull ||
                  isLeaving ||
                  task.gate?.blockedBy !== undefined
                }
                aria-label={`Run ${task.title} now`}
                onClick={() => setConfirm({ kind: "run", task })}
              >
                Run now
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || isLeaving}
                aria-label={`Edit ${task.title}`}
                onClick={() => {
                  setEditing(task);
                  setNotice("");
                  setFormOpen(true);
                }}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={busy || isLeaving || !moveTarget(ordered, task, -1)}
                aria-label={`Move ${task.title} up`}
                onClick={() => move(task, -1)}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={busy || isLeaving || !moveTarget(ordered, task, 1)}
                aria-label={`Move ${task.title} down`}
                onClick={() => move(task, 1)}
              >
                ↓
              </Button>
            </>
          )}
          {task.status === "running" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || isLeaving}
              aria-label={`Cancel ${task.title}`}
              onClick={() =>
                void mutate(
                  `/api/tasks/${task.id}/cancel`,
                  "POST",
                  "Cancelling task.",
                )
              }
            >
              Cancel
            </Button>
          )}
          {task.status !== "running" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || isLeaving}
              aria-label={`Delete ${task.title}`}
              onClick={() => setConfirm({ kind: "delete", task })}
            >
              Delete
            </Button>
          )}
        </div>
      </TaskCard>
    );
  };
  return (
    <>
      {(error || loadError || data?.runnerError) && (
        <div role="alert" className="error">
          {error || loadError || data?.runnerError}{" "}
          <Button type="button" variant="outline" onClick={reload}>
            Refresh queue
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="toast">
          {notice}
        </p>
      )}
      <section className="panel">
        <div className="section-heading queue-heading">
          <h2>Queued tasks</h2>
          <Button
            type="button"
            role="switch"
            aria-checked={data?.autoDispatch ?? false}
            disabled={!data || busy}
            variant={data?.autoDispatch ? "default" : "outline"}
            className="rounded-full"
            onClick={() =>
              void mutate("/api/queue/auto", "PUT", "", {
                enabled: !(data?.autoDispatch ?? false),
              })
            }
          >
            {data?.autoDispatch ? "Queue on" : "Queue off"}
          </Button>
          <QueueBadges planning={data?.planning} />
          <span className="queue-tools">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger aria-label="Task filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="ready">Ready</SelectItem>
                <SelectItem value="waiting">Waiting</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={!data?.planning}
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </Button>
            <Button type="button" onClick={openAdd}>
              Add task
            </Button>
          </span>
        </div>
        {!data && !loadError ? (
          <TaskListSkeleton />
        ) : visibleTasks.length ? (
          visibleTasks.map(taskCard)
        ) : (
          <div className="empty">
            <h2>
              {ordered.length ? "No tasks match this filter" : "No tasks yet"}
            </h2>
          </div>
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
      <ConfirmDialog
        key={confirm ? `${confirm.kind}-${confirm.task.id}` : "none"}
        open={Boolean(confirm)}
        title={confirm?.kind === "run" ? "Run task now?" : "Delete task?"}
        detail={confirm?.task.title ?? ""}
        confirmLabel={confirm?.kind === "run" ? "Run now" : "Delete"}
        danger={confirm?.kind === "delete"}
        busy={busy}
        onConfirm={() => confirm && runConfirmed(confirm)}
        onClose={() => setConfirm(undefined)}
      />
    </>
  );
}

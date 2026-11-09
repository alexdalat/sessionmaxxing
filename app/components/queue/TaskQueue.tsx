"use client";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { DispatchSettingsDialog } from "@/app/components/DispatchSettingsDialog";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { QueueBadges } from "@/app/components/QueueBadges";
import {
  TaskListSkeleton,
  UsageStripSkeleton,
} from "@/app/components/Skeletons";
import { Button } from "@/app/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { useClock } from "@/app/hooks/useClock";
import { useNotice } from "@/app/hooks/useNotice";
import { usePolling } from "@/app/hooks/usePolling";
import { ACTIVE_QUEUE_PATH, api } from "@/app/lib/api";
import { ACTION_LABELS, FIELD_LABELS } from "@/app/lib/labels";
import { displayOrder, movedPast, moveTarget } from "@/app/lib/queueOrder";
import type { PublicTask, QueueSnapshot, TaskInput } from "@/shared/types";
import { TaskCard } from "./TaskCard";
import { TaskFormDialog } from "./TaskForm";
import { UsageStrip } from "./UsageStrip";

const LEAVE_MS = 240;
type Confirmation = { kind: "delete" | "run"; task: PublicTask };
export function TaskQueue() {
  const {
    data,
    error: loadError,
    reload,
  } = usePolling<QueueSnapshot & { runnerError?: string }>(ACTIVE_QUEUE_PATH);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useNotice();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<PublicTask>();
  const [formOpen, setFormOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation>();
  const now = useClock();
  const { edition } = useEnvironment();
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
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
  const dependencyTitles = (task: PublicTask) =>
    task.dependsOn.flatMap((id) => {
      const dependency = ordered.find((candidate) => candidate.id === id);
      return dependency ? [dependency.title] : [];
    });
  const taskCard = (task: PublicTask) => {
    const isLeaving = leaving.has(task.id);
    return (
      <TaskCard
        key={task.id}
        task={task}
        isNext={task.id === nextId}
        isLeaving={isLeaving}
        now={now}
        dependencies={dependencyTitles(task)}
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
                aria-label={`${ACTION_LABELS.runTask}: ${task.title}`}
                onClick={() => setConfirm({ kind: "run", task })}
              >
                {ACTION_LABELS.runTask}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || isLeaving}
                aria-label={`${ACTION_LABELS.editTask}: ${task.title}`}
                onClick={() => {
                  setEditing(task);
                  setNotice("");
                  setFormOpen(true);
                }}
              >
                {ACTION_LABELS.editTask}
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
              aria-label={`${ACTION_LABELS.cancelTask}: ${task.title}`}
              onClick={() =>
                void mutate(
                  `/api/tasks/${task.id}/cancel`,
                  "POST",
                  "Cancelling task.",
                )
              }
            >
              {ACTION_LABELS.cancelTask}
            </Button>
          )}
          {task.status !== "running" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || isLeaving}
              aria-label={`${ACTION_LABELS.deleteTask}: ${task.title}`}
              onClick={() => setConfirm({ kind: "delete", task })}
            >
              {ACTION_LABELS.deleteTask}
            </Button>
          )}
        </div>
      </TaskCard>
    );
  };
  return (
    <>
      {(error || loadError || data?.runnerError) && (
        <section className="panel span-12" data-tone="paper" role="alert">
          <h2 className="panel-label">Error</h2>
          <p className="error-message">
            {error || loadError || data?.runnerError}
          </p>
          <div className="panel-tools">
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              {ACTION_LABELS.refreshQueue}
            </Button>
          </div>
        </section>
      )}
      {notice && (
        <p role="status" className="toast">
          {notice}
        </p>
      )}
      {edition === "lite" &&
        (data?.planning ? (
          <UsageStrip planning={data.planning} now={now} onRefreshed={reload} />
        ) : (
          !data && !loadError && <UsageStripSkeleton />
        ))}
      <section className="panel span-12" data-tone="paper">
        <h2 className="panel-label">Queued tasks</h2>
        <div className="panel-tools">
          <div className="tool-group">
            <Button
              type="button"
              role="switch"
              aria-checked={data?.autoDispatch ?? false}
              disabled={!data || busy}
              variant={data?.autoDispatch ? "default" : "outline"}
              size="sm"
              onClick={() =>
                void mutate("/api/queue/auto", "PUT", "", {
                  enabled: !(data?.autoDispatch ?? false),
                })
              }
            >
              {ACTION_LABELS.runQueue}
            </Button>
            <QueueBadges planning={data?.planning} />
          </div>
          <div className="tool-group">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger aria-label={FIELD_LABELS.filterTasks}>
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
              size="sm"
              disabled={!data?.planning}
              onClick={() => setSettingsOpen(true)}
            >
              {ACTION_LABELS.editSettings}
            </Button>
            <Button type="button" size="sm" onClick={openAdd}>
              {ACTION_LABELS.addTask}
            </Button>
          </div>
        </div>
        {!data && !loadError ? (
          <TaskListSkeleton />
        ) : visibleTasks.length ? (
          visibleTasks.map(taskCard)
        ) : (
          <h3 className="empty-heading">
            {ordered.length ? "No tasks match this filter" : "No tasks yet"}
          </h3>
        )}
      </section>
      <TaskFormDialog
        key={editing?.id ?? "new"}
        open={formOpen}
        task={editing}
        tasks={ordered}
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
        confirmLabel={
          confirm?.kind === "run"
            ? ACTION_LABELS.runTask
            : ACTION_LABELS.deleteTask
        }
        dismissLabel={
          confirm?.kind === "run"
            ? ACTION_LABELS.keepWaiting
            : ACTION_LABELS.keepTask
        }
        danger={confirm?.kind === "delete"}
        busy={busy}
        onConfirm={() => confirm && runConfirmed(confirm)}
        onClose={() => setConfirm(undefined)}
      />
    </>
  );
}

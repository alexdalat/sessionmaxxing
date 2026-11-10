"use client";
import {
  ArrowDown,
  ArrowUp,
  CircleStop,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { DispatchSettingsDialog } from "@/app/components/DispatchSettingsDialog";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { IconButton } from "@/app/components/IconButton";
import { PageHeader } from "@/app/components/PageHeader";
import { QueueStatus } from "@/app/components/QueueStatus";
import { Segmented } from "@/app/components/Segmented";
import { KpisSkeleton, TaskListSkeleton } from "@/app/components/Skeletons";
import { UsageKpis } from "@/app/components/UsageKpis";
import { Button } from "@/app/components/ui/button";
import { Label } from "@/app/components/ui/label";
import { Switch } from "@/app/components/ui/switch";
import { useClock } from "@/app/hooks/useClock";
import { useNotice } from "@/app/hooks/useNotice";
import { usePolling } from "@/app/hooks/usePolling";
import { ACTIVE_QUEUE_PATH, api } from "@/app/lib/api";
import { ACTION_LABELS, FIELD_LABELS } from "@/app/lib/labels";
import { displayOrder, movedPast, moveTarget } from "@/app/lib/queueOrder";
import {
  fetchedLabel,
  stripHeading,
  usageStripRows,
} from "@/app/lib/usageStrip";
import type { PublicTask, QueueSnapshot, TaskInput } from "@/shared/types";
import { TaskCard } from "./TaskCard";
import { TaskFormDialog } from "./TaskForm";

const LEAVE_MS = 240;
const LITE_BUCKETS = 2;
type Filter = "all" | "ready" | "waiting";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ready", label: "Ready" },
  { value: "waiting", label: "Waiting" },
];
type Confirmation = { kind: "delete" | "run"; task: PublicTask };
export function TaskQueue() {
  const {
    data,
    error: loadError,
    reload,
  } = usePolling<QueueSnapshot & { runnerError?: string }>(ACTIVE_QUEUE_PATH);
  const [filter, setFilter] = useState<Filter>("all");
  const queueSwitchId = useId();
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
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(input: TaskInput | Partial<TaskInput>) {
    const saved = await mutate(
      editing ? `/api/tasks/${editing.id}` : "/api/tasks",
      editing ? "PATCH" : "POST",
      editing ? "Task updated" : "Task added",
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
      "Task deleted",
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
    else void mutate(`/api/tasks/${task.id}/run`, "POST", "Task started");
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
    void mutate("/api/queue/order", "PUT", "Order updated", { ids });
  }
  const dependencyTitles = (task: PublicTask) =>
    task.dependsOn.flatMap((id) => {
      const dependency = ordered.find((candidate) => candidate.id === id);
      return dependency ? [dependency.title] : [];
    });
  const taskCard = (task: PublicTask) => {
    const isLeaving = leaving.has(task.id);
    const named = (label: string) => `${label}: ${task.title}`;
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
              <IconButton
                label={ACTION_LABELS.runTask}
                aria-label={named(ACTION_LABELS.runTask)}
                disabled={
                  busy ||
                  slotsFull ||
                  isLeaving ||
                  task.gate?.blockedBy !== undefined
                }
                onClick={() => setConfirm({ kind: "run", task })}
              >
                <Play />
              </IconButton>
              <IconButton
                label={ACTION_LABELS.editTask}
                aria-label={named(ACTION_LABELS.editTask)}
                disabled={busy || isLeaving}
                onClick={() => {
                  setEditing(task);
                  setNotice("");
                  setFormOpen(true);
                }}
              >
                <Pencil />
              </IconButton>
              <IconButton
                label="Move up"
                aria-label={`Move ${task.title} up`}
                disabled={busy || isLeaving || !moveTarget(ordered, task, -1)}
                onClick={() => move(task, -1)}
              >
                <ArrowUp />
              </IconButton>
              <IconButton
                label="Move down"
                aria-label={`Move ${task.title} down`}
                disabled={busy || isLeaving || !moveTarget(ordered, task, 1)}
                onClick={() => move(task, 1)}
              >
                <ArrowDown />
              </IconButton>
            </>
          )}
          {task.status === "running" ? (
            <IconButton
              label={ACTION_LABELS.cancelTask}
              aria-label={named(ACTION_LABELS.cancelTask)}
              disabled={busy || isLeaving}
              onClick={() =>
                void mutate(
                  `/api/tasks/${task.id}/cancel`,
                  "POST",
                  "Cancelling task",
                )
              }
            >
              <CircleStop />
            </IconButton>
          ) : (
            <IconButton
              label={ACTION_LABELS.deleteTask}
              aria-label={named(ACTION_LABELS.deleteTask)}
              disabled={busy || isLeaving}
              onClick={() => setConfirm({ kind: "delete", task })}
            >
              <Trash2 />
            </IconButton>
          )}
        </div>
      </TaskCard>
    );
  };
  const planning = data?.planning;
  const fetched = fetchedLabel(planning?.usage ?? null, now);
  const errors = [
    error,
    loadError,
    data?.runnerError,
    edition === "lite" ? planning?.usageError : null,
  ].filter(Boolean);
  return (
    <div className="page">
      <PageHeader
        title="Task queue"
        status={
          <>
            <QueueStatus planning={planning} queueOn={data?.autoDispatch} />
            {planning?.gate.status === "waiting" && (
              <span>{planning.gate.reason}</span>
            )}
            {planning?.settings.autoApply && <span>Auto-apply on</span>}
            {planning?.settings.keepSessionActive && (
              <span>Session keeper on</span>
            )}
          </>
        }
        actions={
          <>
            <div className="switch-field">
              <Switch
                id={queueSwitchId}
                checked={data?.autoDispatch ?? false}
                disabled={!data || busy}
                onCheckedChange={(enabled) =>
                  void mutate("/api/queue/auto", "PUT", "", { enabled })
                }
              />
              <Label htmlFor={queueSwitchId}>{ACTION_LABELS.runQueue}</Label>
            </div>
            <IconButton
              label={ACTION_LABELS.editSettings}
              size="icon"
              disabled={!planning}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 />
            </IconButton>
            <Button type="button" onClick={openAdd}>
              <Plus />
              {ACTION_LABELS.addTask}
            </Button>
          </>
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
            {ACTION_LABELS.refreshQueue}
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="toast">
          {notice}
        </p>
      )}
      {edition === "lite" &&
        (planning ? (
          <UsageKpis
            rows={usageStripRows(planning, now)}
            head={
              <>
                <h2 className="section-title">
                  {stripHeading(planning.usage)}
                </h2>
                <div className="section-tools">
                  <span
                    className="muted"
                    data-tone={fetched.stale ? "attention" : undefined}
                  >
                    {fetched.text}
                  </span>
                  <IconButton
                    label={ACTION_LABELS.refreshUsage}
                    disabled={busy}
                    onClick={() =>
                      void mutate("/api/usage/refresh", "POST", "")
                    }
                  >
                    <RotateCw />
                  </IconButton>
                </div>
              </>
            }
          />
        ) : (
          !data && !loadError && <KpisSkeleton count={LITE_BUCKETS} />
        ))}
      <section className="section" aria-label="Tasks">
        <div className="section-head">
          <Segmented
            label={FIELD_LABELS.filterTasks}
            value={filter}
            options={FILTERS}
            onChange={setFilter}
          />
        </div>
        {!data && !loadError ? (
          <TaskListSkeleton />
        ) : visibleTasks.length ? (
          <ol className="list">{visibleTasks.map(taskCard)}</ol>
        ) : (
          <p className="empty">
            {ordered.length ? "No tasks match this filter" : "No tasks yet"}
          </p>
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
      {planning && (
        <DispatchSettingsDialog
          key={String(settingsOpen)}
          open={settingsOpen}
          settings={planning.settings}
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
    </div>
  );
}

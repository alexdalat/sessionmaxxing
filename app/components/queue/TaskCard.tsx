"use client";
import type { ReactNode } from "react";
import { Badge } from "@/app/components/ui/badge";
import {
  hourLabel,
  localTimestamp,
  PROVIDER_LABELS,
  type PublicTask,
  type TaskStatus,
} from "@/shared/types";

const gateLabels = {
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  finished: "Finished",
};
const statusVariants: Record<TaskStatus, "success" | "warning" | "info"> = {
  pending: "info",
  running: "success",
  completed: "success",
  failed: "warning",
  cancelled: "warning",
};

export function TaskCard({
  task,
  isNext,
  isLeaving,
  children,
}: {
  task: PublicTask;
  isNext: boolean;
  isLeaving: boolean;
  children: ReactNode;
}) {
  return (
    <article className={`task-card${isLeaving ? " leaving" : ""}`}>
      <div>
        <div className="task-title">
          <h3>{task.title}</h3>
          <Badge variant={statusVariants[task.status]} className="capitalize">
            {task.status}
          </Badge>
          {isNext && <Badge variant="success">Next</Badge>}
        </div>
        <p>
          {PROVIDER_LABELS[task.provider]} · {task.model}
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
              : `${hourLabel(task.preferredWindowStart)} → ${hourLabel((task.preferredWindowStart + 5) % 24)} Eastern`}
          </span>
          {task.earliestStart && (
            <span>After {localTimestamp(task.earliestStart)}</span>
          )}
        </div>
      </div>
      <div className="task-budget">
        {task.gate && task.gate.status !== "finished" && (
          <>
            <strong>{gateLabels[task.gate.status]}</strong>
            <span className="muted">{task.gate.reason}</span>
          </>
        )}
      </div>
      {children}
    </article>
  );
}

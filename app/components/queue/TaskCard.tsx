"use client";
import type { ReactNode } from "react";
import { Badge } from "@/app/components/ui/badge";
import {
  type PreviewState,
  previewState,
  STATE_LABELS,
  waitNote,
} from "@/app/lib/queuePreview";
import {
  hourLabel,
  localTimestamp,
  PROVIDER_LABELS,
  type PublicTask,
} from "@/shared/types";

const THOUSAND = 1000;
const tokenLabel = (tokens: number) => `${Math.round(tokens / THOUSAND)}k`;
const stateVariants: Record<PreviewState, "success" | "info" | "warning"> = {
  running: "success",
  ready: "info",
  waiting: "warning",
};

export function TaskCard({
  task,
  isNext,
  isLeaving,
  now,
  children,
}: {
  task: PublicTask;
  isNext: boolean;
  isLeaving: boolean;
  now: number;
  children: ReactNode;
}) {
  const state = previewState(task);
  const wait = waitNote(task, now);
  return (
    <article className={`task-card${isLeaving ? " leaving" : ""}`}>
      <div>
        <div className="task-title">
          <h3>{task.title}</h3>
          <Badge variant={stateVariants[state]}>{STATE_LABELS[state]}</Badge>
          {wait && <Badge variant="outline">{wait}</Badge>}
          {isNext && <Badge variant="success">Next</Badge>}
          {task.review === "needed" && (
            <Badge variant="warning">Needs review</Badge>
          )}
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
            {tokenLabel(task.outputTokens)} tokens
            {task.sessionCostPercent === null
              ? ""
              : ` · ${task.sessionCostPercent}%`}
          </span>
          <span>
            {task.preferredWindowStart === null
              ? "Any hour"
              : `${hourLabel(task.preferredWindowStart)} → ${hourLabel((task.preferredWindowStart + 5) % 24)} Eastern`}
          </span>
          {task.earliestStart && (
            <span>After {localTimestamp(task.earliestStart)}</span>
          )}
        </div>
      </div>
      <div className="task-budget">
        {task.gate && (
          <>
            <strong>{STATE_LABELS[state]}</strong>
            <span className="muted">{task.gate.reason}</span>
          </>
        )}
      </div>
      {children}
    </article>
  );
}

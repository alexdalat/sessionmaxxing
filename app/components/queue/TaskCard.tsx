"use client";
import type { ReactNode } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { Badge } from "@/app/components/ui/badge";
import {
  type PreviewState,
  previewState,
  STATE_LABELS,
  waitNote,
} from "@/app/lib/queuePreview";
import { windowRangeLabel } from "@/app/lib/schedule";
import { localTimestamp } from "@/shared/local-time";
import { formatTokens, type PublicTask } from "@/shared/types";

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
  dependencies,
  children,
}: {
  task: PublicTask;
  isNext: boolean;
  isLeaving: boolean;
  now: number;
  /** Titles of the tasks this one waits for. */
  dependencies: string[];
  children: ReactNode;
}) {
  const { timeZone, edition } = useEnvironment();
  const state = previewState(task);
  const wait = waitNote(task, now);
  return (
    <article className={`task-card${isLeaving ? " leaving" : ""}`}>
      <div>
        <div className="task-title">
          <h3>{task.title}</h3>
          {isNext && <Badge variant="success">Next</Badge>}
          {task.review === "needed" && (
            <Badge variant="warning">Needs review</Badge>
          )}
        </div>
        <p>{task.model}</p>
        <p className="muted task-workdir">{task.workdir}</p>
        <details>
          <summary>Prompt</summary>
          <pre className="task-prompt">{task.prompt}</pre>
        </details>
        <div className="task-schedule">
          <span>Priority {task.priority}</span>
          <span>max {task.maxTurns} turns</span>
          {edition === "full" && task.tokens !== null && (
            <span>
              {formatTokens(task.tokens)} tokens
              {task.sessionCostPercent === null
                ? ""
                : ` · ${task.sessionCostPercent}%`}
            </span>
          )}
          <span>
            {task.preferredWindowStart === null
              ? "Any hour"
              : windowRangeLabel(task.preferredWindowStart, timeZone, now)}
          </span>
          {task.earliestStart && (
            <span>After {localTimestamp(task.earliestStart, timeZone)}</span>
          )}
          {dependencies.length > 0 && (
            <span>Depends on {dependencies.join(", ")}</span>
          )}
        </div>
      </div>
      <div className="task-budget">
        {task.gate && (
          <>
            <div className="task-state">
              <Badge variant={stateVariants[state]}>
                {STATE_LABELS[state]}
              </Badge>
              {wait && <Badge variant="outline">{wait}</Badge>}
            </div>
            <span className="muted">{task.gate.reason}</span>
          </>
        )}
      </div>
      {children}
    </article>
  );
}

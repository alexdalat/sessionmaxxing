"use client";
import type { ReactNode } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { Badge } from "@/app/components/ui/badge";
import { ACTION_LABELS } from "@/app/lib/labels";
import {
  type PreviewState,
  previewState,
  STATE_LABELS,
  waitNote,
} from "@/app/lib/queuePreview";
import { windowRangeLabel } from "@/app/lib/schedule";
import { localTimestamp } from "@/shared/local-time";
import {
  DEFAULT_MAX_TURNS,
  formatTokens,
  type PublicTask,
} from "@/shared/types";

const stateVariants: Record<PreviewState, "success" | "warning"> = {
  running: "success",
  ready: "success",
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
  const stats: [string, string][] = [];
  if (task.priority !== 0) stats.push(["Priority", String(task.priority)]);
  if (task.maxTurns !== DEFAULT_MAX_TURNS)
    stats.push(["Max turns", String(task.maxTurns)]);
  if (edition === "full" && task.tokens !== null)
    stats.push(["Tokens", formatTokens(task.tokens)]);
  if (edition === "full" && task.sessionCostPercent !== null)
    stats.push(["Session", `${task.sessionCostPercent}%`]);
  if (task.preferredWindowStart !== null)
    stats.push([
      "Window",
      windowRangeLabel(task.preferredWindowStart, timeZone, now),
    ]);
  if (task.earliestStart)
    stats.push(["After", localTimestamp(task.earliestStart, timeZone)]);
  if (dependencies.length > 0)
    stats.push(["Depends on", dependencies.join(", ")]);
  return (
    <li className={`task-card${isLeaving ? " leaving" : ""}`}>
      <div className="task-body">
        <div className="task-title">
          <h3>{task.title}</h3>
          {isNext && <span className="task-tag">Next</span>}
          {task.review === "needed" && (
            <span className="task-tag" data-tone="attention">
              Needs review
            </span>
          )}
        </div>
        <p className="task-where">
          <span>{task.model}</span>
          <span className="mono">{task.workdir}</span>
        </p>
        {stats.length > 0 && (
          <dl className="stats">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="disclosures">
          <details>
            <summary>{ACTION_LABELS.showPrompt}</summary>
            <pre className="code-block">{task.prompt}</pre>
          </details>
        </div>
      </div>
      <div className="task-state">
        {task.gate && (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <Badge variant={stateVariants[state]}>
                {STATE_LABELS[state]}
              </Badge>
              {wait && <span className="muted">{wait}</span>}
            </p>
            {state !== "running" && (
              <span className="muted">{task.gate.reason}</span>
            )}
          </>
        )}
      </div>
      {children}
    </li>
  );
}

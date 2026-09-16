import { MINUTE_MS, type PublicTask } from "@/shared/types";
import { formatRemaining } from "./duration";
import { displayOrder } from "./queueOrder";

export type PreviewState = "running" | "ready" | "waiting";
export const STATE_LABELS: Record<PreviewState, string> = {
  running: "Running",
  ready: "Ready",
  waiting: "Waiting",
};
export interface PreviewRow {
  id: string;
  title: string;
  state: PreviewState;
  note: string;
  reason: string;
}

export const previewState = (task: PublicTask): PreviewState =>
  task.status === "running"
    ? "running"
    : task.gate?.status === "ready"
      ? "ready"
      : "waiting";

/** "in 9h 55m" while a pending task waits for a slot at least a minute out; null otherwise. */
export function waitNote(task: PublicTask, now: number): string | null {
  const at = task.gate?.eligibleAt;
  if (task.status !== "pending" || task.gate?.status === "ready" || !at)
    return null;
  const wait = Date.parse(at) - now;
  return wait >= MINUTE_MS ? `in ${formatRemaining(wait)}` : null;
}

/** Every unfinished task in dispatch order. */
export function queuePreview(tasks: PublicTask[], now: number): PreviewRow[] {
  return displayOrder(tasks)
    .filter((task) => task.status === "running" || task.status === "pending")
    .map((task) => ({
      id: task.id,
      title: task.title,
      state: previewState(task),
      note: waitNote(task, now) ?? previewState(task),
      reason: task.gate?.reason ?? "",
    }));
}

import { MINUTE_MS, type PublicTask } from "@/shared/types";

const RUNNING = 0;
const READY = 1;
const WAITING = 2;
const FINISHED = 3;

const rank = (task: PublicTask) => {
  if (task.status === "running") return RUNNING;
  if (task.status !== "pending") return FINISHED;
  return task.gate?.status === "ready" ? READY : WAITING;
};

const slot = (task: PublicTask): number | null => {
  const at = task.gate?.eligibleAt;
  return at === null || at === undefined ? null : Date.parse(at);
};

/** Whether two tasks come up for dispatch in the same minute, or are both unknowable. */
export const sameStartSlot = (a: PublicTask, b: PublicTask): boolean => {
  const left = slot(a);
  const right = slot(b);
  if (left === null || right === null) return left === right;
  return Math.round(left / MINUTE_MS) === Math.round(right / MINUTE_MS);
};

const bySoonest = (a: PublicTask, b: PublicTask) => {
  const left = slot(a);
  const right = slot(b);
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left - right;
};

/** Queue display order: running, ready, waiting (soonest first), finished. */
export const displayOrder = (tasks: PublicTask[]): PublicTask[] =>
  [RUNNING, READY, WAITING, FINISHED].flatMap((group) => {
    const inGroup = tasks.filter((task) => rank(task) === group);
    return group === WAITING ? inGroup.sort(bySoonest) : inGroup;
  });

/** The pending task shown directly above (-1) or below (1) `task`, when swapping them would move it. */
export const moveTarget = (
  ordered: PublicTask[],
  task: PublicTask,
  offset: -1 | 1,
): PublicTask | undefined => {
  if (task.status !== "pending") return undefined;
  const neighbor = ordered[ordered.indexOf(task) + offset];
  if (!neighbor || rank(neighbor) !== rank(task)) return undefined;
  return rank(task) !== WAITING || sameStartSlot(task, neighbor)
    ? neighbor
    : undefined;
};

/** Priority order with `taskId` placed just before (-1) or after (1) `neighborId`. */
export const movedPast = (
  ids: string[],
  taskId: string,
  neighborId: string,
  offset: -1 | 1,
): string[] => {
  const rest = ids.filter((id) => id !== taskId);
  const at = rest.indexOf(neighborId) + (offset === 1 ? 1 : 0);
  return [...rest.slice(0, at), taskId, ...rest.slice(at)];
};

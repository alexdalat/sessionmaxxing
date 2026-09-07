import type { PublicTask } from "../shared/types";

const RUNNING = 0;
const READY = 1;
const WAITING = 2;
const FINISHED = 3;

const rank = (task: PublicTask) => {
  if (task.status === "running") return RUNNING;
  if (task.status !== "pending") return FINISHED;
  return task.gate?.status === "ready" ? READY : WAITING;
};

const startsAt = (task: PublicTask) =>
  task.earliestStart === null ? 0 : Date.parse(task.earliestStart);

/** Queue display order: running, ready, waiting (soonest earliest start first), finished. */
export const displayOrder = (tasks: PublicTask[]): PublicTask[] =>
  [RUNNING, READY, WAITING, FINISHED].flatMap((group) => {
    const members = tasks.filter((task) => rank(task) === group);
    return group === WAITING
      ? members
          .map((task, index) => ({ task, index }))
          .sort(
            (a, b) => startsAt(a.task) - startsAt(b.task) || a.index - b.index,
          )
          .map(({ task }) => task)
      : members;
  });

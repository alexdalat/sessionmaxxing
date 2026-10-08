import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_MODEL,
  type ModelFamily,
  modelFamily,
  type PublicTask,
  type QueueSnapshot,
  type Task,
  type TaskInput,
  type TaskStatus,
} from "../shared/types.js";
import { atomicJson, DomainError, id } from "./storage.js";
import { TASK_ID, validateFields, validateWorkdir } from "./validation.js";

/** A task input whose "auto" tokens have already been resolved to a number. */
export type StoredTaskInput = Omit<TaskInput, "tokens"> & Pick<Task, "tokens">;
/**
 * Session rates fitted on 2026-09-15 (data/usage-samples.jsonl against the
 * transcripts in ~/.claude/projects), used once to convert tasks stored as a
 * session percent into the output tokens the queue keeps now. Sonnet had too
 * little data to fit and takes the Opus rate, as unknown models do.
 */
const MIGRATION_RATES: Record<ModelFamily, number> = {
  fable: 357,
  opus: 138,
  sonnet: 138,
  haiku: 325,
};
const MIGRATION_DEFAULT_RATE = MIGRATION_RATES.opus;
const MIGRATION_DEFAULT_PERCENT = 25;
const MILLION = 1_000_000;
/**
 * Median ratio of weighted to output tokens over the dispatched runs of the two
 * weeks before 2026-09-21, used once to convert tasks stored as output tokens
 * into the weighted tokens the queue keeps now.
 */
const MIGRATION_WEIGHTED_PER_OUTPUT = 4.8;

interface QueueState {
  version: 1;
  autoDispatch: boolean;
  tasks: Task[];
}
export function publicTask(task: Task): PublicTask {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    workdir: task.workdir,
    model: task.model,
    priority: task.priority,
    status: task.status,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    review: null,
    earliestStart: task.earliestStart,
    preferredWindowStart: task.preferredWindowStart,
    dependsOn: [...task.dependsOn],
    maxTurns: task.maxTurns,
    tokens: task.tokens,
    sessionCostPercent: null,
  };
}
/** Every dependency exists and none of them leads back to `taskId`. */
function validateDependencies(
  state: QueueState,
  taskId: string,
  dependsOn: readonly string[],
) {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const pending = [...dependsOn];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (current === taskId)
      throw new DomainError(
        "A task cannot depend on itself, directly or through another task.",
        400,
      );
    if (seen.has(current)) continue;
    seen.add(current);
    const dependency = byId.get(current);
    if (dependency === undefined)
      throw new DomainError("Depends on names a task that no longer exists.");
    pending.push(...dependency.dependsOn);
  }
}
export class QueueStore {
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    private path: string,
    private state: QueueState,
  ) {}
  static async open(directory: string) {
    const path = join(directory, "queue.json");
    let state: QueueState;
    try {
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { version: 1, autoDispatch: false, tasks: [] };
      await atomicJson(path, state);
    }
    if (
      state.version !== 1 ||
      typeof state.autoDispatch !== "boolean" ||
      !Array.isArray(state.tasks)
    )
      throw new DomainError(
        "Queue state is invalid. Restore a valid queue.json before starting.",
        500,
      );
    let migrated = false;
    const ids = new Set<string>();
    for (const task of state.tasks as (Task & { budgetEstimate?: number })[]) {
      if ("budgetEstimate" in task) {
        delete task.budgetEstimate;
        migrated = true;
      }
      // Task cost moved from a session percent to plan-independent output tokens on
      // 2026-09-15, and from output tokens to weighted tokens on 2026-09-21.
      const persisted: {
        sessionCostPercent?: number;
        outputTokens?: number;
        tokens?: number;
        finishedAt?: string | null;
        dependsOn?: string[];
      } = task;
      if (persisted.dependsOn === undefined) {
        persisted.dependsOn = [];
        migrated = true;
      }
      if (persisted.tokens === undefined) {
        if (persisted.outputTokens === undefined) {
          const family = modelFamily(task.model ?? "");
          const rate =
            family === null ? MIGRATION_DEFAULT_RATE : MIGRATION_RATES[family];
          persisted.outputTokens = Math.round(
            ((persisted.sessionCostPercent ?? MIGRATION_DEFAULT_PERCENT) /
              rate) *
              MILLION,
          );
        }
        persisted.tokens = Math.round(
          persisted.outputTokens * MIGRATION_WEIGHTED_PER_OUTPUT,
        );
        migrated = true;
      }
      if (persisted.sessionCostPercent !== undefined) {
        delete persisted.sessionCostPercent;
        migrated = true;
      }
      if (persisted.outputTokens !== undefined) {
        delete persisted.outputTokens;
        migrated = true;
      }
      if (persisted.finishedAt === undefined) {
        persisted.finishedAt = null;
        migrated = true;
      }
      validateFields(task);
      if (
        !TASK_ID.test(task.id) ||
        ids.has(task.id) ||
        typeof task.workdir !== "string" ||
        !(
          task.workdir === "/home/user" ||
          task.workdir.startsWith("/home/user/")
        ) ||
        !Number.isFinite(Date.parse(task.createdAt)) ||
        !["pending", "running", "completed", "failed", "cancelled"].includes(
          task.status,
        )
      )
        throw new DomainError("Queue task metadata is invalid.", 500);
      ids.add(task.id);
    }
    const interrupted = state.tasks.some((t) => t.status === "running");
    if (interrupted || migrated) {
      for (const task of state.tasks)
        if (task.status === "running") task.status = "failed";
      await atomicJson(path, state);
    }
    return new QueueStore(path, state);
  }
  snapshot(): QueueSnapshot {
    return {
      autoDispatch: this.state.autoDispatch,
      tasks: this.state.tasks
        .map(publicTask)
        .sort(
          (a, b) =>
            a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
        ),
    };
  }
  private transact<T>(
    change: (state: QueueState) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.chain.then(async () => {
      const draft = structuredClone(this.state);
      const result = await change(draft);
      await atomicJson(this.path, draft);
      this.state = draft;
      return result;
    });
    this.chain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  async create(input: StoredTaskInput) {
    validateFields(input);
    const workdir = await validateWorkdir(input.workdir);
    return this.transact((state) => {
      const taskId = id();
      validateDependencies(state, taskId, input.dependsOn);
      const task: Task = {
        ...input,
        workdir,
        id: taskId,
        model: input.model || DEFAULT_MODEL,
        status: "pending",
        createdAt: new Date().toISOString(),
        finishedAt: null,
      };
      state.tasks.push(task);
      return publicTask(task);
    });
  }

  private find(state: QueueState, taskId: string) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new DomainError("Task not found.", 404);
    return task;
  }
  async update(taskId: string, patch: Partial<StoredTaskInput>) {
    return this.transact(async (state) => {
      const task = this.find(state, taskId);
      if (task.status !== "pending")
        throw new DomainError("Only pending tasks can be edited.");
      const updated = { ...task, ...patch };
      validateFields(updated);
      validateDependencies(state, task.id, updated.dependsOn);
      updated.workdir = await validateWorkdir(updated.workdir);
      Object.assign(task, updated);
      return publicTask(task);
    });
  }
  async delete(taskId: string) {
    return this.transact((state) => {
      if (this.find(state, taskId).status === "running")
        throw new DomainError("Cancel the running task before deleting it.");
      state.tasks = state.tasks.filter((t) => t.id !== taskId);
      for (const task of state.tasks)
        task.dependsOn = task.dependsOn.filter(
          (dependencyId) => dependencyId !== taskId,
        );
    });
  }
  async reorder(taskIds: string[]) {
    return this.transact((state) => {
      const pending = state.tasks.filter((t) => t.status === "pending");
      if (
        taskIds.length !== pending.length ||
        new Set(taskIds).size !== pending.length ||
        pending.some((t) => !taskIds.includes(t.id))
      )
        throw new DomainError("Provide each pending task exactly once.", 400);
      taskIds.forEach((taskId, priority) => {
        this.find(state, taskId).priority = priority;
      });
    });
  }
  async claim(taskId: string): Promise<Task> {
    return this.transact((state) => {
      const task = this.find(state, taskId);
      if (task.status !== "pending")
        throw new DomainError("Only pending tasks can run.");
      task.status = "running";
      return structuredClone(task);
    });
  }
  async finish(
    taskId: string,
    status: Extract<TaskStatus, "completed" | "failed" | "cancelled">,
  ) {
    return this.transact((state) => {
      const task = this.find(state, taskId);
      if (task.status !== "running")
        throw new DomainError("Only a running task can finish.");
      task.status = status;
      task.finishedAt = new Date().toISOString();
    });
  }
  /** Puts a running task back in line, as when a usage limit stopped its run. */
  async requeue(taskId: string) {
    return this.transact((state) => {
      const task = this.find(state, taskId);
      if (task.status !== "running")
        throw new DomainError("Only a running task can be requeued.");
      task.status = "pending";
      task.finishedAt = null;
    });
  }
  async retry(taskId: string) {
    return this.transact((state) => {
      const task = this.find(state, taskId);
      if (task.status !== "failed" && task.status !== "cancelled")
        throw new DomainError("Only failed or cancelled tasks can be retried.");
      task.status = "pending";
      task.finishedAt = null;
      return publicTask(task);
    });
  }
  async setAutoDispatch(enabled: boolean) {
    return this.transact((state) => {
      state.autoDispatch = enabled;
    });
  }
}

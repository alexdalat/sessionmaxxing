import type { FastifyInstance } from "fastify";
import {
  AUTO_OUTPUT_TOKENS,
  MAX_DEPENDENCIES,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  needsReview,
  type OutputTokensInput,
  type PlanningSnapshot,
  type PublicTask,
  type Run,
  type SessionRates,
  type TaskInput,
} from "../shared/types.js";
import { modelSessionPercent } from "./calibration.js";
import { emptyQuerySchema } from "./dispatch-settings.js";
import type {
  EstimateRun,
  EstimateTask,
  OutputTokensEstimator,
} from "./estimate.js";
import {
  defaultModel,
  type QueueStore,
  type StoredTaskInput,
} from "./queue.js";
import type { Runner } from "./runner.js";
import type { SessionKeeper } from "./session-keeper.js";
import { DomainError } from "./storage.js";
import { suggestWorkdirs } from "./workdirs.js";

const idSchema = { type: "string", pattern: "^[a-f0-9]{24}$" };
const params = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: idSchema },
};
const properties = {
  title: { type: "string", minLength: 1, maxLength: 120 },
  prompt: { type: "string", minLength: 1, maxLength: 50_000 },
  workdir: { type: "string", minLength: 1, maxLength: 4096 },
  provider: { type: "string", enum: ["claude", "codex"] },
  model: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$" },
  priority: { type: "integer", minimum: 0, maximum: 1_000_000 },
  earliestStart: {
    anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
  },
  preferredWindowStart: {
    anyOf: [{ type: "integer", minimum: 0, maximum: 23 }, { type: "null" }],
  },
  maxTurns: { type: "integer", minimum: 1, maximum: 1000 },
  outputTokens: {
    anyOf: [
      {
        type: "integer",
        minimum: MIN_OUTPUT_TOKENS,
        maximum: MAX_OUTPUT_TOKENS,
      },
      { const: AUTO_OUTPUT_TOKENS },
    ],
  },
  dependsOn: {
    type: "array",
    uniqueItems: true,
    maxItems: MAX_DEPENDENCIES,
    items: idSchema,
  },
};
const workdirQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { q: { type: "string", maxLength: 4096 } },
};
export function registerQueueRoutes(
  app: FastifyInstance,
  queue: QueueStore,
  runner: Runner,
  now: () => Date,
  estimate: OutputTokensEstimator,
  getPlanning?: () => PlanningSnapshot,
  keeper?: SessionKeeper,
) {
  /** The task with the review state of its latest run and its cost at the current rates. */
  const shown = (
    task: PublicTask,
    runs: Run[],
    rates: SessionRates | null,
  ): PublicTask => {
    const latest = runs.find((run) => run.taskId === task.id);
    return {
      ...task,
      review: latest && needsReview(latest) ? "needed" : null,
      sessionCostPercent:
        task.provider !== "claude" || rates === null
          ? null
          : modelSessionPercent(task.outputTokens, task.model, rates),
    };
  };
  const plannedTask = async (task: PublicTask) => {
    const planning = getPlanning?.();
    const withReview = shown(task, runner.list(), planning?.rates ?? null);
    return planning
      ? { ...withReview, gate: await runner.gate(task, planning, now()) }
      : withReview;
  };
  app.get(
    "/api/queue",
    { schema: { querystring: emptyQuerySchema } },
    async () => {
      const planning = getPlanning?.();
      const snapshot = queue.snapshot();
      const at = now();
      const runs = runner.list();
      return {
        ...snapshot,
        tasks: await Promise.all(
          snapshot.tasks.map(async (task) => {
            const withReview = shown(task, runs, planning?.rates ?? null);
            return planning
              ? { ...withReview, gate: await runner.gate(task, planning, at) }
              : withReview;
          }),
        ),
        ...(planning ? { planning } : {}),
        ...(keeper ? { sessionKeeper: keeper.state() } : {}),
        runnerError: runner.error,
      };
    },
  );
  /** Finished runs, as calibration for an estimate; older runs borrow their task's prompt and estimate. */
  const calibration = (): EstimateRun[] => {
    const tasks = new Map(
      queue.snapshot().tasks.map((task) => [task.id, task]),
    );
    return runner.list().flatMap((run) => {
      const task = tasks.get(run.taskId);
      const prompt = run.prompt ?? task?.prompt;
      return prompt === undefined
        ? []
        : [
            {
              title: run.title,
              promptLength: prompt.length,
              model: run.model,
              durationMs: run.durationMs,
              outputTokens: run.outputTokens,
              estimatedOutputTokens:
                run.estimatedOutputTokens ?? task?.outputTokens ?? null,
            },
          ];
    });
  };
  /** "auto" is resolved here so the queue only ever stores a number. */
  const storedTokens = async (
    tokens: OutputTokensInput,
    task: () => EstimateTask,
  ): Promise<number> => {
    if (tokens !== AUTO_OUTPUT_TOKENS) return tokens;
    try {
      return await estimate(task(), calibration());
    } catch (error) {
      throw new DomainError((error as Error).message, 500);
    }
  };
  const editedTask = (
    taskId: string,
    patch: Partial<TaskInput>,
  ): EstimateTask => {
    const task = queue
      .snapshot()
      .tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) throw new DomainError("Task not found.", 404);
    const provider = patch.provider ?? task.provider;
    return {
      title: patch.title ?? task.title,
      prompt: patch.prompt ?? task.prompt,
      model:
        patch.model ||
        (provider === task.provider ? task.model : defaultModel(provider)),
      provider,
    };
  };
  app.get<{ Querystring: { q?: string } }>(
    "/api/workdirs",
    { schema: { querystring: workdirQuerySchema } },
    async (request) =>
      suggestWorkdirs(
        request.query.q ?? "",
        [...queue.snapshot().tasks]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((task) => task.workdir),
      ),
  );
  app.get("/api/runs", async () => ({
    runs: runner.list(),
    runnerError: runner.error,
  }));
  app.get("/api/runs/pending-review", async () => ({
    pending: runner.list().filter(needsReview).length,
  }));
  app.post<{ Params: { id: string } }>(
    "/api/runs/:id/reviewed",
    { schema: { params } },
    (request) => runner.markReviewed(request.params.id),
  );
  app.post<{ Body: TaskInput }>(
    "/api/tasks",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "prompt",
            "workdir",
            "provider",
            "priority",
            "earliestStart",
            "preferredWindowStart",
            "maxTurns",
            "outputTokens",
            "dependsOn",
          ],
          properties,
        },
      },
    },
    async (request, reply) => {
      const input = request.body;
      const created = await queue.create({
        ...input,
        outputTokens: await storedTokens(input.outputTokens, () => ({
          title: input.title,
          prompt: input.prompt,
          model: input.model || defaultModel(input.provider),
          provider: input.provider,
        })),
      });
      return reply.code(201).send(await plannedTask(created));
    },
  );
  app.patch<{ Params: { id: string }; Body: Partial<TaskInput> }>(
    "/api/tasks/:id",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties,
        },
      },
    },
    async (request) => {
      const { outputTokens, ...patch } = request.body;
      const stored: Partial<StoredTaskInput> =
        outputTokens === undefined
          ? patch
          : {
              ...patch,
              outputTokens: await storedTokens(outputTokens, () =>
                editedTask(request.params.id, request.body),
              ),
            };
      return await plannedTask(await queue.update(request.params.id, stored));
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/tasks/:id",
    { schema: { params } },
    async (request) => {
      await queue.delete(request.params.id);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/run",
    { schema: { params } },
    (request) => runner.start(request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/cancel",
    { schema: { params } },
    async (request) => {
      await runner.cancel(request.params.id);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/retry",
    { schema: { params } },
    async (request) => await plannedTask(await queue.retry(request.params.id)),
  );
  app.put<{ Body: { ids: string[] } }>(
    "/api/queue/order",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["ids"],
          properties: {
            ids: { type: "array", uniqueItems: true, items: idSchema },
          },
        },
      },
    },
    async (request) => {
      await queue.reorder(request.body.ids);
      return { ok: true };
    },
  );
  app.put<{ Body: { enabled: boolean } }>(
    "/api/queue/auto",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
      },
    },
    async (request) => {
      await queue.setAutoDispatch(request.body.enabled);
      return { ok: true };
    },
  );
  app.addHook("onClose", async () => runner.close());
}

import type { FastifyInstance } from "fastify";
import {
  AUTO_TOKENS,
  COMMIT_MESSAGE_MAX,
  DEFAULT_MODEL,
  MAX_DEPENDENCIES,
  MAX_TOKENS,
  MIN_TOKENS,
  needsCommit,
  needsReview,
  type PlanningSnapshot,
  type PublicTask,
  type Run,
  type SessionRates,
  type TaskInput,
  type TokensInput,
} from "../shared/types.js";
import { modelSessionPercent } from "./calibration.js";
import type { CommitMessageSuggester } from "./commit-message.js";
import { emptyQuerySchema } from "./dispatch-settings.js";
import type { EstimateRun, EstimateTask, TokensEstimator } from "./estimate.js";
import type { QueueStore, StoredTaskInput } from "./queue.js";
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
  model: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$" },
  priority: { type: "integer", minimum: 0, maximum: 1_000_000 },
  earliestStart: {
    anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
  },
  preferredWindowStart: {
    anyOf: [{ type: "integer", minimum: 0, maximum: 23 }, { type: "null" }],
  },
  maxTurns: { type: "integer", minimum: 1, maximum: 1000 },
  tokens: {
    anyOf: [
      {
        type: "integer",
        minimum: MIN_TOKENS,
        maximum: MAX_TOKENS,
      },
      { const: AUTO_TOKENS },
    ],
  },
  dependsOn: {
    type: "array",
    uniqueItems: true,
    maxItems: MAX_DEPENDENCIES,
    items: idSchema,
  },
};
const commitSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: {
      type: "string",
      maxLength: COMMIT_MESSAGE_MAX,
      pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$",
    },
  },
};
const workdirQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { q: { type: "string", maxLength: 4096 } },
};
const runsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { limit: { type: "string", pattern: "^[1-9][0-9]{0,5}$" } },
};
export function registerQueueRoutes(
  app: FastifyInstance,
  queue: QueueStore,
  runner: Runner,
  now: () => Date,
  estimate: TokensEstimator,
  suggestCommit: CommitMessageSuggester,
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
        rates === null
          ? null
          : modelSessionPercent(task.tokens, task.model, rates),
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
              tokens: run.tokens,
              estimatedTokens: run.estimatedTokens ?? task?.tokens ?? null,
            },
          ];
    });
  };
  /** "auto" is resolved here so the queue only ever stores a number. */
  const storedTokens = async (
    tokens: TokensInput,
    task: () => EstimateTask,
  ): Promise<number> => {
    if (tokens !== AUTO_TOKENS) return tokens;
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
    return {
      title: patch.title ?? task.title,
      prompt: patch.prompt ?? task.prompt,
      model: patch.model || task.model,
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
  app.get<{ Querystring: { limit?: string } }>(
    "/api/runs",
    { schema: { querystring: runsQuerySchema } },
    async (request) => {
      const runs = runner.list();
      return {
        runs:
          request.query.limit === undefined
            ? runs
            : runs.slice(0, Number(request.query.limit)),
        total: runs.length,
        pending: runs.filter(needsReview).length,
        runnerError: runner.error,
      };
    },
  );
  app.get("/api/runs/pending-review", async () => ({
    pending: runner.list().filter(needsReview).length,
  }));
  app.post<{ Params: { id: string } }>(
    "/api/runs/:id/reviewed",
    { schema: { params } },
    (request) => runner.markReviewed(request.params.id),
  );
  /** One suggestion per run, so reloading the page does not ask the model again. */
  const suggestions = new Map<string, Promise<string>>();
  app.post<{ Params: { id: string } }>(
    "/api/runs/:id/commit-message",
    { schema: { params } },
    async (request) => {
      const run = runner.list().find(({ id }) => id === request.params.id);
      if (!run) throw new DomainError("Run not found.", 404);
      if (!needsCommit(run))
        throw new DomainError("This run has nothing left to commit.", 409);
      let suggestion = suggestions.get(run.id);
      if (!suggestion) {
        suggestion = suggestCommit({
          title: run.title,
          summary: run.summary,
          files: run.changes.files,
        });
        suggestions.set(run.id, suggestion);
      }
      try {
        return { message: await suggestion };
      } catch (error) {
        suggestions.delete(run.id);
        throw new DomainError((error as Error).message, 502);
      }
    },
  );
  app.post<{ Params: { id: string }; Body: { message: string } }>(
    "/api/runs/:id/commit",
    { schema: { params, body: commitSchema } },
    async (request) => {
      const committed = await runner.commit(
        request.params.id,
        request.body.message.trim(),
      );
      suggestions.delete(committed.id);
      return committed;
    },
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
            "priority",
            "earliestStart",
            "preferredWindowStart",
            "maxTurns",
            "tokens",
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
        tokens: await storedTokens(input.tokens, () => ({
          title: input.title,
          prompt: input.prompt,
          model: input.model || DEFAULT_MODEL,
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
      const { tokens, ...patch } = request.body;
      const stored: Partial<StoredTaskInput> =
        tokens === undefined
          ? patch
          : {
              ...patch,
              tokens: await storedTokens(tokens, () =>
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

import type { FastifyInstance } from "fastify";
import type {
  PlanningSnapshot,
  PublicTask,
  TaskInput,
} from "../shared/types.js";
import { taskGate } from "./dispatch.js";
import { emptyQuerySchema } from "./dispatch-settings.js";
import type { QueueStore } from "./queue.js";
import type { Runner } from "./runner.js";

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
};
export function registerQueueRoutes(
  app: FastifyInstance,
  queue: QueueStore,
  runner: Runner,
  getPlanning?: () => PlanningSnapshot,
) {
  const plannedTask = (task: PublicTask) =>
    getPlanning ? { ...task, gate: taskGate(task, getPlanning()) } : task;
  app.get(
    "/api/queue",
    { schema: { querystring: emptyQuerySchema } },
    async () => {
      const planning = getPlanning?.();
      const snapshot = queue.snapshot();
      return {
        ...snapshot,
        ...(planning
          ? {
              planning,
              tasks: snapshot.tasks.map((task) => ({
                ...task,
                gate: taskGate(task, planning),
              })),
            }
          : {}),
        runnerError: runner.error,
      };
    },
  );
  app.get("/api/runs", async () => ({
    runs: runner.list(),
    runnerError: runner.error,
  }));
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
          ],
          properties,
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await plannedTask(await queue.create(request.body))),
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
    async (request) =>
      plannedTask(await queue.update(request.params.id, request.body)),
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
    async (request) => plannedTask(await queue.retry(request.params.id)),
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

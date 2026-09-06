import { homedir } from "node:os";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError } from "fastify";
import type {
  DispatchSettings,
  HistoryData,
  PlanningSnapshot,
  RangeDays,
} from "../shared/types.js";
import { aggregate } from "./analytics.js";
import { planDispatch } from "./dispatch.js";
import {
  type DispatchSettingsStore,
  emptyQuerySchema,
  settingsSchema,
} from "./dispatch-settings.js";
import { readHistory } from "./history.js";
import type { QueueStore } from "./queue.js";
import { registerQueueRoutes } from "./routes.js";
import type { Runner } from "./runner.js";
import { DomainError } from "./storage.js";
import type { UsageMonitor } from "./usage-monitor.js";

const DASHBOARD_HOST =
  /^(127\.0\.0\.1|localhost|100\.98\.196\.62|deltabeta\.tail537c71\.ts\.net)(:\d+)?$/;

export interface AppOptions {
  staticRoot?: string;
  queue?: QueueStore;
  runner?: Runner;
  loadHistory?: () => Promise<HistoryData>;
  settings?: DispatchSettingsStore;
  usage?: UsageMonitor;
  now?: () => Date;
}
export async function createApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const loadHistory =
    options.loadHistory ?? (() => readHistory(join(homedir(), ".claude")));
  const now = () => options.now?.() ?? new Date();
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (
      !DASHBOARD_HOST.test(host) ||
      (origin !== undefined && origin !== `http://${host}`) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      return reply.code(403).send({
        error: "Only approved dashboard hosts and origins are accepted.",
      });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({ error: error.message });
    const fastifyError = error as FastifyError;
    if (fastifyError.validation)
      return reply.code(400).send({
        error:
          "Invalid request. Check required fields, types, and allowed values.",
      });
    const status =
      fastifyError.statusCode &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
        ? fastifyError.statusCode
        : 500;
    return reply.code(status).send({
      error:
        status === 500
          ? "The local operation failed. Check file access and runtime state."
          : "The request could not be processed.",
    });
  });
  app.get<{ Querystring: { days?: string } }>(
    "/api/analytics",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            days: {
              type: "string",
              enum: ["7", "14", "30", "90"],
              default: "30",
            },
          },
        },
      },
    },
    async (request) =>
      aggregate(
        await loadHistory(),
        Number(request.query.days ?? 30) as RangeDays,
        now(),
        options.usage?.current().snapshot ?? null,
      ),
  );
  if (options.usage) {
    const usage = options.usage;
    app.get(
      "/api/usage",
      { schema: { querystring: emptyQuerySchema } },
      async () => usage.report(),
    );
    app.post(
      "/api/usage/refresh",
      { schema: { querystring: emptyQuerySchema } },
      async () => {
        await usage.refresh();
        return usage.report();
      },
    );
  }
  let planning: (() => PlanningSnapshot) | undefined;
  if (options.settings && options.usage) {
    const { settings, usage } = options;
    const getPlanning = () =>
      planDispatch(settings.snapshot(), usage.current(), now());
    planning = getPlanning;
    options.runner?.setPlanner(getPlanning);
    app.get(
      "/api/dispatch-settings",
      { schema: { querystring: emptyQuerySchema } },
      async () => getPlanning(),
    );
    app.put<{ Body: DispatchSettings }>(
      "/api/dispatch-settings",
      { schema: { querystring: emptyQuerySchema, body: settingsSchema } },
      async (request) => {
        await settings.save(request.body);
        return getPlanning();
      },
    );
  }
  if (options.queue && options.runner)
    registerQueueRoutes(app, options.queue, options.runner, planning);
  if (options.staticRoot)
    await app.register(fastifyStatic, {
      root: options.staticRoot,
      index: "index.html",
      dotfiles: "deny",
    });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "Route not found." }),
  );
  return app;
}

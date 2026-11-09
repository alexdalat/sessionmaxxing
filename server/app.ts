import { isIPv6 } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError } from "fastify";
import {
  type DispatchSettings,
  type Edition,
  EMPTY_LOAD,
  type Environment,
  type HistoryData,
  type PlanningSnapshot,
  type RangeDays,
  type SessionRates,
} from "../shared/types.js";
import { aggregate } from "./analytics.js";
import {
  CALIBRATION_DAYS,
  fitSessionRates,
  SessionRatesCache,
  windowTokens,
} from "./calibration.js";
import {
  type CommitMessageSuggester,
  suggestCommitMessage,
} from "./commit-message.js";
import { planDispatch } from "./dispatch.js";
import {
  type DispatchSettingsStore,
  emptyQuerySchema,
  settingsSchema,
} from "./dispatch-settings.js";
import { UNSPECIFIED_ADDRESSES } from "./environment.js";
import { estimateTokens, type TokensEstimator } from "./estimate.js";
import { createHistoryReader } from "./history.js";
import { planScore } from "./plan-score.js";
import type { QueueStore } from "./queue.js";
import { QuietHoursCache } from "./quiet-hours.js";
import { registerQueueRoutes } from "./routes.js";
import type { Planner, Runner } from "./runner.js";
import type { SessionKeeper } from "./session-keeper.js";
import { DomainError } from "./storage.js";
import { mergeSessionWindows, sessionWindows } from "./usage-history.js";
import type { UsageMonitor } from "./usage-monitor.js";

const LITE_HOME = "/queue/";
const LITE_HIDDEN_FILES: ReadonlySet<string> = new Set([
  "/index.html",
  "/index.txt",
  "/__next.__PAGE__.txt",
  "/__next._full.txt",
]);
const LITE_HIDDEN_PREFIX = "/analytics";
const hiddenInLite = (path: string) =>
  LITE_HIDDEN_FILES.has(path) ||
  path === LITE_HIDDEN_PREFIX ||
  path.startsWith(`${LITE_HIDDEN_PREFIX}/`);

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const BRACKETED = /^\[(.*)\]$/;
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function hostMatcher(allowedHosts: readonly string[]) {
  const names = [...LOCAL_HOSTS, ...allowedHosts]
    .map((name) => BRACKETED.exec(name)?.[1] ?? name)
    .filter((name) => !UNSPECIFIED_ADDRESSES.has(name))
    .map((name) => (isIPv6(name) ? `[${name}]` : name))
    .map((name) => name.replace(REGEXP_SPECIALS, "\\$&"));
  return new RegExp(`^(?:${names.join("|")})(?::\\d+)?$`, "i");
}

export interface AppOptions {
  /** IANA zone the server resolved from TZ. */
  timeZone: string;
  staticRoot?: string;
  /** Defaults to full; startDashboard always passes it. */
  edition?: Edition;
  /** Host names and addresses accepted besides localhost and 127.0.0.1. */
  allowedHosts?: readonly string[];
  queue?: QueueStore;
  runner?: Runner;
  loadHistory?: () => Promise<HistoryData>;
  settings?: DispatchSettingsStore;
  usage?: UsageMonitor;
  keeper?: SessionKeeper;
  now?: () => Date;
  quietHoursTtlMs?: number;
  estimate?: TokensEstimator;
  suggestCommit?: CommitMessageSuggester;
  /** Overrides the fitted session rates; by default they are fitted from samples and transcripts. */
  sessionRates?: () => Promise<SessionRates | null>;
}
export async function createApp(options: AppOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const edition = options.edition ?? "full";
  const loadHistory =
    edition === "full"
      ? (options.loadHistory ??
        createHistoryReader(
          join(homedir(), ".claude"),
          () =>
            new Set<string>([
              ...(options.runner?.dispatchedSessions() ?? []),
              ...(options.keeper?.sessions() ?? []),
            ]),
        ))
      : undefined;
  const now = () => options.now?.() ?? new Date();
  const approvedHost = hostMatcher(options.allowedHosts ?? []);
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (
      !approvedHost.test(host) ||
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
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
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
  if (loadHistory)
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
          options.timeZone,
          now(),
          options.usage?.current().snapshot ?? null,
        ),
    );
  if (options.usage) {
    const usage = options.usage;
    const usageReport = async () => {
      const report = usage.report();
      if (!loadHistory) return report;
      return {
        ...report,
        windows: mergeSessionWindows(
          report.windows,
          (await loadHistory()).events,
          now(),
        ),
      };
    };
    app.get(
      "/api/usage",
      { schema: { querystring: emptyQuerySchema } },
      usageReport,
    );
    if (loadHistory)
      app.get(
        "/api/plan-score",
        { schema: { querystring: emptyQuerySchema } },
        async () =>
          planScore(
            usage.samples(now()),
            now(),
            (await loadHistory()).events,
            options.timeZone,
          ),
      );
    app.post(
      "/api/usage/refresh",
      { schema: { querystring: emptyQuerySchema } },
      async () => {
        await usage.refresh();
        return usageReport();
      },
    );
  }
  let planning: (() => PlanningSnapshot) | undefined;
  if (loadHistory && options.settings && options.usage) {
    const { settings, usage } = options;
    const quiet = new QuietHoursCache(
      async () =>
        aggregate(
          await loadHistory(),
          30,
          options.timeZone,
          now(),
        ).opportunities.map((window) => window.startHour),
      now,
      options.quietHoursTtlMs,
    );
    const rates = new SessionRatesCache(
      options.sessionRates ??
        (async () =>
          fitSessionRates(
            windowTokens(
              sessionWindows(usage.samples(now()), now(), CALIBRATION_DAYS),
              (await loadHistory()).events,
            ),
          )),
      now,
      options.quietHoursTtlMs,
    );
    await rates.refresh();
    const planner: Planner = (load) =>
      planDispatch(
        settings.snapshot(),
        usage.current(),
        now(),
        options.timeZone,
        quiet.current(),
        load,
        rates.current(),
      );
    const getPlanning = () =>
      planner(options.runner?.load(settings.snapshot()) ?? EMPTY_LOAD);
    planning = getPlanning;
    options.runner?.setPlanner(planner, () => usage.refresh());
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
  if (options.queue) {
    const workdirRoot = options.queue.workdirRoot;
    app.get<{ Reply: Environment }>(
      "/api/environment",
      { schema: { querystring: emptyQuerySchema } },
      async () => ({ timeZone: options.timeZone, workdirRoot, edition }),
    );
  }
  if (options.queue && options.runner)
    registerQueueRoutes(
      app,
      edition,
      options.queue,
      options.runner,
      now,
      edition === "full" ? (options.estimate ?? estimateTokens) : undefined,
      options.suggestCommit ?? suggestCommitMessage,
      planning,
      options.keeper,
    );
  if (options.staticRoot) {
    if (edition === "lite")
      app.get("/", (_request, reply) => reply.redirect(LITE_HOME, 302));
    await app.register(fastifyStatic, {
      root: options.staticRoot,
      index: "index.html",
      dotfiles: "deny",
      redirect: true,
      ...(edition === "lite"
        ? { allowedPath: (path: string) => !hiddenInLite(path) }
        : {}),
    });
  }
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "Route not found." }),
  );
  return app;
}

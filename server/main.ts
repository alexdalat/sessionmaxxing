import { mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import type { HistoryData } from "../shared/types.js";
import { createApp } from "./app.js";
import { type FetchUsage, officialUsageFetcher } from "./claude-usage.js";
import { DispatchSettingsStore } from "./dispatch-settings.js";
import { readSessionTokens } from "./history.js";
import { QueueStore } from "./queue.js";
import { Runner } from "./runner.js";
import { SessionKeeper } from "./session-keeper.js";
import { DomainError } from "./storage.js";
import { UsageHistoryStore } from "./usage-history.js";
import { UsageMonitor } from "./usage-monitor.js";

interface StartOptions {
  port?: number;
  dataDirectory?: string;
  development?: boolean;
  loadHistory?: () => Promise<HistoryData>;
  fetchUsage?: FetchUsage;
}
export async function startDashboard(
  options: StartOptions = {},
): Promise<FastifyInstance> {
  const host = process.env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "0.0.0.0")
    throw new DomainError("HOST must be 127.0.0.1 or 0.0.0.0.", 400);
  const port = options.port ?? Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new DomainError("PORT must be an integer from 1 to 65535.", 400);
  const directory = options.dataDirectory ?? resolve("data");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "server.lock");
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new DomainError(
        "Runtime lock already exists. Stop the other dashboard. After a crash, verify that its process has exited before removing data/server.lock.",
      );
    throw error;
  }
  let app: FastifyInstance | undefined;
  let released = false;
  const release = async () => {
    if (!released) {
      released = true;
      await lock.close();
      await unlink(lockPath);
    }
  };
  try {
    await lock.writeFile(String(process.pid));
    await lock.sync();
    const settings = await DispatchSettingsStore.open(directory);
    const usage = new UsageMonitor(
      options.fetchUsage ?? officialUsageFetcher(join(homedir(), ".claude")),
      await UsageHistoryStore.open(directory),
    );
    const queue = await QueueStore.open(directory);
    const runner = await Runner.open(queue, directory, {
      autoApply: () => settings.snapshot().autoApply,
      sessionTokens: (sessionId) =>
        readSessionTokens(join(homedir(), ".claude"), sessionId),
    });
    const keeper = await SessionKeeper.open(directory, {
      enabled: () => settings.snapshot().keepSessionActive,
      usage: () => usage.current(),
      refreshUsage: () => usage.refresh(),
      claudeRuns: () => runner.load().claudeRuns,
    });
    app = await createApp({
      queue,
      runner,
      settings,
      usage,
      keeper,
      loadHistory: options.loadHistory,
      staticRoot: options.development ? undefined : resolve("dist/client"),
    });
    app.addHook("onClose", async () => usage.stop());
    app.addHook("onClose", async () => keeper.close());
    app.addHook("onClose", release);
    await app.listen({ host, port });
    usage.start();
    runner.startScheduler();
    keeper.startScheduler();
    return app;
  } catch (error) {
    if (app) await app.close();
    await release();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const app = await startDashboard({
      development: process.argv.includes("--dev"),
    });
    const address = app.server.address();
    if (address && typeof address !== "string")
      console.info(
        `Claude capacity dashboard: http://${address.address}:${address.port}`,
      );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await app.close();
      } catch {
        console.error(
          "Shutdown failed. Verify provider processes have stopped.",
        );
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch (error) {
    console.error(
      error instanceof DomainError
        ? error.message
        : "Dashboard startup failed. Check the port, production build, and local runtime file access.",
    );
    process.exitCode = 1;
  }
}

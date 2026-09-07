import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import { temporary, usageSnapshot } from "./helpers";

const run = promisify(execFile);
const SCRIPT = resolve("scripts/queue-task.mjs");
const PROMPT = "PRIVATE PROMPT: rename the parser and run pnpm test";

it("builds the task body from flags without posting when asked for a dry run", async () => {
  const { stdout } = await run(process.execPath, [
    SCRIPT,
    "--title",
    "Rename the parser",
    "--prompt",
    PROMPT,
    "--window",
    "3",
    "--max-turns",
    "5",
    "--priority",
    "2",
    "--model",
    "claude-fable-5-1",
    "--dry-run",
  ]);
  expect(JSON.parse(stdout)).toEqual({
    title: "Rename the parser",
    prompt: PROMPT,
    workdir: process.cwd(),
    provider: "claude",
    priority: 2,
    earliestStart: null,
    preferredWindowStart: 3,
    maxTurns: 5,
    model: "claude-fable-5-1",
  });
});

it("queues an unscheduled task against the running dashboard and keeps the prompt off stdout", async () => {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  const queue = await QueueStore.open(temp.path);
  const runner = await Runner.open(queue, temp.path);
  const usage = new UsageMonitor(
    async (at) => usageSnapshot({ fetchedAt: at.toISOString() }),
    await UsageHistoryStore.open(temp.path, now),
    () => now,
  );
  await usage.refresh();
  const app = await createApp({
    queue,
    runner,
    usage,
    settings: await DispatchSettingsStore.open(temp.path),
    now: () => now,
    loadHistory: async () => ({
      events: [],
      health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
    }),
  });
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string")
      throw new Error("The test server did not report a port.");
    const { stdout } = await run(process.execPath, [
      SCRIPT,
      "--title",
      "Rename the parser",
      "--prompt",
      PROMPT,
      "--workdir",
      temp.path,
      "--url",
      `http://127.0.0.1:${address.port}`,
    ]);
    expect(stdout).toContain("session 16%");
    expect(stdout).toContain("weekly 2%");
    expect(stdout).toContain("Any quiet hour");
    expect(stdout).not.toMatch(/PRIVATE|parser and run/);
    const tasks = queue.snapshot().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Rename the parser",
      provider: "claude",
      preferredWindowStart: null,
      maxTurns: 100,
    });
    expect(stdout).toContain(`Queued ${tasks[0].id}`);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

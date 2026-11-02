import { execFile } from "node:child_process";
import { createServer } from "node:net";
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
    "--tokens",
    "40000",
    "--dry-run",
  ]);
  expect(JSON.parse(stdout)).toEqual({
    title: "Rename the parser",
    prompt: PROMPT,
    workdir: process.cwd(),
    priority: 2,
    earliestStart: null,
    preferredWindowStart: 3,
    maxTurns: 5,
    tokens: 40000,
    dependsOn: [],
    model: "claude-fable-5-1",
  });
});

it("rejects the removed --provider flag", async () => {
  await expect(
    run(process.execPath, [
      SCRIPT,
      "--title",
      "Rename the parser",
      "--prompt",
      PROMPT,
      "--provider",
      "claude",
      "--dry-run",
    ]),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("Unknown argument --provider"),
  });
});

async function startServer() {
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
    estimate: async () => 75_000,
    loadHistory: async () => ({
      events: [],
      health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
    }),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string")
    throw new Error("The test server did not report a port.");
  return {
    base: `http://127.0.0.1:${address.port}`,
    workdir: temp.path,
    queue,
    close: async () => {
      await app.close();
      await temp.cleanup();
    },
  };
}

const queueArgs = (workdir: string, ...extra: string[]) => [
  SCRIPT,
  "--title",
  "Rename the parser",
  "--prompt",
  PROMPT,
  "--workdir",
  workdir,
  ...extra,
];

it("queues an unscheduled task against the running dashboard and keeps the prompt off stdout", async () => {
  const server = await startServer();
  try {
    const { stdout } = await run(
      process.execPath,
      queueArgs(server.workdir, "--url", server.base),
    );
    expect(stdout).toContain("session 16%");
    expect(stdout).toContain("weekly 2%");
    expect(stdout).toContain("Any hour");
    expect(stdout).not.toMatch(/PRIVATE|parser and run/);
    const tasks = server.queue.snapshot().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Rename the parser",
      preferredWindowStart: null,
      maxTurns: 500,
      tokens: 75_000,
    });
    expect(stdout).toContain(`Queued ${tasks[0].id}`);
  } finally {
    await server.close();
  }
});

it("queues on the server named by SESSIONMAXXING_URL, not the old variable", async () => {
  const named = await startServer();
  const old = await startServer();
  try {
    const { stdout } = await run(process.execPath, queueArgs(named.workdir), {
      env: {
        ...process.env,
        SESSIONMAXXING_URL: named.base,
        CAPACITY_DASHBOARD_URL: old.base,
      },
    });
    expect(stdout.startsWith(`${named.base} ·`)).toBe(true);
    expect(named.queue.snapshot().tasks.map((task) => task.title)).toEqual([
      "Rename the parser",
    ]);
    expect(old.queue.snapshot().tasks).toHaveLength(0);
  } finally {
    await named.close();
    await old.close();
  }
});

it("lets --url override SESSIONMAXXING_URL", async () => {
  const flagged = await startServer();
  const fromEnv = await startServer();
  try {
    const { stdout } = await run(
      process.execPath,
      queueArgs(flagged.workdir, "--url", flagged.base),
      { env: { ...process.env, SESSIONMAXXING_URL: fromEnv.base } },
    );
    expect(stdout.startsWith(`${flagged.base} ·`)).toBe(true);
    expect(flagged.queue.snapshot().tasks).toHaveLength(1);
    expect(fromEnv.queue.snapshot().tasks).toHaveLength(0);
  } finally {
    await flagged.close();
    await fromEnv.close();
  }
});

async function closedPort() {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  if (address === null || typeof address === "string")
    throw new Error("The probe server did not report a port.");
  await new Promise((done) => probe.close(done));
  return address.port;
}

it("fails fast naming the URL and both ways to change it when --url is unreachable", async () => {
  const url = `http://127.0.0.1:${await closedPort()}`;
  const failure = await run(
    process.execPath,
    queueArgs("/srv/notes", "--url", url),
  ).then(
    () => {
      throw new Error("The script exited 0 against a closed port.");
    },
    (error: { code: number; stderr: string }) => error,
  );
  expect(failure.code).toBe(1);
  expect(failure.stderr).toContain(url);
  expect(failure.stderr).toContain("--url");
  expect(failure.stderr).toContain("SESSIONMAXXING_URL");
});

it("fails the same way when SESSIONMAXXING_URL is unreachable", async () => {
  const url = `http://127.0.0.1:${await closedPort()}`;
  await expect(
    run(process.execPath, queueArgs("/srv/notes"), {
      env: { ...process.env, SESSIONMAXXING_URL: url },
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(url),
  });
});

it("prints the server's own message when it answers with an HTTP error", async () => {
  const server = await startServer();
  try {
    await expect(
      run(
        process.execPath,
        queueArgs("/srv/not-a-real-dir", "--url", server.base),
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.not.stringContaining("SESSIONMAXXING_URL"),
    });
    expect(server.queue.snapshot().tasks).toHaveLength(0);
  } finally {
    await server.close();
  }
});

it("shows only the loopback default in --help", async () => {
  const { stdout } = await run(process.execPath, [SCRIPT, "--help"]);
  expect(stdout.match(/https?:\/\/[^\s,]+/g)).toEqual([
    "http://127.0.0.1:4317",
  ]);
});

it("leaves the output tokens for the server to estimate unless a number is given", async () => {
  const auto = await run(process.execPath, [
    SCRIPT,
    "--title",
    "Rename the parser",
    "--prompt",
    PROMPT,
    "--tokens",
    "auto",
    "--dry-run",
  ]);
  expect(JSON.parse(auto.stdout)).toMatchObject({
    tokens: "auto",
    maxTurns: 500,
  });
  const byDefault = await run(process.execPath, [
    SCRIPT,
    "--title",
    "Rename the parser",
    "--prompt",
    PROMPT,
    "--dry-run",
  ]);
  expect(JSON.parse(byDefault.stdout).tokens).toBe("auto");
});

const dryRunWorkdir = (workdir: string) =>
  run(process.execPath, [
    SCRIPT,
    "--title",
    "Rename the parser",
    "--prompt",
    PROMPT,
    "--workdir",
    workdir,
    "--dry-run",
  ]);

it("rewrites a Mac workdir inside a synced folder to its deltabeta path", async () => {
  const { stdout } = await dryRunWorkdir(
    "/Users/me/Documents/Personal/local_code/py/cs_detector",
  );
  expect(JSON.parse(stdout).workdir).toBe(
    "/home/user/syncthing/Personal/local_code/py/cs_detector",
  );
});

it("rewrites the synced folder root itself", async () => {
  const { stdout } = await dryRunWorkdir("/Users/me/.claude");
  expect(JSON.parse(stdout).workdir).toBe("/home/user/.claude");
});

it("rejects a Mac workdir outside every synced folder", async () => {
  await expect(
    dryRunWorkdir("/Users/me/code/repo"),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("not in a Syncthing folder"),
  });
});

it("rejects a Mac sibling whose name only starts with a synced folder name", async () => {
  await expect(
    dryRunWorkdir("/Users/me/Documents/PersonalArchive/repo"),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("not in a Syncthing folder"),
  });
});

it("leaves a deltabeta workdir unchanged", async () => {
  const { stdout } = await dryRunWorkdir("/home/user/maizetix");
  expect(JSON.parse(stdout).workdir).toBe("/home/user/maizetix");
});

it("rejects the Mac home directory itself", async () => {
  await expect(dryRunWorkdir("/Users/me")).rejects.toMatchObject({
    stderr: expect.stringContaining("not in a Syncthing folder"),
  });
});

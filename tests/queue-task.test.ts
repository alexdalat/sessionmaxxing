import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
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
import { TEST_WORKDIR_ROOT, temporary, usageSnapshot } from "./helpers";

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
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
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

const PATH_MAP = "SESSIONMAXXING_PATH_MAP";
const NOTES_MAP = "/Users/me/notes=/srv/notes";

const dryRunWorkdir = (workdir: string | null, map?: string, cwd?: string) => {
  const env = { ...process.env };
  delete env[PATH_MAP];
  if (map !== undefined) env[PATH_MAP] = map;
  return run(
    process.execPath,
    [
      SCRIPT,
      "--title",
      "Rename the parser",
      "--prompt",
      PROMPT,
      ...(workdir === null ? [] : ["--workdir", workdir]),
      "--dry-run",
    ],
    { env, cwd },
  );
};

const mappedWorkdir = async (workdir: string, map?: string) =>
  JSON.parse((await dryRunWorkdir(workdir, map)).stdout).workdir;

it("rewrites a workdir under a mapped prefix to the server's prefix", async () => {
  expect(await mappedWorkdir("/Users/me/notes/project/sub", NOTES_MAP)).toBe(
    "/srv/notes/project/sub",
  );
});

it("rewrites the mapped folder itself", async () => {
  expect(await mappedWorkdir("/Users/me/notes", NOTES_MAP)).toBe("/srv/notes");
});

it("rewrites a workdir given with a trailing slash on the map entry", async () => {
  expect(
    await mappedWorkdir("/Users/me/notes/a", "/Users/me/notes/=/srv/n/"),
  ).toBe("/srv/n/a");
});

it("uses the longest matching prefix whatever the entry order", async () => {
  const orders = [
    "/Users/me=/srv/home,/Users/me/notes=/srv/notes",
    "/Users/me/notes=/srv/notes,/Users/me=/srv/home",
  ];
  for (const map of orders) {
    expect(await mappedWorkdir("/Users/me/notes/project", map)).toBe(
      "/srv/notes/project",
    );
    expect(await mappedWorkdir("/Users/me/other/x", map)).toBe(
      "/srv/home/other/x",
    );
  }
});

it("leaves a sibling whose name only starts with a mapped folder name unchanged", async () => {
  expect(await mappedWorkdir("/Users/me/notes-archive/x", NOTES_MAP)).toBe(
    "/Users/me/notes-archive/x",
  );
});

it("sends a path matching no entry unchanged", async () => {
  expect(await mappedWorkdir("/srv/elsewhere/x", NOTES_MAP)).toBe(
    "/srv/elsewhere/x",
  );
});

it("rewrites nothing when the variable is unset or empty", async () => {
  expect(await mappedWorkdir("/Users/me/notes/x")).toBe("/Users/me/notes/x");
  expect(await mappedWorkdir("/Users/me/notes/x", "")).toBe(
    "/Users/me/notes/x",
  );
});

it("maps the current directory when no workdir is given", async () => {
  const temp = await temporary();
  try {
    const directory = await realpath(temp.path);
    const { stdout } = await dryRunWorkdir(
      null,
      `${directory}=/srv/mapped`,
      directory,
    );
    expect(JSON.parse(stdout).workdir).toBe("/srv/mapped");
  } finally {
    await temp.cleanup();
  }
});

it.each([
  ["an entry without =", "nopair"],
  ["an entry with two =", "/a=/b=/c"],
  ["a relative from side", "relative=/srv/x"],
  ["a relative to side", "/Users/me=relative"],
  ["an empty entry", "/Users/me=/srv/a,,/Users/other=/srv/b"],
  ["a repeated from", "/Users/me=/srv/a,/Users/me=/srv/b"],
  ["the filesystem root as from", "/=/srv/x"],
  ["the filesystem root as to", "/Users/me=/"],
])("fails loudly on a malformed map with %s", async (_label, map) => {
  await expect(dryRunWorkdir("/srv/elsewhere/x", map)).rejects.toMatchObject({
    stderr: expect.stringContaining(PATH_MAP),
  });
});

it("still rejects a relative workdir with the absolute-path message", async () => {
  await expect(dryRunWorkdir("project/sub", NOTES_MAP)).rejects.toMatchObject({
    stderr: expect.stringContaining("--workdir must be an absolute path"),
  });
});

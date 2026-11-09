import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import {
  TEST_TIME_ZONE,
  TEST_WORKDIR_ROOT,
  temporary,
  usageSnapshot,
} from "./helpers";

const run = promisify(execFile);
const SCRIPT = resolve("scripts/queue-task.mjs");
const PROMPT = "PRIVATE PROMPT: rename the parser and run pnpm test";
const UNKNOWN_EDITION = "enterprise-plus";

async function startLiteServer() {
  const temp = await temporary();
  const now = new Date("2026-09-06T12:00:00Z");
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT, "lite");
  const runner = await Runner.open(queue, temp.path);
  const usage = new UsageMonitor(
    async (at) => usageSnapshot({ fetchedAt: at.toISOString() }),
    await UsageHistoryStore.open(temp.path, now),
    () => now,
  );
  await usage.refresh();
  const app = await createApp({
    timeZone: TEST_TIME_ZONE,
    edition: "lite",
    queue,
    runner,
    usage,
    settings: await DispatchSettingsStore.open(temp.path),
    now: () => now,
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

const queueArgs = (workdir: string, base: string, ...extra: string[]) => [
  SCRIPT,
  "--title",
  "Rename the parser",
  "--prompt",
  PROMPT,
  "--workdir",
  workdir,
  "--url",
  base,
  ...extra,
];

const failureOf = (args: string[]) =>
  run(process.execPath, args).then(
    () => {
      throw new Error("The script exited 0.");
    },
    (error: { code: number; stderr: string }) => error,
  );

it("queues against a lite server without a token cost and prints no quiet part", async () => {
  const server = await startLiteServer();
  try {
    const { stdout } = await run(
      process.execPath,
      queueArgs(server.workdir, server.base),
    );
    expect(stdout).toContain("session 16%");
    expect(stdout).toContain("weekly 2%");
    expect(stdout).toMatch(/claude (ready|waiting)/);
    expect(stdout).not.toContain("quiet");
    expect(stdout).not.toMatch(/PRIVATE|parser and run/);
    const tasks = server.queue.snapshot().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Rename the parser",
      tokens: null,
    });
    expect(stdout).toContain(`Queued ${tasks[0].id}`);
  } finally {
    await server.close();
  }
});

it.each([
  ["a number", "50000"],
  ["auto", "auto"],
])(
  "refuses --tokens %s against a lite server and queues nothing",
  async (_label, tokens) => {
    const server = await startLiteServer();
    try {
      const failure = await failureOf(
        queueArgs(server.workdir, server.base, "--tokens", tokens),
      );
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain("lite");
      expect(failure.stderr).toContain("--tokens");
      expect(server.queue.snapshot().tasks).toHaveLength(0);
    } finally {
      await server.close();
    }
  },
);

it("stops naming the value when the server reports an unknown edition and posts nothing", async () => {
  let posts = 0;
  const stub = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST") posts++;
    if (request.url === "/api/environment")
      response.end(
        JSON.stringify({
          timeZone: "UTC",
          workdirRoot: "/",
          edition: UNKNOWN_EDITION,
        }),
      );
    else response.end(JSON.stringify({ snapshot: null, error: null }));
  });
  await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
  const address = stub.address();
  if (address === null || typeof address === "string")
    throw new Error("The stub server did not report a port.");
  try {
    const failure = await failureOf(
      queueArgs("/srv/notes", `http://127.0.0.1:${address.port}`),
    );
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain(UNKNOWN_EDITION);
    expect(posts).toBe(0);
  } finally {
    await new Promise((done) => stub.close(done));
  }
});

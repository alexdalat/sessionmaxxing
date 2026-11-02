import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { planDispatch } from "../server/dispatch.js";
import { gitIn } from "../server/git.js";
import { AUTO_APPLY_INSTRUCTION } from "../server/providers.js";
import { QueueStore } from "../server/queue.js";
import { LIMIT_STOP_ERROR, Runner } from "../server/runner.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchLoad,
  needsReview,
  type Task,
  type WeightedTokens,
} from "../shared/types.js";
import {
  fakeChild,
  SESSION_RATES,
  TEST_WORKDIR_ROOT,
  taskInput,
  temporary,
  usageSnapshot,
} from "./helpers";

const calibration = { rates: SESSION_RATES, error: null };
const serial = (load: DispatchLoad) =>
  planDispatch(
    { ...DEFAULT_DISPATCH_SETTINGS, maxConcurrentRuns: 1 },
    { snapshot: null, error: null },
    new Date(),
    undefined,
    load,
    calibration,
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

it("runs one task at a time with a single slot and persists safe run metadata and redacted logs on completion", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const a = await store.create(taskInput(temp.path));
    const b = await store.create(taskInput(temp.path));
    const child = fakeChild();
    const launch = vi.fn(() => child);
    const runner = await Runner.open(store, temp.path, { launch });
    runner.setPlanner(serial);
    const run = await runner.start(a.id);
    await expect(runner.start(b.id)).rejects.toThrow(/run slots/);
    expect(launch).toHaveBeenCalledTimes(1);
    child.stdout.write(
      '{"type":"assistant","message":{"content":"PRIVATE GENERATED","usage":{"output_tokens":7}}}\n',
    );
    expect(runner.list()[0].preview).toContain(
      "Assistant response · output tokens: 7",
    );
    child.emit("close", 0, null);
    await runner.waitForIdle();
    expect(store.snapshot().tasks.find((t) => t.id === a.id)?.status).toBe(
      "completed",
    );
    expect(runner.list()[0]).toMatchObject({
      status: "completed",
      exitCode: 0,
      taskId: a.id,
      durationMs: expect.any(Number),
    });
    const files = await readdir(`${temp.path}/runs`);
    expect(files.sort()).toEqual([`${run.id}.json`, `${run.id}.log`]);
    const disk = await readFile(`${temp.path}/runs/${run.id}.log`, "utf8");
    expect(disk).not.toMatch(/PRIVATE|prompt|GENERATED/);
    expect((await Runner.open(store, temp.path)).list()[0].status).toBe(
      "completed",
    );
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
it("keeps the queue recoverable when final run metadata persistence fails", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const child = fakeChild();
    const runner = await Runner.open(store, temp.path, { launch: () => child });
    await runner.start(task.id);
    await rename(`${temp.path}/runs`, `${temp.path}/runs-hidden`);
    await writeFile(`${temp.path}/runs`, "block final run writes");
    child.emit("close", 0, null);
    await runner.waitForIdle();
    expect(store.snapshot().tasks[0].status).toBe("completed");
    expect(runner.list()[0].status).toBe("completed");
    expect(runner.error).toMatch(/persist/i);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
it("cancels the process group, holds the execution slot until close, and records cancellation", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const child = fakeChild();
    child.pid = 12345;
    const signal = vi.fn();
    const runner = await Runner.open(store, temp.path, {
      launch: () => child,
      signal,
    });
    await runner.start(task.id);
    await runner.cancel(task.id);
    expect(signal).toHaveBeenCalledWith(-12345, "SIGTERM");
    expect(store.snapshot().tasks[0].status).toBe("running");
    await expect(runner.start(task.id)).rejects.toThrow(/pending/);
    child.emit("close", null, "SIGTERM");
    await runner.waitForIdle();
    expect(store.snapshot().tasks[0].status).toBe("cancelled");
    expect(runner.list()[0].status).toBe("cancelled");
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
it("kills processes the provider left running in its group when it exits", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const pidFile = join(temp.path, "straggler.pid");
    const runner = await Runner.open(store, temp.path, {
      launch: () =>
        spawn(
          "sh",
          ["-c", `sleep 300 >/dev/null 2>&1 & echo $! > "${pidFile}"`],
          { detached: true, stdio: ["ignore", "pipe", "pipe"] },
        ),
    });
    await runner.start(task.id);
    await runner.waitForIdle();
    const straggler = Number(await readFile(pidFile, "utf8"));
    await vi.waitFor(() =>
      expect(() => process.kill(straggler, 0)).toThrow(/ESRCH/),
    );
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
it("auto-dispatches only eligible preferred windows across midnight, respects earliest start and priority, and stops with the server", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const future = await store.create({
      ...taskInput(temp.path),
      earliestStart: "2026-09-08T00:00:00Z",
      preferredWindowStart: 23,
    });
    const outside = await store.create({
      ...taskInput(temp.path),
      preferredWindowStart: 10,
    });
    const eligible = await store.create({
      ...taskInput(temp.path),
      preferredWindowStart: 23,
      priority: 5,
    });
    const child = fakeChild();
    const launch = vi.fn(() => child);
    const runner = await Runner.open(store, temp.path, {
      launch,
      now: () => new Date("2026-09-06T05:30:00Z"),
    });
    runner.setPlanner(() =>
      planDispatch(
        DEFAULT_DISPATCH_SETTINGS,
        {
          snapshot: {
            fetchedAt: "2026-09-06T05:29:00Z",
            plan: "max",
            session: { percent: 10, resetsAt: "2026-09-06T09:00:00Z" },
            weekly: { percent: 5, resetsAt: "2026-09-12T00:00:00Z" },
            fable: null,
          },
          error: null,
        },
        new Date("2026-09-06T05:30:00Z"),
        undefined,
        undefined,
        calibration,
      ),
    );
    await runner.tick();
    expect(launch).not.toHaveBeenCalled();
    await store.setAutoDispatch(true);
    await Promise.all([runner.tick(), runner.tick()]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(runner.list()[0].taskId).toBe(eligible.id);
    expect(
      store
        .snapshot()
        .tasks.filter((t) => t.status === "pending")
        .map((t) => t.id),
    ).toEqual([future.id, outside.id]);
    child.emit("close", 0, null);
    await runner.waitForIdle();
    await runner.close();
    await store.create(taskInput(temp.path));
    await runner.tick();
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    await temp.cleanup();
  }
});
it("treats provider result errors as failure and returns a safe error when a launch fails", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const child = fakeChild();
    const runner = await Runner.open(store, temp.path, { launch: () => child });
    await runner.start(task.id);
    child.stdout.write(
      '{"type":"result","is_error":true,"result":"The provider gave up."}',
    );
    child.emit("close", 0, null);
    await runner.waitForIdle();
    expect(runner.list()[0].status).toBe("failed");
    await store.retry(task.id);
    const broken = await Runner.open(store, temp.path, {
      launch: () => {
        throw new Error("SECRET ENV_VALUE");
      },
    });
    await broken.start(task.id);
    await broken.waitForIdle();
    expect(broken.list()[0].status).toBe("failed");
    expect(JSON.stringify(broken.list())).not.toMatch(/SECRET|ENV_VALUE/);
    await broken.close();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
it("does not launch a provider if shutdown begins while a task claim is being persisted", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const claim = store.claim.bind(store);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, "claim").mockImplementation(async (id) => {
      await gate;
      return claim(id);
    });
    const child = fakeChild();
    const launch = vi.fn(() => child);
    const runner = await Runner.open(store, temp.path, { launch });
    const starting = runner.start(task.id);
    const closing = runner.close();
    release();
    await starting;
    if (launch.mock.calls.length) child.emit("close", 0);
    await runner.waitForIdle();
    await closing;
    expect(launch).not.toHaveBeenCalled();
    expect(store.snapshot().tasks[0].status).toBe("cancelled");
  } finally {
    await temp.cleanup();
  }
});
it("persists bounded redacted previews while a provider is still running", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const child = fakeChild();
    const runner = await Runner.open(store, temp.path, { launch: () => child });
    const run = await runner.start(task.id);
    child.stdout.write(
      '{"type":"assistant","message":{"content":"PRIVATE LIVE TEXT","usage":{"output_tokens":8}}}\n',
    );
    try {
      await vi.waitFor(
        async () => {
          const log = await readFile(`${temp.path}/runs/${run.id}.log`, "utf8");
          expect(log).toContain("output tokens: 8");
          expect(log).not.toContain("PRIVATE");
        },
        { timeout: 1500 },
      );
    } finally {
      child.emit("close", 0);
      await runner.waitForIdle();
      await runner.close();
    }
  } finally {
    await temp.cleanup();
  }
});

it("launches a Claude run under a generated session id it persists but never lists", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const child = fakeChild();
    const launch = vi.fn<
      (task: Task, sessionId: string | null) => typeof child
    >(() => child);
    const runner = await Runner.open(store, temp.path, { launch });
    const run = await runner.start(task.id);
    const sessionId = launch.mock.calls[0][1];
    expect(sessionId).toMatch(UUID);
    const metadata = JSON.parse(
      await readFile(`${temp.path}/runs/${run.id}.json`, "utf8"),
    );
    expect(metadata.sessionId).toBe(sessionId);
    expect(Object.keys(runner.list()[0])).not.toContain("sessionId");
    expect(JSON.stringify(runner.list())).not.toContain(sessionId);
    expect([...runner.dispatchedSessions()]).toEqual([sessionId]);
    child.emit("close", 0, null);
    await runner.waitForIdle();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("loads a run recorded before session ids were tracked and reports no dispatched session", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const id = "b".repeat(24);
    await mkdir(`${temp.path}/runs`, { recursive: true });
    await writeFile(
      `${temp.path}/runs/${id}.json`,
      JSON.stringify({
        id,
        taskId: "c".repeat(24),
        title: "Legacy run",
        provider: "claude",
        model: "opus",
        status: "completed",
        startedAt: "2026-09-01T10:00:00.000Z",
        endedAt: "2026-09-01T10:05:00.000Z",
        durationMs: 300_000,
        exitCode: 0,
        error: null,
      }),
    );
    await writeFile(`${temp.path}/runs/${id}.log`, JSON.stringify([]));
    const runner = await Runner.open(store, temp.path);
    expect([...runner.dispatchedSessions()]).toEqual([]);
    expect(runner.list()).toEqual([
      {
        id,
        taskId: "c".repeat(24),
        title: "Legacy run",
        prompt: null,
        estimatedTokens: null,
        model: "opus",
        status: "completed",
        startedAt: "2026-09-01T10:00:00.000Z",
        endedAt: "2026-09-01T10:05:00.000Z",
        durationMs: 300_000,
        exitCode: 0,
        error: null,
        tokens: null,
        sessionCostPercent: null,
        summary: null,
        changes: null,
        deploy: null,
        reviewedAt: null,
        preview: [],
      },
    ]);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

const RUN_TIME = new Date("2026-09-06T12:00:00Z");
const SESSION_TOKENS: WeightedTokens = {
  fable: 100_000,
  opus: 50_000,
  sonnet: 0,
  haiku: 0,
};

async function runWithTokens(
  temp: string,
  sessionTokens: (sessionId: string) => Promise<WeightedTokens>,
) {
  const store = await QueueStore.open(temp, TEST_WORKDIR_ROOT);
  const task = await store.create(taskInput(temp));
  const child = fakeChild();
  const runner = await Runner.open(store, temp, {
    launch: () => child,
    now: () => RUN_TIME,
    sessionTokens,
  });
  runner.setPlanner((load) =>
    planDispatch(
      DEFAULT_DISPATCH_SETTINGS,
      {
        snapshot: usageSnapshot({ fetchedAt: RUN_TIME.toISOString() }),
        error: null,
      },
      RUN_TIME,
      undefined,
      load,
      calibration,
    ),
  );
  await runner.start(task.id);
  child.emit("close", 0, null);
  await runner.waitForIdle();
  const run = runner.list()[0];
  const persisted = JSON.parse(
    await readFile(`${temp}/runs/${run.id}.json`, "utf8"),
  );
  const error = runner.error;
  await runner.close();
  return { run, persisted, error };
}

it("records no provider on a new run", async () => {
  const temp = await temporary();
  try {
    const { run, persisted } = await runWithTokens(
      temp.path,
      async () => SESSION_TOKENS,
    );
    expect(persisted).not.toHaveProperty("provider");
    expect(run).not.toHaveProperty("provider");
  } finally {
    await temp.cleanup();
  }
});

it("stores the tokens of a finished run and prices them at the current rates", async () => {
  const temp = await temporary();
  try {
    const sessions: string[] = [];
    const { run, persisted } = await runWithTokens(temp.path, async (id) => {
      sessions.push(id);
      return SESSION_TOKENS;
    });
    expect(run.tokens).toEqual(SESSION_TOKENS);
    expect(persisted.tokens).toEqual(SESSION_TOKENS);
    expect(run.sessionCostPercent).toBe(42.6);
    expect(persisted.sessionCostPercent).toBeUndefined();
    expect(sessions).toHaveLength(1);
  } finally {
    await temp.cleanup();
  }
});

it("leaves a run unmeasured when its transcript recorded no tokens", async () => {
  const temp = await temporary();
  try {
    const { run, persisted, error } = await runWithTokens(
      temp.path,
      async () => ({ fable: 0, opus: 0, sonnet: 0, haiku: 0 }),
    );
    expect(run.tokens).toBeNull();
    expect(run.sessionCostPercent).toBeNull();
    expect(persisted.tokens).toBeNull();
    expect(error).toBeNull();
  } finally {
    await temp.cleanup();
  }
});

it("pauses auto-dispatch when the tokens of a run cannot be read", async () => {
  const temp = await temporary();
  try {
    const { run, error } = await runWithTokens(temp.path, async () => {
      throw new Error("transcripts are unreadable");
    });
    expect(run.tokens).toBeNull();
    expect(run.status).toBe("completed");
    expect(error).toMatch(/tokens of the run/);
  } finally {
    await temp.cleanup();
  }
});

it("backfills the tokens of a saved run that has only output tokens", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const id = "b".repeat(24);
    const sessionId = "11111111-2222-3333-4444-555555555555";
    await mkdir(join(temp.path, "runs"), { recursive: true });
    await writeFile(
      join(temp.path, "runs", `${id}.json`),
      JSON.stringify({
        id,
        taskId: "c".repeat(24),
        title: "Saved run",
        provider: "claude",
        model: "opus",
        status: "completed",
        startedAt: "2026-09-01T10:00:00.000Z",
        endedAt: "2026-09-01T10:05:00.000Z",
        durationMs: 300_000,
        exitCode: 0,
        error: null,
        sessionCostPercent: 73,
        outputTokens: { fable: 0, opus: 1_200, sonnet: 0, haiku: 0 },
        sessionId,
      }),
    );
    await writeFile(join(temp.path, "runs", `${id}.log`), JSON.stringify([]));
    const asked: string[] = [];
    const runner = await Runner.open(store, temp.path, {
      sessionTokens: async (session) => {
        asked.push(session);
        return SESSION_TOKENS;
      },
    });
    runner.setPlanner(serial);
    expect(asked).toEqual([sessionId]);
    expect(runner.list()[0].tokens).toEqual(SESSION_TOKENS);
    const persisted = JSON.parse(
      await readFile(join(temp.path, "runs", `${id}.json`), "utf8"),
    );
    expect(persisted.tokens).toEqual(SESSION_TOKENS);
    expect(persisted.outputTokens).toBeUndefined();
    expect(persisted.sessionCostPercent).toBeUndefined();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("stores the summary and changed files of a finished run", async () => {
  const temp = await temporary();
  try {
    const workdir = join(temp.path, "repo");
    await mkdir(workdir);
    const git = gitIn(workdir);
    await git(["init", "-b", "main"]);
    await writeFile(`${workdir}/notes.md`, "one\n");
    await git(["add", "notes.md"]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "first",
    ]);
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(workdir));
    const child = fakeChild();
    const runner = await Runner.open(store, temp.path, { launch: () => child });
    const run = await runner.start(task.id);
    await appendFile(`${workdir}/notes.md`, "two\n");
    await writeFile(`${workdir}/extra.txt`, "new\n");
    child.stdout.write(
      '{"type":"result","is_error":false,"num_turns":3,"result":"Added a note."}\n',
    );
    child.emit("close", 0, null);
    await runner.waitForIdle();
    const finished = runner.list()[0];
    expect(finished.summary).toBe("Added a note.");
    expect(finished.changes).toEqual({
      branch: "main",
      commits: 0,
      files: [
        { path: "extra.txt", added: 0, removed: 0 },
        { path: "notes.md", added: 1, removed: 0 },
      ],
    });
    expect(needsReview(finished)).toBe(true);
    const persisted = JSON.parse(
      await readFile(`${temp.path}/runs/${run.id}.json`, "utf8"),
    );
    expect(persisted.summary).toBe("Added a note.");
    expect(persisted.changes.files).toHaveLength(2);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("appends the apply instruction to a dispatched prompt only while the override is on", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    let autoApply = false;
    const launched: string[] = [];
    const children: ReturnType<typeof fakeChild>[] = [];
    const launch = vi.fn((dispatched: Task) => {
      launched.push(dispatched.prompt);
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const runner = await Runner.open(store, temp.path, {
      launch,
      autoApply: () => autoApply,
    });
    const finish = async (id: string) => {
      await runner.start(id);
      children.at(-1)?.emit("close", 0, null);
      await runner.waitForIdle();
    };
    await finish(task.id);
    expect(launched[0]).toBe(task.prompt);

    autoApply = true;
    const second = await store.create(taskInput(temp.path));
    await finish(second.id);
    expect(launched[1]).toBe(`${task.prompt}\n\n${AUTO_APPLY_INSTRUCTION}`);
    expect(store.snapshot().tasks.find((t) => t.id === second.id)?.prompt).toBe(
      task.prompt,
    );
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
const SESSION_LIMIT_RESULT =
  '{"type":"result","is_error":true,"num_turns":41,"result":"You\'ve hit your session limit · resets 5:50am (America/New_York)"}\n';

it("puts a task stopped by the session limit back in line and resumes its Claude session on the next run", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const children = [fakeChild(), fakeChild()];
    const launch = vi.fn(
      (_task: Task, _sessionId: string | null, _resume: boolean) =>
        children[launch.mock.calls.length - 1],
    );
    const runner = await Runner.open(store, temp.path, { launch });
    await runner.start(task.id);
    children[0].stdout.write(SESSION_LIMIT_RESULT);
    children[0].emit("close", 1);
    await runner.waitForIdle();
    expect(store.snapshot().tasks[0].status).toBe("pending");
    expect(runner.list()[0]).toMatchObject({
      status: "failed",
      error: LIMIT_STOP_ERROR,
    });
    await runner.start(task.id);
    const [first, second] = launch.mock.calls;
    expect(first[1]).toMatch(UUID);
    expect(first[2]).toBe(false);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(true);
    children[1].stdout.write(
      '{"type":"result","is_error":false,"num_turns":3,"result":"Finished."}\n',
    );
    children[1].emit("close", 0);
    await runner.waitForIdle();
    expect(store.snapshot().tasks[0].status).toBe("completed");
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
it("starts a fresh Claude session when a retried task failed for another reason", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const children = [fakeChild(), fakeChild()];
    const launch = vi.fn(
      (_task: Task, _sessionId: string | null, _resume: boolean) =>
        children[launch.mock.calls.length - 1],
    );
    const runner = await Runner.open(store, temp.path, { launch });
    await runner.start(task.id);
    children[0].stdout.write(
      '{"type":"result","is_error":true,"result":"The provider gave up."}\n',
    );
    children[0].emit("close", 1);
    await runner.waitForIdle();
    expect(store.snapshot().tasks[0].status).toBe("failed");
    await store.retry(task.id);
    await runner.start(task.id);
    const [first, second] = launch.mock.calls;
    expect(second[1]).toMatch(UUID);
    expect(second[1]).not.toBe(first[1]);
    expect(second[2]).toBe(false);
    children[1].emit("close", 0);
    await runner.waitForIdle();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
it("keeps the usage-limit reason of a stopped run across a restart so its task still resumes", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    const child = fakeChild();
    const runner = await Runner.open(store, temp.path, { launch: () => child });
    await runner.start(task.id);
    child.stdout.write(SESSION_LIMIT_RESULT);
    child.emit("close", 1);
    await runner.waitForIdle();
    await runner.close();
    const resumed = fakeChild();
    const launch = vi.fn(
      (_task: Task, _sessionId: string | null, _resume: boolean) => resumed,
    );
    const restarted = await Runner.open(store, temp.path, { launch });
    expect(restarted.list()[0].error).toBe(LIMIT_STOP_ERROR);
    await restarted.start(task.id);
    expect(launch.mock.calls[0][2]).toBe(true);
    resumed.emit("close", 0);
    await restarted.waitForIdle();
    await restarted.close();
  } finally {
    await temp.cleanup();
  }
});

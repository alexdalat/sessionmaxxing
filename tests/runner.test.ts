import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { planDispatch } from "../server/dispatch.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { DEFAULT_DISPATCH_SETTINGS, type Task } from "../shared/types.js";
import { fakeChild, taskInput, temporary } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

it("runs one task at a time and persists safe run metadata and redacted logs on completion", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path);
    const a = await store.create(taskInput(temp.path));
    const b = await store.create(taskInput(temp.path));
    const child = fakeChild();
    const launch = vi.fn(() => child);
    const runner = await Runner.open(store, temp.path, { launch });
    const run = await runner.start(a.id);
    await expect(runner.start(b.id)).rejects.toThrow(/running/);
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
    const store = await QueueStore.open(temp.path);
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
    const store = await QueueStore.open(temp.path);
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
    await expect(runner.start(task.id)).rejects.toThrow(/running/);
    child.emit("close", null, "SIGTERM");
    await runner.waitForIdle();
    expect(store.snapshot().tasks[0].status).toBe("cancelled");
    expect(runner.list()[0].status).toBe("cancelled");
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
it("auto-dispatches only eligible preferred windows across midnight, respects earliest start and priority, and stops with the server", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path);
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
    const store = await QueueStore.open(temp.path);
    const task = await store.create(taskInput(temp.path));
    const child = fakeChild();
    const runner = await Runner.open(store, temp.path, { launch: () => child });
    await runner.start(task.id);
    child.stdout.write(
      '{"type":"result","is_error":true,"result":"PRIVATE ERROR"}',
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
    expect(JSON.stringify(broken.list())).not.toMatch(
      /PRIVATE|SECRET|ENV_VALUE/,
    );
    await broken.close();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});
it("does not launch a provider if shutdown begins while a task claim is being persisted", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path);
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
    const store = await QueueStore.open(temp.path);
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
    const store = await QueueStore.open(temp.path);
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

it("launches a Codex run without a session id and keeps it out of the dispatched sessions", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path);
    const task = await store.create({
      ...taskInput(temp.path),
      provider: "codex",
      model: "gpt-6-astra",
    });
    const child = fakeChild();
    const launch = vi.fn<
      (task: Task, sessionId: string | null) => typeof child
    >(() => child);
    const runner = await Runner.open(store, temp.path, { launch });
    const run = await runner.start(task.id);
    expect(launch.mock.calls[0][1]).toBeNull();
    expect(
      JSON.parse(await readFile(`${temp.path}/runs/${run.id}.json`, "utf8"))
        .sessionId,
    ).toBeNull();
    expect([...runner.dispatchedSessions()]).toEqual([]);
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
    const store = await QueueStore.open(temp.path);
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
        provider: "claude",
        model: "opus",
        status: "completed",
        startedAt: "2026-09-01T10:00:00.000Z",
        endedAt: "2026-09-01T10:05:00.000Z",
        durationMs: 300_000,
        exitCode: 0,
        error: null,
        preview: [],
      },
    ]);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

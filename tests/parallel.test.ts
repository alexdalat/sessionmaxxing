import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { planDispatch, taskGate } from "../server/dispatch.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { QueueStore } from "../server/queue.js";
import { Runner, SLOTS_BUSY_ERROR } from "../server/runner.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchLoad,
  type DispatchSettings,
  type PublicTask,
  type Task,
  type UsageSnapshot,
} from "../shared/types.js";
import {
  fakeChild,
  SESSION_RATES,
  sessionRates,
  TEST_TIME_ZONE,
  TEST_WORKDIR_ROOT,
  taskInput,
  temporary,
  usageSnapshot,
} from "./helpers";

const at = new Date("2026-09-06T12:00:00Z");
const now = () => at;
/** Reserves 25% at every hour so quiet-hours ranking never holds a task. */
const anyHour = {
  ...DEFAULT_DISPATCH_SETTINGS,
  sessionReservePercent: 25,
  busyHoursReservePercent: 25,
};
const planner =
  (settings: Partial<DispatchSettings> = {}, snapshot = usageSnapshot()) =>
  (load: DispatchLoad) =>
    planDispatch(
      { ...anyHour, ...settings },
      { snapshot, error: null },
      at,
      undefined,
      load,
      { rates: SESSION_RATES, error: null },
    );

async function repos(root: string, names: string[]) {
  const canonical = await realpath(root);
  const paths: Record<string, string> = {};
  for (const name of names) {
    paths[name] = join(canonical, name);
    await mkdir(join(paths[name], ".git"), { recursive: true });
  }
  return paths;
}
function children() {
  const byTask = new Map<string, ReturnType<typeof fakeChild>>();
  const launch = vi.fn((task: Task) => {
    const child = fakeChild();
    byTask.set(task.id, child);
    return child;
  });
  return {
    launch,
    of: (taskId: string) => {
      const child = byTask.get(taskId);
      if (!child) throw new Error("Task was never launched.");
      return child;
    },
  };
}
const statusOf = (store: QueueStore, taskId: string) =>
  store.snapshot().tasks.find((task) => task.id === taskId)?.status;

it("starts independent repositories together in queue order up to the slot limit and holds the rest", async () => {
  const temp = await temporary();
  try {
    const { a, b, c } = await repos(temp.path, ["a", "b", "c"]);
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const third = await store.create({ ...taskInput(c), priority: 2 });
    const first = await store.create({ ...taskInput(a), priority: 0 });
    const second = await store.create({ ...taskInput(b), priority: 1 });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    const plan = planner({ maxConcurrentRuns: 2 });
    runner.setPlanner(plan);
    await store.setAutoDispatch(true);
    await Promise.all([runner.tick(), runner.tick()]);
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(statusOf(store, third.id)).toBe("pending");
    const held = await runner.gate(
      store.snapshot().tasks[2],
      plan(runner.load()),
      at,
    );
    expect(held).toMatchObject({
      status: "waiting",
      reason: "All 2 run slots busy",
    });
    expect(held.blockedBy).toBeUndefined();
    expect(runner.load()).toMatchObject({ running: 2, claudeRuns: 2 });
    await runner.tick();
    expect(kids.launch).toHaveBeenCalledTimes(2);
    kids.of(first.id).emit("close", 0, null);
    await vi.waitFor(() => expect(statusOf(store, first.id)).toBe("completed"));
    await runner.tick();
    expect(kids.launch).toHaveBeenCalledTimes(3);
    expect(kids.launch.mock.calls[2][0].id).toBe(third.id);
    const running = runner
      .list()
      .filter((run) => run.status === "running")
      .map((run) => run.taskId)
      .sort();
    expect(running).toEqual([second.id, third.id].sort());
    kids.of(second.id).emit("close", 0, null);
    kids.of(third.id).emit("close", 0, null);
    await runner.waitForIdle();
    expect(runner.list().map((run) => run.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("holds a task whose repository is busy while a later independent task starts, then runs it once the repository frees", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    await mkdir(join(a, "sub"));
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const busy = await store.create({
      ...taskInput(a),
      title: "First in a",
      priority: 0,
    });
    const blocked = await store.create({
      ...taskInput(join(a, "sub")),
      priority: 1,
    });
    const other = await store.create({ ...taskInput(b), priority: 2 });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    const plan = planner({ maxConcurrentRuns: 2 });
    runner.setPlanner(plan);
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([
      busy.id,
      other.id,
    ]);
    const gate = await runner.gate(
      store
        .snapshot()
        .tasks.find((task) => task.id === blocked.id) as PublicTask,
      plan(runner.load()),
      at,
    );
    expect(gate).toMatchObject({
      status: "waiting",
      reason: "All 2 run slots busy",
    });
    kids.of(other.id).emit("close", 0, null);
    await vi.waitFor(() => expect(statusOf(store, other.id)).toBe("completed"));
    expect(
      await runner.gate(
        store
          .snapshot()
          .tasks.find((task) => task.id === blocked.id) as PublicTask,
        plan(runner.load()),
        at,
      ),
    ).toEqual({
      status: "waiting",
      reason: "Waits for “First in a” · same project",
      eligibleAt: at.toISOString(),
      blockedBy: "First in a",
    });
    await runner.tick();
    expect(kids.launch).toHaveBeenCalledTimes(2);
    kids.of(busy.id).emit("close", 0, null);
    await vi.waitFor(() => expect(statusOf(store, busy.id)).toBe("completed"));
    await runner.tick();
    expect(kids.launch.mock.calls[2][0].id).toBe(blocked.id);
    kids.of(blocked.id).emit("close", 0, null);
    await runner.waitForIdle();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("refuses Run now for nested, symlinked, and same-repository directories while their repository runs, but not for another repository", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    await mkdir(join(a, "nested", "deeper"), { recursive: true });
    await symlink(a, join(b, "..", "alias"));
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const holder = await store.create({ ...taskInput(a), title: "Holder" });
    const nested = await store.create(taskInput(join(a, "nested", "deeper")));
    const aliased = await store.create(taskInput(join(b, "..", "alias")));
    const parent = await store.create(taskInput(await realpath(temp.path)));
    const independent = await store.create(taskInput(b));
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    runner.setPlanner(planner({ maxConcurrentRuns: 4 }));
    await runner.start(holder.id);
    for (const task of [nested, aliased, parent])
      await expect(runner.start(task.id)).rejects.toThrow(
        "Waits for “Holder” · same project",
      );
    await runner.start(independent.id);
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([
      holder.id,
      independent.id,
    ]);
    kids.of(holder.id).emit("close", 0, null);
    kids.of(independent.id).emit("close", 0, null);
    await runner.waitForIdle();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("admits Claude tasks only while the session budget covers every running task's expected cost", async () => {
  const temp = await temporary();
  try {
    const { a, b, c } = await repos(temp.path, ["a", "b", "c"]);
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const first = await store.create({
      ...taskInput(a),
      tokens: 150_000,
      priority: 0,
    });
    const second = await store.create({
      ...taskInput(b),
      tokens: 150_000,
      priority: 1,
    });
    const third = await store.create({
      ...taskInput(c),
      tokens: 150_000,
      priority: 2,
    });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    const thirtyPercent = usageSnapshot({
      session: { percent: 30, resetsAt: "2026-09-06T16:09:00.000Z" },
    });
    const plan = planner({ maxConcurrentRuns: 3 }, thirtyPercent);
    runner.setPlanner(plan);
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([
      first.id,
      second.id,
    ]);
    const load = runner.load();
    expect(load).toMatchObject({
      running: 2,
      claudeRuns: 2,
      reserved: { session: 41.4, weekly: 6, fable: 0 },
    });
    const planning = plan(load);
    expect(planning.session).toEqual({
      percent: 30,
      ceiling: 75,
      pace: null,
      reserved: 41.4,
      ok: true,
    });
    // Polling folds what the running tasks have spent into the percent while their hold stands.
    const polled = planner(
      { maxConcurrentRuns: 3 },
      usageSnapshot({
        session: { percent: 45, resetsAt: "2026-09-06T16:09:00.000Z" },
      }),
    )(load);
    expect(polled.gate).toEqual({
      status: "waiting",
      reason:
        "Session 45% + 41.4% held for running tasks, over the 75% queue cutoff",
    });
    const thirdTask = store
      .snapshot()
      .tasks.find((task) => task.id === third.id) as PublicTask;
    expect(await runner.gate(thirdTask, planning, at)).toMatchObject({
      status: "waiting",
      reason: expect.stringMatching(
        /^Session 30% \+ 41\.4% held for running tasks \+ 20\.7% expected, over the 75% queue cutoff/,
      ),
    });
    const twoSlots = planner({ maxConcurrentRuns: 2 }, thirtyPercent)(load);
    expect(await runner.gate(thirdTask, twoSlots, at)).toMatchObject({
      status: "waiting",
      reason: "All 2 run slots busy",
    });
    await runner.tick();
    expect(kids.launch).toHaveBeenCalledTimes(2);
    expect(statusOf(store, third.id)).toBe("pending");
    for (const id of [first.id, second.id]) kids.of(id).emit("close", 0, null);
    await runner.waitForIdle();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("keeps serial behaviour with one slot: the second independent task waits for the first to finish", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const first = await store.create({ ...taskInput(a), priority: 0 });
    const second = await store.create({ ...taskInput(b), priority: 1 });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    runner.setPlanner(planner({ maxConcurrentRuns: 1 }));
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch).toHaveBeenCalledTimes(1);
    const planning = planner({ maxConcurrentRuns: 1 })(runner.load());
    expect(planning.gate).toEqual({
      status: "waiting",
      reason: "All 1 run slot busy",
    });
    expect(planning.session.reserved).toBe(13.8);
    await expect(runner.start(second.id)).rejects.toThrow(SLOTS_BUSY_ERROR);
    await runner.tick();
    expect(kids.launch).toHaveBeenCalledTimes(1);
    kids.of(first.id).emit("close", 0, null);
    await vi.waitFor(() => expect(statusOf(store, first.id)).toBe("completed"));
    await runner.tick();
    expect(kids.launch.mock.calls[1][0].id).toBe(second.id);
    kids.of(second.id).emit("close", 0, null);
    await runner.waitForIdle();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("cancels one run without touching the other", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const doomed = await store.create(taskInput(a));
    const survivor = await store.create(taskInput(b));
    const signal = vi.fn();
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: (task) => {
        const child = kids.launch(task);
        child.pid = task.id === doomed.id ? 111 : 222;
        return child;
      },
      signal,
      now,
    });
    await runner.start(doomed.id);
    await runner.start(survivor.id);
    await runner.cancel(doomed.id);
    expect(signal.mock.calls).toEqual([[-111, "SIGTERM"]]);
    kids.of(doomed.id).emit("close", null, "SIGTERM");
    await vi.waitFor(() =>
      expect(statusOf(store, doomed.id)).toBe("cancelled"),
    );
    expect(statusOf(store, survivor.id)).toBe("running");
    expect(
      runner.list().find((run) => run.taskId === survivor.id)?.status,
    ).toBe("running");
    await expect(runner.cancel(doomed.id)).rejects.toThrow(/not running/);
    kids
      .of(survivor.id)
      .stdout.write(
        '{"type":"assistant","message":{"usage":{"output_tokens":3}}}\n',
      );
    kids.of(survivor.id).emit("close", 0, null);
    await runner.waitForIdle();
    expect(
      runner.list().find((run) => run.taskId === survivor.id),
    ).toMatchObject({
      status: "completed",
      preview: ["Assistant response · output tokens: 3"],
    });
    expect(runner.error).toBeNull();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("records two runs that finish in the same tick without mixing their results", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const ok = await store.create({ ...taskInput(a), title: "Passes" });
    const bad = await store.create({ ...taskInput(b), title: "Fails" });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    const [okRun, badRun] = await Promise.all([
      runner.start(ok.id),
      runner.start(bad.id),
    ]);
    kids.of(ok.id).emit("close", 0, null);
    kids.of(bad.id).emit("close", 1, null);
    await runner.waitForIdle();
    expect(statusOf(store, ok.id)).toBe("completed");
    expect(statusOf(store, bad.id)).toBe("failed");
    expect(runner.error).toBeNull();
    for (const [run, status, exitCode] of [
      [okRun, "completed", 0],
      [badRun, "failed", 1],
    ] as const) {
      const disk = JSON.parse(
        await readFile(join(temp.path, "runs", `${run.id}.json`), "utf8"),
      );
      expect(disk).toMatchObject({
        id: run.id,
        taskId: run.taskId,
        title: run.title,
        status,
        exitCode,
      });
      expect(disk.endedAt).toBe(at.toISOString());
    }
    expect(runner.load()).toMatchObject({
      running: 0,
      lastRunEndedAt: at.toISOString(),
    });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("marks every run interrupted by a restart failed and keeps the rest of its metadata", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const first = await store.create(taskInput(a));
    const second = await store.create(taskInput(b));
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    const runs = [await runner.start(first.id), await runner.start(second.id)];
    const before = await Promise.all(
      runs.map(async (run) =>
        JSON.parse(
          await readFile(join(temp.path, "runs", `${run.id}.json`), "utf8"),
        ),
      ),
    );
    const later = new Date("2026-09-06T13:00:00Z");
    const reopenedStore = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const reopened = await Runner.open(reopenedStore, temp.path, {
      now: () => later,
    });
    expect(reopenedStore.snapshot().tasks.map((task) => task.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(reopened.list()).toHaveLength(2);
    for (const run of reopened.list())
      expect(run).toMatchObject({
        status: "failed",
        endedAt: later.toISOString(),
        error: "Server stopped before the run finished.",
      });
    for (const [index, run] of runs.entries()) {
      const after = JSON.parse(
        await readFile(join(temp.path, "runs", `${run.id}.json`), "utf8"),
      );
      expect(after).toEqual({
        ...before[index],
        status: "failed",
        endedAt: later.toISOString(),
        error: "Server stopped before the run finished.",
      });
    }
    expect([...reopened.dispatchedSessions()].sort()).toEqual(
      [before[0].sessionId, before[1].sessionId].sort(),
    );
    expect(reopened.load()).toMatchObject({ running: 0 });
    for (const task of [first, second]) kids.of(task.id).emit("close", 0);
    await runner.waitForIdle();
    await runner.close();
    await reopened.close();
  } finally {
    await temp.cleanup();
  }
});

it("reports slots, reservations, and the blocking run through the queue route", async () => {
  const temp = await temporary();
  const { a, b } = await repos(temp.path, ["a", "b"]);
  const monitor = new UsageMonitor(
    async (fetchedAt: Date) =>
      usageSnapshot({ fetchedAt: fetchedAt.toISOString() }),
    await UsageHistoryStore.open(temp.path, at),
    now,
  );
  const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
  const settings = await DispatchSettingsStore.open(temp.path);
  await settings.save({ ...anyHour, maxConcurrentRuns: 2 });
  const kids = children();
  const runner = await Runner.open(queue, temp.path, {
    launch: kids.launch,
    now,
  });
  const app = await createApp({
    timeZone: TEST_TIME_ZONE,
    queue,
    runner,
    settings,
    usage: monitor,
    now,
    sessionRates,
  });
  try {
    await monitor.refresh();
    const holder = await queue.create({ ...taskInput(a), title: "Holder" });
    await mkdir(join(a, "docs"));
    const blocked = await queue.create({
      ...taskInput(join(a, "docs")),
      priority: 1,
    });
    const free = await queue.create({ ...taskInput(b), priority: 2 });
    expect(
      (await app.inject({ method: "POST", url: `/api/tasks/${holder.id}/run` }))
        .statusCode,
    ).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: `/api/tasks/${blocked.id}/run`,
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toBe("Waits for “Holder” · same project");
    const snapshot = (await app.inject("/api/queue")).json();
    expect(snapshot.planning.load).toEqual({
      lastRunEndedAt: null,
      running: 1,
      claudeRuns: 1,
      reserved: { session: 13.8, weekly: 3, fable: 0 },
    });
    expect(snapshot.planning.session).toMatchObject({
      percent: 16,
      reserved: 13.8,
      ok: true,
    });
    expect(snapshot.planning.gate.reason).toBe(
      `Session 16% + 13.8% held for running tasks of 75% · Weekly 2% + 3% held for running tasks of ${snapshot.planning.weekly.ceiling}%`,
    );
    const gates = Object.fromEntries(
      snapshot.tasks.map((task: { id: string; gate: unknown }) => [
        task.id,
        task.gate,
      ]),
    );
    expect(gates[holder.id]).toMatchObject({ status: "running" });
    expect(gates[blocked.id]).toEqual({
      status: "waiting",
      reason: "Waits for “Holder” · same project",
      eligibleAt: at.toISOString(),
      blockedBy: "Holder",
    });
    expect(gates[free.id]).toMatchObject({ status: "ready" });
    expect(JSON.stringify(snapshot)).not.toContain("sessionId");
  } finally {
    for (const [task] of kids.launch.mock.calls)
      kids.of(task.id).emit("close", 0, null);
    await runner.waitForIdle();
    await app.close();
    await temp.cleanup();
  }
});

it("loads dispatch settings saved before concurrency existed and fills the new keys with defaults once", async () => {
  const temp = await temporary();
  const path = join(temp.path, "dispatch-settings.json");
  try {
    const legacy = {
      sessionReservePercent: 20,
      busyHoursReservePercent: 80,
      weeklyMarginPercent: 30,
      quietStartHours: 8,
    };
    await writeFile(path, JSON.stringify(legacy));
    const migrated = (await DispatchSettingsStore.open(temp.path)).snapshot();
    expect(migrated).toEqual({
      autoApply: false,
      keepSessionActive: false,
      ...legacy,
      maxConcurrentRuns: 2,
      runWeeklyCostPercent: 3,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(migrated);
    const custom = {
      ...migrated,
      maxConcurrentRuns: 1,
      runWeeklyCostPercent: 5,
    };
    await writeFile(path, JSON.stringify(custom));
    expect((await DispatchSettingsStore.open(temp.path)).snapshot()).toEqual(
      custom,
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(custom);
  } finally {
    await temp.cleanup();
  }
});

it("gates Fable tasks on Fable reservations and other Claude tasks on the weekly reservation alone", () => {
  const snapshot: UsageSnapshot = usageSnapshot({
    weekly: { percent: 30, resetsAt: "2026-09-10T00:00:00Z" },
    fable: { percent: 55, resetsAt: "2026-09-10T00:00:00Z" },
  });
  const settings = { ...anyHour, runWeeklyCostPercent: 10 };
  const pending = {
    id: "a".repeat(24),
    status: "pending" as const,
    model: "fable",
    preferredWindowStart: null,
    earliestStart: null,
    tokens: 20_000,
  };
  const oneFableRunning: DispatchLoad = {
    lastRunEndedAt: null,
    running: 1,
    claudeRuns: 1,
    reserved: { session: 20, weekly: 10, fable: 10 },
  };
  const planning = planDispatch(
    settings,
    { snapshot, error: null },
    at,
    undefined,
    oneFableRunning,
    { rates: SESSION_RATES, error: null },
  );
  expect(planning.weekly).toMatchObject({ percent: 30, ceiling: 60, ok: true });
  expect(planning.fable).toMatchObject({
    percent: 55,
    ceiling: 60,
    reserved: 10,
    ok: false,
  });
  expect(taskGate(pending, planning, at, [])).toMatchObject({
    status: "waiting",
    reason:
      "Fable weekly 55% + 10% held for running tasks, over the 60% queue cutoff",
  });
  expect(taskGate({ ...pending, model: "opus" }, planning, at, []).status).toBe(
    "ready",
  );
});

import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { planLite } from "../server/dispatch.js";
import { QueueStore } from "../server/queue.js";
import { RestartStore } from "../server/restarts.js";
import { Runner, restartReason, SLOTS_BUSY_ERROR } from "../server/runner.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchLoad,
  type DispatchSettings,
  type PublicTask,
  type Task,
} from "../shared/types.js";
import {
  fakeChild,
  TEST_TIME_ZONE,
  TEST_WORKDIR_ROOT,
  taskInput,
  temporary,
  usageSnapshot,
} from "./helpers";

const at = new Date("2026-09-06T12:00:00Z");
const now = () => at;
const SESSION_AT_BOUNDARY = 60;
const SESSION_OVER_CUTOFF = 90;
const RESERVE = 25;
const WEEKLY_HOLD = 3;
const sessionUsage = (percent: number) =>
  usageSnapshot({
    session: { percent, resetsAt: "2026-09-06T16:09:00.000Z" },
  });
const planner =
  (
    settings: Partial<DispatchSettings> = {},
    snapshot = sessionUsage(SESSION_AT_BOUNDARY),
  ) =>
  (load: DispatchLoad) =>
    planLite(
      {
        ...DEFAULT_DISPATCH_SETTINGS,
        sessionReservePercent: RESERVE,
        runWeeklyCostPercent: WEEKLY_HOLD,
        ...settings,
      },
      { snapshot, error: null },
      at,
      TEST_TIME_ZONE,
      load,
    );
const liteInput = (workdir: string) => ({
  ...taskInput(workdir),
  tokens: null,
});

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
    finishAll: async (runner: Runner) => {
      for (const child of byTask.values()) child.emit("close", 0, null);
      await runner.waitForIdle();
    },
  };
}
const taskOf = (store: QueueStore, taskId: string) =>
  store.snapshot().tasks.find((task) => task.id === taskId) as PublicTask;
const liteStore = (directory: string) =>
  QueueStore.open(directory, TEST_WORKDIR_ROOT, "lite");

it("starts a second lite task beside the first when the fixed hold still fits the cutoff", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await liteStore(temp.path);
    const first = await store.create({ ...liteInput(a), priority: 0 });
    const second = await store.create({ ...liteInput(b), priority: 1 });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      edition: "lite",
      now,
    });
    runner.setPlanner(planner({ runSessionHoldPercent: 10 }));
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(runner.load().reserved).toMatchObject({
      session: 20,
      weekly: 2 * WEEKLY_HOLD,
    });
    await kids.finishAll(runner);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("keeps a second lite task waiting when the fixed hold pushes the session over the cutoff", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await liteStore(temp.path);
    const first = await store.create({ ...liteInput(a), priority: 0 });
    const second = await store.create({ ...liteInput(b), priority: 1 });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      edition: "lite",
      now,
    });
    const plan = planner({ runSessionHoldPercent: 20 });
    runner.setPlanner(plan);
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([first.id]);
    expect(runner.load().reserved.session).toBe(20);
    expect(
      await runner.gate(taskOf(store, second.id), plan(runner.load()), at),
    ).toMatchObject({
      status: "waiting",
      reason:
        "Session 60% + 20% held for running tasks, over the 75% queue cutoff",
    });
    await kids.finishAll(runner);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("holds nothing for a lite task when the hold is zero", async () => {
  const temp = await temporary();
  try {
    const { a } = await repos(temp.path, ["a"]);
    const store = await liteStore(temp.path);
    await store.create(liteInput(a));
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      edition: "lite",
      now,
    });
    runner.setPlanner(planner({ runSessionHoldPercent: 0 }));
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch).toHaveBeenCalledTimes(1);
    expect(runner.load()).toMatchObject({
      running: 1,
      reserved: { session: 0 },
    });
    await kids.finishAll(runner);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("stores no tokens and no session cost for a finished lite run and releases its hold", async () => {
  const temp = await temporary();
  try {
    const { a } = await repos(temp.path, ["a"]);
    const store = await liteStore(temp.path);
    const task = await store.create(liteInput(a));
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      edition: "lite",
      now,
    });
    runner.setPlanner(planner({ runSessionHoldPercent: 15 }));
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(runner.load().reserved.session).toBe(15);
    kids.of(task.id).emit("close", 0, null);
    await runner.waitForIdle();
    const [run] = runner.list();
    expect(run).toMatchObject({
      status: "completed",
      tokens: null,
      sessionCostPercent: null,
    });
    expect(runner.load().reserved.session).toBe(0);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("blocks a lite task on its dependency ahead of the usage gate", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await liteStore(temp.path);
    const first = await store.create({
      ...liteInput(a),
      title: "Parse transcripts",
      priority: 0,
    });
    const second = await store.create({
      ...liteInput(b),
      priority: 1,
      dependsOn: [first.id],
    });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      edition: "lite",
      now,
    });
    const plan = planner({}, sessionUsage(SESSION_OVER_CUTOFF));
    runner.setPlanner(plan);
    expect(
      await runner.gate(taskOf(store, second.id), plan(runner.load()), at),
    ).toMatchObject({
      status: "waiting",
      reason: "Waits for “Parse transcripts”",
      blockedBy: "Parse transcripts",
    });
    await expect(runner.start(second.id)).rejects.toThrow(
      "Waits for “Parse transcripts”",
    );
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("never runs two lite tasks of one repository together", async () => {
  const temp = await temporary();
  try {
    const { a } = await repos(temp.path, ["a"]);
    await mkdir(join(a, "sub"));
    const store = await liteStore(temp.path);
    const holder = await store.create({
      ...liteInput(a),
      title: "First in a",
      priority: 0,
    });
    const blocked = await store.create({
      ...liteInput(join(a, "sub")),
      priority: 1,
    });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      edition: "lite",
      now,
    });
    const plan = planner({ runSessionHoldPercent: 10 });
    runner.setPlanner(plan);
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([
      holder.id,
    ]);
    expect(
      await runner.gate(taskOf(store, blocked.id), plan(runner.load()), at),
    ).toMatchObject({
      status: "waiting",
      reason: "Waits for “First in a” · same project",
      blockedBy: "First in a",
    });
    await kids.finishAll(runner);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("lets Run now start a lite task the usage gate holds and refuses once the slots are full", async () => {
  const temp = await temporary();
  try {
    const { a, b, c } = await repos(temp.path, ["a", "b", "c"]);
    const store = await liteStore(temp.path);
    const first = await store.create({ ...liteInput(a), priority: 0 });
    const second = await store.create({ ...liteInput(b), priority: 1 });
    const third = await store.create({ ...liteInput(c), priority: 2 });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      edition: "lite",
      now,
    });
    const plan = planner(
      { maxConcurrentRuns: 2 },
      sessionUsage(SESSION_OVER_CUTOFF),
    );
    runner.setPlanner(plan);
    expect(
      (await runner.gate(taskOf(store, first.id), plan(runner.load()), at))
        .status,
    ).toBe("waiting");
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch).not.toHaveBeenCalled();
    await runner.start(first.id);
    await runner.start(second.id);
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([
      first.id,
      second.id,
    ]);
    await expect(runner.start(third.id)).rejects.toThrow(SLOTS_BUSY_ERROR);
    await kids.finishAll(runner);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("holds the lite queue for a requested restart and refuses Run now with the same reason", async () => {
  const temp = await temporary();
  try {
    const { a } = await repos(temp.path, ["a"]);
    const title = "Deploy the dashboard";
    const seed = await RestartStore.open(temp.path, now);
    await seed.request({
      runId: "c".repeat(24),
      title,
      method: { kind: "command", argv: ["./restart.sh"] },
      workdir: a,
      requestedAt: at.toISOString(),
    });
    const store = await liteStore(temp.path);
    const task = await store.create(liteInput(a));
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      edition: "lite",
      now,
    });
    const plan = planner();
    runner.setPlanner(plan);
    expect(
      await runner.gate(taskOf(store, task.id), plan(runner.load()), at),
    ).toMatchObject({ status: "waiting", reason: restartReason(title) });
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch).not.toHaveBeenCalled();
    await expect(runner.start(task.id)).rejects.toThrow(restartReason(title));
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

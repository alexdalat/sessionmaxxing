import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { planDispatch } from "../server/dispatch.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchLoad,
  type Task,
} from "../shared/types.js";
import {
  fakeChild,
  SESSION_RATES,
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
const planner = (load: DispatchLoad) =>
  planDispatch(
    anyHour,
    { snapshot: usageSnapshot(), error: null },
    at,
    undefined,
    load,
    {
      rates: SESSION_RATES,
      error: null,
    },
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
const taskOf = (store: QueueStore, taskId: string) => {
  const task = store
    .snapshot()
    .tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error("Task is not queued.");
  return task;
};

it("holds a dependent task until the task it waits for completes", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await QueueStore.open(temp.path);
    const first = await store.create({
      ...taskInput(a),
      title: "Parse transcripts",
      priority: 0,
    });
    const second = await store.create({
      ...taskInput(b),
      title: "Chart the parse",
      priority: 1,
      dependsOn: [first.id],
    });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    runner.setPlanner(planner);
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([first.id]);
    expect(statusOf(store, second.id)).toBe("pending");
    expect(
      await runner.gate(taskOf(store, second.id), planner(runner.load()), at),
    ).toMatchObject({
      status: "waiting",
      reason: "Waits for “Parse transcripts”",
      eligibleAt: null,
      blockedBy: "Parse transcripts",
    });
    await expect(runner.start(second.id)).rejects.toThrow(
      "Waits for “Parse transcripts”",
    );
    kids.of(first.id).emit("close", 0, null);
    await vi.waitFor(() => expect(statusOf(store, first.id)).toBe("completed"));
    await runner.tick();
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([
      first.id,
      second.id,
    ]);
    kids.of(second.id).emit("close", 0, null);
    await runner.waitForIdle();
  } finally {
    await temp.cleanup();
  }
});

it("keeps a dependent task blocked when the task it waits for fails", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await QueueStore.open(temp.path);
    const first = await store.create({
      ...taskInput(a),
      title: "Parse transcripts",
      priority: 0,
    });
    const second = await store.create({
      ...taskInput(b),
      title: "Chart the parse",
      priority: 1,
      dependsOn: [first.id],
    });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    runner.setPlanner(planner);
    await store.setAutoDispatch(true);
    await runner.tick();
    kids.of(first.id).emit("close", 1, null);
    await vi.waitFor(() => expect(statusOf(store, first.id)).toBe("failed"));
    await runner.tick();
    expect(kids.launch).toHaveBeenCalledTimes(1);
    expect(
      await runner.gate(taskOf(store, second.id), planner(runner.load()), at),
    ).toMatchObject({
      status: "waiting",
      reason: "Blocked: “Parse transcripts” failed",
      blockedBy: "Parse transcripts",
    });
    await runner.waitForIdle();
  } finally {
    await temp.cleanup();
  }
});

it("dispatches a task whose dependency already completed", async () => {
  const temp = await temporary();
  try {
    const { a, b } = await repos(temp.path, ["a", "b"]);
    const store = await QueueStore.open(temp.path);
    const first = await store.create({ ...taskInput(a), priority: 0 });
    await store.claim(first.id);
    await store.finish(first.id, "completed");
    const second = await store.create({
      ...taskInput(b),
      priority: 1,
      dependsOn: [first.id],
    });
    const kids = children();
    const runner = await Runner.open(store, temp.path, {
      launch: kids.launch,
      now,
    });
    runner.setPlanner(planner);
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(kids.launch.mock.calls.map(([task]) => task.id)).toEqual([
      second.id,
    ]);
    expect(
      await runner.gate(taskOf(store, second.id), planner(runner.load()), at),
    ).toMatchObject({ status: "running" });
    kids.of(second.id).emit("close", 0, null);
    await runner.waitForIdle();
  } finally {
    await temp.cleanup();
  }
});

it("rejects a dependency on a task that is not queued", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path);
    await expect(
      store.create({
        ...taskInput(temp.path),
        dependsOn: ["0123456789abcdef01234567"],
      }),
    ).rejects.toThrow("no longer exists");
  } finally {
    await temp.cleanup();
  }
});

it("rejects a dependency that closes a cycle", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path);
    const first = await store.create(taskInput(temp.path));
    const second = await store.create({
      ...taskInput(temp.path),
      dependsOn: [first.id],
    });
    const third = await store.create({
      ...taskInput(temp.path),
      dependsOn: [second.id],
    });
    await expect(
      store.update(first.id, { dependsOn: [third.id] }),
    ).rejects.toThrow("cannot depend on itself");
    await expect(
      store.update(first.id, { dependsOn: [first.id] }),
    ).rejects.toThrow("cannot depend on itself");
    expect(taskOf(store, first.id).dependsOn).toEqual([]);
  } finally {
    await temp.cleanup();
  }
});

it("drops a deleted task from the tasks that depended on it", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path);
    const first = await store.create(taskInput(temp.path));
    const second = await store.create({
      ...taskInput(temp.path),
      dependsOn: [first.id],
    });
    await store.delete(first.id);
    expect(taskOf(store, second.id).dependsOn).toEqual([]);
    const reopened = await QueueStore.open(temp.path);
    expect(taskOf(reopened, second.id).dependsOn).toEqual([]);
  } finally {
    await temp.cleanup();
  }
});

it("keeps the dependencies of tasks stored before the feature existed empty", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path);
    const created = await store.create(taskInput(temp.path));
    const path = join(temp.path, "queue.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    for (const task of state.tasks) delete task.dependsOn;
    await writeFile(path, JSON.stringify(state));
    const reopened = await QueueStore.open(temp.path);
    expect(taskOf(reopened, created.id).dependsOn).toEqual([]);
  } finally {
    await temp.cleanup();
  }
});

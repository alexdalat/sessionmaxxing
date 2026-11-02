import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { QueueStore } from "../server/queue.js";
import type { Task } from "../shared/types.js";
import { TEST_WORKDIR_ROOT, taskInput, temporary } from "./helpers";

it("atomically creates private queue state and persists tasks while including prompts and workdirs in public views", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    expect(task).toMatchObject({
      title: "Fix a test",
      model: "opus",
      status: "pending",
      priority: 0,
    });
    const snapshot = store.snapshot();
    expect(snapshot.tasks[0].prompt).toBe(taskInput(temp.path).prompt);
    expect(snapshot.tasks[0].workdir).toBe(temp.path);
    const disk = JSON.parse(await readFile(`${temp.path}/queue.json`, "utf8"));
    expect(disk.tasks[0].prompt).toContain("PRIVATE PROMPT");
    expect(
      (await QueueStore.open(temp.path, TEST_WORKDIR_ROOT)).snapshot().tasks,
    ).toEqual(store.snapshot().tasks);
    expect(await readdir(temp.path)).toEqual(["queue.json"]);
    expect((await stat(`${temp.path}/queue.json`)).mode & 0o777).toBe(0o600);
  } finally {
    await temp.cleanup();
  }
});
it("rejects missing, relative, outside-root and symlink-escaped workdirs and malformed task fields", async () => {
  const { symlink } = await import("node:fs/promises");
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    await symlink("/etc", `${temp.path}/escape`);
    for (const workdir of [
      "relative",
      "/etc",
      dirname(TEST_WORKDIR_ROOT),
      `${temp.path}/missing`,
      `${temp.path}/escape`,
    ]) {
      await expect(store.create(taskInput(workdir))).rejects.toThrow(
        /directory/,
      );
    }
    for (const patch of [
      { title: "" },
      { prompt: "" },
      { model: "--bad" },
      { priority: -1 },
      { maxTurns: 0 },
      { preferredWindowStart: 24 },
      { earliestStart: "not-a-date" },
    ]) {
      await expect(
        store.create({ ...taskInput(temp.path), ...patch }),
      ).rejects.toThrow();
    }
    expect(store.snapshot().tasks).toHaveLength(0);
  } finally {
    await temp.cleanup();
  }
});
it("edits pending tasks, preserves omitted prompts, claims independently, retries failure and reorders priorities", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const [a, b] = await Promise.all([
      store.create(taskInput(temp.path)),
      store.create(taskInput(temp.path)),
    ]);
    expect(b.model).toBe("opus");
    await store.update(a.id, { title: "Updated title" });
    await store.reorder([b.id, a.id]);
    expect(store.snapshot().tasks.map((t) => t.id)).toEqual([b.id, a.id]);
    const results = await Promise.allSettled([
      store.claim(a.id),
      store.claim(b.id),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(store.snapshot().tasks.map((t) => t.status)).toEqual([
      "running",
      "running",
    ]);
    expect((results[0] as PromiseFulfilledResult<unknown>).value).toMatchObject(
      { prompt: taskInput(temp.path).prompt },
    );
    await expect(store.update(a.id, { title: "Cannot edit" })).rejects.toThrow(
      /pending/,
    );
    await expect(store.delete(a.id)).rejects.toThrow(/running/);
    await store.finish(a.id, "failed");
    await store.retry(a.id);
    await store.claim(a.id);
    await store.finish(a.id, "cancelled");
    await store.retry(a.id);
    await store.claim(a.id);
    await store.finish(a.id, "completed");
    await expect(store.retry(a.id)).rejects.toThrow(/failed or cancelled/);
    await store.finish(b.id, "completed");
    await store.delete(a.id);
    await store.delete(b.id);
    expect(store.snapshot().tasks).toHaveLength(0);
    expect(
      (await QueueStore.open(temp.path, TEST_WORKDIR_ROOT)).snapshot().tasks,
    ).toHaveLength(0);
  } finally {
    await temp.cleanup();
  }
});
it("keeps auto-dispatch on and recovers interrupted tasks on restart without overwriting corrupt state", async () => {
  const { writeFile } = await import("node:fs/promises");
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = await store.create(taskInput(temp.path));
    await store.setAutoDispatch(true);
    await store.claim(task.id);
    const restarted = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    expect(restarted.snapshot()).toMatchObject({
      autoDispatch: true,
      tasks: [{ status: "failed" }],
    });
    await writeFile(`${temp.path}/queue.json`, "{broken");
    await expect(
      QueueStore.open(temp.path, TEST_WORKDIR_ROOT),
    ).rejects.toThrow();
    expect(await readFile(`${temp.path}/queue.json`, "utf8")).toBe("{broken");
    await writeFile(
      `${temp.path}/queue.json`,
      '{"version":1,"tasks":[{"status":"pending"}]}',
    );
    await expect(
      QueueStore.open(temp.path, TEST_WORKDIR_ROOT),
    ).rejects.toThrow();
  } finally {
    await temp.cleanup();
  }
});
it("can reopen a task whose workdir is the root itself, and under a different root", async () => {
  const temp = await temporary();
  try {
    const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    await queue.create(taskInput(TEST_WORKDIR_ROOT));
    const reopened = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const task = reopened.snapshot().tasks[0];
    expect(task.workdir).toBe(TEST_WORKDIR_ROOT);
    expect((await reopened.claim(task.id)).workdir).toBe(TEST_WORKDIR_ROOT);
    const elsewhere = await QueueStore.open(temp.path, temp.path);
    expect(elsewhere.snapshot().tasks[0].workdir).toBe(TEST_WORKDIR_ROOT);
  } finally {
    await temp.cleanup();
  }
});

it("drops legacy budget estimates from saved tasks atomically without losing them", async () => {
  const temp = await temporary();
  try {
    const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    await queue.create(taskInput(temp.path));
    await queue.create(taskInput(temp.path));
    const path = `${temp.path}/queue.json`;
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...current,
        tasks: current.tasks.map((task: object) => ({
          ...task,
          budgetEstimate: 5,
        })),
      }),
    );
    const migrated = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    expect(migrated.snapshot().tasks).toHaveLength(2);
    for (const task of migrated.snapshot().tasks)
      expect(task).not.toHaveProperty("budgetEstimate");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(current);
    expect(await readdir(temp.path)).toEqual(["queue.json"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await temp.cleanup();
  }
});

it("converts tasks saved as a session percent or as output tokens into weighted tokens", async () => {
  const temp = await temporary();
  try {
    const queue = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    await queue.create(taskInput(temp.path));
    await queue.create({
      ...taskInput(temp.path),
      model: "claude-fable-5-1",
    });
    await queue.create({
      ...taskInput(temp.path),
      model: "claude-unknown-1",
    });
    const path = `${temp.path}/queue.json`;
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...current,
        tasks: current.tasks.map(
          ({ tokens: _tokens, ...task }: Task, index: number) =>
            index === 0
              ? { ...task, outputTokens: 100_000 }
              : { ...task, sessionCostPercent: 40 },
        ),
      }),
    );
    const migrated = (
      await QueueStore.open(temp.path, TEST_WORKDIR_ROOT)
    ).snapshot().tasks;
    // Output tokens count 4.8 times over; 40% of a session at the Fable rate of 357
    // points per million output tokens is 112,045 of them, and 289,855 at the Opus rate of 138.
    expect(migrated[0].tokens).toBe(480_000);
    expect(migrated[1].tokens).toBe(537_816);
    expect(migrated[2].tokens).toBe(1_391_304);
    for (const task of migrated) {
      expect(task).not.toHaveProperty("sessionCostPercent", expect.any(Number));
      expect(task).not.toHaveProperty("outputTokens");
    }
    const saved = JSON.parse(await readFile(path, "utf8")).tasks;
    expect(saved[0].tokens).toBe(480_000);
    expect(saved[0].outputTokens).toBeUndefined();
    expect(saved[1].tokens).toBe(537_816);
    expect(saved[1].sessionCostPercent).toBeUndefined();
  } finally {
    await temp.cleanup();
  }
});

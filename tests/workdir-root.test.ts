import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveWorkdirRoot } from "../server/environment.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { DomainError } from "../server/storage.js";
import { underRoot, validateWorkdir } from "../server/validation.js";
import { fakeChild, taskInput, temporary } from "./helpers";

const VARIABLE = "SESSIONMAXXING_WORKDIR_ROOT";

it("resolves the root variable through a symlink to the real directory", async () => {
  const temp = await temporary();
  try {
    await mkdir(`${temp.path}/real`);
    await symlink(`${temp.path}/real`, `${temp.path}/link`);
    const root = await resolveWorkdirRoot(
      { [VARIABLE]: `${temp.path}/link` },
      "/nonexistent-home",
    );
    expect(root).toBe(`${temp.path}/real`);
  } finally {
    await temp.cleanup();
  }
});
it("falls back to the real path of the home when the variable is unset", async () => {
  const temp = await temporary();
  try {
    await mkdir(`${temp.path}/real`);
    await symlink(`${temp.path}/real`, `${temp.path}/home`);
    expect(await resolveWorkdirRoot({}, `${temp.path}/home`)).toBe(
      `${temp.path}/real`,
    );
  } finally {
    await temp.cleanup();
  }
});
it("rejects a root that is missing, a file, relative or empty, naming the variable", async () => {
  const temp = await temporary();
  try {
    await writeFile(`${temp.path}/file`, "x");
    for (const value of [
      `${temp.path}/missing`,
      `${temp.path}/file`,
      "relative",
      "",
    ]) {
      const attempt = resolveWorkdirRoot({ [VARIABLE]: value }, temp.path);
      await expect(attempt).rejects.toBeInstanceOf(DomainError);
      await expect(attempt).rejects.toThrow(VARIABLE);
    }
  } finally {
    await temp.cleanup();
  }
});
it("names the variable as the way to set the boundary when the home does not exist", async () => {
  const temp = await temporary();
  try {
    const attempt = resolveWorkdirRoot({}, `${temp.path}/no-home`);
    await expect(attempt).rejects.toBeInstanceOf(DomainError);
    await expect(attempt).rejects.toThrow(VARIABLE);
  } finally {
    await temp.cleanup();
  }
});

it("accepts a directory below the root and the root itself, returning real paths", async () => {
  const temp = await temporary();
  try {
    await mkdir(`${temp.path}/root/project`, { recursive: true });
    const root = `${temp.path}/root`;
    expect(await validateWorkdir(`${root}/project`, root)).toBe(
      `${root}/project`,
    );
    expect(await validateWorkdir(root, root)).toBe(root);
  } finally {
    await temp.cleanup();
  }
});
it("accepts a child directory whose name starts with two dots", async () => {
  const temp = await temporary();
  try {
    await mkdir(`${temp.path}/root/..hidden`, { recursive: true });
    const root = `${temp.path}/root`;
    expect(await validateWorkdir(`${root}/..hidden`, root)).toBe(
      `${root}/..hidden`,
    );
  } finally {
    await temp.cleanup();
  }
});
it("rejects the parent, a prefix-named sibling, a symlink out, a relative path, a missing path and a file, saying the directory must be under the root", async () => {
  const temp = await temporary();
  try {
    const root = `${temp.path}/root`;
    await mkdir(root);
    await mkdir(`${temp.path}/root-sibling`);
    await mkdir(`${temp.path}/outside`);
    await symlink(`${temp.path}/outside`, `${root}/escape`);
    await writeFile(`${root}/file`, "x");
    for (const path of [
      temp.path,
      `${temp.path}/root-sibling`,
      `${root}/escape`,
      "relative",
      `${root}/missing`,
      `${root}/file`,
    ]) {
      const attempt = validateWorkdir(path, root);
      await expect(attempt).rejects.toBeInstanceOf(DomainError);
      await expect(attempt).rejects.toThrow(`under ${root}`);
    }
  } finally {
    await temp.cleanup();
  }
});
it("tells inside from outside by path segments", () => {
  expect(underRoot("/a/b", "/a/b")).toBe(true);
  expect(underRoot("/a/b/c", "/a/b")).toBe(true);
  expect(underRoot("/a/b/..c", "/a/b")).toBe(true);
  expect(underRoot("/a", "/a/b")).toBe(false);
  expect(underRoot("/a/b-sibling", "/a/b")).toBe(false);
  expect(underRoot("/x/y", "/a/b")).toBe(false);
});

it("reopens stored tasks under a different root and still returns their workdir", async () => {
  const temp = await temporary();
  try {
    const rootA = `${temp.path}/a`;
    const rootB = `${temp.path}/b`;
    await mkdir(`${rootA}/project`, { recursive: true });
    await mkdir(rootB);
    const store = await QueueStore.open(temp.path, rootA);
    const task = await store.create(taskInput(`${rootA}/project`));
    const reopened = await QueueStore.open(temp.path, rootB);
    expect(reopened.snapshot().tasks.map((t) => t.workdir)).toEqual([
      `${rootA}/project`,
    ]);
    expect((await reopened.claim(task.id)).workdir).toBe(`${rootA}/project`);
  } finally {
    await temp.cleanup();
  }
});
it("rejects creating or editing a task outside the current root", async () => {
  const temp = await temporary();
  try {
    const rootA = `${temp.path}/a`;
    const rootB = `${temp.path}/b`;
    await mkdir(rootA);
    await mkdir(rootB);
    const store = await QueueStore.open(temp.path, rootB);
    await expect(store.create(taskInput(rootA))).rejects.toThrow(
      `under ${rootB}`,
    );
    const task = await store.create(taskInput(rootB));
    await expect(store.update(task.id, { workdir: rootA })).rejects.toThrow(
      `under ${rootB}`,
    );
  } finally {
    await temp.cleanup();
  }
});
it("refuses to open a queue whose task has a relative workdir", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, temp.path);
    await store.create(taskInput(temp.path));
    const path = join(temp.path, "queue.json");
    const disk = JSON.parse(await readFile(path, "utf8"));
    disk.tasks[0].workdir = "relative";
    await writeFile(path, JSON.stringify(disk));
    await expect(QueueStore.open(temp.path, temp.path)).rejects.toThrow(
      "Queue task metadata is invalid.",
    );
  } finally {
    await temp.cleanup();
  }
});

it("fails the run of a stored task that lies outside the current root, explaining why", async () => {
  const temp = await temporary();
  try {
    const rootA = `${temp.path}/a`;
    const rootB = `${temp.path}/b`;
    await mkdir(rootA);
    await mkdir(rootB);
    const first = await QueueStore.open(temp.path, rootA);
    const task = await first.create(taskInput(rootA));
    const store = await QueueStore.open(temp.path, rootB);
    const launched: string[] = [];
    const runner = await Runner.open(store, temp.path, {
      launch: (started) => {
        launched.push(started.workdir);
        return fakeChild();
      },
    });
    const run = await runner.start(task.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain(`under ${rootB}`);
    expect(store.snapshot().tasks[0].status).toBe("failed");
    expect(launched).toEqual([]);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

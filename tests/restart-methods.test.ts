import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { gitIn } from "../server/git.js";
import { QueueStore } from "../server/queue.js";
import { RESTART_METHODS_FILE } from "../server/restart-methods.js";
import { Runner } from "../server/runner.js";
import {
  RESTART_ARG_MAX,
  RESTART_ARGV_MAX,
  type RestartMethod,
} from "../shared/types.js";
import {
  fakeChild,
  fakeCommand,
  TEST_TIME_ZONE,
  TEST_WORKDIR_ROOT,
  taskInput,
  temporary,
} from "./helpers";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
const COMMAND: RestartMethod = {
  kind: "command",
  argv: ["./restart.sh", "two words"],
};
const WORKDIR_MESSAGE = `Work directory must be an existing absolute directory under ${TEST_WORKDIR_ROOT}.`;

async function dashboard(temp: string) {
  const data = join(temp, "data");
  const project = join(temp, "project");
  await mkdir(project, { recursive: true });
  const git = gitIn(project);
  await git(["init", "-b", "main"]);
  await writeFile(join(project, "notes.md"), "one\n");
  await git(["add", "."]);
  await git([...IDENTITY, "commit", "-m", "first"]);
  const store = await QueueStore.open(data, TEST_WORKDIR_ROOT);
  const command = fakeCommand();
  let child = fakeChild();
  const runner = await Runner.open(store, data, {
    launch: () => {
      child = fakeChild();
      return child;
    },
    autoApply: () => true,
    restart: { spawn: command.spawn },
  });
  const app = await createApp({
    timeZone: TEST_TIME_ZONE,
    queue: store,
    runner,
  });
  const read = (workdir: string) =>
    app.inject({
      method: "GET",
      url: `/api/restart-methods?workdir=${encodeURIComponent(workdir)}`,
    });
  const write = (payload: unknown) =>
    app.inject({ method: "PUT", url: "/api/restart-methods", payload });
  const stored = () => readFile(join(data, RESTART_METHODS_FILE), "utf8");
  return {
    data,
    project,
    store,
    runner,
    app,
    command,
    read,
    write,
    stored,
    finishRun: async () => {
      const task = await store.create(taskInput(project));
      const started = await runner.start(task.id);
      await appendFile(join(project, "notes.md"), "two\n");
      child.emit("close", 0, null);
      await runner.waitForIdle();
      return started;
    },
  };
}

it("runs the method set through the API after an applied run that changes the directory", async () => {
  const temp = await temporary();
  const { app, project, write, read, command, finishRun } = await dashboard(
    temp.path,
  );
  try {
    const workdir = await realpath(project);
    const saved = await write({ workdir: project, method: COMMAND });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ method: COMMAND });
    expect((await read(project)).json()).toEqual({ method: COMMAND });
    const started = await finishRun();
    await vi.waitFor(async () => {
      const { runs } = (await app.inject("/api/runs")).json();
      expect(
        runs.find((run: { id: string }) => run.id === started.id).restart,
      ).toMatchObject({ status: "succeeded" });
    });
    expect(
      command.calls.map(({ command, args, options }) => [
        command,
        args,
        options.cwd,
      ]),
    ).toEqual([["./restart.sh", ["two words"], workdir]]);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("answers none for a directory without an entry and removes the entry when none is set", async () => {
  const temp = await temporary();
  const { app, project, write, read, stored } = await dashboard(temp.path);
  try {
    expect((await read(project)).json()).toEqual({ method: { kind: "none" } });
    await write({ workdir: project, method: { kind: "compose" } });
    expect(JSON.parse(await stored()).methods).toEqual({
      [await realpath(project)]: { kind: "compose" },
    });
    const cleared = await write({
      workdir: project,
      method: { kind: "none" },
    });
    expect(cleared.json()).toEqual({ method: { kind: "none" } });
    expect(JSON.parse(await stored()).methods).toEqual({});
    expect((await read(project)).json()).toEqual({ method: { kind: "none" } });
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("stores a method set through a symlink under the real path", async () => {
  const temp = await temporary();
  const { app, project, write, read } = await dashboard(temp.path);
  try {
    const link = join(temp.path, "link");
    await symlink(project, link);
    await write({ workdir: link, method: COMMAND });
    expect((await read(await realpath(project))).json()).toEqual({
      method: COMMAND,
    });
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it("returns a stored method after the runner is opened again on the same data directory", async () => {
  const temp = await temporary();
  const { app, project, write, data, store } = await dashboard(temp.path);
  try {
    await write({ workdir: project, method: COMMAND });
    const reopened = await Runner.open(store, data);
    expect(reopened.restartMethods.get(await realpath(project))).toEqual(
      COMMAND,
    );
    await reopened.close();
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

const argument = (length: number) => "a".repeat(length);
const invalidMethods: [string, unknown][] = [
  ["no arguments", { kind: "command", argv: [] }],
  [
    "too many arguments",
    { kind: "command", argv: Array(RESTART_ARGV_MAX + 1).fill("a") },
  ],
  ["an empty argument", { kind: "command", argv: ["./run", ""] }],
  [
    "a too long argument",
    { kind: "command", argv: [argument(RESTART_ARG_MAX + 1)] },
  ],
  ["a NUL character", { kind: "command", argv: ["a\u0000b"] }],
  ["a line feed", { kind: "command", argv: ["a\nb"] }],
  ["a carriage return", { kind: "command", argv: ["a\rb"] }],
  ["none with arguments", { kind: "none", argv: [] }],
  ["an unknown kind", { kind: "restart" }],
  ["no method", undefined],
];
it.each(invalidMethods)(
  "rejects %s and leaves the stored methods unchanged",
  async (_name, method) => {
    const temp = await temporary();
    const { app, project, write, stored } = await dashboard(temp.path);
    try {
      await write({ workdir: project, method: COMMAND });
      const before = await stored();
      const response = await write({ workdir: project, method });
      expect(response.statusCode).toBe(400);
      expect(await stored()).toBe(before);
    } finally {
      await app.close();
      await temp.cleanup();
    }
  },
);

const validLimits: [string, RestartMethod][] = [
  ["one argument", { kind: "command", argv: ["a"] }],
  [
    "the most arguments",
    { kind: "command", argv: Array(RESTART_ARGV_MAX).fill("a") },
  ],
  [
    "the longest argument",
    { kind: "command", argv: [argument(RESTART_ARG_MAX)] },
  ],
];
it.each(validLimits)("stores %s", async (_name, method) => {
  const temp = await temporary();
  const { app, project, write, read } = await dashboard(temp.path);
  try {
    expect((await write({ workdir: project, method })).statusCode).toBe(200);
    expect((await read(project)).json()).toEqual({ method });
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

it.each([
  ["a relative path", () => "relative/path"],
  ["a missing directory", (project: string) => join(project, "missing")],
  ["a directory outside the work-directory root", () => "/"],
])(
  "answers 400 with the work directory message for %s",
  async (_name, pick) => {
    const temp = await temporary();
    const { app, project, write, read, stored } = await dashboard(temp.path);
    try {
      const workdir = pick(project);
      const got = await read(workdir);
      expect(got.statusCode).toBe(400);
      expect(got.json().error).toBe(WORKDIR_MESSAGE);
      const put = await write({ workdir, method: COMMAND });
      expect(put.statusCode).toBe(400);
      expect(put.json().error).toBe(WORKDIR_MESSAGE);
      expect(JSON.parse(await stored()).methods).toEqual({});
    } finally {
      await app.close();
      await temp.cleanup();
    }
  },
);

it("answers 400 to a read without a work directory", async () => {
  const temp = await temporary();
  const { app } = await dashboard(temp.path);
  try {
    const response = await app.inject("/api/restart-methods");
    expect(response.statusCode).toBe(400);
  } finally {
    await app.close();
    await temp.cleanup();
  }
});

import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { QueueStore } from "../server/queue.js";
import { OUTPUT_CAP_BYTES } from "../server/restarts.js";
import { Runner } from "../server/runner.js";
import {
  fakeChild,
  fakeCommand,
  TEST_WORKDIR_ROOT,
  taskInput,
  temporary,
} from "./helpers";

const FIXTURES = join("tests", "fixtures", "restart");
const RUN_TITLE = "Imported run";

const fixture = (name: string) => readFile(join(FIXTURES, name), "utf8");
const succeeded = async () =>
  JSON.parse(await fixture("succeeded-result.json"));
const failed = async () => JSON.parse(await fixture("failed-result.json"));

async function install(temp: { path: string }) {
  const data = join(temp.path, "data");
  const withCompose = join(temp.path, "with-compose");
  const plain = join(temp.path, "plain");
  await mkdir(withCompose, { recursive: true });
  await mkdir(plain, { recursive: true });
  await writeFile(join(withCompose, "compose.yaml"), "services: {}\n");
  const store = await QueueStore.open(data, TEST_WORKDIR_ROOT);
  const composeTask = await store.create(taskInput(withCompose));
  const plainTask = await store.create(taskInput(plain));
  return { data, withCompose, plain, store, composeTask, plainTask };
}

async function writeRun(data: string, runId: string, taskId: string) {
  await mkdir(join(data, "runs"), { recursive: true });
  await writeFile(
    join(data, "runs", `${runId}.json`),
    JSON.stringify({
      id: runId,
      taskId,
      title: RUN_TITLE,
      model: "opus",
      status: "completed",
      startedAt: "2026-09-01T10:00:00.000Z",
      endedAt: "2026-09-01T10:05:00.000Z",
      durationMs: 300_000,
      exitCode: 0,
      error: null,
    }),
  );
  await writeFile(join(data, "runs", `${runId}.log`), JSON.stringify([]));
}

async function writeResult(
  data: string,
  result: { runId: string },
  log?: string,
) {
  const folder = join(data, "deploy", "results");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${result.runId}.json`), JSON.stringify(result));
  if (log !== undefined)
    await writeFile(join(folder, `${result.runId}.log`), log);
}

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

it("gives Compose directories a Compose method, imports old deploy results and removes the deploy folder", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    const ok = await succeeded();
    const bad = await failed();
    const log = await fixture("failed-result.log");
    await writeRun(setup.data, ok.runId, setup.composeTask.id);
    await writeRun(setup.data, bad.runId, setup.plainTask.id);
    await writeResult(setup.data, ok);
    await writeResult(setup.data, bad, log);

    const runner = await Runner.open(setup.store, setup.data);

    const composeDirectory = await realpath(setup.withCompose);
    const plainDirectory = await realpath(setup.plain);
    expect(runner.restartMethods.get(composeDirectory)).toEqual({
      kind: "compose",
    });
    expect(runner.restartMethods.get(plainDirectory)).toEqual({ kind: "none" });
    expect(await readJson(join(setup.data, "restart-methods.json"))).toEqual({
      version: 1,
      methods: { [composeDirectory]: { kind: "compose" } },
    });

    const restartOf = (runId: string) =>
      runner.list().find((run) => run.id === runId)?.restart;
    expect(restartOf(ok.runId)).toEqual({
      status: "succeeded",
      updatedAt: ok.updatedAt,
      output: null,
    });
    expect(restartOf(bad.runId)).toEqual({
      status: "failed",
      updatedAt: bad.updatedAt,
      output: log,
    });

    expect(
      await readJson(join(setup.data, "restarts", `${ok.runId}.json`)),
    ).toEqual({
      runId: ok.runId,
      title: RUN_TITLE,
      workdir: setup.composeTask.workdir,
      method: { kind: "compose" },
      status: "succeeded",
      requestedAt: ok.updatedAt,
      updatedAt: ok.updatedAt,
      output: null,
      sibling: null,
    });
    expect(
      (await readJson(join(setup.data, "restarts", `${bad.runId}.json`)))
        .workdir,
    ).toBe(setup.plainTask.workdir);
    expect(await exists(join(setup.data, "deploy"))).toBe(false);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("runs once, so a Compose file added later leaves the directory at none", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    const first = await Runner.open(setup.store, setup.data);
    await first.close();
    await writeFile(join(setup.plain, "compose.yaml"), "services: {}\n");

    const second = await Runner.open(setup.store, setup.data);

    expect(second.restartMethods.get(await realpath(setup.plain))).toEqual({
      kind: "none",
    });
    expect(
      second.restartMethods.get(await realpath(setup.withCompose)),
    ).toEqual({ kind: "compose" });
    await second.close();
  } finally {
    await temp.cleanup();
  }
});

const tree = (path: string) =>
  readdir(path, { recursive: true }).then((names) => names.sort());

const importedRecord = (
  result: { runId: string; updatedAt: string },
  workdir: string | null,
  status: "succeeded" | "failed",
  output: string | null,
) => ({
  runId: result.runId,
  title: RUN_TITLE,
  workdir,
  method: { kind: "compose" },
  status,
  requestedAt: result.updatedAt,
  updatedAt: result.updatedAt,
  output,
  sibling: null,
});

it("refuses to start while a deploy request is pending and leaves the data directory as it was", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    const ok = await succeeded();
    await writeRun(setup.data, ok.runId, setup.composeTask.id);
    await writeResult(setup.data, ok);
    const request = join(setup.data, "deploy", "requests", `${ok.runId}.json`);
    await mkdir(join(setup.data, "deploy", "requests"), { recursive: true });
    await writeFile(request, "{}");
    const before = await tree(setup.data);

    await expect(Runner.open(setup.store, setup.data)).rejects.toThrow(
      new RegExp(`${request}.*host watcher.*delete`),
    );

    expect(await tree(setup.data)).toEqual(before);
  } finally {
    await temp.cleanup();
  }
});

it.each([
  ["is not JSON", () => "not json"],
  [
    "has an extra key",
    (result: object) => JSON.stringify({ ...result, extra: 1 }),
  ],
  [
    "names another run id",
    (result: object) => JSON.stringify({ ...result, runId: "a".repeat(24) }),
  ],
  [
    "has an unknown status",
    (result: object) => JSON.stringify({ ...result, status: "done" }),
  ],
])("refuses to start when a deploy result %s", async (_name, corrupt) => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    const ok = await succeeded();
    const bad = await failed();
    await writeRun(setup.data, ok.runId, setup.composeTask.id);
    await writeRun(setup.data, bad.runId, setup.plainTask.id);
    await writeResult(setup.data, ok);
    await writeResult(setup.data, bad, await fixture("failed-result.log"));
    const file = join(setup.data, "deploy", "results", `${bad.runId}.json`);
    await writeFile(file, corrupt(bad));
    const before = await tree(setup.data);

    await expect(Runner.open(setup.store, setup.data)).rejects.toThrow(file);

    expect(await tree(setup.data)).toEqual(before);
  } finally {
    await temp.cleanup();
  }
});

it("imports a deploying result as failed with the interruption output", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    const ok = { ...(await succeeded()), status: "deploying" };
    await writeRun(setup.data, ok.runId, setup.composeTask.id);
    await writeResult(setup.data, ok);

    const runner = await Runner.open(setup.store, setup.data);

    expect(runner.list()[0].restart).toEqual({
      status: "failed",
      updatedAt: ok.updatedAt,
      output: "Interrupted before the dashboard took over restarts",
    });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("keeps the last 64 KiB of a failed deploy log", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    const bad = await failed();
    await writeRun(setup.data, bad.runId, setup.plainTask.id);
    const log = `${"a".repeat(OUTPUT_CAP_BYTES)}${"b".repeat(OUTPUT_CAP_BYTES)}`;
    await writeResult(setup.data, bad, log);

    const runner = await Runner.open(setup.store, setup.data);

    expect(runner.list()[0].restart?.output).toBe("b".repeat(OUTPUT_CAP_BYTES));
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("shows a result whose task was deleted without blocking the queue or spawning anything", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    const bad = await failed();
    await writeRun(setup.data, bad.runId, setup.plainTask.id);
    await writeResult(setup.data, bad, await fixture("failed-result.log"));
    await setup.store.delete(setup.plainTask.id);
    const command = fakeCommand();
    const child = fakeChild();
    const runner = await Runner.open(setup.store, setup.data, {
      restart: { spawn: command.spawn },
      launch: () => child,
    });

    expect(
      await readJson(join(setup.data, "restarts", `${bad.runId}.json`)),
    ).toMatchObject({ workdir: null, status: "failed" });
    expect(runner.list()[0].restart?.status).toBe("failed");
    const run = await runner.start(setup.composeTask.id);
    expect(run.status).toBe("running");
    expect(command.calls).toEqual([]);
    child.emit("close", 0, null);
    await runner.waitForIdle();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("skips a result whose run is gone", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    await writeResult(setup.data, await succeeded());

    const runner = await Runner.open(setup.store, setup.data);

    expect(await exists(join(setup.data, "restarts"))).toBe(true);
    expect(await tree(join(setup.data, "restarts"))).toEqual([]);
    expect(await exists(join(setup.data, "deploy"))).toBe(false);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it.each([
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
])("gives a directory holding %s a Compose method", async (name) => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    await writeFile(join(setup.plain, name), "services: {}\n");

    const runner = await Runner.open(setup.store, setup.data);

    expect(runner.restartMethods.get(await realpath(setup.plain))).toEqual({
      kind: "compose",
    });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("skips a task directory that no longer exists", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    await rm(setup.plain, { recursive: true });

    const runner = await Runner.open(setup.store, setup.data);

    expect(await readJson(join(setup.data, "restart-methods.json"))).toEqual({
      version: 1,
      methods: { [await realpath(setup.withCompose)]: { kind: "compose" } },
    });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("imports nothing from empty deploy folders and still removes them", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    await mkdir(join(setup.data, "deploy", "results"), { recursive: true });
    await mkdir(join(setup.data, "deploy", "requests"), { recursive: true });

    const runner = await Runner.open(setup.store, setup.data);

    expect(await exists(join(setup.data, "deploy"))).toBe(false);
    expect(await tree(join(setup.data, "restarts"))).toEqual([]);
    expect(await exists(join(setup.data, "restart-methods.json"))).toBe(true);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("finishes a migration interrupted before the deploy folder was removed", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    const ok = await succeeded();
    const bad = await failed();
    const log = await fixture("failed-result.log");
    await writeRun(setup.data, ok.runId, setup.composeTask.id);
    await writeRun(setup.data, bad.runId, setup.plainTask.id);
    await writeResult(setup.data, ok);
    await writeResult(setup.data, bad, log);
    await mkdir(join(setup.data, "restarts"), { recursive: true });
    await writeFile(
      join(setup.data, "restarts", `${ok.runId}.json`),
      JSON.stringify(
        importedRecord(ok, setup.composeTask.workdir, "succeeded", null),
      ),
    );

    const runner = await Runner.open(setup.store, setup.data);

    expect(
      await readJson(join(setup.data, "restarts", `${ok.runId}.json`)),
    ).toEqual(importedRecord(ok, setup.composeTask.workdir, "succeeded", null));
    expect(
      await readJson(join(setup.data, "restarts", `${bad.runId}.json`)),
    ).toEqual(importedRecord(bad, setup.plainTask.workdir, "failed", log));
    expect(await exists(join(setup.data, "deploy"))).toBe(false);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("recomputes the methods and keeps the records after a migration interrupted once the deploy folder was gone", async () => {
  const temp = await temporary();
  try {
    const setup = await install(temp);
    const ok = await succeeded();
    await writeRun(setup.data, ok.runId, setup.composeTask.id);
    const record = importedRecord(
      ok,
      setup.composeTask.workdir,
      "succeeded",
      null,
    );
    await mkdir(join(setup.data, "restarts"), { recursive: true });
    await writeFile(
      join(setup.data, "restarts", `${ok.runId}.json`),
      JSON.stringify(record),
    );

    const runner = await Runner.open(setup.store, setup.data);

    expect(
      await readJson(join(setup.data, "restarts", `${ok.runId}.json`)),
    ).toEqual(record);
    expect(
      runner.restartMethods.get(await realpath(setup.withCompose)),
    ).toEqual({ kind: "compose" });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

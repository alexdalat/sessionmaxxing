import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { TEST_WORKDIR_ROOT, taskInput, temporary } from "./helpers";

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
  readdir(path).then(
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

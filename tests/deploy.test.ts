import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gitIn } from "../server/git.js";
import { QueueStore } from "../server/queue.js";
import { deployReason, Runner } from "../server/runner.js";
import { fakeChild, TEST_WORKDIR_ROOT, taskInput, temporary } from "./helpers";

const COMPOSE = "services:\n  app:\n    image: node\n";
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

interface Conditions {
  autoApply: boolean;
  compose: boolean;
  change: boolean;
  exitCode: number;
}

async function repository(project: string, compose: boolean) {
  await mkdir(project, { recursive: true });
  const git = gitIn(project);
  await git(["init", "-b", "main"]);
  await writeFile(join(project, "notes.md"), "one\n");
  if (compose) await writeFile(join(project, "compose.yaml"), COMPOSE);
  await git(["add", "."]);
  await git([...IDENTITY, "commit", "-m", "first"]);
}

async function dashboard(temp: string, conditions: Conditions) {
  const data = join(temp, "data");
  const project = join(temp, "project");
  await repository(project, conditions.compose);
  const store = await QueueStore.open(data, TEST_WORKDIR_ROOT);
  let child = fakeChild();
  const runner = await Runner.open(store, data, {
    launch: () => {
      child = fakeChild();
      return child;
    },
    autoApply: () => conditions.autoApply,
  });
  const run = async () => {
    const task = await store.create(taskInput(project));
    const started = await runner.start(task.id);
    if (conditions.change) await appendFile(join(project, "notes.md"), "two\n");
    child.emit("close", conditions.exitCode, null);
    await runner.waitForIdle();
    return started;
  };
  const requests = join(data, "deploy", "requests");
  const results = join(data, "deploy", "results");
  const finish = async (code = 0) => {
    child.emit("close", code, null);
    await runner.waitForIdle();
  };
  return { data, project, store, runner, run, finish, requests, results };
}

it("requests a host deploy when an applied run leaves changes in a Compose project", async () => {
  const temp = await temporary();
  try {
    const { project, runner, run, requests } = await dashboard(temp.path, {
      autoApply: true,
      compose: true,
      change: true,
      exitCode: 0,
    });
    const started = await run();
    const request = JSON.parse(
      await readFile(join(requests, `${started.id}.json`), "utf8"),
    );
    expect(request.runId).toBe(started.id);
    expect(request.title).toBe("Fix a test");
    expect(request.workdir).toBe(project);
    expect(runner.list()[0].deploy).toEqual({
      status: "requested",
      updatedAt: request.requestedAt,
    });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it.each([
  {
    case: "the apply override is off",
    autoApply: false,
    compose: true,
    change: true,
    exitCode: 0,
  },
  {
    case: "the work directory has no Compose file",
    autoApply: true,
    compose: false,
    change: true,
    exitCode: 0,
  },
  {
    case: "the run changed nothing",
    autoApply: true,
    compose: true,
    change: false,
    exitCode: 0,
  },
  {
    case: "the run failed",
    autoApply: true,
    compose: true,
    change: true,
    exitCode: 1,
  },
])("requests no deploy when $case", async (conditions) => {
  const temp = await temporary();
  try {
    const { runner, run, requests } = await dashboard(temp.path, conditions);
    await run();
    expect(await readdir(requests)).toEqual([]);
    expect(runner.list()[0].deploy).toBeNull();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("starts nothing while a deploy is pending and resumes once the host reports it", async () => {
  const temp = await temporary();
  try {
    const { project, store, runner, run, finish, requests, results } =
      await dashboard(temp.path, {
        autoApply: true,
        compose: true,
        change: true,
        exitCode: 0,
      });
    const deployed = await run();
    const waiting = await store.create(taskInput(project));
    await expect(runner.start(waiting.id)).rejects.toThrow(
      deployReason("Fix a test"),
    );
    await writeFile(
      join(results, `${deployed.id}.json`),
      JSON.stringify({
        runId: deployed.id,
        status: "succeeded",
        updatedAt: "2026-09-15T12:00:00.000Z",
      }),
    );
    await rm(join(requests, `${deployed.id}.json`));
    await runner.start(waiting.id);
    await finish();
    expect(runner.list().find((run) => run.id === deployed.id)?.deploy).toEqual(
      { status: "succeeded", updatedAt: "2026-09-15T12:00:00.000Z" },
    );
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("refuses to open with a malformed deploy result", async () => {
  const temp = await temporary();
  try {
    const data = join(temp.path, "data");
    const store = await QueueStore.open(data, TEST_WORKDIR_ROOT);
    await mkdir(join(data, "deploy", "results"), { recursive: true });
    await writeFile(
      join(data, "deploy", "results", `${"a".repeat(24)}.json`),
      JSON.stringify({ runId: "a".repeat(24), state: "done" }),
    );
    await expect(Runner.open(store, data)).rejects.toThrow(/invalid/i);
  } finally {
    await temp.cleanup();
  }
});

import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { planDispatch } from "../server/dispatch.js";
import { gitIn } from "../server/git.js";
import { QueueStore } from "../server/queue.js";
import type { RestartOptions } from "../server/restart-executor.js";
import {
  capOutput,
  OUTPUT_CAP_BYTES,
  RestartStore,
  STOPPED_BEFORE_FINISH,
} from "../server/restarts.js";
import { Runner, restartReason } from "../server/runner.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchLoad,
  type RestartMethod,
} from "../shared/types.js";
import {
  type CommandResponse,
  fakeChild,
  fakeCommand,
  SESSION_RATES,
  TEST_TIME_ZONE,
  TEST_WORKDIR_ROOT,
  taskInput,
  temporary,
  usageSnapshot,
} from "./helpers";
import { idleCommand, idlePids, processAlive } from "./restart-process";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
const NOW = "2026-09-06T12:00:00.000Z";
const COMMAND: RestartMethod = {
  kind: "command",
  argv: ["./restart.sh", "--now", "two words"],
};
const COMPOSE: RestartMethod = { kind: "compose" };
const TITLE = taskInput("").title;

async function repository(project: string) {
  await mkdir(project, { recursive: true });
  const git = gitIn(project);
  await git(["init", "-b", "main"]);
  await writeFile(join(project, "notes.md"), "one\n");
  await git(["add", "."]);
  await git([...IDENTITY, "commit", "-m", "first"]);
}

interface Setup {
  autoApply?: boolean;
  method?: RestartMethod;
  respond?: (command: string, args: string[]) => CommandResponse;
  /** Replaces the fake spawner, so restarts run real processes. */
  restart?: RestartOptions;
}

interface Finish {
  change?: boolean;
  exitCode?: number;
  cancel?: boolean;
}

async function dashboard(temp: string, setup: Setup = {}) {
  const data = join(temp, "data");
  const project = join(temp, "project");
  await repository(project);
  const workdir = await realpath(project);
  const store = await QueueStore.open(data, TEST_WORKDIR_ROOT);
  const command = fakeCommand(setup.respond);
  let child = fakeChild();
  let launches = 0;
  const runner = await Runner.open(store, data, {
    launch: () => {
      launches++;
      child = fakeChild();
      return child;
    },
    autoApply: () => setup.autoApply ?? true,
    restart: setup.restart ?? { spawn: command.spawn },
    now: () => new Date(NOW),
  });
  if (setup.method) await runner.restartMethods.set(workdir, setup.method);
  const exit = async (code: number | null) => {
    child.emit("close", code, null);
    await runner.waitForIdle();
  };
  const run = async ({ change = true, exitCode = 0, cancel }: Finish = {}) => {
    const task = await store.create(taskInput(project));
    const started = await runner.start(task.id);
    if (change) await appendFile(join(project, "notes.md"), "two\n");
    if (cancel) await runner.cancel(task.id);
    await exit(cancel ? null : exitCode);
    return started;
  };
  const restartOf = (runId: string) =>
    runner.list().find((listed) => listed.id === runId)?.restart;
  const settled = (runId: string) =>
    vi.waitFor(() =>
      expect(["succeeded", "failed"]).toContain(restartOf(runId)?.status),
    );
  const record = async (runId: string) =>
    JSON.parse(await readFile(join(data, "restarts", `${runId}.json`), "utf8"));
  return {
    data,
    project,
    workdir,
    store,
    runner,
    command,
    run,
    exit,
    restartOf,
    settled,
    record,
    launches: () => launches,
  };
}

const planner = (load: DispatchLoad) =>
  planDispatch(
    { ...DEFAULT_DISPATCH_SETTINGS, busyHoursReservePercent: 25 },
    { snapshot: usageSnapshot({ fetchedAt: NOW }), error: null },
    new Date(NOW),
    TEST_TIME_ZONE,
    undefined,
    load,
    { rates: SESSION_RATES, error: null },
  );

it("restarts the work directory with its Command method after an applied run leaves changes", async () => {
  const temp = await temporary();
  try {
    const { workdir, runner, command, run, restartOf, settled, record } =
      await dashboard(temp.path, { method: COMMAND });
    const started = await run();
    await settled(started.id);
    expect(
      command.calls.map(({ command, args, options }) => ({
        command,
        args,
        cwd: options.cwd,
        shell: options.shell,
      })),
    ).toEqual([
      {
        command: "./restart.sh",
        args: ["--now", "two words"],
        cwd: workdir,
        shell: false,
      },
    ]);
    expect(restartOf(started.id)).toEqual({
      status: "succeeded",
      updatedAt: expect.any(String),
      output: null,
    });
    expect(await record(started.id)).toMatchObject({
      runId: started.id,
      title: TITLE,
      workdir,
      method: COMMAND,
      status: "succeeded",
    });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("writes a restart record with exactly the record fields", async () => {
  const temp = await temporary();
  try {
    const { runner, run, settled, record } = await dashboard(temp.path, {
      method: COMMAND,
    });
    const started = await run();
    await settled(started.id);
    expect(Object.keys(await record(started.id)).sort()).toEqual(
      [
        "method",
        "output",
        "requestedAt",
        "runId",
        "sibling",
        "status",
        "title",
        "updatedAt",
        "workdir",
      ].sort(),
    );
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("restarts a Docker Compose directory with build and then up -d", async () => {
  const temp = await temporary();
  try {
    const { workdir, runner, command, run, restartOf, settled } =
      await dashboard(temp.path, { method: COMPOSE });
    const started = await run();
    await settled(started.id);
    expect(
      command.calls.map(({ command, args, options }) => [
        command,
        args,
        options.cwd,
        options.shell,
      ]),
    ).toEqual([
      ["docker", ["compose", "build"], workdir, false],
      ["docker", ["compose", "up", "-d"], workdir, false],
    ]);
    expect(restartOf(started.id)?.status).toBe("succeeded");
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("fails a Docker Compose restart without running up -d when the build fails", async () => {
  const temp = await temporary();
  try {
    const { runner, command, run, restartOf, settled } = await dashboard(
      temp.path,
      { method: COMPOSE, respond: () => ({ code: 1 }) },
    );
    const started = await run();
    await settled(started.id);
    expect(command.calls.map(({ args }) => args)).toEqual([
      ["compose", "build"],
    ]);
    expect(restartOf(started.id)?.status).toBe("failed");
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("hides the dashboard's own variables from every restart process", async () => {
  const temp = await temporary();
  vi.stubEnv("SESSIONMAXXING_PROBE", "leak");
  try {
    const { runner, command, run, settled } = await dashboard(temp.path, {
      method: COMPOSE,
    });
    const started = await run();
    await settled(started.id);
    expect(process.env.SESSIONMAXXING_PROBE).toBe("leak");
    expect(command.calls).toHaveLength(2);
    for (const { options } of command.calls) {
      expect(options.env.PATH).toBe(process.env.PATH);
      expect(
        Object.keys(options.env).filter((name) =>
          name.startsWith("SESSIONMAXXING_"),
        ),
      ).toEqual([]);
    }
    await runner.close();
  } finally {
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
});

it.each<{ case: string } & Setup & Finish>([
  { case: "the apply override is off", autoApply: false, method: COMMAND },
  { case: "the directory has no restart method" },
  { case: "the run changed nothing", method: COMMAND, change: false },
  { case: "the run failed", method: COMMAND, exitCode: 1 },
  { case: "the run was cancelled", method: COMMAND, cancel: true },
])("requests no restart when $case", async (conditions) => {
  const temp = await temporary();
  try {
    const { data, runner, command, run, restartOf } = await dashboard(
      temp.path,
      conditions,
    );
    const started = await run(conditions);
    expect(restartOf(started.id)).toBeNull();
    expect(await readdir(join(data, "restarts"))).toEqual([]);
    expect(command.calls).toEqual([]);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("starts nothing while a restart is unfinished and starts the same task once it succeeds", async () => {
  const temp = await temporary();
  try {
    const {
      project,
      store,
      runner,
      command,
      run,
      exit,
      settled,
      restartOf,
      launches,
    } = await dashboard(temp.path, {
      method: COMMAND,
      respond: () => ({ hang: true }),
    });
    runner.setPlanner(planner);
    const restarted = await run();
    await vi.waitFor(() => expect(command.children).toHaveLength(1));
    expect(restartOf(restarted.id)?.status).toBe("restarting");
    const waiting = await store.create(taskInput(project));
    const reason = restartReason(TITLE);
    await expect(runner.start(waiting.id)).rejects.toThrow(reason);
    const task = () => {
      const found = store.snapshot().tasks.find(({ id }) => id === waiting.id);
      if (!found) throw new Error("The waiting task is gone.");
      return found;
    };
    expect(
      await runner.gate(task(), planner(runner.load()), new Date(NOW)),
    ).toMatchObject({ status: "waiting", reason });
    await store.setAutoDispatch(true);
    await runner.tick();
    expect(launches()).toBe(1);
    command.children[0].emit("close", 0, null);
    await settled(restarted.id);
    expect(
      (await runner.gate(task(), planner(runner.load()), new Date(NOW))).status,
    ).toBe("ready");
    await store.setAutoDispatch(false);
    await runner.start(waiting.id);
    expect(launches()).toBe(2);
    await exit(0);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("keeps the method that ran in the record when the setting changes afterwards", async () => {
  const temp = await temporary();
  try {
    const { workdir, runner, run, settled, record } = await dashboard(
      temp.path,
      { method: COMMAND },
    );
    const started = await run();
    await settled(started.id);
    await runner.restartMethods.set(workdir, COMPOSE);
    expect(runner.restartMethods.get(workdir)).toEqual(COMPOSE);
    expect((await record(started.id)).method).toEqual(COMMAND);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it.each([
  {
    case: "a stored none method",
    method: { kind: "none" },
  },
  {
    case: "an argument with a line break",
    method: { kind: "command", argv: ["./restart.sh", "two\nlines"] },
  },
])("refuses to open with $case in restart-methods.json", async ({ method }) => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    await writeFile(
      join(temp.path, "restart-methods.json"),
      JSON.stringify({ version: 1, methods: { [temp.path]: method } }),
    );
    await expect(Runner.open(store, temp.path)).rejects.toThrow(
      /restart-methods\.json/,
    );
  } finally {
    await temp.cleanup();
  }
});

it("refuses to open with a restart record that lacks a field", async () => {
  const temp = await temporary();
  try {
    const store = await QueueStore.open(temp.path, TEST_WORKDIR_ROOT);
    const runId = "a".repeat(24);
    await mkdir(join(temp.path, "restarts"));
    await writeFile(
      join(temp.path, "restarts", `${runId}.json`),
      JSON.stringify({
        runId,
        title: TITLE,
        workdir: temp.path,
        method: COMPOSE,
        status: "succeeded",
        requestedAt: NOW,
        updatedAt: NOW,
        output: null,
      }),
    );
    await expect(Runner.open(store, temp.path)).rejects.toThrow(
      `restarts/${runId}.json`,
    );
  } finally {
    await temp.cleanup();
  }
});

const KIB = 1024;
const failedOutput = async (
  temp: string,
  method: RestartMethod,
  respond: Setup["respond"],
) => {
  const fixture = await dashboard(temp, { method, respond });
  const started = await fixture.run();
  await fixture.settled(started.id);
  return { ...fixture, started, restart: fixture.restartOf(started.id) };
};

it("shows a failed restart's output followed by the line naming the failed program", async () => {
  const temp = await temporary();
  try {
    const { workdir, runner, restart } = await failedOutput(
      temp.path,
      COMMAND,
      () => ({ code: 1, stdout: "building\n", stderr: "boom\n" }),
    );
    expect(restart?.status).toBe("failed");
    const lines = restart?.output?.split("\n") ?? [];
    expect(lines).toContain("building");
    expect(lines).toContain("boom");
    expect(lines.at(-1)).toBe(`./restart.sh exited with code 1 in ${workdir}`);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("keeps no output for a restart that succeeds", async () => {
  const temp = await temporary();
  try {
    const { runner, started, restart, record } = await failedOutput(
      temp.path,
      COMMAND,
      () => ({ stdout: "restarted\n" }),
    );
    expect(restart).toMatchObject({ status: "succeeded", output: null });
    expect((await record(started.id)).output).toBeNull();
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("keeps only the last 64 KiB of a failed restart's output", async () => {
  const temp = await temporary();
  try {
    const { workdir, runner, restart } = await failedOutput(
      temp.path,
      COMMAND,
      () => ({ code: 1, stdout: `${"x".repeat(100 * KIB)}END\n` }),
    );
    const output = restart?.output ?? "";
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    expect(output).toContain("END");
    expect(
      output.endsWith(`./restart.sh exited with code 1 in ${workdir}`),
    ).toBe(true);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("cuts capped output on a whole character", () => {
  const euro = "€";
  const euroBytes = Buffer.byteLength(euro);
  const text = euro.repeat(30_000);
  expect((Buffer.byteLength(text) - OUTPUT_CAP_BYTES) % euroBytes).not.toBe(0);
  const capped = capOutput(text);
  expect(capped).not.toContain("�");
  expect(capped).toBe(euro.repeat(Math.floor(OUTPUT_CAP_BYTES / euroBytes)));
});

it("keeps the output of both Docker Compose steps in arrival order", async () => {
  const temp = await temporary();
  try {
    const { workdir, runner, restart } = await failedOutput(
      temp.path,
      COMPOSE,
      (_command, args) =>
        args.includes("build")
          ? { stdout: "built image\n" }
          : { code: 1, stderr: "port is taken\n" },
    );
    expect(restart?.output).toBe(
      `built image\nport is taken\ndocker compose up -d exited with code 1 in ${workdir}`,
    );
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("stops a restart that runs past the limit with its whole process group and starts tasks again", async () => {
  const temp = await temporary();
  try {
    const { project, workdir, store, runner, run, settled, restartOf, exit } =
      await dashboard(temp.path, {
        method: idleCommand(temp.path),
        restart: { stepTimeoutMs: 200, killGraceMs: 100 },
      });
    const started = await run();
    const pids = await idlePids(temp.path);
    await settled(started.id);
    const restart = restartOf(started.id);
    expect(restart?.status).toBe("failed");
    expect(restart?.output).toContain("ran past");
    expect(restart?.output).toContain(workdir);
    const next = await store.create(taskInput(project));
    await runner.start(next.id);
    await exit(1);
    await vi.waitFor(() => {
      expect(processAlive(pids.child)).toBe(false);
      expect(processAlive(pids.grandchild)).toBe(false);
    });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("holds the queue for a restart requested before the start and runs it once the scheduler starts", async () => {
  const temp = await temporary();
  try {
    const data = join(temp.path, "data");
    const project = join(temp.path, "project");
    await repository(project);
    const store = await QueueStore.open(data, TEST_WORKDIR_ROOT);
    const runId = "c".repeat(24);
    const seed = await RestartStore.open(data, () => new Date(NOW));
    await seed.request({
      runId,
      title: TITLE,
      method: { kind: "command", argv: ["./restart.sh"] },
      workdir: await realpath(project),
      requestedAt: NOW,
    });
    const command = fakeCommand();
    const runner = await Runner.open(store, data, {
      restart: { spawn: command.spawn },
      now: () => new Date(NOW),
    });
    const task = await store.create(taskInput(project));
    await expect(runner.start(task.id)).rejects.toThrow(restartReason(TITLE));
    expect(command.calls).toEqual([]);
    runner.startScheduler();
    await vi.waitFor(async () =>
      expect(
        JSON.parse(
          await readFile(join(data, "restarts", `${runId}.json`), "utf8"),
        ).status,
      ).toBe("succeeded"),
    );
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("stops a running restart when the runner closes and fails its record at the next open", async () => {
  const temp = await temporary();
  try {
    const { data, store, runner, run, restartOf, record } = await dashboard(
      temp.path,
      { method: idleCommand(temp.path), restart: { killGraceMs: 100 } },
    );
    const started = await run();
    const pids = await idlePids(temp.path);
    expect(restartOf(started.id)?.status).toBe("restarting");
    const closing = Date.now();
    await runner.close();
    expect(Date.now() - closing).toBeLessThan(1000);
    expect((await record(started.id)).status).toBe("restarting");
    await vi.waitFor(() => {
      expect(processAlive(pids.child)).toBe(false);
      expect(processAlive(pids.grandchild)).toBe(false);
    });
    const reopened = await Runner.open(store, data, {
      restart: { spawn: fakeCommand().spawn },
    });
    expect(
      reopened.list().find(({ id }) => id === started.id)?.restart,
    ).toMatchObject({ status: "failed", output: STOPPED_BEFORE_FINISH });
    await reopened.close();
  } finally {
    await temp.cleanup();
  }
});

import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  RestartExecutor,
  type RestartOptions,
} from "../server/restart-executor.js";
import {
  type RestartAction,
  RestartStore,
  STOPPED_BEFORE_FINISH,
} from "../server/restarts.js";
import { fakeCommand, temporary } from "./helpers";

const NOW = "2026-09-06T12:00:00.000Z";
const TITLE = "Fix a test";
const FIRST = "a".repeat(24);
const SECOND = "b".repeat(24);
const SECOND_NOW = "2026-09-06T12:00:01.000Z";
const SMALL_LIMITS: RestartOptions = { stepTimeoutMs: 2000, killGraceMs: 100 };

const node = (script: string, ...args: string[]): RestartAction => ({
  kind: "command",
  argv: [process.execPath, "-e", script, ...args],
});

async function workdirIn(temp: string) {
  const path = join(temp, "work");
  await mkdir(path, { recursive: true });
  return realpath(path);
}

async function openStore(temp: string) {
  return RestartStore.open(join(temp, "data"), () => new Date(NOW));
}

async function runRestart(
  temp: string,
  method: RestartAction,
  options: RestartOptions = SMALL_LIMITS,
) {
  const workdir = await workdirIn(temp);
  const store = await openStore(temp);
  await store.request({
    runId: FIRST,
    title: TITLE,
    method,
    workdir,
    requestedAt: NOW,
  });
  const reports: string[] = [];
  const executor = new RestartExecutor(store, options, {
    idle: async () => {},
    report: (message) => reports.push(message),
  });
  await executor.drain();
  return { store, workdir, reports, restart: store.publicStatus(FIRST) };
}

const lines = (output: string | null | undefined) => (output ?? "").split("\n");

it("hands every argument to the process exactly as stored, with no shell", async () => {
  const temp = await temporary();
  try {
    const args = ["a b", "$(whoami)", "it's", "--flag=x y", "*"];
    const { restart } = await runRestart(
      temp.path,
      node(
        "console.log(JSON.stringify(process.argv.slice(1)));process.exit(1)",
        ...args,
      ),
    );
    expect(restart?.status).toBe("failed");
    expect(lines(restart?.output)).toContain(JSON.stringify(args));
  } finally {
    await temp.cleanup();
  }
});

it("fails at once naming the program and the work directory when the program does not exist", async () => {
  const temp = await temporary();
  try {
    const { restart, workdir } = await runRestart(temp.path, {
      kind: "command",
      argv: ["./no-such-restart"],
    });
    expect(restart?.status).toBe("failed");
    expect(restart?.output).toMatch(
      new RegExp(`^Could not start \\./no-such-restart in ${workdir}: `),
    );
  } finally {
    await temp.cleanup();
  }
});

it("resolves a relative program against the work directory", async () => {
  const temp = await temporary();
  try {
    const workdir = await workdirIn(temp.path);
    const script = join(workdir, "restart.mjs");
    await writeFile(
      script,
      "#!/usr/bin/env node\nconsole.log(process.cwd());process.exit(1)\n",
    );
    await chmod(script, 0o755);
    const { restart } = await runRestart(temp.path, {
      kind: "command",
      argv: ["./restart.mjs"],
    });
    expect(lines(restart?.output)).toContain(workdir);
  } finally {
    await temp.cleanup();
  }
});

it("runs the process without the dashboard's own variables", async () => {
  const temp = await temporary();
  vi.stubEnv("SESSIONMAXXING_PROBE", "leak");
  try {
    const { restart } = await runRestart(
      temp.path,
      node(
        'console.log(JSON.stringify(Object.keys(process.env).filter((name) => name.startsWith("SESSIONMAXXING_"))));process.exit(1)',
      ),
    );
    expect(process.env.SESSIONMAXXING_PROBE).toBe("leak");
    expect(lines(restart?.output)).toContain("[]");
  } finally {
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
});

it("fails naming the signal when the process is killed by one", async () => {
  const temp = await temporary();
  try {
    const { restart } = await runRestart(
      temp.path,
      node('process.kill(process.pid, "SIGTERM");setInterval(() => {}, 1000)'),
    );
    expect(restart?.status).toBe("failed");
    expect(lines(restart?.output).at(-1)).toMatch(/was stopped by SIGTERM in /);
  } finally {
    await temp.cleanup();
  }
});

it("fails a restart that outlives the limit and names the limit and the work directory", async () => {
  const temp = await temporary();
  try {
    const { restart, workdir } = await runRestart(
      temp.path,
      node("setInterval(() => {}, 1000)"),
      { stepTimeoutMs: 200, killGraceMs: 100 },
    );
    expect(restart?.status).toBe("failed");
    expect(lines(restart?.output).at(-1)).toMatch(
      new RegExp(`ran past .* minutes in ${workdir} and was stopped$`),
    );
  } finally {
    await temp.cleanup();
  }
});

it("reports a kill failure other than ESRCH naming the restart", async () => {
  const temp = await temporary();
  try {
    const { reports } = await runRestart(
      temp.path,
      node("setInterval(() => {}, 1000)"),
      {
        stepTimeoutMs: 100,
        killGraceMs: 50,
        signal: () => {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
      },
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(TITLE);
  } finally {
    await temp.cleanup();
  }
});

it("marks a record left restarting as failed when the store opens", async () => {
  const temp = await temporary();
  try {
    const workdir = await workdirIn(temp.path);
    const before = await openStore(temp.path);
    await before.request({
      runId: FIRST,
      title: TITLE,
      method: node("0"),
      workdir,
      requestedAt: NOW,
    });
    await before.update(FIRST, { status: "restarting" });
    const after = await openStore(temp.path);
    expect(after.publicStatus(FIRST)).toMatchObject({
      status: "failed",
      output: STOPPED_BEFORE_FINISH,
    });
    expect(after.pending()).toBeUndefined();
    const stored = JSON.parse(
      await readFile(
        join(temp.path, "data", "restarts", `${FIRST}.json`),
        "utf8",
      ),
    );
    expect(stored).toMatchObject({
      status: "failed",
      output: "Dashboard stopped before the restart finished",
    });
  } finally {
    await temp.cleanup();
  }
});

it("leaves a requested record requested when the store opens", async () => {
  const temp = await temporary();
  try {
    const workdir = await workdirIn(temp.path);
    const before = await openStore(temp.path);
    await before.request({
      runId: FIRST,
      title: TITLE,
      method: node("0"),
      workdir,
      requestedAt: NOW,
    });
    const after = await openStore(temp.path);
    expect(after.pending()?.status).toBe("requested");
  } finally {
    await temp.cleanup();
  }
});

it("leaves a restarting record with a sibling alone when the store opens", async () => {
  const temp = await temporary();
  try {
    const workdir = await workdirIn(temp.path);
    const before = await openStore(temp.path);
    await before.request({
      runId: FIRST,
      title: TITLE,
      method: { kind: "compose" },
      workdir,
      requestedAt: NOW,
    });
    await before.update(FIRST, {
      status: "restarting",
      sibling: "dashboard-2",
    });
    const after = await openStore(temp.path);
    expect(after.pending()).toMatchObject({
      status: "restarting",
      sibling: "dashboard-2",
    });
  } finally {
    await temp.cleanup();
  }
});

const twoRestarts = async (
  temp: string,
  command: ReturnType<typeof fakeCommand>,
) => {
  const workdir = await workdirIn(temp);
  const store = await openStore(temp);
  const methods: [string, string, RestartAction][] = [
    [FIRST, NOW, { kind: "command", argv: ["./first"] }],
    [SECOND, SECOND_NOW, { kind: "command", argv: ["./second"] }],
  ];
  for (const [runId, requestedAt, method] of methods)
    await store.request({ runId, title: TITLE, method, workdir, requestedAt });
  const executor = new RestartExecutor(
    store,
    { spawn: command.spawn },
    { idle: async () => {}, report: () => {} },
  );
  return { store, executor };
};

it("runs two requested restarts one at a time in request order", async () => {
  const temp = await temporary();
  try {
    const command = fakeCommand((program) => ({ hang: program === "./first" }));
    const { store, executor } = await twoRestarts(temp.path, command);
    const drained = executor.drain();
    await vi.waitFor(() => expect(command.calls).toHaveLength(1));
    const quiet = new Promise((resolve) => setTimeout(resolve, 50));
    await quiet;
    expect(command.calls.map(({ command }) => command)).toEqual(["./first"]);
    expect(store.publicStatus(SECOND)?.status).toBe("requested");
    command.children[0].emit("close", 0, null);
    await drained;
    expect(command.calls.map(({ command }) => command)).toEqual([
      "./first",
      "./second",
    ]);
    expect(store.publicStatus(FIRST)?.status).toBe("succeeded");
    expect(store.publicStatus(SECOND)?.status).toBe("succeeded");
  } finally {
    await temp.cleanup();
  }
});

it("still runs a record requested while the previous restart finishes", async () => {
  const temp = await temporary();
  try {
    const command = fakeCommand((program) => ({ hang: program === "./first" }));
    const workdir = await workdirIn(temp.path);
    const store = await openStore(temp.path);
    const executor = new RestartExecutor(
      store,
      { spawn: command.spawn },
      { idle: async () => {}, report: () => {} },
    );
    await store.request({
      runId: FIRST,
      title: TITLE,
      method: { kind: "command", argv: ["./first"] },
      workdir,
      requestedAt: NOW,
    });
    void executor.drain();
    await vi.waitFor(() => expect(command.children).toHaveLength(1));
    command.children[0].emit("close", 0, null);
    await store.request({
      runId: SECOND,
      title: TITLE,
      method: { kind: "command", argv: ["./second"] },
      workdir,
      requestedAt: SECOND_NOW,
    });
    await executor.drain();
    expect(store.publicStatus(FIRST)?.status).toBe("succeeded");
    expect(store.publicStatus(SECOND)?.status).toBe("succeeded");
  } finally {
    await temp.cleanup();
  }
});

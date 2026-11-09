import {
  chmod,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { type CommandResponse, fakeCommand, temporary } from "./helpers";

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

async function workdirIn(temp: string, name = "work") {
  const path = join(temp, name);
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

const IMAGE_ID = `sha256:${"ab".repeat(32)}`;
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const COMPOSE: RestartAction = { kind: "compose" };

const verbOf = (command: string, args: string[]) => {
  if (command !== "docker") return command;
  if (args[0] === "compose") return `compose ${args[1]}`;
  return args[0] === "rm" && args[1] === "--force" ? "rm --force" : args[0];
};

// Hand-written in the shape the executor reads: no daemon exists here to produce a real answer.
const inspected = (
  labels: Record<string, string> | null,
  image = IMAGE_ID,
) => ({
  stdout: JSON.stringify([{ Image: image, Config: { Labels: labels } }]),
});

interface DockerCase {
  /** The label the fake daemon reports for the dashboard container; defaults to the work directory. */
  label?: (workdir: string) => string | Promise<string>;
  answers?: Record<string, CommandResponse>;
  options?: RestartOptions;
  method?: RestartAction;
  directory?: string;
  inspect?: (workdir: string) => CommandResponse;
}

async function dockerRestart(temp: string, setup: DockerCase = {}) {
  const workdir = await workdirIn(temp, setup.directory);
  const socketPath = join(temp, "docker.sock");
  await writeFile(socketPath, "");
  const label = await (setup.label ?? ((path) => path))(workdir);
  const command = fakeCommand((program, args) => {
    const verb = verbOf(program, args);
    if (verb === "inspect")
      return (
        setup.inspect?.(workdir) ?? inspected({ [WORKING_DIR_LABEL]: label })
      );
    return setup.answers?.[verb] ?? (verb === "wait" ? { stdout: "0\n" } : {});
  });
  const store = await openStore(temp);
  await store.request({
    runId: FIRST,
    title: TITLE,
    method: setup.method ?? COMPOSE,
    workdir,
    requestedAt: NOW,
  });
  const executor = new RestartExecutor(
    store,
    {
      spawn: command.spawn,
      dockerInstall: true,
      socketPath,
      killGraceMs: 50,
      ...setup.options,
    },
    { idle: async () => {}, report: () => {} },
  );
  await executor.drain();
  return {
    store,
    workdir,
    command,
    sibling: `sessionmaxxing-restart-${FIRST}`,
    restart: store.publicStatus(FIRST),
    verbs: command.calls.map(({ command, args }) => verbOf(command, args)),
  };
}

it("restarts a Docker Compose directory in place without docker inspect when the server is a native install", async () => {
  const temp = await temporary();
  try {
    const { verbs, restart } = await dockerRestart(temp.path, {
      options: { dockerInstall: undefined },
    });
    expect(verbs).toEqual(["compose build", "compose up"]);
    expect(restart?.status).toBe("succeeded");
  } finally {
    await temp.cleanup();
  }
});

it("restarts another project in place when the dashboard's label names a different directory", async () => {
  const temp = await temporary();
  try {
    const { verbs, restart } = await dockerRestart(temp.path, {
      label: () => "/somewhere/else",
    });
    expect(verbs).toEqual(["inspect", "compose build", "compose up"]);
    expect(restart?.status).toBe("succeeded");
  } finally {
    await temp.cleanup();
  }
});

it("treats a work directory as the dashboard's own project when the label is a symlink to it", async () => {
  const temp = await temporary();
  try {
    const { verbs, restart } = await dockerRestart(temp.path, {
      label: async (workdir) => {
        const link = join(temp.path, "link");
        await symlink(workdir, link);
        return link;
      },
    });
    expect(verbs).toContain("run");
    expect(verbs).not.toContain("compose up");
    expect(restart?.status).toBe("succeeded");
  } finally {
    await temp.cleanup();
  }
});

it.each([
  { case: "an empty label set", labels: {} },
  { case: "no label set at all", labels: null },
])(
  "fails naming the label when the dashboard container has $case",
  async ({ labels }) => {
    const temp = await temporary();
    try {
      const { verbs, restart } = await dockerRestart(temp.path, {
        inspect: () => inspected(labels),
      });
      expect(restart?.status).toBe("failed");
      expect(restart?.output).toContain(WORKING_DIR_LABEL);
      expect(verbs).toEqual(["inspect"]);
    } finally {
      await temp.cleanup();
    }
  },
);

it("fails with docker's message when docker inspect fails", async () => {
  const temp = await temporary();
  try {
    const { verbs, restart } = await dockerRestart(temp.path, {
      inspect: () => ({ code: 1, stderr: "Error: No such object: abc\n" }),
    });
    expect(restart?.status).toBe("failed");
    expect(restart?.output).toContain("Error: No such object: abc");
    expect(verbs).toEqual(["inspect"]);
  } finally {
    await temp.cleanup();
  }
});

it("fails when docker inspect prints something that is not JSON", async () => {
  const temp = await temporary();
  try {
    const { verbs, restart } = await dockerRestart(temp.path, {
      inspect: () => ({ stdout: "not json" }),
    });
    expect(restart?.status).toBe("failed");
    expect(restart?.output).toContain("cannot read");
    expect(verbs).toEqual(["inspect"]);
  } finally {
    await temp.cleanup();
  }
});

it.each([
  "latest",
  "sha256:abc",
  `sha256:${"A".repeat(64)}`,
  `sha256:${"a".repeat(65)}`,
])(
  "fails without building when docker reports the image id %j",
  async (image) => {
    const temp = await temporary();
    try {
      const { verbs, restart } = await dockerRestart(temp.path, {
        inspect: (workdir) =>
          inspected({ [WORKING_DIR_LABEL]: workdir }, image),
      });
      expect(restart?.status).toBe("failed");
      expect(restart?.output).toContain(image);
      expect(verbs).toEqual(["inspect"]);
    } finally {
      await temp.cleanup();
    }
  },
);

it.each(["a,b", 'a"b', "a\nb"])(
  "fails naming the work directory when it contains %j, which a mount cannot carry",
  async (directory) => {
    const temp = await temporary();
    try {
      const { verbs, restart, workdir } = await dockerRestart(temp.path, {
        directory,
      });
      expect(restart?.status).toBe("failed");
      expect(restart?.output).toContain(workdir);
      expect(verbs).toEqual(["inspect"]);
    } finally {
      await temp.cleanup();
    }
  },
);

it("fails with the build output and starts no sibling when the own project's build fails", async () => {
  const temp = await temporary();
  try {
    const { verbs, restart } = await dockerRestart(temp.path, {
      answers: { "compose build": { code: 1, stderr: "build broke\n" } },
    });
    expect(restart?.status).toBe("failed");
    expect(restart?.output).toContain("build broke");
    expect(verbs).toEqual(["inspect", "compose build"]);
  } finally {
    await temp.cleanup();
  }
});

it("fails with docker's output and force-removes the sibling when docker run fails", async () => {
  const temp = await temporary();
  try {
    const { command, verbs, restart, sibling } = await dockerRestart(
      temp.path,
      { answers: { run: { code: 1, stderr: "port already allocated\n" } } },
    );
    expect(restart?.status).toBe("failed");
    expect(restart?.output).toContain("port already allocated");
    expect(verbs).toEqual(["inspect", "compose build", "run", "rm --force"]);
    expect(command.calls.at(-1)?.args).toEqual(["rm", "--force", sibling]);
    expect(verbs).not.toContain("compose up");
  } finally {
    await temp.cleanup();
  }
});

it("fails with the sibling's logs and its exit code, then removes it, when the sibling exits non-zero", async () => {
  const temp = await temporary();
  try {
    const { command, verbs, restart, sibling } = await dockerRestart(
      temp.path,
      {
        answers: {
          wait: { stdout: "3\n" },
          logs: { stdout: "bind: address already in use\n" },
        },
      },
    );
    expect(restart?.status).toBe("failed");
    expect(restart?.output).toContain("bind: address already in use");
    expect(restart?.output?.split("\n").at(-1)).toBe(
      `Sibling ${sibling} exited with code 3`,
    );
    expect(verbs.slice(-3)).toEqual(["wait", "logs", "rm"]);
    expect(command.calls.at(-1)?.args).toEqual(["rm", sibling]);
  } finally {
    await temp.cleanup();
  }
});

it("fails and force-removes the sibling when it does not finish within the limit", async () => {
  const temp = await temporary();
  try {
    const { command, verbs, restart, sibling } = await dockerRestart(
      temp.path,
      {
        answers: { wait: { hang: true } },
        options: { siblingTimeoutMs: 200 },
      },
    );
    expect(restart?.status).toBe("failed");
    expect(restart?.output).toMatch(/did not finish within/);
    expect(verbs.slice(-2)).toEqual(["wait", "rm --force"]);
    expect(command.calls.at(-1)?.args).toEqual(["rm", "--force", sibling]);
  } finally {
    await temp.cleanup();
  }
});

it("runs a Command method in the dashboard's own directory in-process, without docker inspect", async () => {
  const temp = await temporary();
  try {
    const { verbs, restart } = await dockerRestart(temp.path, {
      method: { kind: "command", argv: ["./restart.sh"] },
    });
    expect(verbs).toEqual(["./restart.sh"]);
    expect(restart?.status).toBe("succeeded");
  } finally {
    await temp.cleanup();
  }
});

async function ownProject(
  temp: string,
  answers: Record<string, CommandResponse> = {},
) {
  const workdir = await workdirIn(temp);
  const socketPath = join(temp, "docker.sock");
  await writeFile(socketPath, "");
  const command = fakeCommand((program, args) => {
    const verb = verbOf(program, args);
    if (verb === "inspect") return inspected({ [WORKING_DIR_LABEL]: workdir });
    return answers[verb] ?? (verb === "wait" ? { stdout: "0\n" } : {});
  });
  const store = await openStore(temp);
  await store.request({
    runId: FIRST,
    title: TITLE,
    method: COMPOSE,
    workdir,
    requestedAt: NOW,
  });
  const executorOn = (
    on: RestartStore,
    idle: () => Promise<void> = async () => {},
  ) =>
    new RestartExecutor(
      on,
      {
        spawn: command.spawn,
        dockerInstall: true,
        socketPath,
        killGraceMs: 50,
      },
      { idle, report: () => {} },
    );
  const file = join(temp, "data", "restarts", `${FIRST}.json`);
  return {
    command,
    store,
    executorOn,
    verbs: () =>
      command.calls.map(({ command, args }) => verbOf(command, args)),
    stored: async () => JSON.parse(await readFile(file, "utf8")),
    sibling: `sessionmaxxing-restart-${FIRST}`,
    reopen: () => openStore(temp),
  };
}

const leaveWithSibling = async (store: RestartStore, sibling: string) => {
  await store.update(FIRST, { status: "restarting", sibling });
};

it("finishes a restart whose sibling outlived the dashboard, and removes the sibling", async () => {
  const temp = await temporary();
  try {
    const { store, executorOn, verbs, sibling, reopen, command } =
      await ownProject(temp.path);
    await leaveWithSibling(store, sibling);
    const after = await reopen();
    await executorOn(after).drain();
    expect(verbs()).toEqual(["wait", "logs", "rm"]);
    expect(command.calls.map(({ args }) => args[1])).toEqual([
      sibling,
      sibling,
      sibling,
    ]);
    expect(after.publicStatus(FIRST)).toMatchObject({
      status: "succeeded",
      output: null,
    });
  } finally {
    await temp.cleanup();
  }
});

it("fails the resumed record with docker's message when the sibling is gone", async () => {
  const temp = await temporary();
  try {
    const { store, executorOn, verbs, sibling, reopen } = await ownProject(
      temp.path,
      {
        wait: { code: 1, stderr: "Error: No such container: gone\n" },
      },
    );
    await leaveWithSibling(store, sibling);
    const after = await reopen();
    await executorOn(after).drain();
    expect(verbs()).toEqual(["wait"]);
    const restart = after.publicStatus(FIRST);
    expect(restart?.status).toBe("failed");
    expect(restart?.output).toContain("Error: No such container: gone");
  } finally {
    await temp.cleanup();
  }
});

it("leaves the record requested and starts no sibling when it closes during the idle wait, and a new executor then restarts", async () => {
  const temp = await temporary();
  try {
    const { store, executorOn, verbs, stored, reopen } = await ownProject(
      temp.path,
    );
    let release = () => {};
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = executorOn(store, () => idle);
    const drained = first.drain();
    await vi.waitFor(() =>
      expect(verbs()).toEqual(["inspect", "compose build"]),
    );
    const closing = first.close();
    release();
    await Promise.all([drained, closing]);
    expect(verbs()).not.toContain("run");
    expect((await stored()).status).toBe("requested");
    expect((await stored()).sibling).toBeNull();

    const after = await reopen();
    await executorOn(after).drain();
    expect(verbs().slice(2)).toEqual([
      "inspect",
      "compose build",
      "run",
      "wait",
      "logs",
      "rm",
    ]);
    expect(after.publicStatus(FIRST)?.status).toBe("succeeded");
  } finally {
    await temp.cleanup();
  }
});

it("stops only the docker wait when it closes during the sibling wait, and a new executor resumes it", async () => {
  const temp = await temporary();
  try {
    const answers: Record<string, CommandResponse> = { wait: { hang: true } };
    const { executorOn, store, verbs, stored, sibling, reopen } =
      await ownProject(temp.path, answers);
    const first = executorOn(store);
    const drained = first.drain();
    await vi.waitFor(() => expect(verbs().at(-1)).toBe("wait"));
    const before = await stored();
    expect(before).toMatchObject({ status: "restarting", sibling });
    await first.close();
    await drained;
    expect(await stored()).toEqual(before);
    expect(verbs()).not.toContain("rm");
    expect(verbs()).not.toContain("rm --force");

    answers.wait = { stdout: "0\n" };
    const after = await reopen();
    await executorOn(after).drain();
    expect(verbs().slice(-3)).toEqual(["wait", "logs", "rm"]);
    expect(after.publicStatus(FIRST)?.status).toBe("succeeded");
  } finally {
    await temp.cleanup();
  }
});

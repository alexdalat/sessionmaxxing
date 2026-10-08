import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { migrateProvider } from "../server/legacy-provider.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { DomainError } from "../server/storage.js";
import { temporary } from "./helpers.js";

const ID_A = "a".repeat(24);
const ID_B = "b".repeat(24);
const ID_C = "c".repeat(24);
const ID_CODEX = "d".repeat(24);
const ID_CODEX_RUNNING = "e".repeat(24);
const ID_CODEX_PENDING = "f".repeat(24);
const CODEX_MODEL = "gpt-6-astra";
const CREATED_AT = "2026-09-01T10:00:00.000Z";
const FINISHED_AT = "2026-09-01T11:00:00.000Z";
const UNSUPPORTED_TASK_PROVIDER = "Queue task has an unsupported provider.";

const storedTask = (workdir: string, patch: Record<string, unknown> = {}) => ({
  title: "Fix a test",
  prompt: "Rename the parser",
  workdir,
  provider: "claude",
  priority: 0,
  earliestStart: null,
  preferredWindowStart: null,
  maxTurns: 500,
  model: "opus",
  id: ID_A,
  status: "completed",
  createdAt: CREATED_AT,
  finishedAt: FINISHED_AT,
  dependsOn: [] as string[],
  tokens: 100_000,
  ...patch,
});
const codexTask = (workdir: string, patch: Record<string, unknown> = {}) =>
  storedTask(workdir, {
    provider: "codex",
    model: CODEX_MODEL,
    id: ID_CODEX,
    ...patch,
  });
const withoutProvider = ({
  provider: _provider,
  ...rest
}: Record<string, unknown>) => rest;
const listed = (task: Record<string, unknown>) => ({
  ...withoutProvider(task),
  review: null,
  sessionCostPercent: null,
});
const queueText = (tasks: unknown[], autoDispatch = true) =>
  JSON.stringify({ version: 1, autoDispatch, tasks }, null, 2);

describe("migrateProvider", () => {
  it("leaves a record without a provider key unchanged", () => {
    const record = { title: "Fix a test" };
    expect(migrateProvider(record, "Queue task")).toBe("unchanged");
    expect(record).toEqual({ title: "Fix a test" });
  });

  it("strips the claude provider key from the record", () => {
    const record = { title: "Fix a test", provider: "claude" };
    expect(migrateProvider(record, "Queue task")).toBe("stripped");
    expect(record).toEqual({ title: "Fix a test" });
  });

  it("drops a codex record without modifying it", () => {
    const record = { title: "Fix a test", provider: "codex" };
    expect(migrateProvider(record, "Run")).toBe("drop");
    expect(record).toEqual({ title: "Fix a test", provider: "codex" });
  });

  it.each([
    ["gemini", "gemini"],
    ["null", null],
    ["a number", 1],
  ])("throws a 500 for an unsupported provider (%s)", (_name, provider) => {
    let caught: unknown;
    try {
      migrateProvider({ provider }, "Run");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).statusCode).toBe(500);
    expect((caught as DomainError).message).toBe(
      "Run has an unsupported provider.",
    );
  });
});

it("drops codex tasks and strips the provider from many Claude tasks in one rewrite", async () => {
  const temp = await temporary();
  try {
    const first = storedTask(temp.path, { id: ID_A, status: "completed" });
    const second = storedTask(temp.path, {
      id: ID_B,
      status: "pending",
      priority: 1,
      finishedAt: null,
      dependsOn: [ID_CODEX, ID_A],
    });
    const third = storedTask(temp.path, {
      id: ID_C,
      status: "failed",
      priority: 2,
    });
    const codex = codexTask(temp.path);
    const path = `${temp.path}/queue.json`;
    await writeFile(path, queueText([first, codex, second, third]));

    const queue = await QueueStore.open(temp.path);

    const expected = [
      withoutProvider(first),
      { ...withoutProvider(second), dependsOn: [ID_A] },
      withoutProvider(third),
    ];
    expect(queue.snapshot().tasks).toEqual(expected.map(listed));
    expect(await readFile(path, "utf8")).toBe(queueText(expected));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(temp.path)).toEqual(["queue.json"]);
  } finally {
    await temp.cleanup();
  }
});

it("leaves queue.json identical on a second open after the migration", async () => {
  const temp = await temporary();
  try {
    const path = `${temp.path}/queue.json`;
    await writeFile(
      path,
      queueText([storedTask(temp.path), codexTask(temp.path)]),
    );
    await QueueStore.open(temp.path);
    const afterFirst = await readFile(path, "utf8");
    const reopened = await QueueStore.open(temp.path);
    expect(await readFile(path, "utf8")).toBe(afterFirst);
    expect(reopened.snapshot().tasks).toHaveLength(1);
  } finally {
    await temp.cleanup();
  }
});

it("loads a queue whose only task is a codex task as empty", async () => {
  const temp = await temporary();
  try {
    const path = `${temp.path}/queue.json`;
    await writeFile(path, queueText([codexTask(temp.path)], false));
    const queue = await QueueStore.open(temp.path);
    expect(queue.snapshot().tasks).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(queueText([], false));
  } finally {
    await temp.cleanup();
  }
});

it("drops running and pending codex tasks without marking anything failed", async () => {
  const temp = await temporary();
  try {
    const kept = storedTask(temp.path);
    await writeFile(
      `${temp.path}/queue.json`,
      queueText([
        kept,
        codexTask(temp.path, {
          id: ID_CODEX_RUNNING,
          status: "running",
          finishedAt: null,
        }),
        codexTask(temp.path, {
          id: ID_CODEX_PENDING,
          status: "pending",
          finishedAt: null,
        }),
      ]),
    );
    const queue = await QueueStore.open(temp.path);
    expect(queue.snapshot().tasks).toEqual([listed(kept)]);
  } finally {
    await temp.cleanup();
  }
});

it("does not rewrite a task without a provider key", async () => {
  const temp = await temporary();
  try {
    const path = `${temp.path}/queue.json`;
    const task = withoutProvider(storedTask(temp.path));
    const compact = JSON.stringify({
      version: 1,
      autoDispatch: true,
      tasks: [task],
    });
    await writeFile(path, compact);
    const queue = await QueueStore.open(temp.path);
    expect(queue.snapshot().tasks).toEqual([listed(task)]);
    expect(await readFile(path, "utf8")).toBe(compact);
  } finally {
    await temp.cleanup();
  }
});

it("does not rewrite an empty queue", async () => {
  const temp = await temporary();
  try {
    const path = `${temp.path}/queue.json`;
    const compact = JSON.stringify({
      version: 1,
      autoDispatch: false,
      tasks: [],
    });
    await writeFile(path, compact);
    const queue = await QueueStore.open(temp.path);
    expect(queue.snapshot().tasks).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(compact);
  } finally {
    await temp.cleanup();
  }
});

it("fails loudly on an unsupported task provider and leaves the file untouched", async () => {
  const temp = await temporary();
  try {
    const path = `${temp.path}/queue.json`;
    const text = queueText([
      storedTask(temp.path),
      storedTask(temp.path, { provider: "gemini", id: ID_B }),
    ]);
    await writeFile(path, text);
    await expect(QueueStore.open(temp.path)).rejects.toThrow(
      UNSUPPORTED_TASK_PROVIDER,
    );
    expect(await readFile(path, "utf8")).toBe(text);
  } finally {
    await temp.cleanup();
  }
});

const RUN_FULL = "1".repeat(24);
const RUN_MINIMAL = "2".repeat(24);
const RUN_CODEX = "3".repeat(24);
const RUN_CODEX_RUNNING = "4".repeat(24);
const RUN_GEMINI = "5".repeat(24);
const UNSUPPORTED_RUN_PROVIDER = "Run has an unsupported provider.";
const SESSION_ID = "6f1c2f0e-4d6a-4b7e-9d0a-2b8f3c1a7e55";
const STARTED_AT = "2026-09-01T10:00:00.000Z";
const ENDED_AT = "2026-09-01T10:05:00.000Z";
const SAFE_PREVIEW = ["Provider initialized", "Result: completed · turns: 3"];
const REDACTED_PREVIEW = ["[redacted stderr]", "[redacted stdout]"];

const minimalRun = (patch: Record<string, unknown> = {}) => ({
  id: RUN_MINIMAL,
  taskId: ID_A,
  title: "Rename the parser",
  provider: "claude",
  model: "opus",
  status: "completed",
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  durationMs: 300_000,
  exitCode: 0,
  error: null,
  ...patch,
});
const fullRun = () => ({
  id: RUN_FULL,
  taskId: ID_B,
  title: "Fix a test",
  prompt: "Rename the parser",
  estimatedTokens: 100_000,
  provider: "claude",
  model: "opus",
  status: "completed",
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  durationMs: 300_000,
  exitCode: 0,
  error: null,
  tokens: { fable: 0, opus: 52_000, sonnet: 0, haiku: 0 },
  sessionId: SESSION_ID,
  summary: "Renamed the parser.",
  changes: {
    branch: "main",
    commits: 1,
    files: [{ path: "src/parser.ts", added: 4, removed: 2 }],
  },
  reviewedAt: null,
});
const codexRun = (patch: Record<string, unknown> = {}) =>
  minimalRun({
    id: RUN_CODEX,
    provider: "codex",
    model: CODEX_MODEL,
    ...patch,
  });
const runText = (run: unknown) => JSON.stringify(run, null, 2);

async function writeRun(
  directory: string,
  run: { id: string },
  preview: string[] | null,
) {
  const runs = `${directory}/runs`;
  await mkdir(runs, { recursive: true });
  await writeFile(`${runs}/${run.id}.json`, runText(run));
  if (preview !== null)
    await writeFile(`${runs}/${run.id}.log`, JSON.stringify(preview, null, 2));
}
const readRuns = async (directory: string) => {
  const runs = `${directory}/runs`;
  const texts: Record<string, string> = {};
  for (const name of (await readdir(runs)).sort())
    texts[name] = await readFile(`${runs}/${name}`, "utf8");
  return texts;
};
async function openRunner(directory: string) {
  const store = await QueueStore.open(directory);
  return Runner.open(store, directory);
}

it("deletes codex run files and strips the provider from Claude run json leaving logs untouched", async () => {
  const temp = await temporary();
  try {
    const full = fullRun();
    const minimal = minimalRun();
    await writeRun(temp.path, full, SAFE_PREVIEW);
    await writeRun(temp.path, minimal, []);
    await writeRun(temp.path, codexRun(), REDACTED_PREVIEW);
    const logs = {
      [`${RUN_FULL}.log`]: JSON.stringify(SAFE_PREVIEW, null, 2),
      [`${RUN_MINIMAL}.log`]: JSON.stringify([], null, 2),
    };

    const runner = await openRunner(temp.path);

    expect(
      runner
        .list()
        .map((run) => run.id)
        .sort(),
    ).toEqual([RUN_FULL, RUN_MINIMAL]);
    expect(await readRuns(temp.path)).toEqual({
      [`${RUN_FULL}.json`]: runText(withoutProvider(full)),
      [`${RUN_MINIMAL}.json`]: runText(withoutProvider(minimal)),
      ...logs,
    });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("leaves every run file identical on a second open after the migration", async () => {
  const temp = await temporary();
  try {
    await writeRun(temp.path, fullRun(), SAFE_PREVIEW);
    await writeRun(temp.path, minimalRun(), []);
    await writeRun(temp.path, codexRun(), REDACTED_PREVIEW);
    await (await openRunner(temp.path)).close();
    const afterFirst = await readRuns(temp.path);

    const second = await openRunner(temp.path);

    expect(
      second
        .list()
        .map((run) => run.id)
        .sort(),
    ).toEqual([RUN_FULL, RUN_MINIMAL]);
    expect(await readRuns(temp.path)).toEqual(afterFirst);
    await second.close();
  } finally {
    await temp.cleanup();
  }
});

it("removes a codex run whose log is already missing", async () => {
  const temp = await temporary();
  try {
    await writeRun(temp.path, codexRun(), null);
    const runner = await openRunner(temp.path);
    expect(runner.list()).toEqual([]);
    expect(await readdir(`${temp.path}/runs`)).toEqual([]);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("drops a running codex run instead of marking it failed", async () => {
  const temp = await temporary();
  try {
    await writeRun(
      temp.path,
      codexRun({ id: RUN_CODEX_RUNNING, status: "running", endedAt: null }),
      REDACTED_PREVIEW,
    );
    const runner = await openRunner(temp.path);
    expect(runner.list()).toEqual([]);
    expect(await readdir(`${temp.path}/runs`)).toEqual([]);
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("does not rewrite a run without a provider key", async () => {
  const temp = await temporary();
  try {
    const run = withoutProvider(minimalRun());
    const runs = `${temp.path}/runs`;
    await mkdir(runs, { recursive: true });
    await writeFile(`${runs}/${RUN_MINIMAL}.json`, JSON.stringify(run));
    await writeFile(`${runs}/${RUN_MINIMAL}.log`, "[]");
    const runner = await openRunner(temp.path);
    expect(runner.list().map((listed) => listed.id)).toEqual([RUN_MINIMAL]);
    expect(await readRuns(temp.path)).toEqual({
      [`${RUN_MINIMAL}.json`]: JSON.stringify(run),
      [`${RUN_MINIMAL}.log`]: "[]",
    });
    await runner.close();
  } finally {
    await temp.cleanup();
  }
});

it("fails loudly on an unsupported run provider and leaves its files untouched", async () => {
  const temp = await temporary();
  try {
    await writeRun(
      temp.path,
      minimalRun({ id: RUN_GEMINI, provider: "gemini" }),
      SAFE_PREVIEW,
    );
    const before = await readRuns(temp.path);
    await expect(openRunner(temp.path)).rejects.toThrow(
      UNSUPPORTED_RUN_PROVIDER,
    );
    expect(await readRuns(temp.path)).toEqual(before);
  } finally {
    await temp.cleanup();
  }
});

it("loads the live dispatch settings unchanged without rewriting the file", async () => {
  const temp = await temporary();
  try {
    const settings = {
      autoApply: false,
      keepSessionActive: true,
      sessionReservePercent: 10,
      busyHoursReservePercent: 50,
      weeklyMarginPercent: 5,
      quietStartHours: 8,
      maxConcurrentRuns: 1,
      runWeeklyCostPercent: 3,
    };
    const path = `${temp.path}/dispatch-settings.json`;
    const text = JSON.stringify(settings, null, 2);
    await writeFile(path, text);
    const store = await DispatchSettingsStore.open(temp.path);
    expect(store.snapshot()).toEqual(settings);
    expect(await readFile(path, "utf8")).toBe(text);
  } finally {
    await temp.cleanup();
  }
});

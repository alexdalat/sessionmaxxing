import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { migrateProvider } from "../server/legacy-provider.js";
import { QueueStore } from "../server/queue.js";
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

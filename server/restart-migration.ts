import { access, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RestartMethod, RestartStatus, Task } from "../shared/types.js";
import { type RestartRecord, saveRestart, utf8Tail } from "./restarts.js";
import { DomainError, exactKeys } from "./storage.js";

/** The project files `docker compose` looks for in a directory. */
export const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];
export const INTERRUPTED_IMPORT =
  "Interrupted before the dashboard took over restarts";
const LEGACY_DIRECTORY = "deploy";
const RESULT_FILE = /^([a-f0-9]{24})\.json$/;
const RESULT_KEYS = ["runId", "status", "updatedAt"];
const LEGACY_STATUSES = ["requested", "deploying", "succeeded", "failed"];
const COMPOSE = { kind: "compose" } as const;
const ABSENT_PATH_CODES = ["ENOENT", "ENOTDIR"];

interface LegacyRun {
  id: string;
  title: string;
  taskId: string;
}
interface LegacyResult {
  runId: string;
  status: string;
  updatedAt: string;
  logPath: string;
}

const isAbsent = (error: unknown) =>
  ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? "");

export async function hasComposeFile(workdir: string) {
  for (const name of COMPOSE_FILES) {
    try {
      await access(join(workdir, name));
      return true;
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
  }
  return false;
}

async function namesIn(folder: string) {
  try {
    return await readdir(folder);
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
}

async function assertNoPendingRequest(folder: string) {
  const [name] = await namesIn(folder);
  if (name !== undefined)
    throw new DomainError(
      `Deploy request ${join(folder, name)} is still pending. Let the host watcher finish it or delete the file, then start the dashboard again.`,
      500,
    );
}

async function readResults(folder: string) {
  const results: LegacyResult[] = [];
  for (const name of await namesIn(folder)) {
    if (name.endsWith(".log")) continue;
    const path = join(folder, name);
    const invalid = (reason: string) =>
      new DomainError(
        `Deploy result ${path} is invalid: ${reason} Fix or delete it, then start the dashboard again.`,
        500,
      );
    const match = name.match(RESULT_FILE);
    if (!match) throw invalid("its name is not a run id.");
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw invalid("it is not JSON.");
    }
    if (!exactKeys(value, RESULT_KEYS))
      throw invalid(`it does not have exactly ${RESULT_KEYS.join(", ")}.`);
    if (value.runId !== match[1])
      throw invalid("its runId is not its file name.");
    if (
      typeof value.status !== "string" ||
      !LEGACY_STATUSES.includes(value.status)
    )
      throw invalid("its status is unknown.");
    if (typeof value.updatedAt !== "string")
      throw invalid("its updatedAt is not text.");
    results.push({
      runId: match[1],
      status: value.status,
      updatedAt: value.updatedAt,
      logPath: join(folder, `${match[1]}.log`),
    });
  }
  return results;
}

async function readLog(path: string) {
  try {
    return utf8Tail(await readFile(path));
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

async function recordOf(
  result: LegacyResult,
  run: LegacyRun,
  tasks: ReadonlyMap<string, Pick<Task, "workdir">>,
): Promise<RestartRecord> {
  const status: RestartStatus =
    result.status === "succeeded" ? "succeeded" : "failed";
  let output: string | null = null;
  if (result.status === "failed") output = await readLog(result.logPath);
  else if (status === "failed") output = INTERRUPTED_IMPORT;
  return {
    runId: result.runId,
    title: run.title,
    workdir: tasks.get(run.taskId)?.workdir ?? null,
    method: COMPOSE,
    status,
    // The old result files carry no request time, only the time of the last change.
    requestedAt: result.updatedAt,
    updatedAt: result.updatedAt,
    output,
    sibling: null,
  };
}

async function composeMethods(tasks: readonly Pick<Task, "workdir">[]) {
  const methods: Record<string, RestartMethod> = {};
  for (const workdir of new Set(tasks.map((task) => task.workdir))) {
    let directory: string;
    try {
      directory = await realpath(workdir);
    } catch (error) {
      if (isAbsent(error)) continue;
      throw error;
    }
    if (await hasComposeFile(directory)) methods[directory] = COMPOSE;
  }
  return methods;
}

/**
 * The one-time conversion from the host watcher: Compose directories get a
 * Compose method, old deploy results become restart records, and the deploy
 * folder is removed. The caller writes restart-methods.json afterwards, so an
 * interrupted conversion runs again from the start.
 */
export async function migrateRestarts(
  directory: string,
  tasks: readonly Pick<Task, "id" | "workdir">[],
  runs: readonly LegacyRun[],
) {
  const legacy = join(directory, LEGACY_DIRECTORY);
  await assertNoPendingRequest(join(legacy, "requests"));
  const results = await readResults(join(legacy, "results"));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const runById = new Map(runs.map((run) => [run.id, run]));
  const records: RestartRecord[] = [];
  for (const result of results) {
    const run = runById.get(result.runId);
    // Without its run there is no run card to show the result on.
    if (run) records.push(await recordOf(result, run, taskById));
  }
  const methods = await composeMethods(tasks);
  for (const record of records) await saveRestart(directory, record);
  await rm(legacy, { recursive: true, force: true });
  return methods;
}

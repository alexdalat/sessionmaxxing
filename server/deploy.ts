import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEPLOY_STATUSES,
  type RunChanges,
  type RunDeploy,
} from "../shared/types.js";
import { atomicJson, DomainError, exactKeys } from "./storage.js";

/** The project files `docker compose` looks for in a directory. */
const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];
const RUN_FILE = /^([a-f0-9]{24})\.json$/;
const REQUEST_KEYS = ["runId", "title", "workdir", "requestedAt"];
const RESULT_KEYS = ["runId", "status", "updatedAt"];

export interface DeployRequest {
  runId: string;
  title: string;
  workdir: string;
  requestedAt: string;
}

export async function hasComposeFile(workdir: string): Promise<boolean> {
  for (const name of COMPOSE_FILES) {
    try {
      await access(join(workdir, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

export const leftChanges = (changes: RunChanges | null) =>
  changes !== null && (changes.commits > 0 || changes.files.length > 0);

/** Every `<run id>.json` in a directory, skipping files the host removes between listing and reading. */
async function readRunFiles(directory: string) {
  const files: { runId: string; name: string; value: unknown }[] = [];
  for (const name of await readdir(directory)) {
    const match = RUN_FILE.exec(name);
    if (!match) continue;
    try {
      const value = JSON.parse(await readFile(join(directory, name), "utf8"));
      files.push({ runId: match[1], name, value });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new DomainError(`Deploy file ${name} is unreadable.`, 500);
    }
  }
  return files;
}

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Deploys handed to the host watcher (deploy/host-deploy.sh), which has the
 * docker CLI the dashboard container lacks. The host writes a result per run
 * and removes the request when it is done.
 */
export class DeployQueue {
  private requests = new Map<string, DeployRequest>();
  private results = new Map<string, RunDeploy>();
  private constructor(
    private requestDirectory: string,
    private resultDirectory: string,
  ) {}
  static async open(directory: string) {
    const queue = new DeployQueue(
      join(directory, "deploy", "requests"),
      join(directory, "deploy", "results"),
    );
    await mkdir(queue.requestDirectory, { recursive: true, mode: 0o700 });
    await mkdir(queue.resultDirectory, { recursive: true, mode: 0o700 });
    await queue.refresh();
    return queue;
  }
  async refresh() {
    const requests = new Map<string, DeployRequest>();
    for (const { runId, name, value } of await readRunFiles(
      this.requestDirectory,
    )) {
      if (
        !exactKeys(value, REQUEST_KEYS) ||
        value.runId !== runId ||
        !REQUEST_KEYS.every((key) => isString(value[key]))
      )
        throw new DomainError(`Deploy request ${name} is invalid.`, 500);
      requests.set(runId, value as unknown as DeployRequest);
    }
    const results = new Map<string, RunDeploy>();
    for (const { runId, name, value } of await readRunFiles(
      this.resultDirectory,
    )) {
      if (
        !exactKeys(value, RESULT_KEYS) ||
        value.runId !== runId ||
        !DEPLOY_STATUSES.some((status) => status === value.status) ||
        !isString(value.updatedAt)
      )
        throw new DomainError(`Deploy result ${name} is invalid.`, 500);
      results.set(runId, {
        status: value.status as RunDeploy["status"],
        updatedAt: value.updatedAt,
      });
    }
    this.requests = requests;
    this.results = results;
  }
  async request(request: DeployRequest) {
    await atomicJson(
      join(this.requestDirectory, `${request.runId}.json`),
      request,
    );
    this.requests.set(request.runId, request);
  }
  /** A deploy the host has not finished; it may restart the dashboard, so no run starts meanwhile. */
  pending(): DeployRequest | undefined {
    return this.requests.values().next().value;
  }
  status(runId: string): RunDeploy | null {
    const result = this.results.get(runId);
    if (result) return result;
    const request = this.requests.get(runId);
    return request
      ? { status: "requested", updatedAt: request.requestedAt }
      : null;
  }
}

import { mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  RESTART_STATUSES,
  type RestartMethod,
  type RestartStatus,
  type RunRestart,
} from "../shared/types.js";
import { validateRestartMethod } from "./restart-methods.js";
import { atomicJson, DomainError, exactKeys } from "./storage.js";

export const RESTARTS_DIRECTORY = "restarts";
const RECORD_FILE = /^([a-f0-9]{24})\.json$/;
const RECORD_KEYS = [
  "runId",
  "title",
  "workdir",
  "method",
  "status",
  "requestedAt",
  "updatedAt",
  "output",
  "sibling",
];
const FINISHED: readonly RestartStatus[] = ["succeeded", "failed"];
export const OUTPUT_CAP_BYTES = 64 * 1024;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BITS = 0x80;

/** The last `limit` bytes of `bytes` as text, starting on a whole UTF-8 character. */
export function utf8Tail(bytes: Buffer, limit = OUTPUT_CAP_BYTES) {
  let start = Math.max(0, bytes.length - limit);
  while (
    start < bytes.length &&
    (bytes[start] & CONTINUATION_MASK) === CONTINUATION_BITS
  )
    start++;
  return bytes.subarray(start).toString("utf8");
}
export const capOutput = (text: string) => utf8Tail(Buffer.from(text, "utf8"));

/** A restart method that restarts something. */
export type RestartAction = Exclude<RestartMethod, { kind: "none" }>;
export interface RestartRecord {
  runId: string;
  title: string;
  /** Null only for a finished record whose work directory is unknown. */
  workdir: string | null;
  /** A copy of the method read when the run finished. */
  method: RestartAction;
  status: RestartStatus;
  requestedAt: string;
  updatedAt: string;
  output: string | null;
  /** The container that recreates the dashboard's own Compose project. */
  sibling: string | null;
}
export type RestartRequest = Pick<
  RestartRecord,
  "runId" | "title" | "method" | "requestedAt"
> & { workdir: string };
export type RestartPatch = Partial<
  Pick<RestartRecord, "status" | "output" | "sibling">
>;

export const saveRestart = (directory: string, record: RestartRecord) =>
  atomicJson(
    join(directory, RESTARTS_DIRECTORY, `${record.runId}.json`),
    record,
  );

const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown) => value === null || isString(value);

function parseRecord(name: string, runId: string, text: string) {
  const invalid = (reason: string) =>
    new DomainError(
      `Restart record ${RESTARTS_DIRECTORY}/${name} is invalid: ${reason} Restore a valid record before starting.`,
      500,
    );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("it is not JSON.");
  }
  if (!exactKeys(value, RECORD_KEYS))
    throw invalid(`it does not have exactly ${RECORD_KEYS.join(", ")}.`);
  if (value.runId !== runId) throw invalid("its runId is not its file name.");
  if (!isString(value.title)) throw invalid("its title is not text.");
  if (!RESTART_STATUSES.some((status) => status === value.status))
    throw invalid("its status is unknown.");
  const status = value.status as RestartStatus;
  const { workdir } = value;
  if (workdir === null ? !FINISHED.includes(status) : !isString(workdir))
    throw invalid("its work directory is missing.");
  if (isString(workdir) && !isAbsolute(workdir))
    throw invalid("its work directory is not absolute.");
  let method: RestartMethod;
  try {
    method = validateRestartMethod(value.method, 500);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    throw invalid(`its method: ${error.message}`);
  }
  if (method.kind === "none") throw invalid("its method is none.");
  if (!isString(value.requestedAt) || !isString(value.updatedAt))
    throw invalid("its times are not text.");
  if (!isNullableString(value.output) || !isNullableString(value.sibling))
    throw invalid("its output or sibling is not text or null.");
  if (value.sibling !== null && method.kind !== "compose")
    throw invalid("only a Docker Compose restart has a sibling.");
  return { ...value, method, status } as RestartRecord;
}

/** Restart records in request order; the server is their only writer, so the in-memory copy is the truth. */
export class RestartStore {
  private constructor(
    private directory: string,
    private records: Map<string, RestartRecord>,
    private now: () => Date,
  ) {}
  static async open(directory: string, now: () => Date) {
    const folder = join(directory, RESTARTS_DIRECTORY);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const records: RestartRecord[] = [];
    for (const name of await readdir(folder)) {
      const match = name.match(RECORD_FILE);
      if (!match) continue;
      records.push(
        parseRecord(name, match[1], await readFile(join(folder, name), "utf8")),
      );
    }
    records.sort(
      (a, b) =>
        a.requestedAt.localeCompare(b.requestedAt) ||
        a.runId.localeCompare(b.runId),
    );
    return new RestartStore(
      directory,
      new Map(records.map((record) => [record.runId, record])),
      now,
    );
  }
  async request(request: RestartRequest) {
    const record: RestartRecord = {
      ...request,
      method: structuredClone(request.method),
      status: "requested",
      updatedAt: request.requestedAt,
      output: null,
      sibling: null,
    };
    await saveRestart(this.directory, record);
    this.records.set(record.runId, record);
  }
  /** Persists the change first, so a failed write leaves the record as it was. */
  async update(runId: string, patch: RestartPatch) {
    const current = this.records.get(runId);
    if (!current) throw new DomainError("Restart record not found.", 500);
    const record = {
      ...current,
      ...patch,
      updatedAt: this.now().toISOString(),
    };
    await saveRestart(this.directory, record);
    this.records.set(runId, record);
    return record;
  }
  /** The first restart not finished yet; it may recreate the dashboard, so no run starts meanwhile. */
  pending(): RestartRecord | undefined {
    for (const record of this.records.values())
      if (!FINISHED.includes(record.status)) return record;
    return undefined;
  }
  publicStatus(runId: string): RunRestart | null {
    const record = this.records.get(runId);
    if (!record) return null;
    return {
      status: record.status,
      updatedAt: record.updatedAt,
      output: record.status === "failed" ? record.output : null,
    };
  }
}

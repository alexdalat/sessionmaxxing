import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  ActivityEvent,
  HistoryData,
  ParsedEvent,
  WeightedTokens,
} from "../shared/types.js";
import {
  emptyWeightedTokens,
  modelFamily,
  weightedTokens,
} from "../shared/types.js";
import { parseTranscript } from "./parser.js";

interface ParsedFile {
  events: ParsedEvent[];
  lines: number;
  warnings: number;
  historyEntries: number;
}
interface CachedFile extends ParsedFile {
  mtimeMs: number;
  size: number;
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
async function entries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}
async function fingerprint(path: string) {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function listFiles(root: string) {
  const files: string[] = [];
  for (const project of await entries(join(root, "projects"))) {
    if (!project.isDirectory()) continue;
    const directory = join(root, "projects", project.name);
    for (const file of await entries(directory)) {
      if (file.isFile() && file.name.endsWith(".jsonl")) {
        files.push(join(directory, file.name));
        continue;
      }
      if (!file.isDirectory()) continue;
      const subagents = join(directory, file.name, "subagents");
      for (const agent of await entries(subagents))
        if (agent.isFile() && agent.name.endsWith(".jsonl"))
          files.push(join(subagents, agent.name));
    }
  }
  files.push(join(root, "history.jsonl"));
  return files;
}
async function parseFile(path: string, isHistory: boolean) {
  const parsed: ParsedFile = {
    events: [],
    lines: 0,
    warnings: 0,
    historyEntries: 0,
  };
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      parsed.lines++;
      if (isHistory) {
        try {
          const record = JSON.parse(line);
          if (record && typeof record === "object") parsed.historyEntries++;
          else parsed.warnings++;
        } catch {
          parsed.warnings++;
        }
        continue;
      }
      const transcript = parseTranscript(line);
      parsed.warnings += transcript.warnings;
      if (transcript.events.length) parsed.events.push(transcript.events[0]);
    }
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
  return parsed;
}

async function sessionFiles(root: string, sessionId: string) {
  // The session id is matched against directory entries, never joined into a path.
  const transcript = `${sessionId}.jsonl`;
  const files: string[] = [];
  for (const project of await entries(join(root, "projects"))) {
    if (!project.isDirectory()) continue;
    const directory = join(root, "projects", project.name);
    for (const file of await entries(directory)) {
      if (file.isFile() && file.name === transcript) {
        files.push(join(directory, file.name));
        continue;
      }
      if (!file.isDirectory() || file.name !== sessionId) continue;
      const subagents = join(directory, file.name, "subagents");
      for (const agent of await entries(subagents))
        if (agent.isFile() && agent.name.endsWith(".jsonl"))
          files.push(join(subagents, agent.name));
    }
  }
  return files;
}

/**
 * Weighted tokens one dispatched session consumed from `since` on, by model
 * family, subagents included. A resumed session keeps its id, so each run
 * counts only the records written after it started.
 */
export async function readSessionTokens(
  root: string,
  sessionId: string,
  since: string,
): Promise<WeightedTokens> {
  const tokens = emptyWeightedTokens();
  const latest = new Map<string, ActivityEvent>();
  const anonymous: ActivityEvent[] = [];
  for (const path of await sessionFiles(root, sessionId)) {
    const parsed = await parseFile(path, false);
    if (!parsed) continue;
    for (const { messageId, event } of parsed.events)
      if (messageId === null) anonymous.push(event);
      else latest.set(messageId, event);
  }
  for (const event of [...latest.values(), ...anonymous]) {
    if (event.timestamp < since) continue;
    // A record whose model the parser did not recognize has no family to charge.
    const family = modelFamily(event.model);
    if (family !== null) tokens[family] += weightedTokens(event, family);
  }
  return tokens;
}

/** History reader that reparses only the transcript files whose size or mtime changed. */
export function createHistoryReader(
  root: string,
  dispatchedSessions: () => ReadonlySet<string> = () => new Set<string>(),
): () => Promise<HistoryData> {
  const cache = new Map<string, CachedFile>();
  const historyPath = join(root, "history.jsonl");
  return async () => {
    // Read fresh every call: runs are dispatched while the process lives, and
    // an unchanged transcript file keeps its cached parse.
    const dispatched = dispatchedSessions();
    const data: HistoryData = {
      events: [],
      health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
    };
    const seen = new Map<string, number>();
    const present = new Set<string>();
    for (const path of await listFiles(root)) {
      const info = await fingerprint(path);
      if (!info) continue;
      let file = cache.get(path);
      if (!file || file.mtimeMs !== info.mtimeMs || file.size !== info.size) {
        const parsed = await parseFile(path, path === historyPath);
        if (!parsed) continue;
        file = { ...parsed, ...info };
        cache.set(path, file);
      }
      present.add(path);
      data.health.files++;
      data.health.lines += file.lines;
      data.health.warnings += file.warnings;
      data.health.historyEntries += file.historyEntries;
      for (const { messageId, sessionId, event } of file.events) {
        const attributed =
          sessionId !== null && dispatched.has(sessionId)
            ? { ...event, source: "dispatched" as const }
            : event;
        const index = messageId === null ? undefined : seen.get(messageId);
        if (index !== undefined) data.events[index] = attributed;
        else {
          if (messageId !== null) seen.set(messageId, data.events.length);
          data.events.push(attributed);
        }
      }
    }
    for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
    data.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return data;
  };
}
export function readHistory(root: string): Promise<HistoryData> {
  return createHistoryReader(root)();
}

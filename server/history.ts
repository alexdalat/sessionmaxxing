import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ActivityEvent, HistoryData } from "../shared/types.js";
import { parseTranscript } from "./parser.js";

interface ParsedFile {
  events: Array<{ key?: string; event: ActivityEvent }>;
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
    for (const file of await entries(directory))
      if (file.isFile() && file.name.endsWith(".jsonl"))
        files.push(join(directory, file.name));
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
      if (!transcript.events.length) continue;
      const record = JSON.parse(line);
      const key =
        typeof record.message?.id === "string" ? record.message.id : undefined;
      parsed.events.push({ key, event: transcript.events[0] });
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

/** History reader that reparses only the transcript files whose size or mtime changed. */
export function createHistoryReader(root: string): () => Promise<HistoryData> {
  const cache = new Map<string, CachedFile>();
  const historyPath = join(root, "history.jsonl");
  return async () => {
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
      for (const { key, event } of file.events) {
        const index = key ? seen.get(key) : undefined;
        if (index !== undefined) data.events[index] = event;
        else {
          if (key) seen.set(key, data.events.length);
          data.events.push(event);
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

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HistoryData } from "../shared/types.js";
import { parseTranscript } from "./parser.js";

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
export async function readHistory(root: string): Promise<HistoryData> {
  const data: HistoryData = {
    events: [],
    health: { files: 0, lines: 0, warnings: 0, historyEntries: 0 },
  };
  const seen = new Map<string, number>();
  const files: string[] = [];
  for (const project of await entries(join(root, "projects"))) {
    if (!project.isDirectory()) continue;
    const directory = join(root, "projects", project.name);
    for (const file of await entries(directory))
      if (file.isFile() && file.name.endsWith(".jsonl"))
        files.push(join(directory, file.name));
  }
  for (const path of [...files, join(root, "history.jsonl")]) {
    const isHistory = path === join(root, "history.jsonl");
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        data.health.lines++;
        if (isHistory) {
          try {
            const record = JSON.parse(line);
            if (record && typeof record === "object")
              data.health.historyEntries++;
            else data.health.warnings++;
          } catch {
            data.health.warnings++;
          }
          continue;
        }
        const parsed = parseTranscript(line);
        data.health.warnings += parsed.warnings;
        if (!parsed.events.length) continue;
        const record = JSON.parse(line);
        const key =
          typeof record.message?.id === "string"
            ? record.message.id
            : undefined;
        const index = key ? seen.get(key) : undefined;
        if (index !== undefined) data.events[index] = parsed.events[0];
        else {
          if (key) seen.set(key, data.events.length);
          data.events.push(parsed.events[0]);
        }
      }
      data.health.files++;
    } catch (error) {
      if (!missing(error)) throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  data.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return data;
}

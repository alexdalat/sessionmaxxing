import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { WorkdirSuggestions } from "../shared/types.js";
import { DomainError } from "./storage.js";
import { ALLOWED_HOME, underHome } from "./validation.js";

const MAX_RECENT = 12;
const MAX_MATCHES = 20;
const EXCLUDED_DIRECTORY = "node_modules";
const CLAUDE_STATE_FILE = ".claude.json";
const MISSING_DIRECTORY_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES"]);

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (MISSING_DIRECTORY_CODES.has(errorCode(error) ?? "")) return false;
    throw error;
  }
}

/** Project paths Claude Code has opened, newest first; a project without a start time sorts last. */
async function claudeProjects(home: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(home, CLAUDE_STATE_FILE), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const { projects } = JSON.parse(raw) as {
    projects?: Record<string, { lastStartTime?: number }>;
  };
  if (projects === undefined) return [];
  if (typeof projects !== "object" || projects === null)
    throw new DomainError(
      `Claude Code state in ${CLAUDE_STATE_FILE} is invalid.`,
      500,
    );
  return Object.entries(projects)
    .map(([path, project]) => ({
      path,
      startedAt:
        typeof project?.lastStartTime === "number"
          ? project.lastStartTime
          : Number.NEGATIVE_INFINITY,
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((project) => project.path);
}

async function recentWorkdirs(queueWorkdirs: string[], home: string) {
  const recent: string[] = [];
  for (const path of [...(await claudeProjects(home)), ...queueWorkdirs]) {
    if (recent.length === MAX_RECENT) break;
    if (recent.includes(path)) continue;
    if (!underHome(path, home) || !(await isDirectory(path))) continue;
    recent.push(path);
  }
  return recent;
}

async function matchingWorkdirs(query: string, home: string) {
  if (!query.startsWith("/")) return [];
  const listing = query.endsWith("/");
  const directory = listing ? query : dirname(query);
  const prefix = listing ? "" : basename(query);
  if (!underHome(directory, home)) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (MISSING_DIRECTORY_CODES.has(errorCode(error) ?? "")) return [];
    throw error;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (
      !entry.name.startsWith(prefix) ||
      entry.name.startsWith(".") ||
      entry.name === EXCLUDED_DIRECTORY
    )
      continue;
    const path = join(directory, entry.name);
    // readdir reports a symlink as a link, so its target decides; a broken link
    // stats ENOENT and is simply not a directory to suggest.
    if (!entry.isDirectory() && !(await isDirectory(path))) continue;
    matches.push(path);
  }
  return matches.sort().slice(0, MAX_MATCHES);
}

export async function suggestWorkdirs(
  query: string,
  queueWorkdirs: string[],
  home: string = ALLOWED_HOME,
): Promise<WorkdirSuggestions> {
  return {
    recent: await recentWorkdirs(queueWorkdirs, home),
    matches: query ? await matchingWorkdirs(query, home) : [],
  };
}

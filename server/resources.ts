import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DomainError } from "./storage.js";

const PATH_KEY = "path:";
const REPO_KEY = "repo:";
const GITDIR_PREFIX = "gitdir:";
export const RESOURCE_ERROR =
  "Could not resolve the work directory's repository. Check the directory and its .git entry.";

/**
 * The git common directory owning `directory`, found by walking up to the first
 * `.git` entry. Linked worktrees and submodules keep a `.git` file that points
 * at their private git dir, whose `commondir` file names the shared one.
 */
async function gitCommonDir(directory: string): Promise<string | null> {
  for (let current = directory; ; current = dirname(current)) {
    const entry = join(current, ".git");
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (current === dirname(current)) return null;
      continue;
    }
    if (info.isDirectory()) return realpath(entry);
    const content = await readFile(entry, "utf8");
    const line = content.split("\n")[0].trim();
    if (!line.startsWith(GITDIR_PREFIX))
      throw new DomainError(RESOURCE_ERROR, 400);
    const target = line.slice(GITDIR_PREFIX.length).trim();
    const gitdir = isAbsolute(target) ? target : resolve(current, target);
    let common = gitdir;
    try {
      const shared = (await readFile(join(gitdir, "commondir"), "utf8")).trim();
      common = isAbsolute(shared) ? shared : resolve(gitdir, shared);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return realpath(common);
  }
}

/**
 * Deterministic lock keys for a work directory: its canonical path and, when it
 * sits inside a git checkout, the repository that checkout belongs to.
 */
export async function resolveResources(workdir: string): Promise<string[]> {
  let canonical: string;
  let repository: string | null;
  try {
    canonical = await realpath(workdir);
    repository = await gitCommonDir(canonical);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(RESOURCE_ERROR, 400);
  }
  return [
    `${PATH_KEY}${canonical}`,
    ...(repository === null ? [] : [`${REPO_KEY}${repository}`]),
  ];
}

const nested = (a: string, b: string) => a === b || b.startsWith(`${a}/`);

/** Whether two resource sets may not run at the same time. */
export function resourcesCollide(a: readonly string[], b: readonly string[]) {
  for (const left of a)
    for (const right of b) {
      if (left.startsWith(PATH_KEY) && right.startsWith(PATH_KEY)) {
        if (nested(left, right) || nested(right, left)) return true;
      } else if (left === right) return true;
    }
  return false;
}

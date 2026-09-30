import { spawn } from "node:child_process";
import type { RunChanges } from "../shared/types.js";

export type RunGit = (args: string[]) => Promise<string>;
interface Counts {
  added: number;
  removed: number;
}
export interface GitSnapshot {
  branch: string;
  head: string;
  /** Line counts of every tracked file that differs from HEAD, keyed by path relative to the work directory. */
  tracked: Map<string, Counts>;
  untracked: Set<string>;
}
const OUTSIDE_REPOSITORY_CODE = 128;
const NOT_A_REPOSITORY = /not a git repository/i;
class GitError extends Error {
  constructor(
    args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} exited with ${code}: ${stderr.trim()}`);
  }
}
const outsideRepository = (error: unknown) =>
  error instanceof GitError &&
  error.code === OUTSIDE_REPOSITORY_CODE &&
  NOT_A_REPOSITORY.test(error.stderr);

export function gitIn(cwd: string): RunGit {
  return (args) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn("git", args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve(out) : reject(new GitError(args, code, err)),
      );
    });
}
const lines = (output: string) =>
  output.split("\n").filter((line) => line.length > 0);
/** Binary files report "-" instead of a line count. */
const count = (field: string) => (field === "-" ? 0 : Number(field));
function parseNumstat(output: string): Map<string, Counts> {
  const files = new Map<string, Counts>();
  for (const line of lines(output)) {
    const [added, removed, ...path] = line.split("\t");
    files.set(path.join("\t"), {
      added: count(added),
      removed: count(removed),
    });
  }
  return files;
}
const NUMSTAT = ["--numstat", "--relative"];
/** Git's well-known empty tree; stands in for HEAD until the repository has a commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Initialises git in the work directory when it is not already a repository; nothing gets staged or committed. */
export async function ensureRepository(
  workdir: string,
  git: RunGit = gitIn(workdir),
): Promise<boolean> {
  try {
    await git(["rev-parse", "--git-dir"]);
    return false;
  } catch (error) {
    if (!outsideRepository(error)) throw error;
  }
  await git(["init", "-b", "main"]);
  return true;
}
const UNBORN_CODE = 1;
async function resolveHead(git: RunGit): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", "-q", "HEAD"])).trim();
  } catch (error) {
    if (error instanceof GitError && error.code === UNBORN_CODE)
      return EMPTY_TREE;
    throw error;
  }
}
/** The work directory's git state, or null when it is not inside a repository. */
export async function snapshotWorkdir(
  workdir: string,
  git: RunGit = gitIn(workdir),
): Promise<GitSnapshot | null> {
  try {
    const head = await resolveHead(git);
    const branch = (
      await git(
        head === EMPTY_TREE
          ? ["symbolic-ref", "--short", "HEAD"]
          : ["rev-parse", "--abbrev-ref", "HEAD"],
      )
    ).trim();
    return {
      branch,
      head,
      tracked: parseNumstat(await git(["diff", head, ...NUMSTAT, "--", "."])),
      untracked: new Set(
        lines(await git(["ls-files", "--others", "--exclude-standard"])),
      ),
    };
  } catch (error) {
    if (outsideRepository(error)) return null;
    throw error;
  }
}
/** Commits exactly `paths`; anything else staged or modified in the work directory stays out of the commit. */
export async function commitPaths(
  paths: string[],
  message: string,
  git: RunGit,
): Promise<void> {
  // Literal pathspecs so a file named like a glob commits only itself.
  await git(["--literal-pathspecs", "add", "-A", "--", ...paths]);
  await git([
    "--literal-pathspecs",
    "commit",
    "--only",
    "-m",
    message,
    "--",
    ...paths,
  ]);
}
/** What changed in the work directory between two snapshots, counting commits the run made itself. */
export async function diffSnapshots(
  before: GitSnapshot,
  after: GitSnapshot,
  git: RunGit,
): Promise<RunChanges> {
  const files = new Map<string, Counts>();
  const record = (path: string, counts: Counts) => {
    const total = files.get(path);
    files.set(
      path,
      total
        ? {
            added: total.added + counts.added,
            removed: total.removed + counts.removed,
          }
        : counts,
    );
  };
  let commits = 0;
  if (after.head === before.head) {
    for (const [path, counts] of after.tracked) {
      const was = before.tracked.get(path);
      if (!was || was.added !== counts.added || was.removed !== counts.removed)
        record(path, counts);
    }
  } else {
    const range =
      before.head === EMPTY_TREE ? after.head : `${before.head}..${after.head}`;
    commits = Number((await git(["rev-list", "--count", range])).trim());
    for (const [path, counts] of parseNumstat(
      await git(["diff", ...NUMSTAT, before.head, after.head, "--", "."]),
    ))
      record(path, counts);
    for (const [path, counts] of after.tracked) record(path, counts);
  }
  for (const path of after.untracked)
    if (!before.untracked.has(path)) record(path, { added: 0, removed: 0 });
  return {
    branch: after.branch,
    commits,
    files: [...files]
      .map(([path, counts]) => ({ path, ...counts }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

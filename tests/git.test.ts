import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  diffSnapshots,
  ensureRepository,
  type GitSnapshot,
  gitIn,
  snapshotWorkdir,
} from "../server/git.js";
import { temporary } from "./helpers";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
async function repository(path: string) {
  const git = gitIn(path);
  await git(["init", "-b", "main"]);
  await writeFile(`${path}/notes.md`, "one\n");
  await git(["add", "."]);
  await git([...IDENTITY, "commit", "-m", "first"]);
  return git;
}
const snapshot = (patch: Partial<GitSnapshot>): GitSnapshot => ({
  branch: "main",
  head: "0".repeat(40),
  tracked: new Map(),
  untracked: new Set(),
  ...patch,
});
const noGit = () => {
  throw new Error("git is not needed while HEAD stays put");
};

it("lists files the run modified and ignores files that were already dirty before it", async () => {
  const before = snapshot({
    tracked: new Map([["already.ts", { added: 3, removed: 1 }]]),
    untracked: new Set(["scratch.txt"]),
  });
  const after = snapshot({
    tracked: new Map([
      ["already.ts", { added: 3, removed: 1 }],
      ["server/parser.ts", { added: 12, removed: 4 }],
    ]),
    untracked: new Set(["scratch.txt", "server/git.ts"]),
  });
  expect(await diffSnapshots(before, after, noGit)).toEqual({
    branch: "main",
    commits: 0,
    files: [
      { path: "server/git.ts", added: 0, removed: 0 },
      { path: "server/parser.ts", added: 12, removed: 4 },
    ],
  });
});

it("counts a file whose diff grew during the run", async () => {
  const before = snapshot({
    tracked: new Map([["notes.md", { added: 1, removed: 0 }]]),
  });
  const after = snapshot({
    tracked: new Map([["notes.md", { added: 5, removed: 2 }]]),
  });
  expect((await diffSnapshots(before, after, noGit)).files).toEqual([
    { path: "notes.md", added: 5, removed: 2 },
  ]);
});

it("reports commits and branch when HEAD moved", async () => {
  const temp = await temporary();
  try {
    const git = await repository(temp.path);
    const before = await snapshotWorkdir(temp.path);
    await git(["checkout", "-b", "rename"]);
    await writeFile(`${temp.path}/notes.md`, "one\ntwo\n");
    await git(["add", "."]);
    await git([...IDENTITY, "commit", "-m", "second"]);
    await appendFile(`${temp.path}/notes.md`, "three\n");
    const after = await snapshotWorkdir(temp.path);
    if (!before || !after)
      throw new Error("The work directory is a repository");
    expect(await diffSnapshots(before, after, git)).toEqual({
      branch: "rename",
      commits: 1,
      files: [{ path: "notes.md", added: 2, removed: 0 }],
    });
  } finally {
    await temp.cleanup();
  }
});

it("reads the branch, the lines tracked files changed, and untracked files", async () => {
  const temp = await temporary();
  try {
    await repository(temp.path);
    await appendFile(`${temp.path}/notes.md`, "two\n");
    await writeFile(`${temp.path}/extra.txt`, "new\n");
    const snap = await snapshotWorkdir(temp.path);
    expect(snap?.branch).toBe("main");
    expect(snap?.head).toMatch(/^[0-9a-f]{40}$/);
    expect([...(snap?.tracked ?? [])]).toEqual([
      ["notes.md", { added: 1, removed: 0 }],
    ]);
    expect([...(snap?.untracked ?? [])]).toEqual(["extra.txt"]);
  } finally {
    await temp.cleanup();
  }
});

it("returns no snapshot for a work directory outside a repository", async () => {
  const path = await mkdtemp(join(tmpdir(), "capacity-git-"));
  try {
    expect(await snapshotWorkdir(path)).toBeNull();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

it("initialises a repository and leaves existing files untracked", async () => {
  const path = await mkdtemp(join(tmpdir(), "capacity-git-"));
  try {
    await writeFile(`${path}/notes.md`, "one\n");
    expect(await ensureRepository(path)).toBe(true);
    const git = gitIn(path);
    await expect(
      git(["rev-parse", "--verify", "-q", "HEAD"]),
    ).rejects.toThrow();
    expect(await git(["status", "--porcelain"])).toBe("?? notes.md\n");
    const snap = await snapshotWorkdir(path);
    expect(snap?.branch).toBe("main");
    expect([...(snap?.tracked ?? [])]).toEqual([]);
    expect([...(snap?.untracked ?? [])]).toEqual(["notes.md"]);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

it("counts a run's first commit in a repository that had none", async () => {
  const path = await mkdtemp(join(tmpdir(), "capacity-git-"));
  try {
    await writeFile(`${path}/notes.md`, "one\n");
    await ensureRepository(path);
    const git = gitIn(path);
    const before = await snapshotWorkdir(path);
    await writeFile(`${path}/notes.md`, "one\ntwo\n");
    await writeFile(`${path}/new.ts`, "export {};\n");
    await git(["add", "."]);
    await git([...IDENTITY, "commit", "-m", "first"]);
    const after = await snapshotWorkdir(path);
    if (!before || !after) throw new Error("snapshots missing");
    expect(await diffSnapshots(before, after, git)).toEqual({
      branch: "main",
      commits: 1,
      files: [
        { path: "new.ts", added: 1, removed: 0 },
        { path: "notes.md", added: 2, removed: 0 },
      ],
    });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

it("leaves an existing repository and its dirty files alone", async () => {
  const temp = await temporary();
  try {
    const git = await repository(temp.path);
    await appendFile(`${temp.path}/notes.md`, "two\n");
    const head = (await git(["rev-parse", "HEAD"])).trim();
    expect(await ensureRepository(temp.path)).toBe(false);
    expect((await git(["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await git(["status", "--porcelain"])).toBe(" M notes.md\n");
  } finally {
    await temp.cleanup();
  }
});

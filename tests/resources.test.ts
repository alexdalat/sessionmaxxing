import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  RESOURCE_ERROR,
  resolveResources,
  resourcesCollide,
} from "../server/resources.js";
import { temporary } from "./helpers";

async function repo(path: string) {
  await mkdir(join(path, ".git"), { recursive: true });
  return path;
}

it("keys a checkout by its canonical path and its .git directory", async () => {
  const temp = await temporary();
  try {
    const root = await realpath(temp.path);
    await repo(join(root, "repo"));
    await mkdir(join(root, "repo", "packages", "web"), { recursive: true });
    expect(await resolveResources(join(root, "repo"))).toEqual([
      `path:${root}/repo`,
      `repo:${root}/repo/.git`,
    ]);
    expect(
      await resolveResources(join(root, "repo", "packages", "web")),
    ).toEqual([`path:${root}/repo/packages/web`, `repo:${root}/repo/.git`]);
  } finally {
    await temp.cleanup();
  }
});

it("follows a linked worktree's .git file to the repository it shares", async () => {
  const temp = await temporary();
  try {
    const root = await realpath(temp.path);
    const main = await repo(join(root, "main"));
    const linked = join(root, "main-feature");
    await mkdir(join(main, ".git", "worktrees", "feature"), {
      recursive: true,
    });
    await writeFile(
      join(main, ".git", "worktrees", "feature", "commondir"),
      "../..\n",
    );
    await mkdir(linked);
    await writeFile(
      join(linked, ".git"),
      `gitdir: ${main}/.git/worktrees/feature\n`,
    );
    expect(await resolveResources(linked)).toEqual([
      `path:${linked}`,
      `repo:${main}/.git`,
    ]);
    expect(
      resourcesCollide(
        await resolveResources(linked),
        await resolveResources(main),
      ),
    ).toBe(true);
  } finally {
    await temp.cleanup();
  }
});

it("resolves this worktree and its main checkout to one repository", async () => {
  const here = await resolveResources(resolve("tests"));
  const repoKey = here.find((key) => key.startsWith("repo:"));
  expect(repoKey).toMatch(/^repo:\/.*\/\.git$/);
  expect(repoKey).not.toMatch(/worktrees/);
});

it("keeps a submodule's private git dir as its own key when no commondir exists", async () => {
  const temp = await temporary();
  try {
    const root = await realpath(temp.path);
    const superproject = await repo(join(root, "super"));
    await mkdir(join(superproject, ".git", "modules", "lib"), {
      recursive: true,
    });
    await mkdir(join(superproject, "lib"));
    await writeFile(
      join(superproject, "lib", ".git"),
      "gitdir: ../.git/modules/lib\n",
    );
    expect(await resolveResources(join(superproject, "lib"))).toEqual([
      `path:${superproject}/lib`,
      `repo:${superproject}/.git/modules/lib`,
    ]);
  } finally {
    await temp.cleanup();
  }
});

it("resolves symlinked work directories to their target before keying them", async () => {
  const temp = await temporary();
  try {
    const root = await realpath(temp.path);
    const target = await repo(join(root, "target"));
    await symlink(target, join(root, "alias"));
    expect(await resolveResources(join(root, "alias"))).toEqual(
      await resolveResources(target),
    );
  } finally {
    await temp.cleanup();
  }
});

it("refuses a .git file it cannot follow instead of guessing", async () => {
  const temp = await temporary();
  try {
    const root = await realpath(temp.path);
    await mkdir(join(root, "broken"));
    await writeFile(join(root, "broken", ".git"), "not a git pointer\n");
    await expect(resolveResources(join(root, "broken"))).rejects.toThrow(
      RESOURCE_ERROR,
    );
    await expect(resolveResources(join(root, "missing"))).rejects.toThrow(
      RESOURCE_ERROR,
    );
  } finally {
    await temp.cleanup();
  }
});

it("collides equal, nested, and same-repository resources but not independent ones", () => {
  const a = ["path:/home/user/ws/a", "repo:/home/user/ws/a/.git"];
  const inner = ["path:/home/user/ws/a/src", "repo:/home/user/ws/a/.git"];
  const sibling = ["path:/home/user/ws/a-side", "repo:/home/user/ws/a/.git"];
  const other = ["path:/home/user/ws/b", "repo:/home/user/ws/b/.git"];
  const home = ["path:/home/user"];
  const prefix = ["path:/home/user/ws/ab"];
  expect(resourcesCollide(a, a)).toBe(true);
  expect(resourcesCollide(a, inner)).toBe(true);
  expect(resourcesCollide(inner, a)).toBe(true);
  expect(resourcesCollide(a, sibling)).toBe(true);
  expect(resourcesCollide(home, other)).toBe(true);
  expect(resourcesCollide(a, other)).toBe(false);
  expect(resourcesCollide(a, prefix)).toBe(false);
  expect(resourcesCollide([], a)).toBe(false);
});

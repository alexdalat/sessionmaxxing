import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { suggestWorkdirs } from "../server/workdirs.js";
import { temporary } from "./helpers";

async function fakeHome(
  directories: string[],
  projects?: Record<string, { lastStartTime?: number }>,
) {
  const temp = await temporary();
  for (const directory of directories)
    await mkdir(join(temp.path, directory), { recursive: true });
  if (projects !== undefined)
    await writeFile(
      join(temp.path, ".claude.json"),
      JSON.stringify({ numStartups: 3, projects }),
    );
  return temp;
}

it("orders recent directories by last Claude Code start, oldest for projects without one", async () => {
  const temp = await fakeHome(["alpha", "beta", "gamma"]);
  const at = (name: string) => join(temp.path, name);
  await writeFile(
    join(temp.path, ".claude.json"),
    JSON.stringify({
      projects: {
        [at("gamma")]: { lastStartTime: 3000 },
        [at("beta")]: {},
        [at("alpha")]: { lastStartTime: 9000 },
      },
    }),
  );
  try {
    const { recent } = await suggestWorkdirs("", [], temp.path, temp.path);
    expect(recent).toEqual([at("alpha"), at("gamma"), at("beta")]);
  } finally {
    await temp.cleanup();
  }
});

it("drops projects that no longer exist or sit outside the home root", async () => {
  const temp = await fakeHome(["kept"]);
  const at = (name: string) => join(temp.path, name);
  await writeFile(
    join(temp.path, ".claude.json"),
    JSON.stringify({
      projects: {
        [at("kept")]: { lastStartTime: 4000 },
        [at("deleted")]: { lastStartTime: 5000 },
        "/etc": { lastStartTime: 6000 },
        [join(temp.path, "..", "sibling")]: { lastStartTime: 7000 },
      },
    }),
  );
  try {
    expect(
      (await suggestWorkdirs("", [], temp.path, temp.path)).recent,
    ).toEqual([at("kept")]);
  } finally {
    await temp.cleanup();
  }
});

it("appends queued work directories once, newest first, when no state file exists", async () => {
  const temp = await fakeHome(["one", "two", "three"]);
  const at = (name: string) => join(temp.path, name);
  try {
    const { recent } = await suggestWorkdirs(
      "",
      [at("two"), at("one"), at("two"), at("gone")],
      temp.path,
      temp.path,
    );
    expect(recent).toEqual([at("two"), at("one")]);
  } finally {
    await temp.cleanup();
  }
});

it("keeps at most twelve recent directories", async () => {
  const names = Array.from({ length: 14 }, (_, index) => `repo-${index}`);
  const temp = await fakeHome(names);
  const at = (name: string) => join(temp.path, name);
  await writeFile(
    join(temp.path, ".claude.json"),
    JSON.stringify({
      projects: Object.fromEntries(
        names.map((name, index) => [at(name), { lastStartTime: 1000 - index }]),
      ),
    }),
  );
  try {
    const { recent } = await suggestWorkdirs("", [], temp.path, temp.path);
    expect(recent).toHaveLength(12);
    expect(recent[0]).toBe(at("repo-0"));
    expect(recent).not.toContain(at("repo-12"));
  } finally {
    await temp.cleanup();
  }
});

it("fails instead of returning nothing when the Claude Code state file is malformed", async () => {
  const temp = await fakeHome([]);
  await writeFile(join(temp.path, ".claude.json"), "{not json");
  try {
    await expect(
      suggestWorkdirs("", [], temp.path, temp.path),
    ).rejects.toThrow();
  } finally {
    await temp.cleanup();
  }
});

it("matches directories whose name starts with the typed prefix", async () => {
  const temp = await fakeHome(["work/alpha", "work/alphabet", "work/beta"], {});
  const at = (name: string) => join(temp.path, name);
  try {
    const { matches } = await suggestWorkdirs(
      at("work/alph"),
      [],
      temp.path,
      temp.path,
    );
    expect(matches).toEqual([at("work/alpha"), at("work/alphabet")]);
  } finally {
    await temp.cleanup();
  }
});

it("lists every visible directory when the typed path ends with a slash", async () => {
  const temp = await fakeHome(
    ["work/alpha", "work/beta", "work/.hidden", "work/node_modules"],
    {},
  );
  const at = (name: string) => join(temp.path, name);
  await writeFile(join(temp.path, "work/notes.md"), "a file, not a directory");
  await symlink(at("work/alpha"), at("work/link"));
  await symlink(at("work/missing"), at("work/dangling"));
  try {
    const { matches } = await suggestWorkdirs(
      `${at("work")}/`,
      [],
      temp.path,
      temp.path,
    );
    expect(matches).toEqual([
      at("work/alpha"),
      at("work/beta"),
      at("work/link"),
    ]);
  } finally {
    await temp.cleanup();
  }
});

it("returns no matches for a relative query or a directory outside the home root", async () => {
  const temp = await fakeHome(["work"], {});
  try {
    expect(
      (await suggestWorkdirs("work/al", [], temp.path, temp.path)).matches,
    ).toEqual([]);
    expect(
      (await suggestWorkdirs("/etc/pa", [], temp.path, temp.path)).matches,
    ).toEqual([]);
    expect(
      (
        await suggestWorkdirs(
          join(temp.path, "absent/x"),
          [],
          temp.path,
          temp.path,
        )
      ).matches,
    ).toEqual([]);
  } finally {
    await temp.cleanup();
  }
});

it("reads Claude state only from the Claude home, whatever the root", async () => {
  const root = await fakeHome(["inside"]);
  const claudeHome = await temporary();
  const at = (name: string) => join(root.path, name);
  await writeFile(
    join(root.path, ".claude.json"),
    JSON.stringify({ projects: { [at("inside")]: { lastStartTime: 1 } } }),
  );
  try {
    expect(
      (await suggestWorkdirs("", [], root.path, claudeHome.path)).recent,
    ).toEqual([]);
    await writeFile(
      join(claudeHome.path, ".claude.json"),
      JSON.stringify({
        projects: {
          [at("inside")]: { lastStartTime: 2 },
          [claudeHome.path]: { lastStartTime: 3 },
        },
      }),
    );
    expect(
      (await suggestWorkdirs("", [], root.path, claudeHome.path)).recent,
    ).toEqual([at("inside")]);
  } finally {
    await root.cleanup();
    await claudeHome.cleanup();
  }
});

it("lists matches only inside the root", async () => {
  const root = await fakeHome(["work/alpha"]);
  const outside = await fakeHome(["work/alpha"]);
  try {
    expect(
      (
        await suggestWorkdirs(
          join(root.path, "work/al"),
          [],
          root.path,
          outside.path,
        )
      ).matches,
    ).toEqual([join(root.path, "work/alpha")]);
    expect(
      (
        await suggestWorkdirs(
          join(outside.path, "work/al"),
          [],
          root.path,
          outside.path,
        )
      ).matches,
    ).toEqual([]);
  } finally {
    await root.cleanup();
    await outside.cleanup();
  }
});

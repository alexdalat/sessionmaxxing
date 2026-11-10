import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  moveLegacyData,
  prepareDataDirectory,
  resolveDataDirectory,
} from "../server/data-directory.js";
import { planDispatch } from "../server/dispatch.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { DomainError } from "../server/storage.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchLoad,
} from "../shared/types.js";
import {
  fakeChild,
  SESSION_RATES,
  TEST_TIME_ZONE,
  TEST_WORKDIR_ROOT,
  taskInput,
  temporary,
  usageSnapshot,
} from "./helpers";

const HOME = "/home/user";
const SAMPLE_TIME = new Date("2026-09-07T00:00:00.000Z");
const serial = (load: DispatchLoad) =>
  planDispatch(
    { ...DEFAULT_DISPATCH_SETTINGS, maxConcurrentRuns: 1 },
    { snapshot: null, error: null },
    new Date(),
    TEST_TIME_ZONE,
    undefined,
    load,
    { rates: SESSION_RATES, error: null },
  );
const MODE_MASK = 0o777;

interface Entry {
  path: string;
  kind: "directory" | "file";
  mode: number;
  content?: string;
}
async function describeTree(root: string, prefix = ""): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const stats = await lstat(path);
    const relative = join(prefix, name);
    const mode = stats.mode & MODE_MASK;
    if (stats.isDirectory()) {
      entries.push({ path: relative, kind: "directory", mode });
      entries.push(...(await describeTree(path, relative)));
    } else {
      entries.push({
        path: relative,
        kind: "file",
        mode,
        content: await readFile(path, "utf8"),
      });
    }
  }
  return entries;
}
async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
async function readStores(directory: string) {
  const queue = await QueueStore.open(directory, TEST_WORKDIR_ROOT);
  const runner = await Runner.open(queue, directory);
  const settings = await DispatchSettingsStore.open(directory);
  const usage = await UsageHistoryStore.open(directory, SAMPLE_TIME);
  const view = {
    queue: queue.snapshot(),
    runs: runner.list(),
    settings: settings.snapshot(),
    samples: usage.recent(SAMPLE_TIME),
    latest: usage.snapshot(),
  };
  await runner.close();
  return view;
}
async function writeLegacyTree(legacy: string) {
  await mkdir(join(legacy, "runs", "nested"), { recursive: true });
  await mkdir(join(legacy, "empty"));
  await writeFile(join(legacy, "queue.json"), '{"version":1}\n');
  await writeFile(
    join(legacy, "runs", "nested", "a.log"),
    "line one\nline two",
  );
  await writeFile(join(legacy, "secret.json"), "token-bytes", { mode: 0o600 });
  await chmod(join(legacy, "secret.json"), 0o600);
}

it("uses SESSIONMAXXING_DATA_DIR over XDG_DATA_HOME when both are set", () => {
  expect(
    resolveDataDirectory(
      { SESSIONMAXXING_DATA_DIR: "/srv/sm", XDG_DATA_HOME: "/var/xdg" },
      HOME,
    ),
  ).toBe("/srv/sm");
});
it("places the data directory under an absolute XDG_DATA_HOME", () => {
  expect(resolveDataDirectory({ XDG_DATA_HOME: "/var/xdg" }, HOME)).toBe(
    "/var/xdg/sessionmaxxing",
  );
});
it.each([["relative/xdg"], [""]])(
  "ignores XDG_DATA_HOME=%j and falls back to the home default",
  (xdg) => {
    expect(resolveDataDirectory({ XDG_DATA_HOME: xdg }, HOME)).toBe(
      "/home/user/.local/share/sessionmaxxing",
    );
  },
);
it("defaults to the home directory when no variable is set", () => {
  expect(resolveDataDirectory({}, HOME)).toBe(
    "/home/user/.local/share/sessionmaxxing",
  );
});
it.each([["relative"], [""]])(
  "rejects SESSIONMAXXING_DATA_DIR=%j naming the variable",
  (value) => {
    expect(() =>
      resolveDataDirectory({ SESSIONMAXXING_DATA_DIR: value }, HOME),
    ).toThrow(DomainError);
    expect(() =>
      resolveDataDirectory({ SESSIONMAXXING_DATA_DIR: value }, HOME),
    ).toThrow("SESSIONMAXXING_DATA_DIR");
  },
);

it("moves the legacy tree to an absent target with absent parents, keeping every byte and mode", async () => {
  const temp = await temporary();
  try {
    const legacy = join(temp.path, "data");
    const target = join(temp.path, "share", "deeper", "sessionmaxxing");
    await writeLegacyTree(legacy);
    const before = await describeTree(legacy);
    await moveLegacyData(legacy, target);
    expect(await describeTree(target)).toEqual(before);
    expect(before).toContainEqual({
      path: "secret.json",
      kind: "file",
      mode: 0o600,
      content: "token-bytes",
    });
    expect(before).toContainEqual({
      path: "empty",
      kind: "directory",
      mode: expect.any(Number),
    });
    expect(await exists(legacy)).toBe(false);
  } finally {
    await temp.cleanup();
  }
});
it("changes nothing when the legacy directory is absent", async () => {
  const temp = await temporary();
  try {
    const target = join(temp.path, "share", "sessionmaxxing");
    await moveLegacyData(join(temp.path, "data"), target);
    expect(await exists(target)).toBe(false);
    expect(await exists(join(temp.path, "share"))).toBe(false);
  } finally {
    await temp.cleanup();
  }
});
it.each([
  ["empty", async (_target: string) => undefined],
  [
    "populated",
    async (target: string) => writeFile(join(target, "queue.json"), "mine"),
  ],
])(
  "refuses to touch either side when the target exists and is %s",
  async (_label, fill) => {
    const temp = await temporary();
    try {
      const legacy = join(temp.path, "data");
      const target = join(temp.path, "target");
      await writeLegacyTree(legacy);
      await mkdir(target);
      await fill(target);
      const legacyBefore = await describeTree(legacy);
      const targetBefore = await describeTree(target);
      const failure = await moveLegacyData(legacy, target).catch(
        (error) => error,
      );
      expect(failure).toBeInstanceOf(DomainError);
      expect(failure.message).toContain(legacy);
      expect(failure.message).toContain(target);
      expect(await describeTree(legacy)).toEqual(legacyBefore);
      expect(await describeTree(target)).toEqual(targetBefore);
    } finally {
      await temp.cleanup();
    }
  },
);
it("refuses a legacy directory that holds server.lock", async () => {
  const temp = await temporary();
  try {
    const legacy = join(temp.path, "data");
    const target = join(temp.path, "target");
    await writeLegacyTree(legacy);
    await writeFile(join(legacy, "server.lock"), "4242");
    const before = await describeTree(legacy);
    await expect(moveLegacyData(legacy, target)).rejects.toThrow(
      join(legacy, "server.lock"),
    );
    expect(await describeTree(legacy)).toEqual(before);
    expect(await exists(target)).toBe(false);
  } finally {
    await temp.cleanup();
  }
});
it("refuses a legacy path that is a regular file", async () => {
  const temp = await temporary();
  try {
    const legacy = join(temp.path, "data");
    await writeFile(legacy, "not a directory");
    await expect(
      moveLegacyData(legacy, join(temp.path, "target")),
    ).rejects.toThrow("is not a directory");
    expect(await readFile(legacy, "utf8")).toBe("not a directory");
  } finally {
    await temp.cleanup();
  }
});
it("refuses a legacy path that is a symlink to a real directory", async () => {
  const temp = await temporary();
  try {
    const real = join(temp.path, "real");
    const legacy = join(temp.path, "data");
    await mkdir(real);
    await symlink(real, legacy);
    await expect(
      moveLegacyData(legacy, join(temp.path, "target")),
    ).rejects.toThrow("is not a directory");
    expect((await lstat(legacy)).isSymbolicLink()).toBe(true);
    expect(await exists(join(temp.path, "target"))).toBe(false);
  } finally {
    await temp.cleanup();
  }
});
it("does nothing when the target is the legacy path itself", async () => {
  const temp = await temporary();
  try {
    const legacy = join(temp.path, "data");
    await writeLegacyTree(legacy);
    const before = await describeTree(legacy);
    await moveLegacyData(legacy, legacy);
    await moveLegacyData(legacy, `${legacy}/`);
    expect(await describeTree(legacy)).toEqual(before);
  } finally {
    await temp.cleanup();
  }
});
it("refuses a target nested inside the legacy directory", async () => {
  const temp = await temporary();
  try {
    const legacy = join(temp.path, "data");
    const target = join(legacy, "inner", "sessionmaxxing");
    await writeLegacyTree(legacy);
    const before = await describeTree(legacy);
    const failure = await moveLegacyData(legacy, target).catch((e) => e);
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure.message).toContain(legacy);
    expect(failure.message).toContain(target);
    expect(await describeTree(legacy)).toEqual(before);
  } finally {
    await temp.cleanup();
  }
});
it("refuses a legacy directory nested inside the target", async () => {
  const temp = await temporary();
  try {
    const target = join(temp.path, "share");
    const legacy = join(target, "data");
    await writeLegacyTree(legacy);
    const before = await describeTree(legacy);
    const failure = await moveLegacyData(legacy, target).catch((e) => e);
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure.message).toContain(legacy);
    expect(failure.message).toContain(target);
    expect(await describeTree(legacy)).toEqual(before);
  } finally {
    await temp.cleanup();
  }
});
it("turns EXDEV into the exact single-quoted mv command and leaves legacy untouched", async () => {
  const temp = await temporary();
  try {
    const legacy = join(temp.path, "it's data");
    const target = join(temp.path, "share", "sessionmaxxing");
    await writeLegacyTree(legacy);
    const before = await describeTree(legacy);
    const crossDevice = Object.assign(new Error("cross-device"), {
      code: "EXDEV",
    });
    const failure = await moveLegacyData(legacy, target, async () => {
      throw crossDevice;
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure.message).toContain(
      `mv '${join(temp.path, "it'\\''s data")}' '${target}'`,
    );
    expect(await describeTree(legacy)).toEqual(before);
    expect(await exists(target)).toBe(false);
  } finally {
    await temp.cleanup();
  }
});
it("propagates any other rename error unchanged", async () => {
  const temp = await temporary();
  try {
    const legacy = join(temp.path, "data");
    await writeLegacyTree(legacy);
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(
      moveLegacyData(legacy, join(temp.path, "target"), async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
  } finally {
    await temp.cleanup();
  }
});

it("returns an explicit directory untouched and moves nothing even when cwd/data exists", async () => {
  const temp = await temporary();
  try {
    const cwd = join(temp.path, "cwd");
    await writeLegacyTree(join(cwd, "data"));
    const before = await describeTree(join(cwd, "data"));
    const explicit = join(temp.path, "chosen");
    expect(
      await prepareDataDirectory({
        explicit,
        env: {},
        home: join(temp.path, "home"),
        cwd,
      }),
    ).toBe(explicit);
    expect(await describeTree(join(cwd, "data"))).toEqual(before);
    expect(await exists(explicit)).toBe(false);
  } finally {
    await temp.cleanup();
  }
});
it("returns the resolved target without moving anything when the working directory has no data/", async () => {
  const temp = await temporary();
  try {
    const home = join(temp.path, "home");
    const cwd = join(temp.path, "cwd");
    await mkdir(cwd);
    const target = await prepareDataDirectory({
      explicit: undefined,
      env: {},
      home,
      cwd,
    });
    expect(target).toBe(join(home, ".local/share/sessionmaxxing"));
    expect(await exists(home)).toBe(false);
    expect(await readdir(cwd)).toEqual([]);
  } finally {
    await temp.cleanup();
  }
});
const PROJECT_ROWS = "id,value\n1,2\n";
it.each([
  [
    "a project folder without queue.json",
    async (path: string) => {
      await mkdir(path);
      await writeFile(join(path, "rows.csv"), PROJECT_ROWS);
    },
  ],
  ["a regular file", (path: string) => writeFile(path, PROJECT_ROWS)],
])(
  "leaves %s named data in the working directory where it is",
  async (_label, create) => {
    const temp = await temporary();
    try {
      const home = join(temp.path, "home");
      const cwd = join(temp.path, "cwd");
      await mkdir(cwd);
      await create(join(cwd, "data"));
      const before = await describeTree(cwd);
      expect(
        await prepareDataDirectory({ explicit: undefined, env: {}, home, cwd }),
      ).toBe(join(home, ".local/share/sessionmaxxing"));
      expect(await describeTree(cwd)).toEqual(before);
      expect(await exists(home)).toBe(false);
    } finally {
      await temp.cleanup();
    }
  },
);
it("starts beside a project's data folder when the data directory already exists", async () => {
  const temp = await temporary();
  try {
    const home = join(temp.path, "home");
    const cwd = join(temp.path, "cwd");
    const target = join(home, ".local/share/sessionmaxxing");
    await mkdir(join(cwd, "data"), { recursive: true });
    await writeFile(join(cwd, "data", "rows.csv"), PROJECT_ROWS);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "queue.json"), '{"version":1}\n');
    const cwdBefore = await describeTree(cwd);
    const targetBefore = await describeTree(target);
    expect(
      await prepareDataDirectory({ explicit: undefined, env: {}, home, cwd }),
    ).toBe(target);
    expect(await describeTree(cwd)).toEqual(cwdBefore);
    expect(await describeTree(target)).toEqual(targetBefore);
  } finally {
    await temp.cleanup();
  }
});
it("honours SESSIONMAXXING_DATA_DIR as the destination of the move", async () => {
  const temp = await temporary();
  try {
    const cwd = join(temp.path, "cwd");
    const target = join(temp.path, "elsewhere", "state");
    await writeLegacyTree(join(cwd, "data"));
    const before = await describeTree(join(cwd, "data"));
    expect(
      await prepareDataDirectory({
        explicit: undefined,
        env: { SESSIONMAXXING_DATA_DIR: target },
        home: join(temp.path, "home"),
        cwd,
      }),
    ).toBe(target);
    expect(await describeTree(target)).toEqual(before);
  } finally {
    await temp.cleanup();
  }
});

it("lets the real stores report the same queue, runs, settings and samples after the move", async () => {
  const temp = await temporary();
  try {
    const cwd = join(temp.path, "cwd");
    const home = join(temp.path, "home");
    const legacy = join(cwd, "data");
    await mkdir(legacy, { recursive: true });
    const store = await QueueStore.open(legacy, TEST_WORKDIR_ROOT);
    const finished = await store.create(taskInput(temp.path));
    await store.create({ ...taskInput(temp.path), title: "Still waiting" });
    const child = fakeChild();
    const runner = await Runner.open(store, legacy, { launch: () => child });
    runner.setPlanner(serial);
    await runner.start(finished.id);
    child.emit("close", 0, null);
    await runner.waitForIdle();
    await runner.close();
    await (await DispatchSettingsStore.open(legacy)).save({
      ...DEFAULT_DISPATCH_SETTINGS,
      sessionReservePercent: 30,
      weeklyMarginPercent: 5,
    });
    await (await UsageHistoryStore.open(legacy, SAMPLE_TIME)).record(
      usageSnapshot({ fetchedAt: "2026-09-06T12:00:00.000Z" }),
    );

    const before = await readStores(legacy);
    expect(before.queue.tasks).toHaveLength(2);
    expect(before.runs).toHaveLength(1);
    expect(before.runs[0]).toMatchObject({ status: "completed", exitCode: 0 });
    expect(before.settings.sessionReservePercent).toBe(30);
    expect(before.samples).toHaveLength(1);

    const target = await prepareDataDirectory({
      explicit: undefined,
      env: {},
      home,
      cwd,
    });
    expect(target).toBe(join(home, ".local/share/sessionmaxxing"));
    expect(await exists(legacy)).toBe(false);
    expect(await readStores(target)).toEqual(before);
  } finally {
    await temp.cleanup();
  }
});

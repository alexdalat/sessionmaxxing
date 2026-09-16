import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  SESSION_PING_COOLDOWN_MS,
  SESSION_PING_FAILED,
  SessionKeeper,
  sessionIdle,
  sessionPingArgs,
} from "../server/session-keeper.js";
import type { UsageSnapshot, UsageState } from "../shared/types.js";
import { fakeChild, temporary, usageSnapshot } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const START = Date.parse("2026-09-15T12:00:00Z");
const idle = (patch: Partial<UsageSnapshot> = {}) =>
  usageSnapshot({
    fetchedAt: "2026-09-15T11:59:00.000Z",
    session: { percent: 0, resetsAt: null },
    ...patch,
  });

function harness(
  directory: string,
  initial: UsageState,
  options: { enabled?: boolean; claudeRuns?: number } = {},
) {
  let clock = START;
  const state = { usage: initial, enabled: options.enabled ?? true };
  const children: ReturnType<typeof fakeChild>[] = [];
  const launch = vi.fn((_sessionId: string, _cwd: string) => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  const refreshed: number[] = [];
  const open = () =>
    SessionKeeper.open(directory, {
      enabled: () => state.enabled,
      usage: () => state.usage,
      refreshUsage: async () => {
        refreshed.push(clock);
      },
      claudeRuns: () => options.claudeRuns ?? 0,
      launch,
      now: () => new Date(clock),
      cwd: directory,
    });
  return {
    open,
    launch,
    children,
    refreshed,
    state,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
}

it("treats a missing or past reset time as an idle session and a future one as open", () => {
  const now = new Date(START);
  expect(sessionIdle({ percent: 0, resetsAt: null }, now)).toBe(true);
  expect(
    sessionIdle({ percent: 40, resetsAt: "2026-09-15T12:00:00.000Z" }, now),
  ).toBe(true);
  expect(
    sessionIdle({ percent: 40, resetsAt: "2026-09-15T12:00:01.000Z" }, now),
  ).toBe(false);
});

it("launches one short haiku prompt with its own session id when no window is open", async () => {
  const temp = await temporary();
  try {
    const h = harness(temp.path, { snapshot: idle(), error: null });
    const keeper = await h.open();
    await keeper.tick();
    expect(h.launch).toHaveBeenCalledTimes(1);
    const [sessionId, cwd] = h.launch.mock.calls[0];
    expect(sessionId).toMatch(UUID);
    expect(cwd).toBe(temp.path);
    expect(sessionPingArgs(sessionId)).toEqual([
      "-p",
      "hi",
      "--model",
      "haiku",
      "--max-turns",
      "1",
      "--session-id",
      sessionId,
    ]);
    expect(keeper.state()).toEqual({
      lastStartedAt: h.now().toISOString(),
      error: null,
    });
    await keeper.tick();
    expect(h.launch).toHaveBeenCalledTimes(1);
    h.advance(20_000);
    h.children[0].emit("close", 0, null);
    await keeper.close();
    expect(h.refreshed).toEqual([START + 20_000]);
    expect(keeper.state().error).toBeNull();
    expect([...keeper.sessions()]).toEqual([sessionId]);
    expect(
      JSON.parse(
        await readFile(join(temp.path, "session-keeper.json"), "utf8"),
      ),
    ).toEqual({
      pings: [
        {
          sessionId,
          startedAt: new Date(START).toISOString(),
          endedAt: new Date(START + 20_000).toISOString(),
          exitCode: 0,
        },
      ],
    });
  } finally {
    await temp.cleanup();
  }
});

it.each([
  ["the setting is off", { enabled: false }, idle()],
  ["no snapshot exists", {}, null],
  [
    "a window is still open",
    {},
    idle({ session: { percent: 30, resetsAt: "2026-09-15T13:00:00.000Z" } }),
  ],
  ["a Claude task is running", { claudeRuns: 1 }, idle()],
  [
    "the weekly window is exhausted",
    {},
    idle({ weekly: { percent: 100, resetsAt: "2026-09-20T08:00:00.000Z" } }),
  ],
])("does nothing while %s", async (_case, options, snapshot) => {
  const temp = await temporary();
  try {
    const h = harness(temp.path, { snapshot, error: null }, options);
    const keeper = await h.open();
    await keeper.tick();
    expect(h.launch).not.toHaveBeenCalled();
    expect(keeper.state()).toEqual({ lastStartedAt: null, error: null });
    await keeper.close();
  } finally {
    await temp.cleanup();
  }
});

it("pings again only after a newer snapshot still shows no window and the cooldown has passed", async () => {
  const temp = await temporary();
  try {
    const h = harness(temp.path, { snapshot: idle(), error: null });
    const keeper = await h.open();
    await keeper.tick();
    h.advance(10_000);
    h.children[0].emit("close", 0, null);
    await keeper.waitForIdle();
    h.advance(SESSION_PING_COOLDOWN_MS);
    await keeper.tick();
    expect(h.launch).toHaveBeenCalledTimes(1);
    h.state.usage = {
      snapshot: idle({ fetchedAt: new Date(START + 15_000).toISOString() }),
      error: null,
    };
    await keeper.tick();
    expect(h.launch).toHaveBeenCalledTimes(2);
    h.children[1].emit("close", 0, null);
    await keeper.waitForIdle();
    h.advance(1000);
    h.state.usage = {
      snapshot: idle({ fetchedAt: h.now().toISOString() }),
      error: null,
    };
    h.advance(SESSION_PING_COOLDOWN_MS - 2000);
    await keeper.tick();
    expect(h.launch).toHaveBeenCalledTimes(2);
    h.advance(1000);
    await keeper.tick();
    expect(h.launch).toHaveBeenCalledTimes(3);
    h.children[2].emit("close", 0, null);
    await keeper.close();
  } finally {
    await temp.cleanup();
  }
});

it("starts a new window once the reported reset time has passed", async () => {
  const temp = await temporary();
  try {
    const h = harness(temp.path, {
      snapshot: idle({
        session: { percent: 55, resetsAt: "2026-09-15T12:30:00.000Z" },
      }),
      error: null,
    });
    const keeper = await h.open();
    await keeper.tick();
    expect(h.launch).not.toHaveBeenCalled();
    h.advance(30 * 60_000);
    await keeper.tick();
    expect(h.launch).toHaveBeenCalledTimes(1);
    h.children[0].emit("close", 0, null);
    await keeper.close();
  } finally {
    await temp.cleanup();
  }
});

it("reports a ping that exits non-zero or cannot start, and clears it on the next success", async () => {
  const temp = await temporary();
  try {
    const h = harness(temp.path, { snapshot: idle(), error: null });
    const keeper = await h.open();
    await keeper.tick();
    h.children[0].emit("close", 1, null);
    await keeper.waitForIdle();
    expect(keeper.state().error).toBe(SESSION_PING_FAILED);
    h.advance(SESSION_PING_COOLDOWN_MS);
    h.state.usage = {
      snapshot: idle({ fetchedAt: h.now().toISOString() }),
      error: null,
    };
    await keeper.tick();
    h.children[1].emit("error", new Error("ENOENT"));
    await keeper.waitForIdle();
    expect(keeper.state().error).toBe(SESSION_PING_FAILED);
    h.advance(SESSION_PING_COOLDOWN_MS);
    h.state.usage = {
      snapshot: idle({ fetchedAt: h.now().toISOString() }),
      error: null,
    };
    await keeper.tick();
    h.children[2].emit("close", 0, null);
    await keeper.waitForIdle();
    expect(keeper.state().error).toBeNull();
    await keeper.close();
  } finally {
    await temp.cleanup();
  }
});

it("restores ping sessions from disk and closes a ping the last server left open", async () => {
  const temp = await temporary();
  try {
    const h = harness(temp.path, { snapshot: idle(), error: null });
    const keeper = await h.open();
    await keeper.tick();
    const [sessionId] = h.launch.mock.calls[0];
    h.advance(5000);
    const reopened = await h.open();
    expect([...reopened.sessions()]).toEqual([sessionId]);
    expect(reopened.state()).toEqual({
      lastStartedAt: new Date(START).toISOString(),
      error: null,
    });
    expect(
      JSON.parse(await readFile(join(temp.path, "session-keeper.json"), "utf8"))
        .pings[0].endedAt,
    ).toBe(new Date(START + 5000).toISOString());
    await reopened.close();
    h.children[0].emit("close", 0, null);
    await keeper.close();
    await writeFile(join(temp.path, "session-keeper.json"), '{"pings":[{}]}');
    await expect(h.open()).rejects.toThrow(/session keeper state is invalid/);
  } finally {
    await temp.cleanup();
  }
});

it("terminates a ping still running at shutdown", async () => {
  const temp = await temporary();
  try {
    const h = harness(temp.path, { snapshot: idle(), error: null });
    const keeper = await h.open();
    await keeper.tick();
    const child = h.children[0];
    child.kill.mockImplementation(() => {
      child.emit("close", null, "SIGTERM");
      return true;
    });
    await keeper.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(keeper.state().error).toBe(SESSION_PING_FAILED);
  } finally {
    await temp.cleanup();
  }
});

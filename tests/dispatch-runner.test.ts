import { expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { DispatchSettingsStore } from "../server/dispatch-settings.js";
import { QueueStore } from "../server/queue.js";
import { Runner } from "../server/runner.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import { fakeChild, taskInput, temporary, usageSnapshot } from "./helpers";

it("auto-dispatch skips Claude tasks without headroom, still runs Codex tasks, and promotes Claude tasks once usage drops", async () => {
  const temp = await temporary();
  let clock = Date.parse("2026-09-06T12:00:00Z");
  const now = () => new Date(clock);
  let sessionPercent = 80;
  const monitor = new UsageMonitor(
    async (at) =>
      usageSnapshot({
        fetchedAt: at.toISOString(),
        session: { percent: sessionPercent, resetsAt: "2026-09-06T16:09:00Z" },
      }),
    await UsageHistoryStore.open(temp.path, now()),
    now,
  );
  const queue = await QueueStore.open(temp.path);
  const settings = await DispatchSettingsStore.open(temp.path);
  const child = fakeChild();
  const launch = vi.fn(() => child);
  const runner = await Runner.open(queue, temp.path, { launch, now });
  const app = await createApp({ queue, runner, settings, usage: monitor, now });
  try {
    await monitor.refresh();
    const claude = await queue.create(taskInput(temp.path));
    const codex = await queue.create({
      ...taskInput(temp.path),
      provider: "codex",
      priority: 1,
    });
    await queue.setAutoDispatch(true);
    await Promise.all([runner.tick(), runner.tick()]);
    expect(runner.list()[0]?.taskId).toBe(codex.id);
    expect(launch).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    await runner.waitForIdle();
    await runner.tick();
    expect(launch).toHaveBeenCalledTimes(1);
    const waiting = (await app.inject("/api/queue"))
      .json()
      .tasks.find((task: { id: string }) => task.id === claude.id);
    expect(waiting.gate).toEqual({
      status: "waiting",
      reason: "Session at 80%, above the 75% ceiling",
    });
    sessionPercent = 30;
    clock += 60_000;
    await monitor.refresh();
    await runner.tick();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(runner.list()[0]?.taskId).toBe(claude.id);
    child.emit("close", 0);
    await runner.waitForIdle();
    await settings.save({ sessionReservePercent: 80, weeklyMarginPercent: 10 });
    await queue.create(taskInput(temp.path));
    await runner.tick();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(
      (await app.inject("/api/queue")).json().planning.providers.claude,
    ).toEqual({
      status: "waiting",
      reason: "Session at 30%, above the 20% ceiling",
    });
  } finally {
    child.emit("close", 0);
    await runner.waitForIdle();
    await app.close();
    await temp.cleanup();
  }
});

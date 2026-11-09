import { readdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import { temporary, usageSnapshot } from "./helpers";

const now = new Date("2026-09-06T12:00:00Z");

it("stop waits for a fetch in flight so nothing is written after it resolves", async () => {
  const temp = await temporary();
  try {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const monitor = new UsageMonitor(
      async () => {
        await gate;
        return usageSnapshot({ fetchedAt: now.toISOString() });
      },
      await UsageHistoryStore.open(temp.path, now),
      () => now,
    );
    monitor.start();
    const stopped = monitor.stop();
    release();
    await stopped;
    const afterStop = await readdir(temp.path);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(temp.path)).toEqual(afterStop);
    expect(afterStop).toContain("usage-samples.jsonl");
  } finally {
    await temp.cleanup();
  }
});

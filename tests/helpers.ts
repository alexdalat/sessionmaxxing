import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import type { UsageSnapshot } from "../shared/types.js";
export async function temporary() {
  await mkdir("tests/.tmp", { recursive: true });
  const path = await mkdtemp(resolve("tests/.tmp/case-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
export const taskInput = (workdir: string) => ({
  title: "Fix a test",
  prompt: "PRIVATE PROMPT $(echo unsafe) `whoami`\nKeep as one argument",
  workdir,
  provider: "claude" as const,
  priority: 0,
  earliestStart: null,
  preferredWindowStart: null,
  maxTurns: 10,
});
export const usageSnapshot = (
  patch: Partial<UsageSnapshot> = {},
): UsageSnapshot => ({
  fetchedAt: "2026-09-06T12:00:00.000Z",
  plan: "max",
  session: { percent: 16, resetsAt: "2026-09-06T16:09:00.000Z" },
  weekly: { percent: 2, resetsAt: "2026-09-13T07:53:00.000Z" },
  fable: { percent: 4, resetsAt: "2026-09-13T07:53:00.000Z" },
  ...patch,
});

export function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined as number | undefined,
    kill: vi.fn(() => true),
  });
}

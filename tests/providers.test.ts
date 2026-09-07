import { expect, it, vi } from "vitest";
import { launchProvider, type SpawnProvider } from "../server/providers.js";
import { fakeChild, taskInput } from "./helpers";

it("launches exact provider argv with top-level Codex flags, no shell, and the whole prompt as one argument", () => {
  const child = fakeChild();
  const spawn = vi.fn<SpawnProvider>(() => child);
  const base = {
    ...taskInput("/home/user"),
    id: "a".repeat(24),
    status: "pending" as const,
    createdAt: new Date().toISOString(),
    model: "opus",
  };
  launchProvider(base, spawn);
  expect(spawn).toHaveBeenLastCalledWith(
    "claude",
    [
      "-p",
      base.prompt,
      "--model",
      "opus",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--max-turns",
      "10",
    ],
    {
      cwd: "/home/user",
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  launchProvider({ ...base, provider: "codex", model: "gpt-6-astra" }, spawn);
  expect(spawn).toHaveBeenLastCalledWith(
    "codex",
    [
      "-m",
      "gpt-6-astra",
      "-s",
      "workspace-write",
      "-a",
      "never",
      "exec",
      "--skip-git-repo-check",
      "--",
      base.prompt,
    ],
    {
      cwd: "/home/user",
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  expect(
    spawn.mock.calls.every(
      (call) => call[1].filter((arg) => arg === base.prompt).length === 1,
    ),
  ).toBe(true);
  expect(
    spawn.mock.calls.map((call) =>
      call[1].includes("--dangerously-skip-permissions"),
    ),
  ).toEqual([true, false]);
});
it("bounds previews and redacts arbitrary text, credentials, environment values, IDs, and message contents across chunks", async () => {
  const { OutputPreview } = await import("../server/output.js");
  const preview = new OutputPreview();
  preview.push(
    "stdout",
    '{"type":"assistant","message":{"content":"PRIVATE PROMPT sk-secret",',
  );
  preview.push(
    "stdout",
    '"usage":{"output_tokens":12}},"uuid":"8a23ad17-7659-48e0-9fcd-6ac18fed91a9"}\n',
  );
  preview.push("stderr", "ENV_SECRET=hidden OAuth\n");
  for (let i = 0; i < 200; i++)
    preview.push("stdout", `${"x".repeat(20_000)}\n`);
  expect(preview.lines()).toContain("Assistant response · output tokens: 12");
  expect(preview.lines().join("\n").length).toBeLessThanOrEqual(8192);
  expect(preview.lines().join("\n")).not.toMatch(
    /PRIVATE|sk-secret|hidden|OAuth|8a23|ENV_SECRET|xxx/,
  );
  expect(preview.lines().join("\n")).toContain("[redacted");
});

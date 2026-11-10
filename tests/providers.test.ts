import { expect, it, vi } from "vitest";
import {
  autoApplyInstruction,
  HEADLESS_INSTRUCTION,
  isLimitStop,
  launchProvider,
  RESUME_PROMPT,
  type SpawnProvider,
  withAutoApply,
} from "../server/providers.js";
import type { RestartMethod } from "../shared/types.js";
import { fakeChild, taskInput } from "./helpers";

it("launches the exact claude argv with no shell and the whole prompt, headless instruction appended, as one argument", () => {
  const child = fakeChild();
  const spawn = vi.fn<SpawnProvider>(() => child);
  const base = {
    ...taskInput("/home/user"),
    id: "a".repeat(24),
    status: "pending" as const,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    model: "opus",
  };
  const sessionId = "4f1c2b6e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
  const launched = `${base.prompt}\n\n${HEADLESS_INSTRUCTION}`;
  launchProvider(base, sessionId, false, spawn);
  expect(spawn).toHaveBeenLastCalledWith(
    "claude",
    [
      "-p",
      launched,
      "--model",
      "opus",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--max-turns",
      "10",
      "--session-id",
      sessionId,
    ],
    {
      cwd: "/home/user",
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  expect(spawn.mock.lastCall?.[1].filter((arg) => arg === launched)).toEqual([
    launched,
  ]);
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
it("keeps the final result text as the run summary", async () => {
  const { OutputPreview } = await import("../server/output.js");
  const preview = new OutputPreview();
  preview.push(
    "stdout",
    '{"type":"assistant","message":{"content":"working on it","usage":{"output_tokens":3}}}\n',
  );
  preview.push(
    "stdout",
    '{"type":"result","is_error":false,"num_turns":4,"result":"Renamed the parser and ran the tests."}\n',
  );
  preview.flush();
  expect(preview.summary()).toBe("Renamed the parser and ran the tests.");
  expect(preview.lines().join("\n")).not.toContain("working on it");
});
it("truncates a long summary to its tail", async () => {
  const { MAX_SUMMARY_CHARS, OutputPreview } = await import(
    "../server/output.js"
  );
  const preview = new OutputPreview();
  const result = `${"a".repeat(MAX_SUMMARY_CHARS)}That is the end.`;
  preview.push(
    "stdout",
    `${JSON.stringify({ type: "result", is_error: false, num_turns: 1, result })}\n`,
  );
  const summary = preview.summary();
  expect(summary).toHaveLength(MAX_SUMMARY_CHARS);
  expect(summary?.startsWith("…")).toBe(true);
  expect(summary?.endsWith("That is the end.")).toBe(true);
});
it("keeps plain stdout out of the summary and the preview", async () => {
  const { OutputPreview } = await import("../server/output.js");
  const preview = new OutputPreview();
  preview.push("stdout", "Updated the parser.\nAll tests pass.\n");
  preview.flush();
  expect(preview.summary()).toBeNull();
  expect(preview.lines()).toEqual(["[redacted stdout]"]);
});

const applyTask = {
  ...taskInput("/home/user"),
  id: "a".repeat(24),
  status: "pending" as const,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  model: "opus",
};
const APPLY_METHODS: [string, RestartMethod, string][] = [
  [
    "none",
    { kind: "none" },
    "the dashboard restarts nothing after the run ends",
  ],
  [
    "compose",
    { kind: "compose" },
    "`docker compose build` and `docker compose up -d`",
  ],
  [
    "command",
    { kind: "command", argv: ["./restart.sh", "--secret-flag"] },
    "the restart command ./restart.sh",
  ],
];
it.each(APPLY_METHODS)(
  "tells an auto-apply run about a %s restart method",
  (_kind, method, sentence) => {
    const instruction = autoApplyInstruction(method);
    expect(instruction).toContain(
      "ignore git entirely: do not check git status, commit, stash, branch, or create a worktree",
    );
    expect(instruction).toContain(
      "never skip or refuse a change because of uncommitted changes",
    );
    expect(instruction).toContain(sentence);
    expect(instruction).toContain(
      "Never restart, recreate or stop the SessionMaxxing container",
    );
    expect(instruction).not.toContain("no docker");
    expect(instruction).not.toContain("on the host");
    expect(instruction).not.toContain("--secret-flag");
    expect(withAutoApply(applyTask, method).prompt).toBe(
      `${applyTask.prompt}\n\n${instruction}`,
    );
  },
);
it("resumes the stopped Claude session with the resume prompt, headless instruction appended, instead of the task prompt", () => {
  const child = fakeChild();
  const spawn = vi.fn<SpawnProvider>(() => child);
  const task = {
    ...taskInput("/home/user"),
    id: "b".repeat(24),
    status: "pending" as const,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    model: "opus",
  };
  const sessionId = "4f1c2b6e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
  launchProvider(task, sessionId, true, spawn);
  const args = spawn.mock.calls[0][1];
  expect(args.slice(0, 2)).toEqual([
    "-p",
    `${RESUME_PROMPT}\n\n${HEADLESS_INSTRUCTION}`,
  ]);
  expect(args.slice(-2)).toEqual(["--resume", sessionId]);
  expect(args).not.toContain("--session-id");
});
it("recognizes the session, 5-hour and weekly limit messages Claude Code ends a run with", () => {
  expect(
    isLimitStop(
      "You've hit your session limit · resets 5:50am (America/Chicago)",
    ),
  ).toBe(true);
  expect(
    isLimitStop("You've hit your 5-hour limit · resets 4am (America/Chicago)"),
  ).toBe(true);
  expect(isLimitStop("You’ve hit your weekly limit · resets Oct 11, 4am")).toBe(
    true,
  );
  expect(isLimitStop("The provider gave up.")).toBe(false);
  expect(isLimitStop(null)).toBe(false);
});

import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { Provider, Task } from "../shared/types.js";
export interface ProviderProcess extends EventEmitter {
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface LaunchOptions {
  cwd: string;
  shell: false;
  detached: true;
  stdio: ["ignore", "pipe", "pipe"];
}
export type SpawnProvider = (
  command: string,
  args: string[],
  options: LaunchOptions,
) => ProviderProcess;
export interface ProviderAdapter {
  command: string;
  args: (task: Task, sessionId: string | null) => string[];
}
/** Appended to a dispatched prompt while the queue's apply override is on. */
export const AUTO_APPLY_INSTRUCTION =
  "Apply this work yourself instead of leaving it for review. Edit the files directly in this work directory and ignore git entirely: do not check git status, commit, stash, branch, or create a worktree, and never skip or refuse a change because of uncommitted changes. This run has no docker. When the work directory has a Compose file, the dashboard redeploys it on the host after the run ends, so do not attempt `docker compose` yourself. Run any other deploy (a Coolify deploy, the project's own deploy command) before you finish. If that tooling is unavailable, report the blocker and the command.";
export const withAutoApply = (task: Task): Task => ({
  ...task,
  prompt: `${task.prompt}\n\n${AUTO_APPLY_INSTRUCTION}`,
});
export const providerAdapters: Record<Provider, ProviderAdapter> = {
  claude: {
    command: "claude",
    args: (task, sessionId) => [
      "-p",
      task.prompt,
      "--model",
      task.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--max-turns",
      String(task.maxTurns),
      ...(sessionId === null ? [] : ["--session-id", sessionId]),
    ],
  },
  codex: {
    command: "codex",
    args: (task) => [
      "-m",
      task.model,
      "-s",
      "workspace-write",
      "-a",
      "never",
      "exec",
      "--skip-git-repo-check",
      "--",
      task.prompt,
    ],
  },
};
export function launchProvider(
  task: Task,
  sessionId: string | null,
  spawnProcess: SpawnProvider = spawn,
  adapters = providerAdapters,
): ProviderProcess {
  const adapter = adapters[task.provider];
  return spawnProcess(adapter.command, adapter.args(task, sessionId), {
    cwd: task.workdir,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

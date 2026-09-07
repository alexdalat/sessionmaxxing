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
  args: (task: Task) => string[];
}
export const providerAdapters: Record<Provider, ProviderAdapter> = {
  claude: {
    command: "claude",
    args: (task) => [
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
  spawnProcess: SpawnProvider = spawn,
  adapters = providerAdapters,
): ProviderProcess {
  const adapter = adapters[task.provider];
  return spawnProcess(adapter.command, adapter.args(task), {
    cwd: task.workdir,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

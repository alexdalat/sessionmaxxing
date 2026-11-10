import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { PRODUCT_NAME } from "../shared/product.js";
import type { RestartMethod, Task } from "../shared/types.js";
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
const CLAUDE_COMMAND = "claude";
const APPLY_IN_PLACE =
  "Apply this work yourself instead of leaving it for review. Edit the files directly in this work directory and ignore git entirely: do not check git status, commit, stash, branch, or create a worktree, and never skip or refuse a change because of uncommitted changes.";
const OTHER_DEPLOYS =
  "Run any other deploy the project needs (a Coolify deploy, the project's own deploy command) before you finish.";
const KEEP_DASHBOARD = `Never restart, recreate or stop the ${PRODUCT_NAME} container: it hosts this run.`;
const REPORT_BLOCKER =
  "If that tooling is unavailable, report the blocker and the command.";
const restartSentence = (method: RestartMethod) => {
  switch (method.kind) {
    case "none":
      return `This work directory has no restart method, so the dashboard restarts nothing after the run ends. ${OTHER_DEPLOYS}`;
    case "compose":
      return `After the run ends the dashboard restarts this work directory with \`docker compose build\` and \`docker compose up -d\`, so do not run them or redeploy the project yourself. ${OTHER_DEPLOYS}`;
    case "command":
      return `After the run ends the dashboard runs the restart command ${method.argv[0]} in this work directory, so do not run it or redeploy the project yourself. ${OTHER_DEPLOYS}`;
  }
};
/** Appended to a dispatched prompt while the queue's apply override is on; names what the dashboard restarts afterwards. */
export const autoApplyInstruction = (method: RestartMethod) =>
  [
    APPLY_IN_PLACE,
    restartSentence(method),
    KEEP_DASHBOARD,
    REPORT_BLOCKER,
  ].join(" ");
export const withAutoApply = (task: Task, method: RestartMethod): Task => ({
  ...task,
  prompt: `${task.prompt}\n\n${autoApplyInstruction(method)}`,
});
/** The final message Claude Code prints when a usage limit ends a run. */
const LIMIT_STOP = /^You['’]ve hit your (?:session|weekly) limit\b/;
export const isLimitStop = (summary: string | null) =>
  summary !== null && LIMIT_STOP.test(summary);
export const RESUME_PROMPT =
  "The Claude usage limit stopped you before you finished. The limit has reset; continue the task from where you left off.";
/** `claude -p` exits when the lead turn ends and kills whatever still runs, so a queued run has to wait in the foreground. */
export const HEADLESS_INSTRUCTION =
  "This run is headless: the process exits as soon as your turn ends, which kills any subagent or background command still running. Start subagents and long commands in the foreground (several subagents in one message still run in parallel) and never end your turn while one is still working.";
export function launchProvider(
  task: Task,
  sessionId: string,
  resume = false,
  spawnProcess: SpawnProvider = spawn,
): ProviderProcess {
  return spawnProcess(
    CLAUDE_COMMAND,
    [
      "-p",
      `${resume ? RESUME_PROMPT : task.prompt}\n\n${HEADLESS_INSTRUCTION}`,
      "--model",
      task.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--max-turns",
      String(task.maxTurns),
      resume ? "--resume" : "--session-id",
      sessionId,
    ],
    {
      cwd: task.workdir,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

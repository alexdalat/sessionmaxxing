import { spawn } from "node:child_process";
import type { LaunchOptions, ProviderProcess } from "./providers.js";
import {
  capOutput,
  OUTPUT_CAP_BYTES,
  type RestartAction,
  type RestartRecord,
  type RestartStore,
  utf8Tail,
} from "./restarts.js";

export interface RestartSpawnOptions extends LaunchOptions {
  env: NodeJS.ProcessEnv;
}
export type SpawnRestart = (
  command: string,
  args: string[],
  options: RestartSpawnOptions,
) => ProviderProcess;
export interface RestartOptions {
  spawn?: SpawnRestart;
}
export interface RestartHooks {
  /** Resolves once no run is starting or active. */
  idle: () => Promise<void>;
  /** Pauses auto-dispatch with a message. */
  report: (message: string) => void;
}

const OWN_PREFIX = "SESSIONMAXXING_";
const DOCKER = "docker";
const RECORD_ERROR =
  "A restart record could not be saved. Auto-dispatch is paused; check runtime file access.";

// Compose interpolation prefers the shell environment over the project's .env, so the
// dashboard's own variables would override the project's values:
// https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/
export const restartEnv = (
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const stripped = { ...env };
  for (const name of Object.keys(stripped))
    if (name.startsWith(OWN_PREFIX)) delete stripped[name];
  return stripped;
};

interface Step {
  /** How failure lines name the step. */
  label: string;
  command: string;
  args: string[];
}
const restartSteps = (method: RestartAction): Step[] =>
  method.kind === "compose"
    ? [
        {
          label: "docker compose build",
          command: DOCKER,
          args: ["compose", "build"],
        },
        {
          label: "docker compose up -d",
          command: DOCKER,
          args: ["compose", "up", "-d"],
        },
      ]
    : [
        {
          label: method.argv[0],
          command: method.argv[0],
          args: method.argv.slice(1),
        },
      ];

/** The last OUTPUT_CAP_BYTES of every step's stdout and stderr, in arrival order. */
class OutputTail {
  private bytes = Buffer.alloc(0);
  push(chunk: Buffer | string) {
    const joined = Buffer.concat([this.bytes, Buffer.from(chunk)]);
    this.bytes =
      joined.length > OUTPUT_CAP_BYTES
        ? Buffer.from(joined.subarray(joined.length - OUTPUT_CAP_BYTES))
        : joined;
  }
  /** The captured text, then `failure` on its own line, within the cap. */
  withFailure(failure: string) {
    const text = utf8Tail(this.bytes);
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";
    return capOutput(`${text}${separator}${failure}`);
  }
}

/** Runs requested restarts one at a time, in request order, without a shell. */
export class RestartExecutor {
  private running: Promise<void> | null = null;
  private closed = false;
  constructor(
    private store: RestartStore,
    private options: RestartOptions,
    private hooks: RestartHooks,
  ) {}
  drain(): Promise<void> {
    if (this.running) return this.running;
    if (this.closed || !this.store.pending()) return Promise.resolve();
    this.running = this.loop();
    return this.running;
  }
  close(): Promise<void> {
    this.closed = true;
    return this.running ?? Promise.resolve();
  }
  private next() {
    return this.closed ? undefined : this.store.pending();
  }
  private async loop() {
    try {
      for (let record = this.next(); record; record = this.next())
        await this.execute(record);
    } catch {
      this.hooks.report(RECORD_ERROR);
    } finally {
      // Cleared in the same step as the check that found nothing pending, so a record
      // requested while the loop winds down starts a new drain.
      this.running = null;
    }
  }
  private async execute(record: RestartRecord) {
    const { workdir } = record;
    if (workdir === null)
      throw new Error("A pending restart has no work directory.");
    await this.store.update(record.runId, { status: "restarting" });
    const tail = new OutputTail();
    let failure: string | null = null;
    for (const step of restartSteps(record.method)) {
      if (this.closed) return;
      failure = await this.runStep(step, workdir, tail);
      if (failure !== null) break;
    }
    await this.store.update(
      record.runId,
      failure === null
        ? { status: "succeeded", output: null }
        : { status: "failed", output: tail.withFailure(failure) },
    );
  }
  /** Resolves with the line naming why the step failed, or null when it exited 0. */
  private runStep(
    step: Step,
    workdir: string,
    tail: OutputTail,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (failure: string | null) => {
        if (settled) return;
        settled = true;
        resolve(failure);
      };
      const couldNotStart = (error: Error) =>
        settle(`Could not start ${step.label} in ${workdir}: ${error.message}`);
      let child: ProviderProcess;
      try {
        child = (this.options.spawn ?? spawn)(step.command, step.args, {
          cwd: workdir,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: restartEnv(),
        });
      } catch (error) {
        couldNotStart(error as Error);
        return;
      }
      for (const channel of ["stdout", "stderr"] as const)
        child[channel]?.on("data", (chunk: Buffer | string) =>
          tail.push(chunk),
        );
      child.once("error", couldNotStart);
      child.once("close", (code: number | null, signal: NodeJS.Signals) =>
        settle(
          code === 0
            ? null
            : code === null
              ? `${step.label} was stopped by ${signal} in ${workdir}`
              : `${step.label} exited with code ${code} in ${workdir}`,
        ),
      );
    });
  }
}

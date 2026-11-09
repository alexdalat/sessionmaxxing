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
  /** Signals a process group; defaults to process.kill. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  stepTimeoutMs?: number;
  killGraceMs?: number;
}
export interface RestartHooks {
  /** Resolves once no run is starting or active. */
  idle: () => Promise<void>;
  /** Pauses auto-dispatch with a message. */
  report: (message: string) => void;
}

export const STEP_TIMEOUT_MS = 30 * 60_000;
export const KILL_GRACE_MS = 2000;
const MS_PER_MINUTE = 60_000;
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

/** A step ended because the executor closed; its record keeps the status it had. */
const STOPPED = Symbol("stopped");
type StepResult = string | null | typeof STOPPED;

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
  private stopStep: (() => void) | null = null;
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
    this.stopStep?.();
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
      const result = await this.runStep(step, record, workdir, tail);
      if (result === STOPPED) return;
      failure = result;
      if (failure !== null) break;
    }
    await this.store.update(
      record.runId,
      failure === null
        ? { status: "succeeded", output: null }
        : { status: "failed", output: tail.withFailure(failure) },
    );
  }
  /** Resolves with the line naming why the step failed, null when it exited 0, or STOPPED when the executor closed. */
  private runStep(
    step: Step,
    record: RestartRecord,
    workdir: string,
    tail: OutputTail,
  ): Promise<StepResult> {
    const limitMs = this.options.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    return new Promise((resolve) => {
      let settled = false;
      let stopping = false;
      let child: ProviderProcess | undefined;
      const timer = setTimeout(() => {
        settle(
          `${step.label} ran past ${limitMs / MS_PER_MINUTE} minutes in ${workdir} and was stopped`,
        );
        if (child) this.terminate(child, record.title);
      }, limitMs);
      timer.unref();
      const settle = (result: StepResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stopStep = null;
        resolve(result);
      };
      const couldNotStart = (error: Error) =>
        settle(`Could not start ${step.label} in ${workdir}: ${error.message}`);
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
      const running = child;
      this.stopStep = () => {
        stopping = true;
        this.terminate(running, record.title, () => settle(STOPPED));
      };
      for (const channel of ["stdout", "stderr"] as const)
        running[channel]?.on("data", (chunk: Buffer | string) =>
          tail.push(chunk),
        );
      running.once("error", couldNotStart);
      running.once("close", (code: number | null, signal: NodeJS.Signals) =>
        settle(
          stopping
            ? STOPPED
            : code === 0
              ? null
              : code === null
                ? `${step.label} was stopped by ${signal} in ${workdir}`
                : `${step.label} exited with code ${code} in ${workdir}`,
        ),
      );
    });
  }
  /** SIGTERM to the step's process group, SIGKILL after the grace; `killed` runs once SIGKILL is sent. */
  private terminate(
    child: ProviderProcess,
    title: string,
    killed?: () => void,
  ) {
    this.signal(child, title, "SIGTERM");
    const timer = setTimeout(() => {
      this.signal(child, title, "SIGKILL");
      killed?.();
    }, this.options.killGraceMs ?? KILL_GRACE_MS);
    timer.unref();
  }
  private signal(
    child: ProviderProcess,
    title: string,
    signal: NodeJS.Signals,
  ) {
    try {
      if (child.pid) (this.options.signal ?? process.kill)(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        this.hooks.report(
          `Could not stop the restart of “${title}”. Stop its process before restarting the dashboard.`,
        );
    }
  }
}

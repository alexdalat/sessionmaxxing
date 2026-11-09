import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
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
  /** Whether this server runs in the Docker image; absent means a native install. */
  dockerInstall?: boolean;
  /** The Docker socket the sibling container mounts. */
  socketPath?: string;
  /** How long a sibling may take; defaults to the step limit. */
  siblingTimeoutMs?: number;
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
export const DOCKER_SOCKET = "/var/run/docker.sock";
export const SIBLING_PREFIX = "sessionmaxxing-restart-";
export const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const UNMOUNTABLE = /[,"\r\n]/;
const EXIT_CODE = /^\d+$/;
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

/** The line the record shows when a restart fails. */
class RestartFailure extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}
/** The executor closed; the record keeps the status it had. */
class Stopped extends Error {}
/** What a step resolves with when the executor closed during it. */
const STOPPED = Symbol("stopped");

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
  text() {
    return utf8Tail(this.bytes);
  }
  /** The captured text, then `failure` on its own line, within the cap. */
  withFailure(failure: string) {
    const text = this.text();
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";
    return capOutput(`${text}${separator}${failure}`);
  }
}

interface Step {
  /** How failure lines name the step. */
  label: string;
  command: string;
  args: string[];
  /** Receives the step's stdout instead of the shared tail, so the executor can read it. */
  stdout?: OutputTail;
  limitMs?: number;
  /** The failure line when the step outlives its limit. */
  timeoutLine?: string;
}
const dockerStep = (label: string, ...args: string[]): Step => ({
  label,
  command: DOCKER,
  args,
});
const COMPOSE_BUILD = dockerStep("docker compose build", "compose", "build");
const COMPOSE_UP = dockerStep("docker compose up -d", "compose", "up", "-d");
const restartSteps = (method: RestartAction): Step[] =>
  method.kind === "compose"
    ? [COMPOSE_BUILD, COMPOSE_UP]
    : [
        {
          label: method.argv[0],
          command: method.argv[0],
          args: method.argv.slice(1),
        },
      ];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The image id and the Compose working-directory label of the container `docker inspect` described. */
function readInspect(text: string, container: string) {
  const unreadable = new RestartFailure(
    `docker inspect ${container} returned an answer the dashboard cannot read`,
  );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadable;
  }
  const described = Array.isArray(value) ? value[0] : undefined;
  if (!isRecord(described) || typeof described.Image !== "string")
    throw unreadable;
  const config = described.Config;
  const labels = isRecord(config) ? config.Labels : undefined;
  const label = isRecord(labels) ? labels[WORKING_DIR_LABEL] : undefined;
  if (label !== undefined && typeof label !== "string") throw unreadable;
  return { image: described.Image, label };
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
    const tail = new OutputTail();
    try {
      if (record.sibling !== null)
        await this.awaitSibling(record, record.sibling, workdir, tail);
      else await this.restart(record, workdir, tail);
    } catch (error) {
      if (error instanceof Stopped) return;
      if (!(error instanceof RestartFailure)) throw error;
      await this.store.update(record.runId, {
        status: "failed",
        output: tail.withFailure(error.message),
      });
    }
  }
  private async restart(
    record: RestartRecord,
    workdir: string,
    tail: OutputTail,
  ) {
    const image =
      record.method.kind === "compose" && this.options.dockerInstall
        ? await this.ownProjectImage(record, workdir, tail)
        : null;
    if (image !== null) return this.restartSelf(record, workdir, image, tail);
    await this.store.update(record.runId, { status: "restarting" });
    for (const step of restartSteps(record.method))
      await this.run(step, record, workdir, tail);
    await this.store.update(record.runId, {
      status: "succeeded",
      output: null,
    });
  }
  /** The dashboard's own image id when `workdir` is its Compose project, null for any other directory. */
  private async ownProjectImage(
    record: RestartRecord,
    workdir: string,
    tail: OutputTail,
  ) {
    const container = hostname();
    const stdout = new OutputTail();
    await this.run(
      {
        ...dockerStep(`docker inspect ${container}`, "inspect", container),
        stdout,
      },
      record,
      workdir,
      tail,
    );
    const { image, label } = readInspect(stdout.text(), container);
    if (label === undefined)
      throw new RestartFailure(
        `The dashboard container ${container} has no ${WORKING_DIR_LABEL} label, so its own project cannot be told from another`,
      );
    if (workdir !== label && workdir !== (await this.canonical(label)))
      return null;
    if (!IMAGE_ID.test(image))
      throw new RestartFailure(
        `docker inspect ${container} returned the image id ${image}, which is not sha256 and 64 hex digits`,
      );
    return image;
  }
  /** The real path of `path`, or the text itself when it does not exist here. */
  private async canonical(path: string) {
    try {
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
      throw error;
    }
  }
  /** Builds in place, waits for the runs to end, then lets a detached sibling recreate this container. */
  private async restartSelf(
    record: RestartRecord,
    workdir: string,
    image: string,
    tail: OutputTail,
  ) {
    const socket = this.options.socketPath ?? DOCKER_SOCKET;
    for (const path of [workdir, socket])
      if (UNMOUNTABLE.test(path))
        throw new RestartFailure(
          `${path} contains a comma, quote or line break, so docker run cannot mount it`,
        );
    await this.run(COMPOSE_BUILD, record, workdir, tail);
    await this.hooks.idle();
    if (this.closed) throw new Stopped();
    const { user, socketGid } = await this.identity(socket);
    const name = `${SIBLING_PREFIX}${record.runId}`;
    await this.store.update(record.runId, {
      status: "restarting",
      sibling: name,
    });
    const unset = Object.keys(process.env)
      .filter((variable) => variable.startsWith(OWN_PREFIX))
      .sort()
      .flatMap((variable) => ["-u", variable]);
    try {
      await this.run(
        dockerStep(
          "docker run",
          "run",
          "--detach",
          "--name",
          name,
          "--user",
          user,
          "--group-add",
          String(socketGid),
          "--mount",
          `type=bind,source=${socket},target=${socket}`,
          "--mount",
          `type=bind,source=${workdir},target=${workdir}`,
          "--workdir",
          workdir,
          image,
          "env",
          ...unset,
          DOCKER,
          "compose",
          "up",
          "-d",
        ),
        record,
        workdir,
        tail,
      );
    } catch (error) {
      if (error instanceof RestartFailure)
        await this.removeSibling(name, record, workdir, tail);
      throw error;
    }
    await this.awaitSibling(record, name, workdir, tail);
  }
  private async identity(socket: string) {
    if (!process.getuid || !process.getgid)
      throw new RestartFailure(
        "This platform has no user ids, so the sibling container cannot run as the dashboard's user",
      );
    try {
      return {
        user: `${process.getuid()}:${process.getgid()}`,
        socketGid: (await stat(socket)).gid,
      };
    } catch (error) {
      throw new RestartFailure(
        `Could not read the Docker socket ${socket}: ${(error as Error).message}`,
      );
    }
  }
  /** Waits for the sibling, records its outcome with its logs, and removes it. */
  private async awaitSibling(
    record: RestartRecord,
    name: string,
    workdir: string,
    tail: OutputTail,
  ) {
    const limitMs =
      this.options.siblingTimeoutMs ??
      this.options.stepTimeoutMs ??
      STEP_TIMEOUT_MS;
    const exit = new OutputTail();
    try {
      await this.run(
        {
          ...dockerStep(`docker wait ${name}`, "wait", name),
          stdout: exit,
          limitMs,
          timeoutLine: `Sibling ${name} did not finish within ${limitMs / MS_PER_MINUTE} minutes and was removed`,
        },
        record,
        workdir,
        tail,
      );
    } catch (error) {
      if (error instanceof RestartFailure && error.timedOut)
        await this.removeSibling(name, record, workdir, tail);
      throw error;
    }
    const code = exit.text().trim();
    if (!EXIT_CODE.test(code))
      throw new RestartFailure(
        `docker wait ${name} returned "${code}" instead of an exit code`,
      );
    await this.run(
      dockerStep(`docker logs ${name}`, "logs", name),
      record,
      workdir,
      tail,
    );
    await this.run(
      dockerStep(`docker rm ${name}`, "rm", name),
      record,
      workdir,
      tail,
    );
    if (code !== "0")
      throw new RestartFailure(`Sibling ${name} exited with code ${code}`);
    await this.store.update(record.runId, {
      status: "succeeded",
      output: null,
    });
  }
  /** Force-removes a sibling that failed or never finished; the primary failure stays the record's line. */
  private async removeSibling(
    name: string,
    record: RestartRecord,
    workdir: string,
    tail: OutputTail,
  ) {
    try {
      await this.run(
        dockerStep(`docker rm --force ${name}`, "rm", "--force", name),
        record,
        workdir,
        tail,
      );
    } catch (error) {
      if (!(error instanceof RestartFailure)) throw error;
    }
  }
  /** Throws Stopped when the executor closed and RestartFailure when the step failed. */
  private async run(
    step: Step,
    record: RestartRecord,
    workdir: string,
    tail: OutputTail,
  ) {
    if (this.closed) throw new Stopped();
    const result = await this.runStep(step, record, workdir, tail);
    if (result === STOPPED) throw new Stopped();
    if (result !== null) throw result;
  }
  /** Resolves with the failure naming why the step failed, null when it exited 0, or STOPPED when the executor closed. */
  private runStep(
    step: Step,
    record: RestartRecord,
    workdir: string,
    tail: OutputTail,
  ): Promise<RestartFailure | null | typeof STOPPED> {
    const limitMs =
      step.limitMs ?? this.options.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    return new Promise((resolve) => {
      let settled = false;
      let stopping = false;
      let child: ProviderProcess | undefined;
      const timer = setTimeout(() => {
        settle(
          new RestartFailure(
            step.timeoutLine ??
              `${step.label} ran past ${limitMs / MS_PER_MINUTE} minutes in ${workdir} and was stopped`,
            true,
          ),
        );
        if (child) this.terminate(child, record.title);
      }, limitMs);
      timer.unref();
      const settle = (result: RestartFailure | null | typeof STOPPED) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stopStep = null;
        resolve(result);
      };
      const fail = (line: string) => settle(new RestartFailure(line));
      const couldNotStart = (error: Error) =>
        fail(`Could not start ${step.label} in ${workdir}: ${error.message}`);
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
      running.stdout?.on("data", (chunk: Buffer | string) =>
        (step.stdout ?? tail).push(chunk),
      );
      running.stderr?.on("data", (chunk: Buffer | string) => tail.push(chunk));
      running.once("error", couldNotStart);
      running.once("close", (code: number | null, signal: NodeJS.Signals) => {
        if (stopping) settle(STOPPED);
        else if (code === 0) settle(null);
        else if (code === null)
          fail(`${step.label} was stopped by ${signal} in ${workdir}`);
        else fail(`${step.label} exited with code ${code} in ${workdir}`);
      });
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

import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanningSnapshot, Run, Task } from "../shared/types.js";
import { localParts, localStart, shiftDate } from "./analytics.js";
import { taskGate } from "./dispatch.js";
import { OutputPreview } from "./output.js";
import { launchProvider, type ProviderProcess } from "./providers.js";
import type { QueueStore } from "./queue.js";
import { atomicJson, DomainError, id } from "./storage.js";
import { validateWorkdir } from "./validation.js";

interface RunnerOptions {
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  launch?: (task: Task) => ProviderProcess;
  now?: () => Date;
}
interface Active {
  task: Task;
  run: Run;
  output: OutputPreview;
  child?: ProviderProcess;
  done: Promise<void>;
  resolve: () => void;
  finishing: boolean;
  cancelled?: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  flushTimer?: ReturnType<typeof setTimeout>;
  writeChain: Promise<void>;
}
export class Runner {
  private runs: Run[] = [];
  private active?: Active;
  private starting = false;
  private startDone: Promise<void> = Promise.resolve();
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private getPlanning?: () => PlanningSnapshot;
  setPlanner(planning: () => PlanningSnapshot) {
    this.getPlanning = planning;
  }
  error: string | null = null;
  private constructor(
    private store: QueueStore,
    private directory: string,
    private options: RunnerOptions,
  ) {}
  static async open(
    store: QueueStore,
    directory: string,
    options: RunnerOptions = {},
  ) {
    const runner = new Runner(store, join(directory, "runs"), options);
    await mkdir(runner.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(runner.directory)) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      const saved: Run = JSON.parse(
        await readFile(join(runner.directory, name), "utf8"),
      );
      if (
        saved.id !== name.slice(0, -5) ||
        !["running", "completed", "failed", "cancelled"].includes(saved.status)
      )
        throw new DomainError("Run metadata is invalid.", 500);
      const preview = JSON.parse(
        await readFile(join(runner.directory, `${saved.id}.log`), "utf8"),
      );
      const run: Run = {
        id: saved.id,
        taskId: saved.taskId,
        title: saved.title,
        provider: saved.provider,
        model: saved.model,
        status: saved.status,
        startedAt: saved.startedAt,
        endedAt: saved.endedAt,
        durationMs: saved.durationMs,
        exitCode: saved.exitCode,
        error: saved.error
          ? "Previous run failed. See status or retry the task."
          : null,
        preview: new OutputPreview(preview).lines(),
      };
      if (run.status === "running") {
        run.status = "failed";
        run.endedAt = runner.now().toISOString();
        run.error = "Server stopped before the run finished.";
        await runner.persist(run);
      }
      runner.runs.push(run);
    }
    return runner;
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  list(): Run[] {
    return this.runs
      .map((run) => ({
        ...run,
        preview:
          this.active?.run.id === run.id
            ? this.active.output.lines()
            : [...run.preview],
        durationMs:
          run.status === "running"
            ? Math.max(0, this.now().getTime() - Date.parse(run.startedAt))
            : run.durationMs,
      }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  private async persist(run: Run) {
    const { preview, ...metadata } = run;
    await atomicJson(join(this.directory, `${run.id}.log`), preview);
    await atomicJson(join(this.directory, `${run.id}.json`), metadata);
  }
  async start(taskId: string): Promise<Run> {
    if (this.stopped) throw new DomainError("The runner is shutting down.");
    if (this.starting || this.active)
      throw new DomainError("A task is already running.");
    this.starting = true;
    let releaseStart: (() => void) | undefined;
    this.startDone = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    try {
      const task = await this.store.claim(taskId);
      const run: Run = {
        id: id(),
        taskId: task.id,
        title: task.title,
        provider: task.provider,
        model: task.model,
        status: "running",
        startedAt: this.now().toISOString(),
        endedAt: null,
        durationMs: 0,
        exitCode: null,
        error: null,
        preview: [],
      };
      let resolve: () => void = () => {
        throw new Error("Completion resolver was not initialized.");
      };
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      const active: Active = {
        task,
        run,
        output: new OutputPreview(),
        done,
        resolve,
        finishing: false,
        writeChain: Promise.resolve(),
      };
      this.active = active;
      this.runs.push(run);
      try {
        task.workdir = await validateWorkdir(task.workdir);
        await this.persist(run);
        if (this.stopped || active.cancelled) {
          active.cancelled = true;
          await this.finish(active, null);
          return this.list().find((r) => r.id === run.id) as Run;
        }
        const child = (this.options.launch ?? launchProvider)(task);
        active.child = child;
        for (const channel of ["stdout", "stderr"] as const) {
          child[channel]?.on("data", (chunk) => {
            active.output.push(channel, chunk.toString());
            this.schedulePreview(active);
          });
        }
        child.once("error", () => {
          void this.finish(
            active,
            null,
            "Provider could not start. Check CLI installation and authentication.",
          );
        });
        child.once("close", (code: number | null) => {
          void this.finish(active, code);
        });
      } catch {
        await this.finish(
          active,
          null,
          "Run could not start. Check the work directory, CLI, and runtime file access.",
        );
      }
      return this.list().find((r) => r.id === run.id) as Run;
    } finally {
      this.starting = false;
      releaseStart?.();
    }
  }
  private schedulePreview(active: Active) {
    if (active.flushTimer || active.finishing) return;
    active.flushTimer = setTimeout(() => {
      active.flushTimer = undefined;
      active.writeChain = active.writeChain
        .then(() =>
          this.persist({ ...active.run, preview: active.output.lines() }),
        )
        .catch(() => {
          this.error =
            "Could not save live output. Auto-dispatch is paused; check runtime file access.";
        });
    }, 250);
    active.flushTimer.unref();
  }
  private async finish(active: Active, code: number | null, error?: string) {
    if (active.finishing) return;
    active.finishing = true;
    if (active.flushTimer) clearTimeout(active.flushTimer);
    await active.writeChain;
    active.output.flush();
    if (active.killTimer) clearTimeout(active.killTimer);
    active.run.status = active.cancelled
      ? "cancelled"
      : code === 0 && !error && !active.output.failed
        ? "completed"
        : "failed";
    active.run.exitCode = code;
    active.run.error =
      error ??
      (active.run.status === "failed"
        ? "Provider reported failure. Check CLI authentication, task settings, or retry."
        : null);
    active.run.endedAt = this.now().toISOString();
    active.run.durationMs = Math.max(
      0,
      this.now().getTime() - Date.parse(active.run.startedAt),
    );
    active.run.preview = active.output.lines();
    try {
      await this.persist(active.run);
    } catch {
      this.error =
        "Could not persist the run result. Queue state was finalized; check runtime file access and restart.";
    }
    try {
      await this.store.finish(active.task.id, active.run.status);
    } catch {
      this.error =
        "Could not finalize the queue task. Auto-dispatch is paused; check runtime file access and restart.";
    } finally {
      this.active = undefined;
      active.resolve();
    }
  }
  async waitForIdle() {
    await this.startDone;
    if (this.active) await this.active.done;
  }
  private signal(active: Active, signal: NodeJS.Signals) {
    if (!active.child) return;
    try {
      if (active.child.pid)
        (this.options.signal ?? process.kill)(-active.child.pid, signal);
      else active.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        throw new DomainError("Could not signal the provider process.");
    }
  }
  async cancel(taskId: string) {
    const active = this.active;
    if (!active || active.task.id !== taskId || active.finishing)
      throw new DomainError("Task is not running.");
    active.cancelled = true;
    this.signal(active, "SIGTERM");
    if (!active.killTimer) {
      active.killTimer = setTimeout(() => {
        try {
          this.signal(active, "SIGKILL");
        } catch {
          this.error =
            "Could not terminate the provider process. Stop it before restarting the dashboard.";
        }
      }, 2000);
      active.killTimer.unref();
    }
  }
  async tick() {
    if (
      this.ticking ||
      !this.getPlanning ||
      this.stopped ||
      this.starting ||
      this.active ||
      this.error ||
      !this.store.snapshot().autoDispatch
    )
      return;
    this.ticking = true;
    try {
      const planning = this.getPlanning();
      const now = this.now().getTime();
      const today = localParts(now).date;
      const eligible = this.store.snapshot().tasks.find((task) => {
        if (
          task.status !== "pending" ||
          taskGate(task, planning).status !== "ready" ||
          (task.earliestStart && Date.parse(task.earliestStart) > now)
        )
          return false;
        if (task.preferredWindowStart === null) return true;
        return [today, shiftDate(today, -1)].some((date) => {
          const start = localStart(date, task.preferredWindowStart as number);
          return now >= start && now < start + 5 * 60 * 60 * 1000;
        });
      });
      if (eligible) await this.start(eligible.id);
    } finally {
      this.ticking = false;
    }
  }
  startScheduler() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.error =
          "Auto-dispatch failed and is paused. Check runtime state and restart.";
      });
    }, 5000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.startDone;
    if (this.active && !this.active.finishing)
      await this.cancel(this.active.task.id);
    await this.waitForIdle();
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchLoad,
  type DispatchSettings,
  EMPTY_LOAD,
  MODEL_FAMILIES,
  needsCommit,
  type PlanningSnapshot,
  type PublicTask,
  type Run,
  type SessionRates,
  type Task,
  type TaskGate,
  type WeightedTokens,
} from "../shared/types.js";
import { sessionPercent } from "./calibration.js";
import { DeployQueue, hasComposeFile, leftChanges } from "./deploy.js";
import {
  blockingDependency,
  costsAhead,
  dependencyReason,
  expectedSessionCost,
  taskGate,
  USAGE_PREDATES_RUN_REASON,
  withRun,
} from "./dispatch.js";
import {
  commitPaths,
  diffSnapshots,
  ensureRepository,
  type GitSnapshot,
  gitIn,
  snapshotWorkdir,
} from "./git.js";
import { OutputPreview } from "./output.js";
import {
  launchProvider,
  type ProviderProcess,
  withAutoApply,
} from "./providers.js";
import type { QueueStore } from "./queue.js";
import { resolveResources, resourcesCollide } from "./resources.js";
import { atomicJson, DomainError, id } from "./storage.js";
import { validateWorkdir } from "./validation.js";

interface RunnerOptions {
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  launch?: (task: Task, sessionId: string | null) => ProviderProcess;
  autoApply?: () => boolean;
  sessionTokens?: (sessionId: string) => Promise<WeightedTokens>;
  now?: () => Date;
}
export type Planner = (load: DispatchLoad) => PlanningSnapshot;
/** A run plus the session id dispatched to Claude, which never leaves the server. Deploy state lives in the deploy queue. */
type StoredRun = Omit<Run, "deploy" | "sessionCostPercent"> & {
  sessionId: string | null;
};
const publicRun = ({
  sessionId: _sessionId,
  ...run
}: StoredRun): Omit<Run, "deploy" | "sessionCostPercent"> => run;
const measured = (tokens: WeightedTokens) =>
  MODEL_FAMILIES.some((family) => tokens[family] > 0);
const savedTokens = (value: unknown): WeightedTokens | null =>
  value !== null &&
  typeof value === "object" &&
  MODEL_FAMILIES.every(
    (family) => typeof (value as WeightedTokens)[family] === "number",
  )
    ? (value as WeightedTokens)
    : null;
interface Holding {
  task: Pick<Task, "id" | "title">;
  resources: readonly string[];
}
interface Active extends Holding {
  task: Task;
  run: StoredRun;
  /** Work directory git state when the run started; undefined when it could not be read, null outside a repository. */
  gitStart?: GitSnapshot | null;
  /** Whether the run was launched with the apply override, so the host may redeploy what it changed. */
  applied: boolean;
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
const KILL_GRACE_MS = 2000;
const PREVIEW_FLUSH_MS = 250;
const TICK_MS = 5000;
export const SLOTS_BUSY_ERROR = "All run slots are busy.";
export const blockedReason = (title: string) =>
  `Waits for “${title}” · same project`;
export const deployReason = (title: string) => `Waits for deploy of “${title}”`;

export class Runner {
  private runs: StoredRun[] = [];
  /** Runs holding a slot and their resource locks, keyed by run id, including runs still being claimed. */
  private active = new Map<string, Active>();
  private starts = new Set<Promise<unknown>>();
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private getPlanning?: Planner;
  private refreshUsage?: () => Promise<unknown>;
  setPlanner(planning: Planner, refreshUsage?: () => Promise<unknown>) {
    this.getPlanning = planning;
    this.refreshUsage = refreshUsage;
  }
  /** The output tokens a finished Claude run produced; null when its transcript recorded none. */
  private async readTokens(sessionId: string | null) {
    if (sessionId === null || !this.options.sessionTokens) return null;
    const tokens = await this.options.sessionTokens(sessionId);
    // No recorded token means the transcript was not found, not that the run was free.
    return measured(tokens) ? tokens : null;
  }
  /** End time of the most recently finished run, so usage fetched before it is not trusted. */
  lastRunEndedAt(): string | null {
    let latest: string | null = null;
    for (const run of this.runs)
      if (run.endedAt !== null && (latest === null || run.endedAt > latest))
        latest = run.endedAt;
    return latest;
  }
  private settings(): DispatchSettings {
    return this.getPlanning?.(EMPTY_LOAD).settings ?? DEFAULT_DISPATCH_SETTINGS;
  }
  private rates(): SessionRates | null {
    return this.getPlanning?.(EMPTY_LOAD).rates ?? null;
  }
  /** Slots held and quota reserved by every active run. */
  load(settings = this.settings()): DispatchLoad {
    const rates = this.rates();
    const runs = this.list();
    let load: DispatchLoad = {
      ...EMPTY_LOAD,
      lastRunEndedAt: this.lastRunEndedAt(),
    };
    // Without rates a run holds nothing, and the Claude gate admits nothing either.
    for (const { task } of this.active.values())
      load = withRun(
        load,
        task,
        expectedSessionCost(task, runs, rates) ?? 0,
        settings,
      );
    return load;
  }
  private planning(load = this.load()): PlanningSnapshot {
    if (!this.getPlanning) throw new DomainError("No planner configured.", 500);
    return this.getPlanning(load);
  }
  error: string | null = null;
  private constructor(
    private store: QueueStore,
    private directory: string,
    private deploys: DeployQueue,
    private options: RunnerOptions,
  ) {}
  static async open(
    store: QueueStore,
    directory: string,
    options: RunnerOptions = {},
  ) {
    const runner = new Runner(
      store,
      join(directory, "runs"),
      await DeployQueue.open(directory),
      options,
    );
    await mkdir(runner.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(runner.directory)) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      const saved: Run & { sessionId?: unknown } = JSON.parse(
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
      const run: StoredRun = {
        id: saved.id,
        taskId: saved.taskId,
        title: saved.title,
        prompt: saved.prompt ?? null,
        estimatedTokens: saved.estimatedTokens ?? null,
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
        tokens: savedTokens(saved.tokens),
        sessionId: typeof saved.sessionId === "string" ? saved.sessionId : null,
        summary: saved.summary ?? null,
        changes: saved.changes ?? null,
        reviewedAt: saved.reviewedAt ?? null,
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
    for (const run of runner.runs) {
      if (run.tokens !== null) continue;
      const tokens = await runner.readTokens(run.sessionId);
      if (tokens === null) continue;
      run.tokens = tokens;
      await runner.persist(run);
    }
    return runner;
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  list(): Run[] {
    const rates = this.rates();
    return this.runs
      .map(publicRun)
      .map((run) => ({
        ...run,
        sessionCostPercent:
          run.tokens === null || rates === null
            ? null
            : sessionPercent(run.tokens, rates),
        deploy: this.deploys.status(run.id),
        preview: this.active.get(run.id)?.output.lines() ?? [...run.preview],
        durationMs:
          run.status === "running"
            ? Math.max(0, this.now().getTime() - Date.parse(run.startedAt))
            : run.durationMs,
      }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  /** Session ids this dashboard assigned to its own runs, used to attribute transcripts. */
  dispatchedSessions(): ReadonlySet<string> {
    const sessions = new Set<string>();
    for (const run of this.runs)
      if (run.sessionId !== null) sessions.add(run.sessionId);
    return sessions;
  }
  async markReviewed(runId: string): Promise<Run> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new DomainError("Run not found.", 404);
    run.reviewedAt = this.now().toISOString();
    await this.persist(run);
    return this.list().find((listed) => listed.id === run.id) as Run;
  }
  /** Commits the files a finished run left uncommitted, then marks the run reviewed. */
  async commit(runId: string, message: string): Promise<Run> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new DomainError("Run not found.", 404);
    if (!needsCommit(run))
      throw new DomainError("This run has nothing left to commit.", 409);
    const task = this.store
      .snapshot()
      .tasks.find((candidate) => candidate.id === run.taskId);
    if (!task) throw new DomainError("Task not found.", 404);
    const workdir = await validateWorkdir(task.workdir);
    const busy = this.holder(await resolveResources(workdir));
    if (busy) throw new DomainError(blockedReason(busy.title), 409);
    try {
      await commitPaths(
        run.changes.files.map((file) => file.path),
        message,
        gitIn(workdir),
      );
    } catch (error) {
      throw new DomainError(
        `Could not commit: ${(error as Error).message}`,
        409,
      );
    }
    return this.markReviewed(runId);
  }
  private async persist(run: StoredRun) {
    const { preview, ...metadata } = run;
    await atomicJson(join(this.directory, `${run.id}.log`), preview);
    await atomicJson(join(this.directory, `${run.id}.json`), metadata);
  }
  /** The active or already selected task whose resources `resources` may not share. */
  private holder(
    resources: readonly string[],
    selected: readonly Holding[] = [],
  ): Holding["task"] | undefined {
    for (const holding of [...this.active.values(), ...selected])
      if (resourcesCollide(holding.resources, resources)) return holding.task;
    return undefined;
  }
  /** The task's gate, plus the lock it would wait for when it is otherwise ready. */
  async gate(
    task: PublicTask,
    planning: PlanningSnapshot,
    now: Date,
  ): Promise<TaskGate> {
    const runs = this.list();
    const queued = this.store.snapshot().tasks;
    if (task.status === "pending") {
      const dependency = blockingDependency(task, queued);
      if (dependency)
        return {
          status: "waiting",
          reason: dependencyReason(dependency),
          eligibleAt: null,
          blockedBy: dependency.title,
        };
    }
    const gate = taskGate(
      task,
      planning,
      now,
      runs,
      costsAhead(task.id, queued, runs, this.rates()),
    );
    if (gate.status !== "ready") return gate;
    const deploying = this.deploys.pending();
    if (deploying)
      return {
        ...gate,
        status: "waiting",
        reason: deployReason(deploying.title),
      };
    let resources: string[];
    try {
      resources = await resolveResources(task.workdir);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return { ...gate, status: "waiting", reason: error.message };
    }
    const holder = this.holder(resources);
    if (!holder) return gate;
    return {
      ...gate,
      status: "waiting",
      reason: blockedReason(holder.title),
      blockedBy: holder.title,
    };
  }
  /**
   * Start a pending task. Run now (`gated` false) skips the usage and schedule
   * gates but never the slot bound or the resource locks.
   */
  async start(taskId: string, gated = false): Promise<Run> {
    if (this.stopped) throw new DomainError("The runner is shutting down.");
    const starting = this.admit(taskId, gated);
    this.starts.add(starting);
    try {
      return await starting;
    } finally {
      this.starts.delete(starting);
    }
  }
  private async admit(taskId: string, gated: boolean): Promise<Run> {
    await this.deploys.refresh();
    const deploying = this.deploys.pending();
    if (deploying) throw new DomainError(deployReason(deploying.title));
    const queued = this.store.snapshot().tasks;
    const task = queued.find((candidate) => candidate.id === taskId);
    if (!task) throw new DomainError("Task not found.", 404);
    if (task.status !== "pending")
      throw new DomainError("Only pending tasks can run.");
    const dependency = blockingDependency(task, queued);
    if (dependency) throw new DomainError(dependencyReason(dependency));
    const resources = await resolveResources(task.workdir);
    if (this.active.size >= this.settings().maxConcurrentRuns)
      throw new DomainError(SLOTS_BUSY_ERROR);
    const holder = this.holder(resources);
    if (holder) throw new DomainError(blockedReason(holder.title));
    if (gated) {
      const gate = taskGate(task, this.planning(), this.now(), this.list());
      if (gate.status !== "ready") throw new DomainError(gate.reason);
    }
    const sessionId = task.provider === "claude" ? randomUUID() : null;
    const run: StoredRun = {
      id: id(),
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
      estimatedTokens: task.tokens,
      provider: task.provider,
      model: task.model,
      status: "running",
      startedAt: this.now().toISOString(),
      endedAt: null,
      durationMs: 0,
      exitCode: null,
      error: null,
      tokens: null,
      summary: null,
      changes: null,
      reviewedAt: null,
      sessionId,
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
      resources,
      run,
      applied: false,
      output: new OutputPreview(),
      done,
      resolve,
      finishing: false,
      writeChain: Promise.resolve(),
    };
    this.active.set(run.id, active);
    this.runs.push(run);
    await this.launch(active, sessionId);
    return this.list().find((r) => r.id === run.id) as Run;
  }
  private async launch(active: Active, sessionId: string | null) {
    const { run } = active;
    try {
      active.task = await this.store.claim(active.task.id);
    } catch (error) {
      this.active.delete(run.id);
      this.runs = this.runs.filter((r) => r.id !== run.id);
      active.resolve();
      throw error;
    }
    const { task } = active;
    try {
      task.workdir = await validateWorkdir(task.workdir);
      await ensureRepository(task.workdir);
      active.gitStart = await snapshotWorkdir(task.workdir);
      await this.persist(run);
      if (this.stopped || active.cancelled) {
        active.cancelled = true;
        await this.finish(active, null);
        return;
      }
      active.applied = this.options.autoApply?.() ?? false;
      const child = (this.options.launch ?? launchProvider)(
        active.applied ? withAutoApply(task) : task,
        sessionId,
      );
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
    }, PREVIEW_FLUSH_MS);
    active.flushTimer.unref();
  }
  private async finish(active: Active, code: number | null, error?: string) {
    if (active.finishing) return;
    active.finishing = true;
    if (active.flushTimer) clearTimeout(active.flushTimer);
    await active.writeChain;
    active.output.flush();
    if (active.killTimer) clearTimeout(active.killTimer);
    // The provider's tool calls can outlive it (a hung test worker behind `| head`) and would be
    // reparented to the container's init, holding CPU until the dashboard restarts.
    try {
      this.signal(active, "SIGKILL");
    } catch {
      this.error =
        "Could not stop processes left behind by a run. Check for stray provider children.";
    }
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
    active.run.summary = active.output.summary();
    try {
      const before = active.gitStart;
      const after = before ? await snapshotWorkdir(active.task.workdir) : null;
      active.run.changes =
        before && after
          ? await diffSnapshots(before, after, gitIn(active.task.workdir))
          : null;
    } catch {
      active.run.error ??=
        "Could not read what the run changed in its work directory.";
    }
    try {
      active.run.tokens = await this.readTokens(active.run.sessionId);
    } catch {
      this.error =
        "Could not read the tokens of the run. Auto-dispatch is paused; check transcript file access.";
    }
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
    }
    try {
      if (
        active.applied &&
        active.run.status === "completed" &&
        leftChanges(active.run.changes) &&
        (await hasComposeFile(active.task.workdir))
      )
        await this.deploys.request({
          runId: active.run.id,
          title: active.run.title,
          workdir: active.task.workdir,
          requestedAt: this.now().toISOString(),
        });
    } catch {
      this.error =
        "Could not request the deploy of the run. Auto-dispatch is paused; check runtime file access.";
    } finally {
      this.active.delete(active.run.id);
      active.resolve();
    }
  }
  async waitForIdle() {
    while (this.starts.size > 0 || this.active.size > 0) {
      await Promise.allSettled([...this.starts]);
      await Promise.all([...this.active.values()].map((a) => a.done));
    }
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
    const active = [...this.active.values()].find(
      (candidate) => candidate.task.id === taskId && !candidate.finishing,
    );
    if (!active) throw new DomainError("Task is not running.");
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
      }, KILL_GRACE_MS);
      active.killTimer.unref();
    }
  }
  /**
   * Pending tasks, in queue order, that fit the free slots, the aggregate quota
   * after every earlier pick, and the locks held by running and picked tasks.
   */
  private async select(at: Date): Promise<PublicTask[]> {
    if (this.deploys.pending()) return [];
    const settings = this.settings();
    const rates = this.rates();
    const runs = this.list();
    let load = this.load(settings);
    const picked: Holding[] = [];
    const queued = this.store.snapshot().tasks;
    for (const task of queued) {
      if (load.running >= settings.maxConcurrentRuns) break;
      if (
        task.status !== "pending" ||
        blockingDependency(task, queued) !== undefined ||
        taskGate(task, this.planning(load), at, runs).status !== "ready"
      )
        continue;
      let resources: string[];
      try {
        resources = await resolveResources(task.workdir);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        continue;
      }
      if (this.holder(resources, picked)) continue;
      picked.push({ task, resources });
      load = withRun(
        load,
        task,
        expectedSessionCost(task, runs, rates) ?? 0,
        settings,
      );
    }
    return picked.map((holding) => holding.task as PublicTask);
  }
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.deploys.refresh();
      if (
        !this.getPlanning ||
        this.error ||
        !this.store.snapshot().autoDispatch
      )
        return;
      if (
        this.planning().providers.claude.reason === USAGE_PREDATES_RUN_REASON &&
        this.refreshUsage
      )
        await this.refreshUsage();
      for (const task of await this.select(this.now())) {
        try {
          await this.start(task.id, true);
        } catch (error) {
          // A Run now or a finished run changed the load mid-tick; the next tick re-plans.
          if (!(error instanceof DomainError)) throw error;
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  startScheduler() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.error =
          error instanceof DomainError
            ? error.message
            : "Auto-dispatch failed and is paused. Check runtime state and restart.";
      });
    }, TICK_MS);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.starts]);
    for (const active of this.active.values())
      if (!active.finishing) await this.cancel(active.task.id);
    await this.waitForIdle();
  }
}

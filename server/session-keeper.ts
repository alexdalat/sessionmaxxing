import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  OfficialUsage,
  SessionKeeperState,
  UsageState,
} from "../shared/types.js";
import type { ProviderProcess } from "./providers.js";
import { atomicJson, DomainError } from "./storage.js";

export const SESSION_PING_PROMPT = "hi";
export const SESSION_PING_MODEL = "haiku";
export const SESSION_PING_FAILED =
  "Session start failed. Check CLI installation and authentication.";
/**
 * The usage endpoint can report the old window for a while after a ping, so
 * a fresh snapshot alone is not proof that a ping did nothing.
 */
export const SESSION_PING_COOLDOWN_MS = 10 * 60_000;
const WEEKLY_EXHAUSTED_PERCENT = 100;
const TICK_MS = 30_000;
const KILL_GRACE_MS = 2000;
const PING_HISTORY_LIMIT = 1000;
const STATE_FILE = "session-keeper.json";

export const sessionPingArgs = (sessionId: string) => [
  "-p",
  SESSION_PING_PROMPT,
  "--model",
  SESSION_PING_MODEL,
  "--max-turns",
  "1",
  "--session-id",
  sessionId,
];
export const launchSessionPing = (
  sessionId: string,
  cwd: string,
): ProviderProcess =>
  spawn("claude", sessionPingArgs(sessionId), {
    cwd,
    shell: false,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });

/** No five-hour window is open: the endpoint reports none, or the last one has reset. */
export const sessionIdle = (usage: OfficialUsage, now: Date) =>
  usage.resetsAt === null || Date.parse(usage.resetsAt) <= now.getTime();

interface Ping {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}
interface Active {
  ping: Ping;
  child: ProviderProcess;
  done: Promise<void>;
  resolve: () => void;
  killTimer?: ReturnType<typeof setTimeout>;
}
interface SessionKeeperOptions {
  enabled: () => boolean;
  usage: () => UsageState;
  refreshUsage: () => Promise<unknown>;
  /** Claude runs in progress already hold a window open, so no ping is needed. */
  claudeRuns: () => number;
  launch?: (sessionId: string, cwd: string) => ProviderProcess;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => Date;
  cwd?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isPing = (value: unknown): value is Ping => {
  if (value === null || typeof value !== "object") return false;
  const ping = value as Record<string, unknown>;
  return (
    typeof ping.sessionId === "string" &&
    UUID.test(ping.sessionId) &&
    typeof ping.startedAt === "string" &&
    (ping.endedAt === null || typeof ping.endedAt === "string") &&
    (ping.exitCode === null || typeof ping.exitCode === "number")
  );
};

/**
 * Opens a fresh five-hour window whenever the previous one has ended, by
 * running one short Claude prompt and letting it exit. Independent of the
 * queue: not a task, not gated by the queue switch or the usage reserves.
 */
export class SessionKeeper {
  private pings: Ping[] = [];
  private active?: Active;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;
  private paused = false;
  error: string | null = null;
  private constructor(
    private path: string,
    private options: SessionKeeperOptions,
  ) {}

  static async open(directory: string, options: SessionKeeperOptions) {
    const keeper = new SessionKeeper(join(directory, STATE_FILE), options);
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(keeper.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      saved = { pings: [] };
    }
    const pings =
      saved !== null && typeof saved === "object"
        ? (saved as Record<string, unknown>).pings
        : undefined;
    if (!Array.isArray(pings) || !pings.every(isPing))
      throw new DomainError(
        `Saved session keeper state is invalid. Restore or remove ${STATE_FILE}.`,
        500,
      );
    keeper.pings = pings;
    let interrupted = false;
    for (const ping of keeper.pings)
      if (ping.endedAt === null) {
        ping.endedAt = keeper.now().toISOString();
        interrupted = true;
      }
    if (interrupted) await keeper.persist();
    return keeper;
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private async persist() {
    await atomicJson(this.path, { pings: this.pings });
  }
  state(): SessionKeeperState {
    return {
      lastStartedAt: this.pings.at(-1)?.startedAt ?? null,
      error: this.error,
    };
  }
  /** Session ids of every ping, so their transcripts count as dispatched activity. */
  sessions(): ReadonlySet<string> {
    return new Set(this.pings.map((ping) => ping.sessionId));
  }
  /** Whether a ping would start now: a fresh, idle snapshot after the last ping and its cooldown. */
  private due(now: Date): boolean {
    if (!this.options.enabled() || this.active || this.options.claudeRuns() > 0)
      return false;
    const { snapshot } = this.options.usage();
    if (
      snapshot === null ||
      !sessionIdle(snapshot.session, now) ||
      snapshot.weekly.percent >= WEEKLY_EXHAUSTED_PERCENT
    )
      return false;
    const last = this.pings.at(-1);
    if (!last) return true;
    return (
      last.endedAt !== null &&
      Date.parse(snapshot.fetchedAt) > Date.parse(last.endedAt) &&
      now.getTime() - Date.parse(last.startedAt) >= SESSION_PING_COOLDOWN_MS
    );
  }
  async tick() {
    if (this.ticking || this.stopped || this.paused) return;
    this.ticking = true;
    try {
      if (this.due(this.now())) await this.ping();
    } finally {
      this.ticking = false;
    }
  }
  private async ping() {
    const ping: Ping = {
      sessionId: randomUUID(),
      startedAt: this.now().toISOString(),
      endedAt: null,
      exitCode: null,
    };
    this.pings.push(ping);
    if (this.pings.length > PING_HISTORY_LIMIT)
      this.pings.splice(0, this.pings.length - PING_HISTORY_LIMIT);
    await this.persist();
    let resolve: () => void = () => {
      throw new Error("Completion resolver was not initialized.");
    };
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const child = (this.options.launch ?? launchSessionPing)(
      ping.sessionId,
      this.options.cwd ?? homedir(),
    );
    const active: Active = { ping, child, done, resolve };
    this.active = active;
    child.once("error", () => void this.finish(active, null, true));
    child.once(
      "close",
      (code: number | null) => void this.finish(active, code, false),
    );
  }
  private async finish(active: Active, code: number | null, failed: boolean) {
    if (active.ping.endedAt !== null) return;
    if (active.killTimer) clearTimeout(active.killTimer);
    active.ping.endedAt = this.now().toISOString();
    active.ping.exitCode = code;
    this.error = code === 0 && !failed ? null : SESSION_PING_FAILED;
    try {
      await this.persist();
      await this.options.refreshUsage();
    } catch {
      this.error =
        "Could not save the session keeper state. Check runtime file access.";
    } finally {
      this.active = undefined;
      active.resolve();
    }
  }
  private signal(active: Active, signal: NodeJS.Signals) {
    try {
      if (active.child.pid)
        (this.options.signal ?? process.kill)(-active.child.pid, signal);
      else active.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        throw new DomainError("Could not signal the session ping process.");
    }
  }
  async waitForIdle() {
    while (this.active) await this.active.done;
  }
  startScheduler() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.paused = true;
        this.error =
          "Session keeper failed and is paused. Check runtime state and restart.";
      });
    }, TICK_MS);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const active = this.active;
    if (!active) return;
    this.signal(active, "SIGTERM");
    active.killTimer = setTimeout(() => {
      try {
        this.signal(active, "SIGKILL");
      } catch {
        this.error =
          "Could not terminate the session ping process. Stop it before restarting the dashboard.";
      }
    }, KILL_GRACE_MS);
    active.killTimer.unref();
    await active.done;
  }
}

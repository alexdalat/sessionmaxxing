# Claude capacity dashboard

A local dashboard for one job: squeeze the most out of a Claude Max plan. It shows Anthropic's official usage for the three buckets Max enforces (Session 5h, Weekly, Fable weekly), records how much of each five-hour window you actually used, and auto-dispatches queued Claude Code tasks into idle windows while keeping weekly usage on pace.

## Run

Requires Node.js 22.12+, pnpm, and a signed-in `claude` CLI (the dashboard reuses its OAuth token). Install `codex` too if you queue Codex tasks.

```sh
pnpm install
pnpm build
pnpm start
```

Open http://127.0.0.1:4317. `PORT` changes the port; `HOST` is `127.0.0.1` or `0.0.0.0` (container only). For development run `pnpm dev` and `pnpm dev:ui` in separate terminals. The UI is a Next.js static export with four routes: `/` (Overview), `/analytics/` (Analytics), `/queue/` (Task queue), and `/runs/` (Runs); Fastify serves the build from `dist/client`.

## Official usage

The server calls `GET https://api.anthropic.com/api/oauth/usage` with the token from `~/.claude/.credentials.json`, the `anthropic-beta: oauth-2025-04-20` header, and a Claude Code User-Agent. That is the same source as Claude Code's `/usage` panel and the "Claude Usage Tracker" browser extension. The response's `five_hour` and `seven_day` windows become **Session (5h)** and **Weekly**; the `limits[]` entry whose model display name is Fable becomes **Fable weekly**. Each bucket shows the percent used, a reset countdown, a pace tick (share of the window already elapsed) and a dispatch-ceiling tick, plus the active minutes and responses your local transcripts show inside that window.

The server fetches every five minutes and on **Refresh** (at most once per 30 s). A failed fetch keeps the last snapshot, shows the error in the panel, and blocks auto-dispatch until a fresh fetch succeeds. An expired token is reported with "run `claude`"; the dashboard never refreshes or stores the token, and no route returns it.

Every snapshot is appended to `data/usage-samples.jsonl` (14 days kept). From those samples:

- **Session windows · last 7 days** draws each five-hour window Anthropic reported, shaded by its peak utilization, on a Eastern-time day grid, with the share of the week that had no window at all.
- **Weekly usage vs pace** plots weekly and Fable utilization through the current seven-day window against the straight line to the reset and the auto-dispatch limit (pace plus the weekly margin, capped at 95%).

## Auto-dispatch

Queue tasks under **Task queue**. With the queue on, the server runs up to *Tasks running at once* **Ready** tasks together (default 2, at most 4; 1 keeps the old one-at-a-time behaviour). The on/off state is stored in `data/queue.json` and survives restarts; every task still running at a restart is marked failed. A Claude task is Ready when a run slot is free, the official snapshot is fresh (under 15 min) and newer than the last finished run, session usage plus the points held for running Claude tasks is at or below `100 − session reserve` (default 25% in quiet hours, 100% outside them, so the default queue only runs in quiet hours), weekly usage plus its held points is at or below `pace + weekly margin` (default 10%, hard cap 95%), and, for Fable models, the Fable window passes the same weekly test. Codex tasks are not gated by usage but take a slot. **Run now** overrides the usage gate and the schedule, never the slot limit or a busy repository. Settings live in `data/dispatch-settings.json`; `PUT /api/dispatch-settings` takes `{ autoApply, keepSessionActive, sessionReservePercent, busyHoursReservePercent, weeklyMarginPercent, quietStartHours, maxConcurrentRuns, runWeeklyCostPercent }`.

With **Start each 5-hour session automatically** on, the server opens a new session window as soon as the previous one ends by running a one-turn `claude -p hi` from the home directory and letting it exit. This is separate from the queue: it needs no task and ignores the queue switch and the reserves. It waits for a fresh usage snapshot after each ping and at least ten minutes between pings, skips while a Claude task is running, and stops when the weekly window is at 100%. Ping session ids live in `data/session-keeper.json`.

### Parallel runs

Two tasks run together only when they cannot touch the same files. The server resolves each work directory (symlinks included) and the git repository it belongs to, following linked worktrees back to their main checkout. Tasks whose directories are equal or nested, or that belong to the same repository, wait for each other; the waiting card names the task it waits for. Independent repositories and unrelated directories run side by side. A directory whose repository cannot be read waits instead of running unlocked.

Every running Claude task holds *Session held per running Claude task* points of the session window (default 20%) and *Weekly held per running Claude task* points of the weekly window (default 3%, Fable models also hold it in the Fable window) until it finishes. The next task starts only if usage plus everything held still fits under the queue cutoff, so two tasks never start just because each would fit alone. The Overview panel shows running slots as `1/2` and the held points next to each bucket. Settings files saved before these options existed load with the defaults.

Limits: the hold is a fixed estimate, not measured consumption; worktrees of one repository always serialize; locks live in the server process, so a task started outside the dashboard is invisible to them; and a restart fails every running task.

Dispatched Claude tasks run with `--dangerously-skip-permissions`, so a queued run has the same tools an interactive session has: shell, web search, and any MCP servers or skills configured under `~/.claude`, which the container mounts along with your global `CLAUDE.md`.

Each Claude task carries **Output tokens**, the number the whole run is expected to produce; the dashboard prices them at the session rates it fits from its own history, so the same task costs more on Fable than on Opus and the number survives a plan change. A task only becomes Ready when session usage, the percent held for running Claude tasks, and its own expected cost (its tokens at the current rates, or the largest percent one of its runs has cost) stay at or below the cutoff.

**Quiet hours** keep your own five-hour windows opening when you actually work. The server ranks all 24 Eastern start hours by your average active minutes in the following five hours over the last 30 days (recomputed every 10 minutes) and, with *Quiet hours only* on (default), a task with no chosen window starts only when the current hour is one of the `quietStartHours` quietest starts (default 8). The dispatch panel lists those hours as ranges and the next one coming up. A task with an explicit preferred window ignores the quiet-hours rule and runs inside that window instead.

## Queueing work

`scripts/queue-task.mjs` queues a task from any terminal without opening the UI:

```sh
node scripts/queue-task.mjs --title "Rename the parser" --prompt-file ./prompt.md \
  --workdir /home/user/workspace/some-repo --model claude-fable-5-1
```

It prints session and weekly usage, the quiet start hours, and the Claude gate reason before posting, then the new task id and the window it will wait for. `--window HH` pins a start hour, `--tokens N` sets the expected output tokens (`auto` by default, estimated by the server), `--dry-run` prints the body instead of posting, and `CAPACITY_DASHBOARD_URL` (or `--url`) picks the server; the loopback default falls back to the tailnet address once. Claude Code queues through it with the `queue-task` skill in `~/.claude/skills/queue-task`; `skills/queue-task/SKILL.md` is the same skill for uploading to claude.ai, where it writes the command out for you to paste instead.

## API

- `GET /api/analytics?days=7|14|30|90` local activity aggregates plus per-bucket local windows.
- `GET /api/usage` `{ snapshot, error, samples, windows }`; `POST /api/usage/refresh` fetches now.
- `GET|PUT /api/dispatch-settings` settings plus the planning snapshot (per-bucket gates, per-provider status and reason).
- `GET /api/queue`, `POST /api/tasks`, `PATCH|DELETE /api/tasks/:id`, `POST /api/tasks/:id/run|cancel|retry`, `PUT /api/queue/order`, `PUT /api/queue/auto`, `GET /api/runs`.

Hosts are limited to `localhost`, `127.0.0.1`, `192.0.2.10`, and `dashboard.example.ts.net`; an Origin header must match `http://<Host>`. There is no dashboard authentication.

## Docker over Tailscale

Compose mounts `/home/user` at the same path (Claude history, `.claude/.credentials.json`, Codex state, work directories) and `./data` at `/app/data`. Run as UID/GID `1000:1000` from this repository:

```sh
mkdir -p data && chmod 700 data
docker compose build
docker compose up --no-build
```

Open http://192.0.2.10:4317 from the tailnet or http://127.0.0.1:4317 on the host. Stop with Ctrl+C; `docker compose down` removes the container. Do not run a native and a container instance against the same `data` directory; the runtime lock refuses a second server.

## Host deploy watcher

Runs happen inside the container, which has no docker CLI, so a run that changes a Compose project cannot redeploy it. When **Apply and deploy without review** is on and a run completes with changes in a directory holding a Compose file, the server writes a request into `data/deploy/requests/`; a systemd user path unit runs `deploy/host-deploy.sh`, which builds the project, waits until no dashboard run is in flight before recreating the dashboard's own container, brings it up, and writes the result back. The run card shows **Deploy queued**, **Deploying**, **Deployed** or **Deploy failed**, and no new run starts until the deploy is finished. Install it once (requires `jq` and `curl`):

```sh
systemctl --user link ~/workspace/claude-capacity-dashboard/deploy/claude-dashboard-deploy.service
systemctl --user enable --now ~/workspace/claude-capacity-dashboard/deploy/claude-dashboard-deploy.path
```

`journalctl --user -u claude-dashboard-deploy.service` has the watcher's own log; each deploy's output is `data/deploy/results/<run id>.log`.

## Privacy

Transcript content is discarded at the parser boundary. Prompts and work directories stay on disk in `data/queue.json` and are never returned by the API. Run previews keep only allowlisted event labels and counters. Runtime state: `data/queue.json`, `data/dispatch-settings.json`, `data/session-keeper.json`, `data/usage-samples.jsonl`, `data/runs/`, `data/deploy/`, `data/server.lock`.

## Layout

| Path | Purpose |
| --- | --- |
| `app/` | Next.js App Router: `layout.tsx`, `styles.css`, one `page.tsx` per route |
| `app/components/` | Feature components by route (`overview/`, `analytics/`, `queue/`, `runs/`); shared ones at the root; `ui/` is shadcn |
| `app/hooks/` | React hooks (`usePolling`, `useAnalytics`) |
| `app/lib/` | Pure client logic: API client, time helpers, chart series, queue ordering, analytics cache |
| `server/` | Fastify server, usage monitor, dispatcher, providers, transcript parser |
| `shared/` | Types and constants shared by server and client |
| `scripts/` | `queue-task.mjs` CLI |
| `tests/` | Vitest suites, `helpers.ts`, `fixtures/` |

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Tests use synthetic transcripts, fake provider processes, and a stubbed usage fetcher. They never call Anthropic or launch coding agents. `tests/parallel.test.ts` and `tests/resources.test.ts` cover the slot bound, aggregate budget, collision rules, and multi-run recovery; the design note is `reports/parallel-dispatch-design.md`.

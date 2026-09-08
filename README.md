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

Queue tasks under **Task queue**. With the queue on, the server runs one **Ready** task at a time. The on/off state is stored in `data/queue.json` and survives restarts; a task interrupted by a restart is marked failed. A Claude task is Ready when the official snapshot is fresh (under 15 min), session usage is at or below `100 − session reserve` (default 25% in quiet hours, 100% outside them, so the default queue only runs in quiet hours), weekly usage is at or below `pace + weekly margin` (default 10%, hard cap 95%), and, for Fable models, the Fable window passes the same weekly test. Codex tasks are not gated. **Run now** overrides everything. Settings live in `data/dispatch-settings.json`; `PUT /api/dispatch-settings` takes `{ sessionReservePercent, busyHoursReservePercent, weeklyMarginPercent, quietStartHours }`.

Dispatched Claude tasks run with `--dangerously-skip-permissions`, so a queued run has the same tools an interactive session has: shell, web search, and any MCP servers or skills configured under `~/.claude`, which the container mounts along with your global `CLAUDE.md`.

**Quiet hours** keep your own five-hour windows opening when you actually work. The server ranks all 24 Eastern start hours by your average active minutes in the following five hours over the last 30 days (recomputed every 10 minutes) and, with *Quiet hours only* on (default), a task with no chosen window starts only when the current hour is one of the `quietStartHours` quietest starts (default 8). The dispatch panel lists those hours as ranges and the next one coming up. A task with an explicit preferred window ignores the quiet-hours rule and runs inside that window instead.

## Queueing work

`scripts/queue-task.mjs` queues a task from any terminal without opening the UI:

```sh
node scripts/queue-task.mjs --title "Rename the parser" --prompt-file ./prompt.md \
  --workdir /home/user/workspace/some-repo --model claude-fable-5-1
```

It prints session and weekly usage, the quiet start hours, and the Claude gate reason before posting, then the new task id and the window it will wait for. `--window HH` pins a start hour, `--dry-run` prints the body instead of posting, and `CAPACITY_DASHBOARD_URL` (or `--url`) picks the server; the loopback default falls back to the tailnet address once. Claude Code queues through it with the `queue-task` skill in `~/.claude/skills/queue-task`; `skills/queue-task/SKILL.md` is the same skill for uploading to claude.ai, where it writes the command out for you to paste instead.

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

## Privacy

Transcript content is discarded at the parser boundary. Prompts and work directories stay on disk in `data/queue.json` and are never returned by the API. Run previews keep only allowlisted event labels and counters. Runtime state: `data/queue.json`, `data/dispatch-settings.json`, `data/usage-samples.jsonl`, `data/runs/`, `data/server.lock`.

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

Tests use synthetic transcripts, fake provider processes, and a stubbed usage fetcher. They never call Anthropic or launch coding agents.

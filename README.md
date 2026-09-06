# Claude capacity dashboard

A local dashboard for one job: squeeze the most out of a Claude Max plan. It shows Anthropic's official usage for the three buckets Max enforces (Session 5h, Weekly, Fable weekly), records how much of each five-hour window you actually used, and auto-dispatches queued Claude Code tasks into idle windows while keeping weekly usage on pace.

## Run

Requires Node.js 22.12+, pnpm, and a signed-in `claude` CLI (the dashboard reuses its OAuth token). Install `codex` too if you queue Codex tasks.

```sh
pnpm install
pnpm build
pnpm start
```

Open http://127.0.0.1:4317. `PORT` changes the port; `HOST` is `127.0.0.1` or `0.0.0.0` (container only). For development run `pnpm dev` and `pnpm dev:ui` in separate terminals.

## Official usage

The server calls `GET https://api.anthropic.com/api/oauth/usage` with the token from `~/.claude/.credentials.json`, the `anthropic-beta: oauth-2025-04-20` header, and a Claude Code User-Agent. That is the same source as Claude Code's `/usage` panel and the "Claude Usage Tracker" browser extension. The response's `five_hour` and `seven_day` windows become **Session (5h)** and **Weekly**; the `limits[]` entry whose model display name is Fable becomes **Fable weekly**. Each bucket shows the percent used, a reset countdown, a pace tick (share of the window already elapsed) and a dispatch-ceiling tick, plus the active minutes and responses your local transcripts show inside that window.

The server fetches every five minutes and on **Refresh** (at most once per 30 s). A failed fetch keeps the last snapshot, shows the error in the panel, and blocks auto-dispatch until a fresh fetch succeeds. An expired token is reported with "run `claude`"; the dashboard never refreshes or stores the token, and no route returns it.

Every snapshot is appended to `data/usage-samples.jsonl` (14 days kept). From those samples:

- **Session windows · last 7 days** draws each five-hour window Anthropic reported, shaded by its peak utilization, on a Eastern-time day grid, with the share of the week that had no window at all.
- **Weekly usage vs pace** plots weekly and Fable utilization through the current seven-day window against the straight line to the reset and the dispatch ceiling.

## Auto-dispatch

Queue tasks under **Task queue**. With auto-dispatch on, the server runs one **Ready** task at a time inside its preferred window while it is alive. A Claude task is Ready when the official snapshot is fresh (under 15 min), session usage is at or below `100 − session reserve` (default 25%), weekly usage is at or below `pace + weekly margin` (default 10%, hard cap 95%), and, for Fable models, the Fable window passes the same weekly test. Codex tasks are not gated. **Run now** overrides everything. Settings live in `data/dispatch-settings.json`; `PUT /api/dispatch-settings` takes `{ sessionReservePercent, weeklyMarginPercent }`.

The **Capacity planner** page still ranks all 24 local start hours by how quiet they have been over the last 30 days so you can pick a preferred window for a task.

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

Open http://192.0.2.10:4317 from the tailnet. Stop with Ctrl+C; `docker compose down` removes the container. Do not run a native and a container instance against the same `data` directory; the runtime lock refuses a second server.

## Privacy

Transcript content is discarded at the parser boundary. Prompts and work directories stay on disk in `data/queue.json` and are never returned by the API. Run previews keep only allowlisted event labels and counters. Runtime state: `data/queue.json`, `data/dispatch-settings.json`, `data/usage-samples.jsonl`, `data/runs/`, `data/server.lock`.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Tests use synthetic transcripts, fake provider processes, and a stubbed usage fetcher. They never call Anthropic or launch coding agents.

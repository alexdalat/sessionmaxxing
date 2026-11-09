# SessionMaxxing

A local dashboard for one job: squeeze the most out of a Claude Max plan. It shows Anthropic's official usage for the three buckets Max enforces (Session 5h, Weekly, Fable weekly), records how much of each five-hour window you actually used, and auto-dispatches queued Claude Code tasks into idle windows while keeping weekly usage on pace.

## Install natively

Requires Node.js 22.12+, pnpm, and a signed-in `claude` CLI (the dashboard reuses its OAuth token).

```sh
pnpm install
pnpm build
pnpm start
```

Run these from the repository root; the server serves the build from `dist/client` relative to its working directory. It listens on http://127.0.0.1:4317. For development run `pnpm dev` and `pnpm dev:ui` in separate terminals. The UI is a Next.js static export with four routes: `/` (Overview), `/analytics/` (Analytics), `/queue/` (Task queue), and `/runs/` (Runs).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSIONMAXXING_HOST` | `127.0.0.1` | Bind address, an IPv4 or IPv6 literal. A wider bind such as `0.0.0.0` also needs `SESSIONMAXXING_ALLOWED_HOSTS`. |
| `SESSIONMAXXING_PORT` | `4317` | Listen port. |
| `SESSIONMAXXING_ALLOWED_HOSTS` | empty | Comma-separated host names or addresses clients type, added to `localhost`, `127.0.0.1` and the bind address. No ports, paths or wildcards. |
| `SESSIONMAXXING_DATA_DIR` | see Data directory | Absolute path of the data directory. |
| `XDG_DATA_HOME` | `~/.local/share` | Absolute base for the default data directory. |
| `SESSIONMAXXING_WORKDIR_ROOT` | the user's home | Absolute existing directory that task work directories must be under. |
| `SESSIONMAXXING_EDITION` | `full` | Edition; `full` is the only value. |
| `TZ` | the host's zone | IANA zone name. Day boundaries, quiet hours, the plan score and every chart follow it. |
| `SESSIONMAXXING_URL` | `http://127.0.0.1:4317` | Server the `scripts/queue-task.mjs` helper contacts. |
| `SESSIONMAXXING_PATH_MAP` | empty | `from=to[,from=to]` absolute path prefixes the helper rewrites `--workdir` through. |

Work directories are accepted only under the running user's home; `SESSIONMAXXING_WORKDIR_ROOT` moves that boundary. The server stops at startup with a message when `TZ` is not an IANA zone the process applied. `GET /api/environment` returns the zone and the work-directory root, and the browser formats every time in that zone.

## Data directory

Runtime state lives in one directory, created with mode 0700: `SESSIONMAXXING_DATA_DIR` when set, else `$XDG_DATA_HOME/sessionmaxxing` when `XDG_DATA_HOME` is absolute, else `~/.local/share/sessionmaxxing`. Inside: `queue.json`, `dispatch-settings.json`, `restart-methods.json`, `session-keeper.json`, `usage-snapshot.json`, `usage-samples.jsonl`, `runs/`, `restarts/` and `server.lock`. The lock refuses a second server on the same directory.

A native start finds a `data/` directory in its working directory and moves it to the data directory once, as one rename. Startup stops with a message naming both paths when the data directory already exists, a lock file is left inside `data`, `data` is a symlink or a file, the two paths are nested, or they sit on different filesystems; the last message carries the exact `mv` command. Nothing is merged, copied or deleted.

## Official usage

The server calls `GET https://api.anthropic.com/api/oauth/usage` with the token from `~/.claude/.credentials.json`, the `anthropic-beta: oauth-2025-04-20` header, and a Claude Code User-Agent. That is the same source as Claude Code's `/usage` panel and the "Claude Usage Tracker" browser extension. The response's `five_hour` and `seven_day` windows become **Session (5h)** and **Weekly**; the `limits[]` entry whose model display name is Fable becomes **Fable weekly**. Each bucket shows the percent used, a reset countdown, a pace tick (share of the window already elapsed) and a dispatch-ceiling tick, plus the active minutes and responses your local transcripts show inside that window.

The server fetches every five minutes and on **Refresh** (at most once per 30 s). A failed fetch keeps the last snapshot, shows the error in the panel, and blocks auto-dispatch until a fresh fetch succeeds. An expired token is reported with "run `claude`"; the dashboard never refreshes or stores the token, and no route returns it.

Every snapshot is appended to `usage-samples.jsonl` in the data directory (90 days kept). From those samples:

- **Session windows · last 7 days** draws each five-hour window Anthropic reported, shaded by its peak utilization, on a day grid in the host's time zone, with the share of the week that had no window at all.
- **Weekly usage vs pace** plots weekly and Fable utilization through the current seven-day window against the straight line to the reset and the auto-dispatch limit (pace plus the weekly margin, capped at 95%).

## Auto-dispatch

Queue tasks under **Task queue**. With the queue on, the server runs up to *Tasks running at once* **Ready** tasks together (default 2, at most 4; 1 keeps the old one-at-a-time behaviour). The on/off state is stored in `queue.json` and survives restarts; every task still running at a restart is marked failed. A Claude task is Ready when a run slot is free, the official snapshot is fresh (under 15 min) and newer than the last finished run, session usage plus the points held for running Claude tasks is at or below `100 − session reserve` (default 25% in quiet hours, 100% outside them, so the default queue only runs in quiet hours), weekly usage plus its held points is at or below `pace + weekly margin` (default 10%, hard cap 95%), and, for Fable models, the Fable window passes the same weekly test. A Claude run that Claude Code stops at the session or weekly limit puts its task back in line; once the window resets and the gate passes, the next run resumes the same Claude session instead of starting over. **Run now** overrides the usage gate and the schedule, never the slot limit or a busy repository. Settings live in `dispatch-settings.json`; `PUT /api/dispatch-settings` takes `{ autoApply, keepSessionActive, sessionReservePercent, busyHoursReservePercent, weeklyMarginPercent, quietStartHours, maxConcurrentRuns, runWeeklyCostPercent }`.

With **Start each 5-hour session automatically** on, the server opens a new session window as soon as the previous one ends by running a one-turn `claude -p hi` from the home directory and letting it exit. This is separate from the queue: it needs no task and ignores the queue switch and the reserves. It waits for a fresh usage snapshot after each ping and at least ten minutes between pings, skips while a Claude task is running, and stops when the weekly window is at 100%. Ping session ids live in `session-keeper.json`.

### Parallel runs

Two tasks run together only when they cannot touch the same files. The server resolves each work directory (symlinks included) and the git repository it belongs to, following linked worktrees back to their main checkout. Tasks whose directories are equal or nested, or that belong to the same repository, wait for each other; the waiting card names the task it waits for. Independent repositories and unrelated directories run side by side. A directory whose repository cannot be read waits instead of running unlocked.

Every running Claude task holds *Session held per running Claude task* points of the session window (default 20%) and *Weekly held per running Claude task* points of the weekly window (default 3%, Fable models also hold it in the Fable window) until it finishes. The next task starts only if usage plus everything held still fits under the queue cutoff, so two tasks never start just because each would fit alone. The Overview panel shows running slots as `1/2` and the held points next to each bucket. Settings files saved before these options existed load with the defaults.

Limits: the hold is a fixed estimate, not measured consumption; worktrees of one repository always serialize; locks live in the server process, so a task started outside the dashboard is invisible to them; and a restart fails every running task.

Dispatched Claude tasks run with `--dangerously-skip-permissions`, so a queued run has the same tools an interactive session has: shell, web search, and any MCP servers or skills configured under `~/.claude`, which the container mounts along with your global `CLAUDE.md`.

Each Claude task carries **Tokens**, the weighted count the whole run is expected to consume: output tokens count once, and input, cache writes and cache reads count at their list-price ratio to output, since cached context re-reads are most of what a session spends. The dashboard prices them at the session rates it fits from its own history, so the same task costs more on Fable than on Opus and the number survives a plan change. A task only becomes Ready when session usage, the percent held for running Claude tasks, and its own expected cost (its tokens at the current rates, or the largest percent one of its runs has cost) stay at or below the cutoff.

**Quiet hours** keep your own five-hour windows opening when you actually work. The server ranks all 24 local start hours by your average active minutes in the following five hours over the last 30 days (recomputed every 10 minutes) and, with *Quiet hours only* on (default), a task with no chosen window starts only when the current hour is one of the `quietStartHours` quietest starts (default 8). The dispatch panel lists those hours as ranges and the next one coming up. A task with an explicit preferred window ignores the quiet-hours rule and runs inside that window instead.

## Queueing work

`scripts/queue-task.mjs` queues a task from any terminal without opening the UI:

```sh
node scripts/queue-task.mjs --title "Rename the parser" --prompt-file ./prompt.md \
  --workdir /home/user/workspace/some-repo --model claude-fable-5-1
```

It prints session and weekly usage, the quiet start hours, and the Claude gate reason before posting, then the new task id and the window it will wait for. `--window HH` pins a start hour, `--tokens N` sets the expected weighted tokens (`auto` by default, estimated by the server), `--dry-run` prints the body instead of posting, and `SESSIONMAXXING_URL` (or `--url`) picks the server and the helper tries only that one. `SESSIONMAXXING_PATH_MAP` rewrites a `--workdir` prefix for a server that sees the same folders under other paths, for example `SESSIONMAXXING_PATH_MAP=/Users/me/Projects=/home/user/projects`. Claude Code queues through it with the `queue-task` skill in `~/.claude/skills/queue-task`; `skills/queue-task/SKILL.md` is the same skill for uploading to claude.ai, where it writes the command out for you to paste instead.

## API

- `GET /api/analytics?days=7|14|30|90` local activity aggregates plus per-bucket local windows.
- `GET /api/usage` `{ snapshot, error, samples, windows }`; `POST /api/usage/refresh` fetches now.
- `GET|PUT /api/dispatch-settings` settings plus the planning snapshot (per-bucket gates and the Claude gate status and reason).
- `GET /api/environment` `{ timeZone, workdirRoot }`.
- `GET /api/queue`, `POST /api/tasks`, `PATCH|DELETE /api/tasks/:id`, `POST /api/tasks/:id/run|cancel|retry`, `PUT /api/queue/order`, `PUT /api/queue/auto`, `GET /api/runs`.
- `GET|PUT /api/restart-methods` the restart method of one work directory: `GET ?workdir=<path>` returns `{ method }`, `PUT { workdir, method }` sets it.

Hosts are limited to `localhost`, `127.0.0.1`, the bind address, and the entries of `SESSIONMAXXING_ALLOWED_HOSTS`; an Origin header must match `http://<Host>`. There is no dashboard authentication.

## Install with Docker Compose

```sh
cp .env.example .env
# fill in .env
docker compose up -d --build
```

`.env` holds nine fields; Compose refuses to start while a required one is empty.

| Field | Value |
| --- | --- |
| `SESSIONMAXXING_UID` | `id -u` |
| `SESSIONMAXXING_GID` | `id -g` |
| `SESSIONMAXXING_DOCKER_GID` | `stat -c %g /var/run/docker.sock` |
| `SESSIONMAXXING_HOME` | Your home directory; mounted at the same path in the container |
| `SESSIONMAXXING_BIND_ADDRESS` | Address Docker publishes on; `127.0.0.1` keeps the dashboard on this machine |
| `SESSIONMAXXING_PORT` | Published port, `4317` |
| `SESSIONMAXXING_EDITION` | `full` |
| `TZ` | IANA zone name such as `Europe/Berlin`; the container's zone |
| `SESSIONMAXXING_ALLOWED_HOSTS` | Extra host names or addresses clients type; may stay empty |

The home directory is mounted at the same path, so Claude history, `.claude/.credentials.json`, work directories and the data directory (`$SESSIONMAXXING_HOME/.local/share/sessionmaxxing`) are all the host's own; there is no data volume. A native install and a container on the same account share that directory, and the lock refuses the second server.

A second published address goes into an untracked `compose.override.yaml`, which Compose merges with `compose.yaml`:

```yaml
services:
  sessionmaxxing:
    ports:
      - target: 4317
        published: "4317"
        host_ip: 192.0.2.10
        protocol: tcp
```

Add that address, or the name clients type for it, to `SESSIONMAXXING_ALLOWED_HOSTS`; only the `SESSIONMAXXING_BIND_ADDRESS` address is approved on its own.

### Upgrading an existing Docker install

An install from before the data directory kept its state in `./data`, mounted at `/app/data`. Stop the old container first, move the directory to the data directory (it must not exist yet), then start the new one:

```sh
docker compose down
mkdir -p ~/.local/share && mv data ~/.local/share/sessionmaxxing
docker compose up -d --build
```

Starting first would create an empty data directory, which the move then refuses to overwrite. These paths assume `SESSIONMAXXING_HOME` is your home directory.

## Restart methods

Each work directory has a restart method, set in the **Restart** field of the task form and shared by every task in that directory. A directory without a method restarts nothing.

| Method | What the server runs |
| --- | --- |
| None | Nothing |
| Docker Compose | `docker compose build`, then `docker compose up -d`, in the directory |
| Command | One argument per line, run in the directory without a shell. The first line is the program, found through `PATH` or relative to the directory. Up to 64 arguments of 4096 characters each |

Methods live in `restart-methods.json`; `GET|PUT /api/restart-methods` reads and sets one.

With **Apply and restart without review** on, a run that completes with commits or changed files gets its directory's method run by the server. The run card shows **Restart queued**, **Restarting**, **Restarted** or **Restart failed**, and a failed restart's last 64 KiB of output under **Restart output**. Nothing new starts until the restart ends. Restarts run one at a time, a step that runs past 30 minutes is stopped, and a dashboard stopped mid-restart records it as failed at the next start. Records live in `restarts/` in the data directory.

The image carries the docker CLI with the compose and buildx plugins, and `compose.yaml` mounts `/var/run/docker.sock` with the group from `SESSIONMAXXING_DOCKER_GID`. Mounting the docker socket gives any dispatched prompt root on the host.

### The dashboard's own project

When the work directory is the dashboard's own Compose project, the server builds in place, waits until no task runs, then starts the container `sessionmaxxing-restart-<run id>` from its own image to run `docker compose up -d`. The recreated dashboard records the result and removes that container. Limits:

- The sibling container sees only the work directory and the socket, so a Compose file that reaches outside the directory fails there.
- A Command in the dashboard's own directory runs inside the dashboard. When it recreates the container, the restart shows as failed at the next start.
- Native installs run the host's `docker` from `PATH`, and no directory counts as the dashboard's own.
- The socket path is the Linux Docker Engine one.

### Upgrading from the host deploy watcher

Earlier versions redeployed Compose projects through a systemd user path unit. The first start of this version refuses to run while that watcher still has a request pending, and the message names the file. To upgrade:

1. Add `SESSIONMAXXING_DOCKER_GID` to `.env` before any Compose command: `printf 'SESSIONMAXXING_DOCKER_GID=%s\n' "$(stat -c %g /var/run/docker.sock)" >> .env`.
2. Disable and delete the user units:

   ```sh
   systemctl --user disable --now claude-dashboard-deploy.path
   systemctl --user stop claude-dashboard-deploy.service
   rm -f ~/.config/systemd/user/claude-dashboard-deploy.path ~/.config/systemd/user/claude-dashboard-deploy.service
   systemctl --user daemon-reload && systemctl --user reset-failed
   ```

3. Rebuild and start once from the host: `docker compose up -d --build`.

The first start gives every task directory that holds a Compose file the Docker Compose method, shows the old results on their run cards, and removes the old `deploy/` folder from the data directory.

## Privacy

Transcript content is discarded at the parser boundary. The output of a failed restart is shown on its run card. Prompts and work directories stay on disk in `queue.json` and are never returned by the API. Run previews keep only allowlisted event labels and counters. Runtime state sits in the data directory described above.

## Layout

| Path | Purpose |
| --- | --- |
| `app/` | Next.js App Router: `layout.tsx`, `styles.css`, one `page.tsx` per route |
| `app/components/` | Feature components by route (`overview/`, `analytics/`, `queue/`, `runs/`); shared ones at the root; `ui/` is shadcn |
| `app/hooks/` | React hooks (`usePolling`, `useAnalytics`) |
| `app/lib/` | Pure client logic: API client, time helpers, chart series, queue ordering, analytics cache |
| `server/` | Fastify server, usage monitor, dispatcher, Claude launcher, transcript parser, data directory and environment settings |
| `shared/` | Types, constants and zone-explicit time helpers shared by server and client |
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

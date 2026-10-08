# SessionMaxxing

Local-only dashboard whose single goal is to get the most out of a Claude Max subscription: fill five-hour session windows that would otherwise go unused with queued Claude Code tasks, while keeping the weekly limit on pace so interactive work never gets cut off.

## Stack

React + TypeScript + Next.js (App Router, static export), Tailwind CSS, Recharts, Fastify, Vitest, Biome, pnpm. Node 22.12+.

Four routes: `/` (Overview), `/analytics/` (Analytics), `/queue/` (Task queue), `/runs/` (Runs). Fastify serves the static export from `dist/client`.

## Layout

- `app/` is the Next.js App Router tree. Route folders hold only `page.tsx`; `layout.tsx` and `styles.css` sit at the root. `output: "export"` with client-side fetching means `loading.tsx` never renders, so page skeletons live in `app/components/Skeletons.tsx`.
- `app/components/` holds feature components grouped by route (`overview/`, `analytics/`, `queue/`, `runs/`); components used by more than one route sit at the folder root. `app/components/ui/` is shadcn-generated and edited only through the shadcn CLI.
- `app/hooks/` holds React hooks; `app/lib/` holds pure client logic (API client, time helpers, chart series, queue ordering, cache) that tests import directly without rendering.
- `server/` is the Fastify process, a flat module set compiled by `tsc -p tsconfig.server.json`; `shared/types.ts` is the contract between server and client.
- `scripts/` is the CLI queue helper; `tests/` is Vitest with `helpers.ts` and `fixtures/`.
- Imports inside `app/` use the `@/` alias (`@/app/...`, `@/shared/types`); `server/` and `tests/` use relative `.js` specifiers because the server runs under plain Node with no alias rewriting. No barrel files.

## What the dashboard knows

- **Official usage** comes from Anthropic's own endpoint, `GET https://api.anthropic.com/api/oauth/usage`, called with the OAuth token Claude Code stores in `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`), the `anthropic-beta: oauth-2025-04-20` header, and a `claude-code/<version>` User-Agent. This is the same data as Claude Code's `/usage` panel: `five_hour`, `seven_day`, and per-model weekly windows under `limits[]` (`kind: "weekly_scoped"`, `scope.model.display_name`, `percent`, `resets_at`). The token is read at fetch time and never returned by any dashboard route. The dashboard never refreshes the token; if it is expired the panel says so and asks you to run `claude`.
- The server polls every five minutes, keeps the last good snapshot when a fetch fails, and appends each snapshot to `data/usage-samples.jsonl`. Samples are kept for 90 days and power the session-window timeline, the weekly-pace chart, and the plan score.
- **Plan score** (`GET /api/plan-score`) measures how close usage gets to two goals: every five-hour window near 100% and the weekly limit near 100%. Session coverage of a Eastern day = Σ(window peak % × hours of that window inside the day) ÷ elapsed hours of the day, so back-to-back windows at the cap score 100. A finished week scores its final weekly %; the open week scores used % ÷ elapsed pace, capped at 100. The plan score is the mean of the last seven days' session coverage and the current week's score. Days before sampling began are null, never zero.
- **Local activity** comes from `~/.claude/projects/*/*.jsonl`, subagent transcripts under `~/.claude/projects/*/<session>/subagents/*.jsonl`, and `~/.claude/history.jsonl`: active minutes, responses, model and project mix, heatmap, cumulative chart, quiet-window ranking. Content never reaches the browser.
- **Activity source** is attributed per assistant record, never by time overlap. A queued Claude task is launched with `--session-id <uuid>`; that id is stored in the run's server-side metadata and any record (including subagent records) carrying it counts as *Dispatched tasks*. Records with `entrypoint: "cli"` count as *Local Claude Code*. Headless records not tied to a run, and records without provenance (older runs, missing fields), stay *Unattributed*. The official quota has no source breakdown, so claude.ai and laptop usage appear only as *Other* with no number; splitting them would need a provenance-tagged import of the laptop's own transcript metadata, which does not exist yet. Session ids never reach the browser.

## Task cost

A task stores the **output tokens** its whole run is expected to produce, every model and subagent included, so the number survives a plan change; `"auto"` has a Haiku estimator read the prompt and past runs before the task is stored, and a failed estimate is an error, never a default. `server/calibration.ts` fits the session percent one million output tokens costs per model family by non-negative least squares over the last 14 days of official five-hour windows (`peak %` against the tokens produced inside the window), skipping windows the meter censored at 100% and windows under 8%; a family with no data takes the largest fitted rate. On the rates fitted 2026-09-15 Fable costs about 357 points per million output tokens and Opus about 138. Every session percent shown — a task's expected cost, a finished run's cost — is derived from tokens at the current rates, and the Claude gate waits while no window can be fitted. A finished Claude run stores the output tokens of its own session, read from its transcript and its subagents' transcripts, instead of the session-meter delta, which any concurrent work contaminated.

## Dispatch policy

With the queue switch on (persisted in `data/queue.json` across restarts), the server runs up to `maxConcurrentRuns` queued tasks at once (default 2, range 1 to 4; 1 is the old serial behaviour); every task still running at a restart is marked failed. A Claude task is **ready** only when all hold:

1. A run slot is free.
2. An official snapshot exists and is under fifteen minutes old, and was fetched after the last run ended.
3. Session utilization plus the session points held for running Claude tasks is at or below `100 − reserve`, where the reserve is `sessionReservePercent` (default 25%) inside quiet hours and `busyHoursReservePercent` outside them. An expired session window counts as 0%; a failed gate names which reserve applied when the two differ. A Claude task also needs headroom for its own expected session cost, `session % + points held for running tasks + expected cost ≤ cutoff`, where the expected cost is the task's own `outputTokens` priced at the fitted session rates until a completed run has been measured, then the largest session percent among that task's completed runs (failed and cancelled runs never set the price). An expected cost above the cutoff is capped at the cutoff, so such a task starts only in an empty session instead of never.
4. Weekly utilization plus the weekly points held for running Claude tasks is at or below `min(95, pace + weeklyMarginPercent)` where pace is the elapsed share of the seven-day window (default margin 10%).
5. For models matching `fable`, the same weekly rule applies to the Fable window when Anthropic reports one, counting only running Fable tasks.
6. With `busyHoursReservePercent` at 100 (the default) the queue keeps the whole session outside quiet hours, so a task without a preferred window starts only when the current Eastern hour is among the `quietStartHours` (default 8) quietest five-hour starts, ranked from the last 30 days of interactive local activity (dispatched and unattributed records excluded) and cached for 10 minutes. Tasks with an explicit preferred window skip this rule. Until the ranking is computed, such tasks wait and say so. Below 100, quiet hours instead choose which session reserve applies and tasks run at any hour that has budget.

With the apply override on (`autoApply`, off by default), every dispatched prompt gains a closing instruction telling the agent to edit the work directory in place, ignore git entirely (no status checks, commits, stashes, branches, or worktrees), and run any non-Compose deploy itself, so a finished run is already live instead of waiting for review. Runs have no docker CLI, so the instruction forbids `docker compose`; the dashboard asks the host watcher to redeploy instead. Uncommitted changes never block a change or the deployment. The stored task prompt is untouched; only the launched copy carries the instruction.

With the session keeper on (`keepSessionActive`, off by default), `server/session-keeper.ts` opens a new five-hour window as soon as the previous one has ended: when the latest official snapshot reports no session window (or one whose `resets_at` has passed), no Claude task is running, and the weekly window is under 100%, it runs `claude -p hi --model haiku --max-turns 1 --session-id <uuid>` from the home directory and lets it exit, then refreshes usage. It is independent of the queue: not a task, not gated by the queue switch, the reserves, or quiet hours. A second ping waits for a snapshot fetched after the last ping ended and at least ten minutes since it started, so a lagging endpoint cannot start sessions in a loop. Ping session ids are stored in `data/session-keeper.json` and count as *Dispatched tasks* activity; `GET /api/queue` carries `sessionKeeper` with the last start time and any error.

A Claude run that ends with Claude Code's usage-limit message (`You've hit your session limit` or `… weekly limit`) is not a failure of the task: the run is stored as failed with the reason "Stopped at the usage limit", the task goes back to pending with no retry cap, and the normal gates hold it until the window resets. Its next run resumes the same Claude session (`--resume <session id>` with a continue prompt instead of the task prompt), so the session id and its *Dispatched tasks* attribution carry over; each run's tokens count only the transcript records written after that run started.

**Run now** overrides the usage gate and the schedule, never the slot bound or the locks. Settings persist in `data/dispatch-settings.json`.

A task can **depend on** other queued tasks (`dependsOn`, up to 20 ids). It waits until every one of them has completed, ahead of every other gate, and Run now refuses while one is unfinished. A dependency that failed or was cancelled keeps the task blocked with that reason until it is retried; deleting a task drops it from the tasks that depended on it, and a cycle is rejected when the task is saved.

**Eligible-time estimate.** This is the baseline model for the published product (SessionMaxxing); later phases keep it. A pending task's `eligibleAt` (`server/dispatch.ts`) is the first instant the live gate would admit it, found by walking the session from now: the pending Claude tasks queued ahead (minus those that depend on the task, directly or through a chain) start one after another, then the task itself. Each one starts at the first instant (now, or a later Eastern hour boundary before the open window resets) whose hour's cutoff fits `used + cost`, the cost capped at that cutoff; the cutoff is `100 − sessionReservePercent` in a quiet start hour or when the queue runs only in quiet hours, and `100 − busyHoursReservePercent` otherwise. A task that fits nowhere before the reset waits for the next window, which starts empty (running tasks are assumed finished by then) and opens when its first task starts. With quiet hours only, the tasks ahead also start only in quiet start hours; the task itself also respects its earliest start, its preferred window, the weekly ceiling and, for Fable models, the Fable ceiling, each counting the points running tasks hold. The estimate is never earlier than the live gate would admit, and with nothing queued ahead it is now exactly when `taskGate` is ready. It is null while the session rates are unknown, when the session reset is unknown and nothing fits, or when no allowed hour exists.

## Host deploy watcher

A dispatched run cannot redeploy its own Compose project: it lives inside the dashboard container, which has no docker CLI, and recreating that container would fail every run inside it. When an applied run completes, left commits or changed files, and its work directory holds a Compose file, `server/deploy.ts` writes `data/deploy/requests/<run id>.json`. A systemd user path unit (`deploy/claude-dashboard-deploy.path`) sees the file and runs `deploy/host-deploy.sh` on the host, which builds the project, waits for every dashboard run to finish before recreating the dashboard's own container, runs `docker compose up -d`, writes `data/deploy/results/<run id>.json` with `deploying`, `succeeded` or `failed`, and removes the request. The run card shows that status as a badge.

While any request is unfinished, the runner starts nothing: `admit()` throws, `select()` picks nothing and every gate waits on the deploy, because the deploy may restart the dashboard. Requests and results are reread every tick, and a malformed file fails loudly like the other runtime state.

## Concurrency and collisions

- Each running Claude task holds its own expected session percent and `runWeeklyCostPercent` weekly points (default 3, also charged to the Fable window for Fable models) until it finishes. The task being admitted is not charged against itself, so the first run follows the same rule as before and each further run must fit behind the expected cost of everything already running. Polling folds real consumption into the snapshot while the hold stays, which double counts in the conservative direction.
- Before a task starts, `server/resources.ts` resolves its work directory to lock keys: the realpath of the directory and, when it sits inside a git checkout, the repository's common git dir (linked worktrees and submodules are followed through their `.git` file). Two tasks collide when their paths are equal or nested, or when they belong to the same repository. Worktrees of one repository therefore never run together; separate repositories do. A directory whose repository cannot be resolved waits with a reason rather than running unlocked.
- The runner (`server/runner.ts`) owns the locks in memory. Each tick walks pending tasks in queue order (priority, then creation time), admits each one that passes its gate against the load of running plus already admitted tasks and does not collide with them, and stops when the slots are full. A collided task keeps its place and is reconsidered every tick; later independent tasks may start ahead of it, which is the only way a lower-priority task overtakes a higher one.
- Lock acquisition happens in one synchronous step inside `start()` after resource resolution, before the queue claim, so Run now and the scheduler cannot both take the same slot or resource.
- `PlanningSnapshot.load` reports running counts and held points; each `BucketGate` carries `reserved`; a task gate that waits on a lock carries `blockedBy` with the holder's title. Session ids and resource keys never reach the browser.

## Rules

- Task prompts and work directories are shown in the browser (local-only dashboard). A run's final assistant message is stored as its summary and shown on the run card; everything else — intermediate assistant text, credentials, tokens, UUIDs, raw transcript records, run output — never reaches the browser.
- Launch the Claude CLI with `child_process.spawn(command, args, { shell: false })`; never build a shell string from a task.
- Accept only existing absolute work directories under `/home/user`.
- Dispatched Claude tasks run with `--dangerously-skip-permissions` so a queued run has every tool an interactive session has (shell, web search, MCP servers, skills from `~/.claude`). The container runs unprivileged and only the local queue owner can add tasks, so the prompt is the trust boundary.
- No silent fallbacks: a failed usage fetch is shown as an error and blocks auto-dispatch; corrupt runtime files fail loudly instead of being reset.
- The only host-side service is the deploy watcher in `deploy/`: a systemd user path unit that runs `docker compose` for finished runs. Nothing else is a cron job or daemon; Docker Compose is otherwise started by hand.
- Tests mock only true boundaries (network, clock, temp filesystem). Never hit the real usage endpoint from tests.
- No "view as table" disclosures, estimate badges, or caveat prose in the UI. The chart is the deliverable.

## Visual direction

Linear-inspired dark UI: page `#08090a`, panels `#0f1011`, elevated `#191a1b`; text `#f7f8f8` / `#d0d6e0` / `#8a8f98`; accent `#7170ff`; Fable amber `#b8893f`; green only for success/running, amber for waiting. Inter for UI, JetBrains Mono for numbers. No gradients or marketing copy.

## Checks

`pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` must pass. Commit only when asked.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

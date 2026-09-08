# Claude capacity dashboard

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

## Dispatch policy

With the queue switch on (persisted in `data/queue.json` across restarts), the server runs one queued task at a time; a task interrupted by a restart is marked failed. A Claude task is **ready** only when all hold:

1. An official snapshot exists and is under fifteen minutes old.
2. Session utilization is at or below `100 − reserve`, where the reserve is `sessionReservePercent` (default 25%) inside quiet hours and `busyHoursReservePercent` outside them. An expired session window counts as 0%; a failed gate names which reserve applied when the two differ.
3. Weekly utilization is at or below `min(95, pace + weeklyMarginPercent)` where pace is the elapsed share of the seven-day window (default margin 10%).
4. For models matching `fable`, the same weekly rule applies to the Fable window when Anthropic reports one.
5. With `busyHoursReservePercent` at 100 (the default) the queue keeps the whole session outside quiet hours, so a task without a preferred window starts only when the current Eastern hour is among the `quietStartHours` (default 8) quietest five-hour starts, ranked from the last 30 days of interactive local activity (dispatched and unattributed records excluded) and cached for 10 minutes. Tasks with an explicit preferred window skip this rule. Until the ranking is computed, such tasks wait and say so. Below 100, quiet hours instead choose which session reserve applies and tasks run at any hour that has budget.

Codex tasks are never gated by Claude usage. **Run now** always overrides the gate and the schedule. Settings persist in `data/dispatch-settings.json`.

## Rules

- Task prompts and work directories are shown in the browser (local-only dashboard). Never return assistant text, credentials, tokens, UUIDs, run output, or raw transcript records.
- Launch providers with `child_process.spawn(command, args, { shell: false })`; never build a shell string from a task.
- Accept only existing absolute work directories under `/home/user`.
- Dispatched Claude tasks run with `--dangerously-skip-permissions` so a queued run has every tool an interactive session has (shell, web search, MCP servers, skills from `~/.claude`). The container runs unprivileged and only the local queue owner can add tasks, so the prompt is the trust boundary.
- No silent fallbacks: a failed usage fetch is shown as an error and blocks auto-dispatch; corrupt runtime files fail loudly instead of being reset.
- No systemd unit, cron job, or background service; Docker Compose is started by hand.
- Tests mock only true boundaries (network, clock, temp filesystem). Never hit the real usage endpoint from tests.
- No "view as table" disclosures, estimate badges, or caveat prose in the UI. The chart is the deliverable.

## Visual direction

Linear-inspired dark UI: page `#08090a`, panels `#0f1011`, elevated `#191a1b`; text `#f7f8f8` / `#d0d6e0` / `#8a8f98`; accent `#7170ff`; Fable amber `#b8893f`; green only for success/running, amber for waiting. Inter for UI, JetBrains Mono for numbers. No gradients or marketing copy.

## Checks

`pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` must pass. Commit only when asked.

# Claude capacity dashboard

Local-only dashboard whose single goal is to get the most out of a Claude Max subscription: fill five-hour session windows that would otherwise go unused with queued Claude Code tasks, while keeping the weekly limit on pace so interactive work never gets cut off.

## Stack

React + TypeScript + Next.js (App Router, static export), Tailwind CSS, Recharts, Fastify, Vitest, Biome, pnpm. Node 22.12+.

Three routes: `/` (Overview), `/queue/` (Task queue), `/runs/` (Runs). Fastify serves the static export from `dist/client`.

## What the dashboard knows

- **Official usage** comes from Anthropic's own endpoint, `GET https://api.anthropic.com/api/oauth/usage`, called with the OAuth token Claude Code stores in `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`), the `anthropic-beta: oauth-2025-04-20` header, and a `claude-code/<version>` User-Agent. This is the same data as Claude Code's `/usage` panel: `five_hour`, `seven_day`, and per-model weekly windows under `limits[]` (`kind: "weekly_scoped"`, `scope.model.display_name`, `percent`, `resets_at`). The token is read at fetch time and never returned by any dashboard route. The dashboard never refreshes the token; if it is expired the panel says so and asks you to run `claude`.
- The server polls every five minutes, keeps the last good snapshot when a fetch fails, and appends each snapshot to `data/usage-samples.jsonl`. Samples power the session-window timeline and the weekly-pace chart.
- **Local activity** comes from `~/.claude/projects/*/*.jsonl` and `~/.claude/history.jsonl`: active minutes, responses, model and project mix, heatmap, cumulative chart, quiet-window ranking. Content never reaches the browser.

## Dispatch policy

With the queue switch on (persisted in `data/queue.json` across restarts), the server runs one queued task at a time; a task interrupted by a restart is marked failed. A Claude task is **ready** only when all hold:

1. An official snapshot exists and is under fifteen minutes old.
2. Session utilization is at or below `100 − sessionReservePercent` (default reserve 25%). An expired session window counts as 0%.
3. Weekly utilization is at or below `min(95, pace + weeklyMarginPercent)` where pace is the elapsed share of the seven-day window (default margin 10%).
4. For models matching `fable`, the same weekly rule applies to the Fable window when Anthropic reports one.
5. With `quietHoursOnly` (default on), a task without a preferred window starts only when the current Eastern hour is among the `quietStartHours` (default 8) quietest five-hour starts, ranked from the last 30 days of local activity and cached for 10 minutes. Tasks with an explicit preferred window skip this rule. Until the ranking is computed, such tasks wait and say so.

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

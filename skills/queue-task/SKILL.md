---
name: queue-task
description: Queue a coding task on the local SessionMaxxing dashboard so it runs automatically in a quiet hour / next session instead of now. Use when the user says "queue this", "run this later", "schedule for tonight", or when Claude Max session usage is above ~75%.
---

# Queue a task on SessionMaxxing

On claude.ai the dashboard is unreachable: it is a loopback or private-network service and
no `curl` or `node` runs there. In that setting, skip the capacity check and instead write
out the exact command for the user to paste into a terminal that can reach it — a
`node scripts/queue-task.mjs ...` invocation, or a `curl -X POST .../api/tasks` with a
JSON body — with the prompt spelled out in full inside it, since nothing else can
supply it later.

The SessionMaxxing dashboard (run `node scripts/queue-task.mjs` from its checkout) keeps a
queue and auto-dispatches tasks into the quietest five-hour windows, gated by official Claude Max
usage. Up to `settings.maxConcurrentRuns` tasks (default 2) run together when their
work directories belong to different repositories; tasks in the same repository, a
nested directory, or another worktree of the same repository wait for each other, and
each running Claude task holds the session percent its own expected tokens cost
until it finishes. Queue work here instead of burning the current session.

## 1. Check capacity

```sh
curl -s "${SESSIONMAXXING_URL:-http://127.0.0.1:4317}/api/usage"
curl -s "${SESSIONMAXXING_URL:-http://127.0.0.1:4317}/api/dispatch-settings"
```

Read `snapshot.session.percent`, `snapshot.weekly.percent`, `quiet.startHours`, and
`gate.reason`. If a call fails, the dashboard is not running at that address — say so
and stop.

## 2. Gather the task

- **title** — short, 1-120 chars.
- **workdir** — absolute path, defaults to the current repo root, must be under the
  server's work-directory root (`workdirRoot` in `GET /api/environment`: the running
  user's home unless `SESSIONMAXXING_WORKDIR_ROOT` moves it).
  Pick the narrowest directory that is its own repository; two tasks only run in parallel
  when their repositories differ, and a workdir equal to the root blocks every other task.
- **prompt** — self-contained; the queued run starts with no conversation history. It must state:
  the files to touch, the decisions already made, and the checks to run (`pnpm typecheck`,
  `pnpm test`, …).
- **commit line** — depends on `settings.autoApply` from `/api/dispatch-settings`:
  - `false`: end the prompt with **do not commit**.
  - `true`: the dashboard appends an edit-in-place paragraph that tells the run to ignore
    git and names the work directory's restart method, which the dashboard runs after the
    run ends. Never write a git step (commit, stash, branch, worktree, clean-tree check),
    a docker step or a restart step in the prompt.
- **git state** — ignore it. Uncommitted changes never block queuing or applying a task.

Write long prompts to a file in your scratchpad directory and pass `--prompt-file`.

## 3. Queue it

```sh
node scripts/queue-task.mjs \
  --title "Rename the parser" \
  --prompt-file /tmp/claude-*/scratchpad/queued-prompt.md \
  --workdir /path/to/some-repo \
  --model claude-fable-5-1 \
  --max-turns 100
```

Other flags: `--priority N` (lower runs first),
`--tokens N|auto` (expected weighted tokens, `auto` by default),
`--window HH` (0-23; omit for any hour), `--after ISO`, `--url` (or `SESSIONMAXXING_URL`), `--dry-run`.
`SESSIONMAXXING_PATH_MAP=from=to[,from=to]` rewrites a `--workdir` prefix for a server that sees the same folders under other paths.
The lite edition (`edition: "lite"` from `GET /api/environment`) has no `quiet` field and takes no `--tokens`.
The script prints the usage summary, then the created task id, title, and window.

## 4. Report back

Tell the user the task id, the quiet start hours it will wait for (or the chosen
window), and these two conditions:

- Auto-dispatch must be on:
  ```sh
  curl -X PUT "${SESSIONMAXXING_URL:-http://127.0.0.1:4317}/api/queue/auto" \
    -H 'Content-Type: application/json' -d '{"enabled":true}'
  ```
- The dashboard must stay running; nothing runs while the server is stopped.

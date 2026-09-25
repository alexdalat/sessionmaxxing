---
name: queue-task
description: Queue a coding task on the local Claude capacity dashboard so it runs automatically in a quiet hour / next session instead of now. Use when the user says "queue this", "run this later", "schedule for tonight", or when Claude Max session usage is above ~75%.
---

# Queue a task on the capacity dashboard

On claude.ai the dashboard is unreachable: it is a loopback/tailnet service and no
`curl` or `node` runs there. In that setting, skip the capacity check and instead write
out the exact command for the user to paste into a terminal on the tailnet — a
`node scripts/queue-task.mjs ...` invocation, or a `curl -X POST .../api/tasks` with a
JSON body — with the prompt spelled out in full inside it, since nothing else can
supply it later.

The dashboard at `/home/user/workspace/claude-capacity-dashboard` keeps a queue and
auto-dispatches tasks into the quietest five-hour windows, gated by official Claude Max
usage. Up to `settings.maxConcurrentRuns` tasks (default 2) run together when their
work directories belong to different repositories; tasks in the same repository, a
nested directory, or another worktree of the same repository wait for each other, and
each running Claude task holds the session percent its own expected tokens cost
until it finishes. Queue work here instead of burning the current session.

## 1. Check capacity

```sh
curl -s http://127.0.0.1:4317/api/usage
curl -s http://127.0.0.1:4317/api/dispatch-settings
```

Fall back to `http://192.0.2.10:4317` (tailnet) if the loopback call fails. Read
`snapshot.session.percent`, `snapshot.weekly.percent`, `quiet.startHours`, and
`providers.claude.reason`. If neither host answers, the container is down — say so
and stop.

## 2. Gather the task

- **title** — short, 1-120 chars.
- **workdir** — absolute path, defaults to the current repo root, must be under `/home/user`.
  Pick the narrowest directory that is its own repository; two tasks only run in parallel
  when their repositories differ, and a workdir of `/home/user` blocks every other task.
- **prompt** — self-contained; the queued run starts with no conversation history. It must state:
  the files to touch, the decisions already made, and the checks to run (`pnpm typecheck`,
  `pnpm test`, …).
- **commit line** — depends on `settings.autoApply` from `/api/dispatch-settings`:
  - `false`: end the prompt with **do not commit**.
  - `true`: the dashboard appends an edit-in-place paragraph that tells the run to ignore
    git and to leave `docker compose` to the host, which redeploys a Compose work directory
    once the run ends. Never write a git step (commit, stash, branch, worktree, clean-tree
    check) or any docker step in the prompt.
- **git state** — ignore it. Uncommitted changes never block queuing or applying a task.

Write long prompts to a file in your scratchpad directory and pass `--prompt-file`.

## 3. Queue it

```sh
node /home/user/workspace/claude-capacity-dashboard/scripts/queue-task.mjs \
  --title "Rename the parser" \
  --prompt-file /tmp/claude-*/scratchpad/queued-prompt.md \
  --workdir /home/user/workspace/some-repo \
  --model claude-fable-5-1 \
  --max-turns 100
```

Other flags: `--provider claude|codex`, `--priority N` (lower runs first),
`--tokens N|auto` (expected weighted tokens, `auto` by default),
`--window HH` (0-23; omit for any hour), `--after ISO`, `--url`, `--dry-run`.
The script prints the usage summary, then the created task id, title, and window.

## 4. Report back

Tell the user the task id, the quiet start hours it will wait for (or the chosen
window), and these two conditions:

- Auto-dispatch must be on:
  ```sh
  curl -X PUT http://127.0.0.1:4317/api/queue/auto \
    -H 'Content-Type: application/json' -d '{"enabled":true}'
  ```
- The dashboard container must stay up (`docker compose up -d` in the dashboard
  repo); nothing runs while the server is stopped.

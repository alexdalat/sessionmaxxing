#!/usr/bin/env bash
# Runs on the host because dispatched runs live in the dashboard container, which has no docker CLI.
set -euo pipefail

repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# The server resolves its data directory with this precedence, and the watcher must read the same one.
case "${XDG_DATA_HOME:-}" in
  /*) xdg_data_home="$XDG_DATA_HOME" ;;
  *) xdg_data_home="$HOME/.local/share" ;;
esac
data_dir="${SESSIONMAXXING_DATA_DIR:-$xdg_data_home/sessionmaxxing}"
requests="$data_dir/deploy/requests"
results="$data_dir/deploy/results"
queue_url="${DASHBOARD_URL:-http://127.0.0.1:4317}/api/queue"
poll_seconds=15
curl_connection_refused=7

write_result() {
  local run_id=$1 status=$2
  jq -n --arg runId "$run_id" --arg status "$status" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
    '{runId: $runId, status: $status, updatedAt: $updatedAt}' >"$results/$run_id.json.tmp"
  mv "$results/$run_id.json.tmp" "$results/$run_id.json"
}

# Recreating the dashboard container fails every run still inside it.
wait_for_idle() {
  local queue code running
  while true; do
    code=0
    queue=$(curl --silent --fail "$queue_url") || code=$?
    if [ "$code" -eq "$curl_connection_refused" ]; then return 0; fi
    if [ "$code" -ne 0 ]; then
      echo "Dashboard queue check failed: curl exited $code"
      return 1
    fi
    running=$(jq '[.tasks[] | select(.status == "running")] | length' <<<"$queue") || return
    if [ "$running" -eq 0 ]; then return 0; fi
    echo "Waiting for $running running task(s)"
    sleep "$poll_seconds"
  done
}

compose_up() {
  local workdir=$1
  case "$(realpath "$workdir")" in
    "$HOME"/*) ;;
    *)
      echo "Refusing $workdir: outside $HOME"
      return 1
      ;;
  esac
  cd "$workdir" || return
  docker compose build || return
  if [ "$(realpath "$workdir")" = "$repo" ]; then wait_for_idle || return; fi
  docker compose up -d
}

deploy() {
  local request=$1 run_id workdir status=failed
  run_id=$(jq -r .runId "$request")
  workdir=$(jq -r .workdir "$request")
  write_result "$run_id" deploying
  if (compose_up "$workdir") >"$results/$run_id.log" 2>&1; then status=succeeded; fi
  write_result "$run_id" "$status"
  rm "$request"
}

shopt -s nullglob
for request in "$requests"/*.json; do
  deploy "$request"
done

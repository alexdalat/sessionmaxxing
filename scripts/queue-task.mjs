#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const DEFAULT_URL = process.env.SESSIONMAXXING_URL ?? "http://127.0.0.1:4317";
const PATH_MAP_VAR = "SESSIONMAXXING_PATH_MAP";
const DEFAULT_MAX_TURNS = 500;
const AUTO_TOKENS = "auto";
const MIN_TOKENS = 5_000;
const MAX_TOKENS = 10_000_000;
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);
const USAGE = `Usage: node scripts/queue-task.mjs --title "..." (--prompt "..." | --prompt-file PATH)
  [--workdir /abs/path]  default: the current directory
  [--model NAME] [--priority N]
  [--max-turns N]        default: 500
  [--tokens N|auto]      expected weighted tokens; auto lets the server estimate them
  [--window HH]          0-23; omit for any hour
  [--depends-on ID[,ID]] run only after these queued task ids finish
  [--no-commit]          with auto-apply on, leave the work uncommitted instead of committing and pushing it
  [--after ISO] [--dry-run]
  [--url URL]            default: $SESSIONMAXXING_URL, else http://127.0.0.1:4317
  $SESSIONMAXXING_PATH_MAP  from=to[,from=to] absolute prefixes; rewrites --workdir for a server that sees these folders elsewhere`;
const VALUE_FLAGS = new Set([
  "--title",
  "--prompt",
  "--prompt-file",
  "--workdir",
  "--model",
  "--priority",
  "--window",
  "--after",
  "--max-turns",
  "--tokens",
  "--depends-on",
  "--url",
]);
const TASK_ID = /^[a-f0-9]{24}$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const values = {};
  let dryRun = false;
  let commit = true;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--no-commit") {
      commit = false;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (!VALUE_FLAGS.has(flag)) fail(`Unknown argument ${flag}.\n${USAGE}`);
    if (values[flag] !== undefined) fail(`${flag} was given twice.`);
    const value = argv[++index];
    if (value === undefined) fail(`${flag} needs a value.`);
    values[flag] = value;
  }
  return { values, dryRun, commit };
}

function taskIds(raw) {
  if (raw === undefined) return [];
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) fail("--depends-on needs at least one task id.");
  for (const id of ids)
    if (!TASK_ID.test(id)) fail(`--depends-on: ${id} is not a task id.`);
  if (new Set(ids).size !== ids.length) fail("--depends-on repeats an id.");
  return ids;
}

function integer(raw, flag, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    fail(`${flag} must be an integer from ${min} to ${max}.`);
  return value;
}

const within = (path, root) => path === root || path.startsWith(`${root}/`);

function pathMapEntry(entry) {
  const sides = entry.split("=");
  if (sides.length !== 2 || !sides.every(isAbsolute))
    fail(
      `${PATH_MAP_VAR}: "${entry}" must be two absolute paths joined by one =.`,
    );
  const [from, to] = sides.map((side) => side.replace(/\/+$/, ""));
  if (!from || !to)
    fail(`${PATH_MAP_VAR}: "${entry}" must not map the filesystem root.`);
  return [from, to];
}

function parsePathMap(raw) {
  if (!raw) return [];
  const pairs = raw.split(",").map(pathMapEntry);
  const seen = new Set();
  for (const [from] of pairs) {
    if (seen.has(from)) fail(`${PATH_MAP_VAR}: ${from} is mapped twice.`);
    seen.add(from);
  }
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

function dashboardPath(path, pathMap) {
  if (!isAbsolute(path)) fail("--workdir must be an absolute path.");
  const pair = pathMap.find(([from]) => within(path, from));
  return pair ? pair[1] + path.slice(pair[0].length) : path;
}

function buildBody(values, commit) {
  if (!values["--title"]) fail(`--title is required.\n${USAGE}`);
  if (values["--prompt"] !== undefined && values["--prompt-file"] !== undefined)
    fail("Pass --prompt or --prompt-file, not both.");
  const prompt =
    values["--prompt-file"] === undefined
      ? values["--prompt"]
      : readFileSync(values["--prompt-file"], "utf8");
  if (!prompt) fail(`--prompt or --prompt-file is required.\n${USAGE}`);
  const pathMap = parsePathMap(process.env[PATH_MAP_VAR]);
  const workdir = dashboardPath(values["--workdir"] ?? process.cwd(), pathMap);
  const body = {
    title: values["--title"],
    prompt,
    workdir,
    priority:
      values["--priority"] === undefined
        ? 0
        : integer(values["--priority"], "--priority", 0, 1_000_000),
    earliestStart: values["--after"] ?? null,
    preferredWindowStart:
      values["--window"] === undefined
        ? null
        : integer(values["--window"], "--window", 0, 23),
    maxTurns:
      values["--max-turns"] === undefined
        ? DEFAULT_MAX_TURNS
        : integer(values["--max-turns"], "--max-turns", 1, 1000),
    tokens:
      values["--tokens"] === undefined || values["--tokens"] === AUTO_TOKENS
        ? AUTO_TOKENS
        : integer(values["--tokens"], "--tokens", MIN_TOKENS, MAX_TOKENS),
    dependsOn: taskIds(values["--depends-on"]),
    commit,
  };
  if (values["--model"] !== undefined) body.model = values["--model"];
  return body;
}

const isConnectionError = (error) =>
  CONNECTION_CODES.has(error?.cause?.code) || CONNECTION_CODES.has(error?.code);

async function send(base, path, init) {
  const response = await fetch(`${base}${path}`, init);
  const payload = await response.json();
  if (!response.ok)
    fail(payload.error ?? `${path} failed with status ${response.status}.`);
  return payload;
}

async function connect(base) {
  try {
    return { base, usage: await send(base, "/api/usage") };
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    return fail(
      `Cannot reach SessionMaxxing at ${base}. Start it, or point this helper at it with --url or SESSIONMAXXING_URL.`,
    );
  }
}

const hourLabel = (hour) => `${String(hour).padStart(2, "0")}:00`;

function quietLabel(quiet) {
  if (quiet.startHours === null)
    return quiet.error ? `unranked (${quiet.error})` : "unranked";
  return quiet.startHours.map(hourLabel).join(" ");
}

const { values, dryRun, commit } = parseArgs(process.argv.slice(2));
const body = buildBody(values, commit);
if (dryRun) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

const { base, usage } = await connect(values["--url"] ?? DEFAULT_URL);
const planning = await send(base, "/api/dispatch-settings");
const gate = planning.gate;
const percent = (bucket) => (bucket ? `${bucket.percent}%` : "unknown");
console.log(
  `${base} · session ${percent(usage.snapshot?.session)} · weekly ${percent(usage.snapshot?.weekly)} · quiet ${quietLabel(planning.quiet)} · claude ${gate.status}: ${gate.reason}${usage.error ? ` · usage error: ${usage.error}` : ""}`,
);

const created = await send(base, "/api/tasks", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
console.log(
  `Queued ${created.id} · ${created.title} · ${created.preferredWindowStart === null ? "Any hour" : `Window ${hourLabel(created.preferredWindowStart)}`}`,
);

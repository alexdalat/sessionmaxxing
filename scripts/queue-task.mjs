#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const DEFAULT_URL = process.env.SESSIONMAXXING_URL ?? "http://127.0.0.1:4317";
const TAILNET_URL = "http://192.0.2.10:4317";
const MAC_HOME = "/Users/me";
// Syncthing folder pairs between the Mac and deltabeta. Runs execute on deltabeta,
// so a workdir given from the Mac must name the same folder by its deltabeta path.
const SYNCED_ROOTS = [
  ["/Users/me/Documents/Personal", "/home/user/syncthing/Personal"],
  ["/Users/me/ObsidianVaults", "/home/user/syncthing/Obsidian"],
  ["/Users/me/.claude", "/home/user/.claude"],
];
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
  [--after ISO] [--dry-run]
  [--url URL]            default: $SESSIONMAXXING_URL, else http://127.0.0.1:4317`;
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
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      dryRun = true;
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
  return { values, dryRun };
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

function dashboardPath(path) {
  if (!isAbsolute(path)) fail("--workdir must be an absolute path.");
  if (!within(path, MAC_HOME)) return path;
  for (const [mac, deltabeta] of SYNCED_ROOTS) {
    if (within(path, mac)) return deltabeta + path.slice(mac.length);
  }
  fail(
    `${path} is not in a Syncthing folder shared with deltabeta. Pass --workdir with the deltabeta path.`,
  );
}

function buildBody(values) {
  if (!values["--title"]) fail(`--title is required.\n${USAGE}`);
  if (values["--prompt"] !== undefined && values["--prompt-file"] !== undefined)
    fail("Pass --prompt or --prompt-file, not both.");
  const prompt =
    values["--prompt-file"] === undefined
      ? values["--prompt"]
      : readFileSync(values["--prompt-file"], "utf8");
  if (!prompt) fail(`--prompt or --prompt-file is required.\n${USAGE}`);
  const workdir = dashboardPath(values["--workdir"] ?? process.cwd());
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
    if (base === TAILNET_URL || !isConnectionError(error)) throw error;
    return { base: TAILNET_URL, usage: await send(TAILNET_URL, "/api/usage") };
  }
}

const hourLabel = (hour) => `${String(hour).padStart(2, "0")}:00`;

function quietLabel(quiet) {
  if (quiet.startHours === null)
    return quiet.error ? `unranked (${quiet.error})` : "unranked";
  return quiet.startHours.map(hourLabel).join(" ");
}

const { values, dryRun } = parseArgs(process.argv.slice(2));
const body = buildBody(values);
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

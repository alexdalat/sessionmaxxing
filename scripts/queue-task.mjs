#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const DEFAULT_URL =
  process.env.CAPACITY_DASHBOARD_URL ?? "http://127.0.0.1:4317";
const TAILNET_URL = "http://192.0.2.10:4317";
const DEFAULT_MAX_TURNS = 100;
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
  [--model NAME] [--provider claude|codex] [--priority N] [--max-turns N]
  [--window HH]          0-23; omit for any quiet hour
  [--after ISO] [--url URL] [--dry-run]`;
const VALUE_FLAGS = new Set([
  "--title",
  "--prompt",
  "--prompt-file",
  "--workdir",
  "--model",
  "--provider",
  "--priority",
  "--window",
  "--after",
  "--max-turns",
  "--url",
]);

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

function integer(raw, flag, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    fail(`${flag} must be an integer from ${min} to ${max}.`);
  return value;
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
  const workdir = values["--workdir"] ?? process.cwd();
  if (!isAbsolute(workdir)) fail("--workdir must be an absolute path.");
  const provider = values["--provider"] ?? "claude";
  if (provider !== "claude" && provider !== "codex")
    fail("--provider must be claude or codex.");
  const body = {
    title: values["--title"],
    prompt,
    workdir,
    provider,
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
const claude = planning.providers.claude;
const percent = (bucket) => (bucket ? `${bucket.percent}%` : "unknown");
console.log(
  `${base} · session ${percent(usage.snapshot?.session)} · weekly ${percent(usage.snapshot?.weekly)} · quiet ${quietLabel(planning.quiet)} · claude ${claude.status}: ${claude.reason}${usage.error ? ` · usage error: ${usage.error}` : ""}`,
);

const created = await send(base, "/api/tasks", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
console.log(
  `Queued ${created.id} · ${created.title} · ${created.preferredWindowStart === null ? "Any quiet hour" : `Window ${hourLabel(created.preferredWindowStart)}`}`,
);

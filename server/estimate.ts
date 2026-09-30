import { spawn } from "node:child_process";
import {
  MAX_TOKENS,
  MIN_TOKENS,
  MODEL_FAMILIES,
  modelFamily,
  type Provider,
  type WeightedTokens,
} from "../shared/types.js";
import type { ProviderProcess } from "./providers.js";

export const ESTIMATOR_MODEL = "haiku";
const ESTIMATE_TIMEOUT_MS = 90_000;
const CALIBRATION_RUNS = 12;
const ESTIMATE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    tokens: {
      type: "integer",
      minimum: MIN_TOKENS,
      maximum: MAX_TOKENS,
    },
  },
  required: ["tokens"],
  additionalProperties: false,
});

export interface EstimateTask {
  title: string;
  prompt: string;
  model: string;
  provider: Provider;
}
/** One finished run, as calibration for the estimate. */
export interface EstimateRun {
  title: string;
  promptLength: number;
  model: string;
  durationMs: number;
  tokens: WeightedTokens | null;
  /** What the run was estimated to consume before it started; null when the estimate was not recorded. */
  estimatedTokens: number | null;
}
export interface EstimateOptions {
  cwd: string | undefined;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}
export type SpawnEstimator = (
  command: string,
  args: string[],
  options: EstimateOptions,
) => ProviderProcess;
export type TokensEstimator = (
  task: EstimateTask,
  history: EstimateRun[],
) => Promise<number>;

const MS_PER_MINUTE = 60_000;
const THOUSAND = 1000;
/** Measured runs the correction reads, newest first. */
const CORRECTION_RUNS = 30;
/** Below this many measured runs a median says more about one outlier than about the estimator. */
const MIN_CORRECTION_RUNS = 5;
const MIN_CORRECTION = 0.25;
const MAX_CORRECTION = 4;
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const measuredTotal = (tokens: WeightedTokens) =>
  MODEL_FAMILIES.reduce((sum, family) => sum + tokens[family], 0);
const ratios = (runs: EstimateRun[]): number[] =>
  runs.flatMap((run) => {
    if (run.tokens === null || !run.estimatedTokens) return [];
    const measured = measuredTotal(run.tokens);
    return measured > 0 ? [measured / run.estimatedTokens] : [];
  });

/**
 * How far past runs of `model` landed from their estimate, as a factor to scale the next
 * estimate by. Runs of the same model family lead; the whole history stands in until that
 * family has enough of its own, and an uncalibrated estimator is left alone at 1.
 */
export function estimateCorrection(
  history: EstimateRun[],
  model: string,
): number {
  const recent = history.slice(0, CORRECTION_RUNS);
  const family = modelFamily(model);
  const own = ratios(recent.filter((run) => modelFamily(run.model) === family));
  const sample = own.length >= MIN_CORRECTION_RUNS ? own : ratios(recent);
  if (sample.length < MIN_CORRECTION_RUNS) return 1;
  return clamp(median(sample), MIN_CORRECTION, MAX_CORRECTION);
}
function tokenMix(tokens: WeightedTokens | null) {
  if (tokens === null) return "unknown";
  const parts = MODEL_FAMILIES.filter((family) => tokens[family] > 0).map(
    (family) => `${Math.round(tokens[family] / THOUSAND)}k ${family}`,
  );
  return `${parts.join(" + ")} tokens`;
}
const calibrationLine = (run: EstimateRun) =>
  `${run.title} | ${run.promptLength} prompt chars | ${run.model} | ${Math.round(run.durationMs / MS_PER_MINUTE)} min | ${tokenMix(run.tokens)}`;

function estimatorPrompt(task: EstimateTask, history: EstimateRun[]): string {
  const calibration = history
    .slice(0, CALIBRATION_RUNS)
    .map(calibrationLine)
    .join("\n");
  return `Estimate how many tokens one unattended coding task will consume in total, thinking, context re-reads and every subagent included.

Tokens are weighted: output tokens count once, and uncached input, cache writes and cache reads count at their price relative to output. A run's total is usually four to six times its output tokens.

The task runs as \`claude -p --dangerously-skip-permissions\` on the ${task.provider} provider with model ${task.model}.

Rules of thumb, from runs on this machine:
- One-file fix or wording change: 25000-75000.
- Small feature with tests: 75000-200000.
- Multi-file feature, migration, or a visual QA pass driving a browser: 250000-600000.
- A project built through a planning workflow, or research plus a large refactor: 700000-1500000.

${calibration ? `Prior runs on this machine, as calibration:\n${calibration}` : "No prior runs are available as calibration."}

Task title: ${task.title}

Task prompt:
${task.prompt}

Reply with only the JSON object.`;
}

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

function structuredOutput(stdout: string): unknown {
  const payload = JSON.parse(stdout) as {
    structured_output?: unknown;
    result?: unknown;
  };
  return (
    payload.structured_output ??
    (typeof payload.result === "string"
      ? (JSON.parse(payload.result) as unknown)
      : payload.result)
  );
}

function readEstimate(output: unknown): number {
  const tokens = (output as { tokens?: unknown } | null)?.tokens;
  if (
    typeof tokens !== "number" ||
    !Number.isInteger(tokens) ||
    tokens < MIN_TOKENS ||
    tokens > MAX_TOKENS
  )
    throw new Error(
      `the model returned ${JSON.stringify(tokens)} instead of an integer from ${MIN_TOKENS} to ${MAX_TOKENS}`,
    );
  return tokens;
}

/** One tool-less, sessionless Haiku answer shaped by `schema`. */
export async function askEstimator(
  prompt: string,
  schema: string,
  spawnProcess: SpawnEstimator = spawn,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ESTIMATE_TIMEOUT_MS);
  timer.unref();
  const child = spawnProcess(
    "claude",
    [
      "-p",
      prompt,
      "--model",
      ESTIMATOR_MODEL,
      "--output-format",
      "json",
      "--no-session-persistence",
      "--tools",
      "",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--json-schema",
      schema,
    ],
    {
      cwd: process.env.HOME,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MAX_THINKING_TOKENS: "0" },
      signal: controller.signal,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0)
      throw new Error(lastLine(stderr) ?? `claude exited with code ${code}`);
    return structuredOutput(stdout);
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(`no answer within ${ESTIMATE_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function estimateTokens(
  task: EstimateTask,
  history: EstimateRun[],
  spawnProcess: SpawnEstimator = spawn,
): Promise<number> {
  try {
    const corrected =
      readEstimate(
        await askEstimator(
          estimatorPrompt(task, history),
          ESTIMATE_SCHEMA,
          spawnProcess,
        ),
      ) * estimateCorrection(history, task.model);
    return clamp(Math.round(corrected), MIN_TOKENS, MAX_TOKENS);
  } catch (error) {
    throw new Error(`Could not estimate tokens: ${(error as Error).message}`);
  }
}

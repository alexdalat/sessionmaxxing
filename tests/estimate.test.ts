import { expect, it, vi } from "vitest";
import {
  ESTIMATOR_MODEL,
  type EstimateRun,
  estimateCorrection,
  estimateOutputTokens,
} from "../server/estimate.js";
import { MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS } from "../shared/types.js";
import { fakeChild } from "./helpers";

const TASK = {
  title: "Rename the parser",
  prompt: "Rename parseEvent and update every caller, then run pnpm test.",
  model: "opus",
  provider: "claude" as const,
};
const HISTORY: EstimateRun[] = [
  {
    title: "Add the runs route",
    promptLength: 420,
    model: "opus",
    durationMs: 20 * 60_000,
    outputTokens: { fable: 87_400, opus: 12_100, sonnet: 0, haiku: 0 },
    estimatedOutputTokens: 100_000,
  },
  {
    title: "Fix the heatmap",
    promptLength: 120,
    model: "sonnet",
    durationMs: 4 * 60_000,
    outputTokens: null,
    estimatedOutputTokens: 30_000,
  },
];

function fakeEstimator(code: number, stdout: string, stderr = "") {
  const child = fakeChild();
  return vi.fn(() => {
    setImmediate(() => {
      let ended = 0;
      const close = () => {
        if (++ended === 2) child.emit("close", code);
      };
      child.stdout.on("end", close);
      child.stderr.on("end", close);
      child.stdout.end(stdout);
      child.stderr.end(stderr);
    });
    return child;
  });
}
const argumentAfter = (args: string[], flag: string) =>
  args[args.indexOf(flag) + 1];

it("returns the output tokens the estimator model reports for the task", async () => {
  const spawnProcess = fakeEstimator(
    0,
    JSON.stringify({
      result: '{"outputTokens":14000}',
      structured_output: { outputTokens: 14000 },
    }),
  );
  await expect(estimateOutputTokens(TASK, HISTORY, spawnProcess)).resolves.toBe(
    14000,
  );
  const [command, args] = spawnProcess.mock.calls[0] as unknown as [
    string,
    string[],
  ];
  expect(command).toBe("claude");
  expect(argumentAfter(args, "--model")).toBe(ESTIMATOR_MODEL);
  expect(JSON.parse(argumentAfter(args, "--json-schema"))).toMatchObject({
    properties: {
      outputTokens: {
        type: "integer",
        minimum: MIN_OUTPUT_TOKENS,
        maximum: MAX_OUTPUT_TOKENS,
      },
    },
    required: ["outputTokens"],
  });
  const prompt = argumentAfter(args, "-p");
  expect(prompt).toContain(TASK.prompt);
  expect(prompt).toContain("Add the runs route");
  expect(prompt).toContain("87k fable + 12k opus output tokens");
  expect(prompt).toContain(
    "Fix the heatmap | 120 prompt chars | sonnet | 4 min | unknown",
  );
});

it("reads the estimate from the result text when no structured output is returned", async () => {
  const spawnProcess = fakeEstimator(
    0,
    JSON.stringify({ result: '{"outputTokens":45000}' }),
  );
  await expect(estimateOutputTokens(TASK, [], spawnProcess)).resolves.toBe(
    45000,
  );
});

it("fails with the last stderr line when the estimator exits non-zero", async () => {
  const spawnProcess = fakeEstimator(
    1,
    "",
    "warming up\nCredit balance is too low\n",
  );
  await expect(estimateOutputTokens(TASK, [], spawnProcess)).rejects.toThrow(
    "Could not estimate output tokens: Credit balance is too low",
  );
});

it("fails instead of defaulting when the estimator returns tokens out of range", async () => {
  const spawnProcess = fakeEstimator(
    0,
    JSON.stringify({ structured_output: { outputTokens: 9_000_000 } }),
  );
  await expect(estimateOutputTokens(TASK, [], spawnProcess)).rejects.toThrow(
    /^Could not estimate output tokens: the model returned 9000000/,
  );
});

it("fails when the estimator output is not JSON", async () => {
  const spawnProcess = fakeEstimator(0, "claude: command not understood");
  await expect(estimateOutputTokens(TASK, [], spawnProcess)).rejects.toThrow(
    /^Could not estimate output tokens: /,
  );
});

const measuredRun = (
  model: string,
  estimatedOutputTokens: number,
  measured: number,
): EstimateRun => ({
  title: `${model} run`,
  promptLength: 300,
  model,
  durationMs: 10 * 60_000,
  outputTokens: { fable: 0, opus: 0, sonnet: 0, haiku: 0, [model]: measured },
  estimatedOutputTokens,
});
const runs = (
  count: number,
  model: string,
  estimate: number,
  measured: number,
) =>
  Array.from({ length: count }, () => measuredRun(model, estimate, measured));

it("leaves the estimate alone until enough runs have been measured against one", () => {
  expect(estimateCorrection(runs(4, "opus", 100_000, 25_000), "opus")).toBe(1);
});

it("corrects by the median of what past runs actually produced", () => {
  expect(
    estimateCorrection(
      [
        ...runs(3, "opus", 100_000, 50_000),
        ...runs(2, "opus", 200_000, 100_000),
      ],
      "opus",
    ),
  ).toBe(0.5);
});

it("ignores runs with no measured tokens and no recorded estimate", () => {
  const unusable: EstimateRun[] = [
    { ...measuredRun("opus", 100_000, 0), outputTokens: null },
    { ...measuredRun("opus", 0, 900_000), estimatedOutputTokens: null },
    measuredRun("opus", 100_000, 0),
  ];
  expect(
    estimateCorrection(
      [...unusable, ...runs(4, "opus", 100_000, 50_000)],
      "opus",
    ),
  ).toBe(1);
});

it("prices a model against its own family once that family has enough runs", () => {
  const history = [
    ...runs(5, "fable", 100_000, 90_000),
    ...runs(6, "opus", 100_000, 25_000),
  ];
  expect(estimateCorrection(history, "claude-fable-5-1")).toBe(0.9);
  expect(estimateCorrection(history, "claude-opus-5")).toBe(0.25);
});

it("falls back to every measured run for a family with too few of its own", () => {
  const history = [
    ...runs(2, "fable", 100_000, 90_000),
    ...runs(5, "opus", 100_000, 50_000),
  ];
  expect(estimateCorrection(history, "fable")).toBe(
    estimateCorrection(history, "opus"),
  );
});

it("keeps the correction inside its bounds when history is extreme", () => {
  expect(estimateCorrection(runs(5, "opus", 10_000, 900_000), "opus")).toBe(4);
  expect(estimateCorrection(runs(5, "opus", 900_000, 10_000), "opus")).toBe(
    0.25,
  );
});

it("scales the estimator's answer by the correction its history earns", async () => {
  const spawnProcess = fakeEstimator(
    0,
    JSON.stringify({ structured_output: { outputTokens: 200_000 } }),
  );
  await expect(
    estimateOutputTokens(TASK, runs(5, "opus", 100_000, 50_000), spawnProcess),
  ).resolves.toBe(100_000);
});

it("never corrects an estimate below the smallest one a task may hold", async () => {
  const spawnProcess = fakeEstimator(
    0,
    JSON.stringify({ structured_output: { outputTokens: MIN_OUTPUT_TOKENS } }),
  );
  await expect(
    estimateOutputTokens(TASK, runs(5, "opus", 100_000, 25_000), spawnProcess),
  ).resolves.toBe(MIN_OUTPUT_TOKENS);
});

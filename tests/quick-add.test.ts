import { expect, it } from "vitest";
import { quickTask } from "../app/lib/quickTask";
import { AUTO_OUTPUT_TOKENS, DEFAULT_MAX_TURNS } from "../shared/types.js";

const target = { workdir: "/home/user/workspace/dashboard", model: "sonnet" };

it("titles a quick-add task from the first line with its whitespace collapsed", () => {
  const task = quickTask(
    "  Fix the   weekly pace   legend\nit overlaps the axis on mobile  ",
    target,
  );
  expect(task?.title).toBe("Fix the weekly pace legend");
  expect(task?.prompt).toBe(
    "Fix the   weekly pace   legend\nit overlaps the axis on mobile",
  );
});

it("strips trailing punctuation from the derived title", () => {
  expect(quickTask("Update the README.", target)?.title).toBe(
    "Update the README",
  );
  expect(quickTask("Why does the chart flicker?", target)?.title).toBe(
    "Why does the chart flicker",
  );
});

it("clips a long title at a word boundary and ends it with an ellipsis", () => {
  const task = quickTask("refactor ".repeat(20), target);
  expect(task?.title.length).toBeLessThanOrEqual(120);
  expect(task?.title.startsWith("refactor refactor")).toBe(true);
  expect(task?.title.endsWith("…")).toBe(true);
  expect(task?.title).not.toMatch(/\s…$/);
});

it("queues a claude task with the chosen directory, model and estimated tokens", () => {
  expect(quickTask("Ship the queue card", target)).toEqual({
    title: "Ship the queue card",
    prompt: "Ship the queue card",
    workdir: "/home/user/workspace/dashboard",
    provider: "claude",
    model: "sonnet",
    priority: 0,
    earliestStart: null,
    preferredWindowStart: null,
    maxTurns: DEFAULT_MAX_TURNS,
    outputTokens: AUTO_OUTPUT_TOKENS,
    dependsOn: [],
  });
});

it("returns no quick-add task for blank text", () => {
  expect(quickTask("   \n  ", target)).toBeNull();
});

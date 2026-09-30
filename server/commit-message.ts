import { spawn } from "node:child_process";
import {
  COMMIT_SUBJECT_MAX,
  CONVENTIONAL_SUBJECT,
  type Run,
} from "../shared/types.js";
import { askEstimator, type SpawnEstimator } from "./estimate.js";

export type CommitRun = Pick<Run, "title" | "summary"> & {
  files: NonNullable<Run["changes"]>["files"];
};
export type CommitMessageSuggester = (run: CommitRun) => Promise<string>;

/** The summary's tail carries the outcome; the rest only costs input tokens. */
const SUMMARY_CHARS = 4000;
const LISTED_FILES = 60;
const SUGGESTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    message: { type: "string", maxLength: COMMIT_SUBJECT_MAX },
  },
  required: ["message"],
  additionalProperties: false,
});

function suggestionPrompt(run: CommitRun): string {
  const files = run.files
    .slice(0, LISTED_FILES)
    .map((file) => `${file.path} +${file.added} -${file.removed}`);
  if (run.files.length > LISTED_FILES)
    files.push(`… and ${run.files.length - LISTED_FILES} more files`);
  return `Write the git commit subject for the work below.

Rules:
- Conventional Commits: "<type>: <subject>" or "<type>(<scope>): <subject>", type one of feat, fix, refactor, perf, test, docs, chore, style, build, ci.
- One line, at most ${COMMIT_SUBJECT_MAX} characters, imperative mood, lowercase after the colon, no trailing period.
- Name the change a reader of git log needs, not the process that produced it.

Task title: ${run.title}

Changed files:
${files.join("\n")}

Final report from the run:
${(run.summary ?? "(none)").slice(-SUMMARY_CHARS)}`;
}

export async function suggestCommitMessage(
  run: CommitRun,
  spawnProcess: SpawnEstimator = spawn,
): Promise<string> {
  try {
    const output = await askEstimator(
      suggestionPrompt(run),
      SUGGESTION_SCHEMA,
      spawnProcess,
    );
    const message = (output as { message?: unknown } | null)?.message;
    if (typeof message !== "string" || !CONVENTIONAL_SUBJECT.test(message))
      throw new Error(
        `the model returned ${JSON.stringify(message)} instead of a conventional commit subject`,
      );
    return message;
  } catch (error) {
    throw new Error(
      `Could not suggest a commit message: ${(error as Error).message}`,
    );
  }
}

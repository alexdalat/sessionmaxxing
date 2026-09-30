import { expect, it } from "vitest";
import {
  type CommitRun,
  suggestCommitMessage,
} from "../server/commit-message.js";
import { COMMIT_SUBJECT_MAX } from "../shared/types.js";
import { fakeEstimator } from "./helpers";

const RUN: CommitRun = {
  title: "Retry failed deploys",
  summary:
    "Added a retry button to failed deploy badges and covered it with tests.",
  files: [
    { path: "server/deploy.ts", added: 24, removed: 3 },
    { path: "tests/deploy.test.ts", added: 40, removed: 0 },
  ],
};
const answer = (message: unknown) =>
  JSON.stringify({ result: "", structured_output: { message } });
const argumentAfter = (args: string[], flag: string) =>
  args[args.indexOf(flag) + 1];

it("returns the conventional subject the model suggests", async () => {
  const spawnProcess = fakeEstimator(0, answer("feat: retry failed deploys"));
  await expect(suggestCommitMessage(RUN, spawnProcess)).resolves.toBe(
    "feat: retry failed deploys",
  );
});

it("asks with the run title, summary and changed files under a length-capped schema", async () => {
  const spawnProcess = fakeEstimator(0, answer("fix(deploy): retry once"));
  await suggestCommitMessage(RUN, spawnProcess);
  const [, args] = spawnProcess.mock.calls[0] as unknown as [string, string[]];
  const prompt = argumentAfter(args, "-p");
  expect(prompt).toContain("Task title: Retry failed deploys");
  expect(prompt).toContain("server/deploy.ts +24 -3");
  expect(prompt).toContain("tests/deploy.test.ts +40 -0");
  expect(prompt).toContain(RUN.summary);
  expect(JSON.parse(argumentAfter(args, "--json-schema"))).toMatchObject({
    properties: { message: { type: "string", maxLength: COMMIT_SUBJECT_MAX } },
    required: ["message"],
  });
});

it("rejects a suggestion without a conventional type", async () => {
  const spawnProcess = fakeEstimator(0, answer("Retry failed deploys"));
  await expect(suggestCommitMessage(RUN, spawnProcess)).rejects.toThrow(
    'Could not suggest a commit message: the model returned "Retry failed deploys" instead of a conventional commit subject',
  );
});

it("rejects a suggestion that spans two lines", async () => {
  const spawnProcess = fakeEstimator(0, answer("feat: retry\nfailed deploys"));
  await expect(suggestCommitMessage(RUN, spawnProcess)).rejects.toThrow(
    /^Could not suggest a commit message: the model returned/,
  );
});

it("reports the CLI's last stderr line when claude fails", async () => {
  const spawnProcess = fakeEstimator(
    1,
    "",
    "warming up\nCredit balance is too low\n",
  );
  await expect(suggestCommitMessage(RUN, spawnProcess)).rejects.toThrow(
    "Could not suggest a commit message: Credit balance is too low",
  );
});

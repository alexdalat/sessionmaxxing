import { describe, expect, it } from "vitest";
import { parseTranscript } from "../server/parser.js";

it("recognizes timestamped Claude assistant responses without token counters", () => {
  const result = parseTranscript(
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-06T12:00:10Z",
      message: { role: "assistant", content: "PRIVATE" },
    }),
  );
  expect(result.events).toEqual([
    {
      timestamp: "2026-09-06T12:00:10.000Z",
      project: "Unknown project",
      model: "Unknown model",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  ]);
  expect(result.warnings).toBe(0);
});

describe("transcript privacy boundary", () => {
  it("extracts only approved assistant metrics and counts malformed JSONL lines", () => {
    const secret = "PRIVATE PROMPT sk-secret OAuth pasted contents";
    const input = [
      JSON.stringify({ type: "user", message: { content: secret } }),
      "{malformed",
      JSON.stringify({
        type: "assistant",
        uuid: "8a23ad17-7659-48e0-9fcd-6ac18fed91a9",
        cwd: "/home/user/workspace/demo",
        timestamp: "2026-09-05T15:12:19Z",
        message: {
          id: "msg_1",
          model: "claude-opus-4-6",
          content: secret,
          usage: {
            input_tokens: 8,
            output_tokens: 12,
            cache_read_input_tokens: 34,
            cache_creation_input_tokens: 5,
          },
        },
      }),
      "",
    ].join("\n");
    const result = parseTranscript(input);
    expect(result).toEqual({
      events: [
        {
          timestamp: "2026-09-05T15:12:19.000Z",
          project: "demo",
          model: "claude-opus-4-6",
          inputTokens: 8,
          outputTokens: 12,
          cacheReadTokens: 34,
          cacheCreationTokens: 5,
        },
      ],
      warnings: 1,
      lines: 3,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|sk-secret|OAuth|uuid|msg_1|content|8a23ad17/,
    );
  });
});

it("reads only immediate project transcripts, deduplicates streamed messages, and reports history health", async () => {
  const { mkdir, mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { readHistory } = await import("../server/history.js");
  await mkdir("tests/.tmp", { recursive: true });
  const root = await mkdtemp("tests/.tmp/history-");
  try {
    await mkdir(`${root}/projects/project/nested`, { recursive: true });
    const response = {
      type: "assistant",
      timestamp: "2026-09-05T15:12:19Z",
      cwd: "/home/user/demo",
      message: {
        id: "private-message-id",
        model: "claude-opus-4-6",
        content: "PRIVATE TEXT",
        usage: { output_tokens: 2 },
      },
    };
    await writeFile(
      `${root}/projects/project/a.jsonl`,
      [
        JSON.stringify(response),
        JSON.stringify({
          ...response,
          message: { ...response.message, usage: { output_tokens: 9 } },
        }),
        "{bad",
      ].join("\n"),
    );
    await writeFile(`${root}/projects/project/nested/ignore.jsonl`, "{bad");
    await writeFile(
      `${root}/history.jsonl`,
      `${JSON.stringify({
        display: "PRIVATE HISTORY",
        timestamp: 1,
        pastedContents: "SECRET",
      })}\n{bad`,
    );
    const result = await readHistory(root);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].outputTokens).toBe(9);
    expect(result.health).toEqual({
      files: 2,
      lines: 5,
      warnings: 2,
      historyEntries: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|SECRET|private-message-id/,
    );
    expect((await readHistory(`${root}/missing`)).events).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("redacts entire credential-shaped project directory names", () => {
  for (const project of [
    "password=hunter2",
    "secret-value",
    "api_key.production",
    "oauth-token-cache",
    "authorization_bearer",
  ]) {
    const input = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-05T12:00:00Z",
      cwd: `/home/user/${project}`,
      message: { model: "claude-opus-5", usage: { output_tokens: 1 } },
    });
    const result = parseTranscript(input);
    expect(result.events[0].project).toBe("[redacted project]");
    expect(JSON.stringify(result)).not.toContain(project);
  }
});
it("rejects identifiers and credential-shaped strings hidden inside model metadata", () => {
  const uuid = "8a23ad17-7659-48e0-9fcd-6ac18fed91a9";
  const events = [`claude-${uuid}`, "claude-sk-secret"]
    .map((model) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-05T12:00:00Z",
        cwd: `/home/user/${uuid}`,
        message: { model, usage: { output_tokens: 1 } },
      }),
    )
    .join("\n");
  const result = parseTranscript(events);
  expect(result.events.map((event) => event.model)).toEqual([
    "Unknown model",
    "Unknown model",
  ]);
  expect(JSON.stringify(result)).not.toMatch(/8a23ad17|sk-secret/);
});
it("recognizes Fable model identifiers so Fable-specific usage can be estimated", () => {
  const events = ["claude-fable-5-1", "claude-fable-5"]
    .map((model) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-06T12:00:00Z",
        message: { model, usage: { output_tokens: 1 } },
      }),
    )
    .join("\n");
  expect(parseTranscript(events).events.map((event) => event.model)).toEqual([
    "claude-fable-5-1",
    "claude-fable-5",
  ]);
});

describe("incremental history reader", () => {
  const MODEL = "claude-opus-4-6";
  const assistantLine = (
    id: string,
    project: string,
    timestamp: string,
    outputTokens: number,
  ) =>
    `${JSON.stringify({
      type: "assistant",
      timestamp,
      cwd: `/home/user/${project}`,
      message: {
        id,
        model: MODEL,
        content: "PRIVATE TEXT",
        usage: { output_tokens: outputTokens },
      },
    })}\n`;
  const expectedEvent = (
    project: string,
    timestamp: string,
    outputTokens: number,
  ) => ({
    timestamp,
    project,
    model: MODEL,
    inputTokens: 0,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  async function fixture() {
    const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
    await mkdir("tests/.tmp", { recursive: true });
    const root = await mkdtemp("tests/.tmp/reader-");
    await mkdir(`${root}/projects/alpha`, { recursive: true });
    await mkdir(`${root}/projects/beta`, { recursive: true });
    await writeFile(
      `${root}/projects/alpha/a.jsonl`,
      assistantLine("m1", "alpha", "2026-09-05T15:00:00Z", 2),
    );
    await writeFile(
      `${root}/projects/beta/b.jsonl`,
      assistantLine("m2", "beta", "2026-09-05T16:00:00Z", 3),
    );
    await writeFile(
      `${root}/history.jsonl`,
      `${JSON.stringify({ display: "PRIVATE HISTORY", timestamp: 1 })}\n`,
    );
    return root;
  }
  async function withFixture(run: (root: string) => Promise<void>) {
    const { rm } = await import("node:fs/promises");
    const root = await fixture();
    try {
      await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("returns the same data on a second read when no file changed", async () => {
    const { createHistoryReader } = await import("../server/history.js");
    await withFixture(async (root) => {
      const read = createHistoryReader(root);
      const first = await read();
      expect(first.events).toEqual([
        expectedEvent("alpha", "2026-09-05T15:00:00.000Z", 2),
        expectedEvent("beta", "2026-09-05T16:00:00.000Z", 3),
      ]);
      expect(first.health).toEqual({
        files: 3,
        lines: 3,
        warnings: 0,
        historyEntries: 1,
      });
      expect(await read()).toEqual(first);
    });
  });

  it("picks up a line appended to one transcript and keeps events from untouched files", async () => {
    const { appendFile } = await import("node:fs/promises");
    const { createHistoryReader } = await import("../server/history.js");
    await withFixture(async (root) => {
      const read = createHistoryReader(root);
      await read();
      await appendFile(
        `${root}/projects/alpha/a.jsonl`,
        assistantLine("m3", "alpha", "2026-09-05T15:30:00Z", 5),
      );
      const result = await read();
      expect(result.events).toEqual([
        expectedEvent("alpha", "2026-09-05T15:00:00.000Z", 2),
        expectedEvent("alpha", "2026-09-05T15:30:00.000Z", 5),
        expectedEvent("beta", "2026-09-05T16:00:00.000Z", 3),
      ]);
      expect(result.health).toEqual({
        files: 3,
        lines: 4,
        warnings: 0,
        historyEntries: 1,
      });
    });
  });

  it("drops the events of a transcript that was deleted between reads", async () => {
    const { rm } = await import("node:fs/promises");
    const { createHistoryReader } = await import("../server/history.js");
    await withFixture(async (root) => {
      const read = createHistoryReader(root);
      await read();
      await rm(`${root}/projects/beta/b.jsonl`);
      const result = await read();
      expect(result.events).toEqual([
        expectedEvent("alpha", "2026-09-05T15:00:00.000Z", 2),
      ]);
      expect(result.health).toEqual({
        files: 2,
        lines: 2,
        warnings: 0,
        historyEntries: 1,
      });
    });
  });

  it("dedups a message id shared by two files when only one of them was reparsed", async () => {
    const { appendFile } = await import("node:fs/promises");
    const { createHistoryReader } = await import("../server/history.js");
    await withFixture(async (root) => {
      const read = createHistoryReader(root);
      await read();
      await appendFile(
        `${root}/projects/beta/b.jsonl`,
        assistantLine("m1", "beta", "2026-09-05T15:00:00Z", 7),
      );
      const result = await read();
      expect(result.events).toEqual([
        expectedEvent("beta", "2026-09-05T15:00:00.000Z", 7),
        expectedEvent("beta", "2026-09-05T16:00:00.000Z", 3),
      ]);
      expect(result.health.files).toBe(3);
    });
  });
});

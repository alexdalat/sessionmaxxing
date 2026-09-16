import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { createHistoryReader, readSessionTokens } from "../server/history.js";
import { temporary } from "./helpers";

const DISPATCHED_SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const assistantLine = (record: {
  messageId: string;
  timestamp: string;
  sessionId?: string;
  entrypoint?: string;
  outputTokens?: number;
  model?: string;
}) =>
  `${JSON.stringify({
    type: "assistant",
    timestamp: record.timestamp,
    cwd: "/home/user/demo",
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.entrypoint === undefined
      ? {}
      : { entrypoint: record.entrypoint }),
    message: {
      id: record.messageId,
      model: record.model ?? "claude-opus-4-6",
      content: "PRIVATE TEXT",
      usage: { output_tokens: record.outputTokens ?? 1 },
    },
  })}\n`;

async function transcript(root: string, relative: string, lines: string[]) {
  const path = join(root, "projects", relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join(""));
}

async function withRoot(run: (root: string) => Promise<void>) {
  const temp = await temporary();
  try {
    await run(temp.path);
  } finally {
    await temp.cleanup();
  }
}

it("attributes a dispatched session without touching an interactive session in the same minutes", async () => {
  await withRoot(async (root) => {
    await transcript(root, `demo/${DISPATCHED_SESSION}.jsonl`, [
      assistantLine({
        messageId: "d1",
        timestamp: "2026-09-06T15:00:00Z",
        sessionId: DISPATCHED_SESSION,
        entrypoint: "sdk-cli",
      }),
      assistantLine({
        messageId: "d2",
        timestamp: "2026-09-06T15:00:30Z",
        sessionId: DISPATCHED_SESSION,
        entrypoint: "sdk-cli",
      }),
    ]);
    await transcript(root, `demo/${OTHER_SESSION}.jsonl`, [
      assistantLine({
        messageId: "l1",
        timestamp: "2026-09-06T15:00:10Z",
        sessionId: OTHER_SESSION,
        entrypoint: "cli",
      }),
    ]);
    const read = createHistoryReader(root, () => new Set([DISPATCHED_SESSION]));
    const result = await read();
    expect(
      result.events.map((event) => [event.timestamp, event.source]),
    ).toEqual([
      ["2026-09-06T15:00:00.000Z", "dispatched"],
      ["2026-09-06T15:00:10.000Z", "local"],
      ["2026-09-06T15:00:30.000Z", "dispatched"],
    ]);
  });
});

it("leaves a headless session this dashboard did not launch unattributed", async () => {
  await withRoot(async (root) => {
    await transcript(root, `demo/${OTHER_SESSION}.jsonl`, [
      assistantLine({
        messageId: "h1",
        timestamp: "2026-09-06T15:00:00Z",
        sessionId: OTHER_SESSION,
        entrypoint: "sdk-cli",
      }),
    ]);
    const read = createHistoryReader(root, () => new Set([DISPATCHED_SESSION]));
    expect((await read()).events.map((event) => event.source)).toEqual([
      "unknown",
    ]);
  });
});

it("counts a message id shared by a session transcript and its subagent transcript once", async () => {
  await withRoot(async (root) => {
    const shared = assistantLine({
      messageId: "shared",
      timestamp: "2026-09-06T15:00:00Z",
      sessionId: OTHER_SESSION,
      entrypoint: "cli",
      outputTokens: 4,
    });
    await transcript(root, `demo/${OTHER_SESSION}.jsonl`, [shared]);
    await transcript(root, `demo/${OTHER_SESSION}/subagents/agent-1.jsonl`, [
      shared,
    ]);
    const result = await createHistoryReader(root)();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].outputTokens).toBe(4);
    expect(result.health.files).toBe(2);
  });
});

it("reads subagent transcripts and attributes them through their parent session", async () => {
  await withRoot(async (root) => {
    await transcript(
      root,
      `demo/${DISPATCHED_SESSION}/subagents/agent-1.jsonl`,
      [
        assistantLine({
          messageId: "sub1",
          timestamp: "2026-09-06T16:00:00Z",
          sessionId: DISPATCHED_SESSION,
          entrypoint: "sdk-cli",
          outputTokens: 7,
        }),
      ],
    );
    const read = createHistoryReader(root, () => new Set([DISPATCHED_SESSION]));
    const result = await read();
    expect(result.events).toEqual([
      {
        timestamp: "2026-09-06T16:00:00.000Z",
        project: "demo",
        model: "claude-opus-4-6",
        source: "dispatched",
        inputTokens: 0,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
  });
});

it("attributes a session added to the dispatched set after an earlier read of unchanged files", async () => {
  await withRoot(async (root) => {
    await transcript(root, `demo/${DISPATCHED_SESSION}.jsonl`, [
      assistantLine({
        messageId: "late",
        timestamp: "2026-09-06T15:00:00Z",
        sessionId: DISPATCHED_SESSION,
        entrypoint: "sdk-cli",
      }),
    ]);
    let dispatched: ReadonlySet<string> = new Set();
    const read = createHistoryReader(root, () => dispatched);
    expect((await read()).events.map((event) => event.source)).toEqual([
      "unknown",
    ]);
    dispatched = new Set([DISPATCHED_SESSION]);
    expect((await read()).events.map((event) => event.source)).toEqual([
      "dispatched",
    ]);
  });
});

it("never attributes a record that carries no session id to a dispatched run", async () => {
  await withRoot(async (root) => {
    await transcript(root, "demo/legacy.jsonl", [
      assistantLine({
        messageId: "n1",
        timestamp: "2026-09-06T15:00:00Z",
        entrypoint: "sdk-cli",
      }),
      assistantLine({
        messageId: "n2",
        timestamp: "2026-09-06T15:01:00Z",
        entrypoint: "cli",
      }),
    ]);
    const read = createHistoryReader(root, () => new Set([DISPATCHED_SESSION]));
    expect((await read()).events.map((event) => event.source)).toEqual([
      "unknown",
      "local",
    ]);
  });
});

it("sums the output tokens of a session, its subagents, and the last record of each message", async () => {
  await withRoot(async (root) => {
    await transcript(root, `demo/${DISPATCHED_SESSION}.jsonl`, [
      assistantLine({
        messageId: "m1",
        timestamp: "2026-09-06T15:00:00Z",
        sessionId: DISPATCHED_SESSION,
        outputTokens: 100,
      }),
      assistantLine({
        messageId: "m2",
        timestamp: "2026-09-06T15:01:00Z",
        sessionId: DISPATCHED_SESSION,
        model: "claude-fable-5-1",
        outputTokens: 200,
      }),
      assistantLine({
        messageId: "m1",
        timestamp: "2026-09-06T15:02:00Z",
        sessionId: DISPATCHED_SESSION,
        outputTokens: 150,
      }),
      assistantLine({
        messageId: "m3",
        timestamp: "2026-09-06T15:03:00Z",
        sessionId: DISPATCHED_SESSION,
        model: "gpt-6-astra",
        outputTokens: 400,
      }),
    ]);
    await transcript(
      root,
      `demo/${DISPATCHED_SESSION}/subagents/worker.jsonl`,
      [
        assistantLine({
          messageId: "s1",
          timestamp: "2026-09-06T15:04:00Z",
          sessionId: DISPATCHED_SESSION,
          model: "claude-haiku-4-5-20251001",
          outputTokens: 50,
        }),
      ],
    );
    await transcript(root, `demo/${OTHER_SESSION}.jsonl`, [
      assistantLine({
        messageId: "o1",
        timestamp: "2026-09-06T15:05:00Z",
        sessionId: OTHER_SESSION,
        outputTokens: 900,
      }),
    ]);
    expect(await readSessionTokens(root, DISPATCHED_SESSION)).toEqual({
      fable: 200,
      opus: 150,
      sonnet: 0,
      haiku: 50,
    });
  });
});

it("reports no tokens for a session with no transcript", async () => {
  await withRoot(async (root) => {
    await transcript(root, `demo/${OTHER_SESSION}.jsonl`, [
      assistantLine({
        messageId: "o1",
        timestamp: "2026-09-06T15:05:00Z",
        sessionId: OTHER_SESSION,
        outputTokens: 900,
      }),
    ]);
    expect(await readSessionTokens(root, DISPATCHED_SESSION)).toEqual({
      fable: 0,
      opus: 0,
      sonnet: 0,
      haiku: 0,
    });
  });
});

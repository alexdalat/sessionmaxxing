import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  officialUsageFetcher,
  parseUsageResponse,
  USAGE_ENDPOINT,
} from "../server/claude-usage.js";
import { UsageHistoryStore } from "../server/usage-history.js";
import { UsageMonitor } from "../server/usage-monitor.js";
import { temporary, usageSnapshot } from "./helpers";

const now = new Date("2026-09-06T12:00:00Z");
const fixture = async () =>
  JSON.parse(await readFile("tests/fixtures/oauth-usage.json", "utf8"));
const credentials = (patch: object = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-SECRET-TOKEN",
      refreshToken: "sk-ant-ort01-SECRET-REFRESH",
      expiresAt: Date.parse("2026-09-06T18:00:00Z"),
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      ...patch,
    },
  });
afterEach(() => vi.restoreAllMocks());

it("parses the five-hour, weekly and Fable windows from the OAuth usage payload", async () => {
  expect(parseUsageResponse(await fixture(), now)).toEqual(usageSnapshot());
});

it("reports a missing Fable window as null and rejects payloads without the core windows", async () => {
  const body = await fixture();
  body.limits = [];
  expect(parseUsageResponse(body, now).fable).toBeNull();
  const { five_hour: _five, ...withoutSession } = body;
  expect(() => parseUsageResponse(withoutSession, now)).toThrow(/five_hour/);
  expect(() => parseUsageResponse("nope", now)).toThrow(/JSON object/);
  expect(
    parseUsageResponse({ ...body, five_hour: { utilization: 0 } }, now).session,
  ).toEqual({ percent: 0, resetsAt: null });
});

it("sends the Claude Code OAuth token with the required beta and user-agent headers", async () => {
  const temp = await temporary();
  try {
    await writeFile(`${temp.path}/.credentials.json`, credentials());
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: fixture,
    })) as unknown as typeof fetch;
    const snapshot = await officialUsageFetcher(temp.path, fetchImpl)(now);
    expect(snapshot).toEqual(usageSnapshot());
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe(USAGE_ENDPOINT);
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk-ant-oat01-SECRET-TOKEN",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": expect.stringMatching(/^claude-code\//),
    });
  } finally {
    await temp.cleanup();
  }
});

it("explains missing, expired and rejected tokens without leaking them", async () => {
  const temp = await temporary();
  const fetchImpl = vi.fn(async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  try {
    await expect(
      officialUsageFetcher(temp.path, fetchImpl)(now),
    ).rejects.toThrow(/Sign in with `claude`/);
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({ expiresAt: now.getTime() - 1 }),
    );
    await expect(
      officialUsageFetcher(temp.path, fetchImpl)(now),
    ).rejects.toThrow(/expired/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await writeFile(`${temp.path}/.credentials.json`, credentials());
    const error = await officialUsageFetcher(
      temp.path,
      fetchImpl,
    )(now).catch((error: Error) => error.message);
    expect(error).toMatch(/HTTP 401/);
    expect(error).not.toMatch(/SECRET/);
  } finally {
    await temp.cleanup();
  }
});

it("keeps the last good snapshot when a refresh fails, records samples, and coalesces refreshes", async () => {
  const temp = await temporary();
  try {
    let clock = now.getTime();
    let fail = false;
    const fetchUsage = vi.fn(async (at: Date) => {
      if (fail) throw new Error("Anthropic usage endpoint returned HTTP 503.");
      return usageSnapshot({ fetchedAt: at.toISOString() });
    });
    const history = await UsageHistoryStore.open(temp.path, now);
    const monitor = new UsageMonitor(
      fetchUsage,
      history,
      () => new Date(clock),
    );
    expect(monitor.current()).toEqual({ snapshot: null, error: null });
    const [first, second] = await Promise.all([
      monitor.refresh(),
      monitor.refresh(),
    ]);
    expect(first).toEqual(second);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(first.snapshot?.fetchedAt).toBe(now.toISOString());
    await monitor.refresh();
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    clock += 5 * 60_000;
    fail = true;
    const failed = await monitor.refresh();
    expect(failed.error).toMatch(/HTTP 503/);
    expect(failed.snapshot?.fetchedAt).toBe(now.toISOString());
    const report = monitor.report();
    expect(report.samples).toHaveLength(1);
    expect(report.windows).toEqual([
      {
        start: "2026-09-06T11:09:00.000Z",
        end: "2026-09-06T16:09:00.000Z",
        peakPercent: 16,
        samples: 1,
      },
    ]);
    const reopened = await UsageHistoryStore.open(temp.path, new Date(clock));
    expect(reopened.recent(new Date(clock))).toEqual(report.samples);
  } finally {
    await temp.cleanup();
  }
});

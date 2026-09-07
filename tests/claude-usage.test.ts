import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  OAUTH_CLIENT_ID,
  officialUsageFetcher,
  parseUsageResponse,
  REFRESH_MARGIN_MS,
  refreshCredentials,
  TOKEN_ENDPOINT,
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
  expect(parseUsageResponse(await fixture(), now, "max")).toEqual(
    usageSnapshot(),
  );
});

it("parses a plan without a Fable window into session and weekly only", async () => {
  const { limits: _limits, ...body } = await fixture();
  expect(parseUsageResponse(body, now, "pro")).toEqual(
    usageSnapshot({ plan: "pro", fable: null }),
  );
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

it("carries the credential subscription type into the snapshot plan", async () => {
  const temp = await temporary();
  try {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: fixture,
    })) as unknown as typeof fetch;
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({ subscriptionType: "pro" }),
    );
    expect((await officialUsageFetcher(temp.path, fetchImpl)(now)).plan).toBe(
      "pro",
    );
    const { subscriptionType: _dropped, ...withoutPlan } = JSON.parse(
      credentials(),
    ).claudeAiOauth;
    await writeFile(
      `${temp.path}/.credentials.json`,
      JSON.stringify({ claudeAiOauth: withoutPlan }),
    );
    expect(
      (await officialUsageFetcher(temp.path, fetchImpl)(now)).plan,
    ).toBeNull();
  } finally {
    await temp.cleanup();
  }
});

it("explains missing and rejected tokens without leaking them", async () => {
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
    await writeFile(`${temp.path}/.credentials.json`, credentials());
    const error = await officialUsageFetcher(
      temp.path,
      fetchImpl,
    )(now).catch((error: Error) => error.message);
    expect(error).toMatch(/refused to refresh.*HTTP 401/);
    expect(error).not.toMatch(/SECRET/);
  } finally {
    await temp.cleanup();
  }
});

const HOUR_MS = 60 * 60_000;
const refreshResponse = {
  access_token: "sk-ant-oat01-FRESH",
  refresh_token: "sk-ant-ort01-ROTATED",
  expires_in: 8 * 3600,
  refresh_token_expires_in: 14 * 24 * 3600,
  scope: "user:inference user:profile",
};
type Route = (init: RequestInit) => Promise<{ status: number; body: unknown }>;
function oauthFetch(token: Route, usage: Route) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = await (url === TOKEN_ENDPOINT ? token : usage)(
      init,
    );
    return { ok: status === 200, status, json: async () => body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const bearer = (init: RequestInit) =>
  (init.headers as Record<string, string>).Authorization;
const usageFor =
  (accepted: string): Route =>
  async (init) =>
    bearer(init) === `Bearer ${accepted}`
      ? { status: 200, body: await fixture() }
      : { status: 401, body: {} };
const readOauth = async (path: string) =>
  JSON.parse(await readFile(`${path}/.credentials.json`, "utf8")).claudeAiOauth;

it("refreshes an expired access token, rewrites the credentials, and fetches with the new token", async () => {
  const temp = await temporary();
  try {
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({
        expiresAt: now.getTime() - 1,
        rateLimitTier: "default_claude_max_5x",
        unknownKey: "kept",
      }),
    );
    const { fetchImpl, calls } = oauthFetch(
      async () => ({ status: 200, body: refreshResponse }),
      usageFor("sk-ant-oat01-FRESH"),
    );
    expect(await officialUsageFetcher(temp.path, fetchImpl)(now)).toEqual(
      usageSnapshot(),
    );
    const [refresh, usage] = calls;
    expect(refresh.url).toBe(TOKEN_ENDPOINT);
    expect(refresh.init.method).toBe("POST");
    expect(refresh.init.headers).toMatchObject({
      "Content-Type": "application/json",
      "User-Agent": expect.stringMatching(/^claude-code\//),
    });
    expect(JSON.parse(String(refresh.init.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "sk-ant-ort01-SECRET-REFRESH",
      client_id: OAUTH_CLIENT_ID,
      scope: "user:inference user:profile",
    });
    expect(usage.url).toBe(USAGE_ENDPOINT);
    expect(bearer(usage.init)).toBe("Bearer sk-ant-oat01-FRESH");
    expect(await readOauth(temp.path)).toEqual({
      accessToken: "sk-ant-oat01-FRESH",
      refreshToken: "sk-ant-ort01-ROTATED",
      expiresAt: now.getTime() + 8 * HOUR_MS,
      refreshTokenExpiresAt: now.getTime() + 14 * 24 * HOUR_MS,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
      unknownKey: "kept",
    });
  } finally {
    await temp.cleanup();
  }
});

it("refreshes inside the expiry margin and leaves a token with time left alone", async () => {
  const temp = await temporary();
  try {
    const { fetchImpl, calls } = oauthFetch(
      async () => ({ status: 200, body: refreshResponse }),
      async () => ({ status: 200, body: await fixture() }),
    );
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({ expiresAt: now.getTime() + REFRESH_MARGIN_MS + 1 }),
    );
    await officialUsageFetcher(temp.path, fetchImpl)(now);
    expect(calls.map((call) => call.url)).toEqual([USAGE_ENDPOINT]);
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({ expiresAt: now.getTime() + REFRESH_MARGIN_MS }),
    );
    await officialUsageFetcher(temp.path, fetchImpl)(now);
    expect(calls.map((call) => call.url)).toEqual([
      USAGE_ENDPOINT,
      TOKEN_ENDPOINT,
      USAGE_ENDPOINT,
    ]);
  } finally {
    await temp.cleanup();
  }
});

it("keeps the old refresh token when the refresh response omits one", async () => {
  const temp = await temporary();
  try {
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({ expiresAt: now.getTime() - 1 }),
    );
    const { refresh_token: _omitted, ...withoutRotation } = refreshResponse;
    const { fetchImpl } = oauthFetch(
      async () => ({ status: 200, body: withoutRotation }),
      usageFor("sk-ant-oat01-FRESH"),
    );
    await officialUsageFetcher(temp.path, fetchImpl)(now);
    expect(await readOauth(temp.path)).toMatchObject({
      accessToken: "sk-ant-oat01-FRESH",
      refreshToken: "sk-ant-ort01-SECRET-REFRESH",
    });
  } finally {
    await temp.cleanup();
  }
});

it("retries once after a usage 401 and reports a second 401 instead of looping", async () => {
  const temp = await temporary();
  try {
    await writeFile(`${temp.path}/.credentials.json`, credentials());
    const good = oauthFetch(
      async () => ({ status: 200, body: refreshResponse }),
      usageFor("sk-ant-oat01-FRESH"),
    );
    expect(await officialUsageFetcher(temp.path, good.fetchImpl)(now)).toEqual(
      usageSnapshot(),
    );
    expect(good.calls.map((call) => call.url)).toEqual([
      USAGE_ENDPOINT,
      TOKEN_ENDPOINT,
      USAGE_ENDPOINT,
    ]);
    await writeFile(`${temp.path}/.credentials.json`, credentials());
    const bad = oauthFetch(
      async () => ({ status: 200, body: refreshResponse }),
      async () => ({ status: 401, body: {} }),
    );
    await expect(
      officialUsageFetcher(temp.path, bad.fetchImpl)(now),
    ).rejects.toThrow(/rejected the Claude Code token \(HTTP 401\)/);
    expect(bad.calls.map((call) => call.url)).toEqual([
      USAGE_ENDPOINT,
      TOKEN_ENDPOINT,
      USAGE_ENDPOINT,
    ]);
  } finally {
    await temp.cleanup();
  }
});

it("explains an expired refresh token, a refused refresh, and a missing refresh token without leaking them", async () => {
  const temp = await temporary();
  try {
    const refused = oauthFetch(
      async () => ({ status: 400, body: {} }),
      usageFor("sk-ant-oat01-FRESH"),
    );
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({
        expiresAt: now.getTime() - 1,
        refreshTokenExpiresAt: now.getTime(),
      }),
    );
    await expect(
      officialUsageFetcher(temp.path, refused.fetchImpl)(now),
    ).rejects.toThrow(/refresh token expired.*sign in again/);
    expect(refused.calls).toHaveLength(0);
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({ expiresAt: now.getTime() - 1 }),
    );
    const error = await officialUsageFetcher(
      temp.path,
      refused.fetchImpl,
    )(now).catch((error: Error) => error.message);
    expect(error).toMatch(/refused to refresh.*HTTP 400/);
    expect(error).not.toMatch(/SECRET/);
    const { refreshToken: _none, ...withoutRefresh } = JSON.parse(
      credentials({ expiresAt: now.getTime() - 1 }),
    ).claudeAiOauth;
    await writeFile(
      `${temp.path}/.credentials.json`,
      JSON.stringify({ claudeAiOauth: withoutRefresh }),
    );
    await expect(
      officialUsageFetcher(temp.path, refused.fetchImpl)(now),
    ).rejects.toThrow(/no refresh token/);
  } finally {
    await temp.cleanup();
  }
});

it("uses a token another process wrote in the meantime instead of refreshing again", async () => {
  const temp = await temporary();
  try {
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({ expiresAt: now.getTime() - 1 }),
    );
    const { fetchImpl, calls } = oauthFetch(
      async () => ({ status: 200, body: refreshResponse }),
      usageFor("sk-ant-oat01-ELSEWHERE"),
    );
    await refreshCredentials(
      temp.path,
      "sk-ant-oat01-SECRET-TOKEN",
      now,
      fetchImpl,
    );
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({ accessToken: "sk-ant-oat01-ELSEWHERE" }),
    );
    expect(
      await refreshCredentials(temp.path, "sk-ant-oat01-FRESH", now, fetchImpl),
    ).toMatchObject({ accessToken: "sk-ant-oat01-ELSEWHERE" });
    expect(calls.map((call) => call.url)).toEqual([TOKEN_ENDPOINT]);
  } finally {
    await temp.cleanup();
  }
});

it("shares one refresh between concurrent usage fetches", async () => {
  const temp = await temporary();
  try {
    await writeFile(
      `${temp.path}/.credentials.json`,
      credentials({ expiresAt: now.getTime() - 1 }),
    );
    const { fetchImpl, calls } = oauthFetch(
      async () => ({ status: 200, body: refreshResponse }),
      usageFor("sk-ant-oat01-FRESH"),
    );
    const fetchUsage = officialUsageFetcher(temp.path, fetchImpl);
    const results = await Promise.all([fetchUsage(now), fetchUsage(now)]);
    expect(results).toEqual([usageSnapshot(), usageSnapshot()]);
    expect(calls.filter((call) => call.url === TOKEN_ENDPOINT)).toHaveLength(1);
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
        activeMinutes: 0,
        samples: 1,
      },
    ]);
    const reopened = await UsageHistoryStore.open(temp.path, new Date(clock));
    expect(reopened.recent(new Date(clock))).toEqual(report.samples);
  } finally {
    await temp.cleanup();
  }
});

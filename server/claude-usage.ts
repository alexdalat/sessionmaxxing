import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OfficialUsage, UsageSnapshot } from "../shared/types.js";
import { FABLE_MODEL } from "../shared/types.js";
import { DomainError } from "./storage.js";

export const USAGE_ENDPOINT =
  "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1";
const OAUTH_BETA = "oauth-2025-04-20";
// The endpoint rate-limits unknown clients aggressively; identify as Claude Code.
const USER_AGENT = "claude-code/2.1.263";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PERCENT = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const SECOND_MS = 1000;
function isoReset(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const ms =
    typeof value === "number" ? value * SECOND_MS : Date.parse(String(value));
  if (!Number.isFinite(ms))
    throw new DomainError("Usage response has an unreadable reset time.", 502);
  return new Date(ms).toISOString();
}
function bucket(value: unknown, name: string): OfficialUsage {
  const utilization = isRecord(value)
    ? (value.utilization ?? value.percent)
    : undefined;
  if (typeof utilization !== "number" || !Number.isFinite(utilization))
    throw new DomainError(`Usage response lacks the ${name} window.`, 502);
  return {
    percent: Math.min(MAX_PERCENT, Math.max(0, utilization)),
    resetsAt: isoReset(isRecord(value) ? value.resets_at : null),
  };
}
function modelWindow(limits: unknown, model: RegExp): OfficialUsage | null {
  if (!Array.isArray(limits)) return null;
  const entry = limits.find((item) => {
    if (!isRecord(item) || item.kind !== "weekly_scoped") return false;
    const scope = isRecord(item.scope) ? item.scope.model : undefined;
    return isRecord(scope) && model.test(String(scope.display_name));
  });
  return entry ? bucket(entry, "model") : null;
}
export function parseUsageResponse(
  body: unknown,
  now: Date,
  plan: string | null = null,
): UsageSnapshot {
  if (!isRecord(body))
    throw new DomainError("Usage response is not a JSON object.", 502);
  return {
    fetchedAt: now.toISOString(),
    plan,
    session: bucket(body.five_hour, "five_hour"),
    weekly: bucket(body.seven_day, "seven_day"),
    fable: modelWindow(body.limits, FABLE_MODEL),
  };
}

export async function readCredentials(claudeDirectory: string, now: Date) {
  let raw: string;
  try {
    raw = await readFile(join(claudeDirectory, ".credentials.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new DomainError(
      "Claude Code credentials not found. Sign in with `claude` first.",
      503,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined;
  if (!isRecord(oauth) || typeof oauth.accessToken !== "string")
    throw new DomainError(
      "Claude Code credentials hold no OAuth token. Sign in with `claude` first.",
      503,
    );
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now.getTime())
    throw new DomainError(
      "Claude Code OAuth token expired. Run `claude` once to refresh it.",
      503,
    );
  return {
    accessToken: oauth.accessToken,
    subscriptionType:
      typeof oauth.subscriptionType === "string"
        ? oauth.subscriptionType
        : null,
  };
}

export type FetchUsage = (now: Date) => Promise<UsageSnapshot>;
export function officialUsageFetcher(
  claudeDirectory: string,
  fetchImpl: typeof fetch = fetch,
): FetchUsage {
  return async (now) => {
    const { accessToken, subscriptionType } = await readCredentials(
      claudeDirectory,
      now,
    );
    const response = await fetchImpl(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new DomainError(
        response.status === 401
          ? "Anthropic rejected the Claude Code token (HTTP 401). Run `claude` once to refresh it."
          : `Anthropic usage endpoint returned HTTP ${response.status}.`,
        502,
      );
    return parseUsageResponse(await response.json(), now, subscriptionType);
  };
}

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OfficialUsage, UsageSnapshot } from "../shared/types.js";
import { FABLE_MODEL } from "../shared/types.js";
import { DomainError } from "./storage.js";

export const USAGE_ENDPOINT =
  "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1";
export const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA = "oauth-2025-04-20";
// The endpoint rate-limits unknown clients aggressively; identify as Claude Code.
const USER_AGENT = "claude-code/2.1.263";
const REQUEST_TIMEOUT_MS = 10_000;
const REFRESH_TIMEOUT_MS = 30_000;
export const REFRESH_MARGIN_MS = 5 * 60_000;
const CREDENTIALS_FILE = ".credentials.json";
const CREDENTIALS_MODE = 0o600;
const MAX_PERCENT = 100;
const SIGN_IN_HINT = "Sign in with `claude` first.";

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

interface CredentialsFile {
  document: Record<string, unknown>;
  oauth: Record<string, unknown>;
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
}
async function loadCredentials(
  claudeDirectory: string,
): Promise<CredentialsFile> {
  let raw: string;
  try {
    raw = await readFile(join(claudeDirectory, CREDENTIALS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new DomainError(
      `Claude Code credentials not found. ${SIGN_IN_HINT}`,
      503,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined;
  if (
    !isRecord(parsed) ||
    !isRecord(oauth) ||
    typeof oauth.accessToken !== "string"
  )
    throw new DomainError(
      `Claude Code credentials hold no OAuth token. ${SIGN_IN_HINT}`,
      503,
    );
  return {
    document: parsed,
    oauth,
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
    subscriptionType:
      typeof oauth.subscriptionType === "string"
        ? oauth.subscriptionType
        : null,
  };
}
const expiringSoon = (credentials: CredentialsFile, now: Date) =>
  credentials.expiresAt !== null &&
  credentials.expiresAt <= now.getTime() + REFRESH_MARGIN_MS;

/** Replaces `staleAccessToken` through the refresh grant and rewrites the credentials file. */
export async function refreshCredentials(
  claudeDirectory: string,
  staleAccessToken: string,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialsFile> {
  // Another Claude Code process may have refreshed already; its rotated refresh token is the only valid one.
  const current = await loadCredentials(claudeDirectory);
  if (current.accessToken !== staleAccessToken) return current;
  const { oauth } = current;
  if (typeof oauth.refreshToken !== "string")
    throw new DomainError(
      `Claude Code credentials hold no refresh token. ${SIGN_IN_HINT}`,
      503,
    );
  if (
    typeof oauth.refreshTokenExpiresAt === "number" &&
    oauth.refreshTokenExpiresAt <= now.getTime()
  )
    throw new DomainError(
      "Claude Code refresh token expired. Run `claude` once to sign in again.",
      503,
    );
  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.map(String) : [];
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: OAUTH_CLIENT_ID,
      scope: scopes.join(" "),
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (response.status !== 200)
    throw new DomainError(
      `Anthropic refused to refresh the Claude Code token (HTTP ${response.status}). Run \`claude\` once to refresh it.`,
      502,
    );
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body.access_token !== "string" ||
    typeof body.expires_in !== "number"
  )
    throw new DomainError("Token refresh response is malformed.", 502);
  const refreshed: Record<string, unknown> = {
    ...oauth,
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string"
        ? body.refresh_token
        : oauth.refreshToken,
    expiresAt: now.getTime() + body.expires_in * SECOND_MS,
  };
  if (typeof body.refresh_token_expires_in === "number")
    refreshed.refreshTokenExpiresAt =
      now.getTime() + body.refresh_token_expires_in * SECOND_MS;
  if (typeof body.scope === "string")
    refreshed.scopes = body.scope.split(" ").filter(Boolean);
  const document = { ...current.document, claudeAiOauth: refreshed };
  const path = join(claudeDirectory, CREDENTIALS_FILE);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  // Claude Code reloads the file on an mtime change, so a whole-file rename is the safe handoff.
  await writeFile(temporaryPath, JSON.stringify(document, null, 2), {
    mode: CREDENTIALS_MODE,
  });
  await rename(temporaryPath, path);
  return loadCredentials(claudeDirectory);
}

export type FetchUsage = (now: Date) => Promise<UsageSnapshot>;
export function officialUsageFetcher(
  claudeDirectory: string,
  fetchImpl: typeof fetch = fetch,
): FetchUsage {
  let refreshing: Promise<CredentialsFile> | undefined;
  const refresh = (staleAccessToken: string, now: Date) => {
    refreshing ??= refreshCredentials(
      claudeDirectory,
      staleAccessToken,
      now,
      fetchImpl,
    ).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  const fetchUsage = (accessToken: string) =>
    fetchImpl(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  return async (now) => {
    let credentials = await loadCredentials(claudeDirectory);
    if (expiringSoon(credentials, now))
      credentials = await refresh(credentials.accessToken, now);
    let response = await fetchUsage(credentials.accessToken);
    if (response.status === 401) {
      credentials = await refresh(credentials.accessToken, now);
      response = await fetchUsage(credentials.accessToken);
    }
    if (!response.ok)
      throw new DomainError(
        response.status === 401
          ? "Anthropic rejected the Claude Code token (HTTP 401). Run `claude` once to refresh it."
          : `Anthropic usage endpoint returned HTTP ${response.status}.`,
        502,
      );
    return parseUsageResponse(
      await response.json(),
      now,
      credentials.subscriptionType,
    );
  };
}

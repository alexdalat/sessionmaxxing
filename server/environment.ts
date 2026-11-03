import { realpath, stat } from "node:fs/promises";
import { isIP, isIPv6 } from "node:net";
import { isAbsolute } from "node:path";
import type { Env } from "./data-directory.js";
import { DomainError } from "./storage.js";

export const HOST_VARIABLE = "SESSIONMAXXING_HOST";
export const EDITION_VARIABLE = "SESSIONMAXXING_EDITION";
export const ALLOWED_HOSTS_VARIABLE = "SESSIONMAXXING_ALLOWED_HOSTS";
export const WORKDIR_ROOT_VARIABLE = "SESSIONMAXXING_WORKDIR_ROOT";
export const ZONE_VARIABLE = "TZ";

const LOOPBACK = "127.0.0.1";
export const UNSPECIFIED_ADDRESSES = new Set(["0.0.0.0", "::"]);
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const BRACKETED_IPV6 = /^\[([^\]]+)\]$/;

export function resolveHost(env: Env) {
  const host = env[HOST_VARIABLE] ?? LOOPBACK;
  if (isIP(host) === 0)
    throw new DomainError(
      `${HOST_VARIABLE} must be an IPv4 or IPv6 address such as 127.0.0.1 or 0.0.0.0.`,
      400,
    );
  return host;
}

export function resolveEdition(env: Env) {
  const edition = env[EDITION_VARIABLE];
  if (edition !== undefined && edition !== "full")
    throw new DomainError(
      `${EDITION_VARIABLE} must be full; only the full edition exists yet.`,
      400,
    );
  return "full";
}

function isAllowedHostEntry(entry: string) {
  if (isIP(entry) !== 0 || HOST_NAME.test(entry)) return true;
  const inner = BRACKETED_IPV6.exec(entry)?.[1];
  return inner !== undefined && isIPv6(inner);
}

export function resolveAllowedHosts(env: Env, host: string) {
  const entries = (env[ALLOWED_HOSTS_VARIABLE] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const entry of entries)
    if (!isAllowedHostEntry(entry))
      throw new DomainError(
        `${ALLOWED_HOSTS_VARIABLE} entry "${entry}" must be a host name or an IP address without port, path, user or wildcard.`,
        400,
      );
  return UNSPECIFIED_ADDRESSES.has(host) ? entries : [host, ...entries];
}

export function formatListenUrl(address: {
  address: string;
  family: string;
  port: number;
}) {
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

async function existingDirectory(path: string) {
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function resolveWorkdirRoot(env: Env, home: string) {
  const explicit = env[WORKDIR_ROOT_VARIABLE];
  if (explicit === undefined) {
    const root = await existingDirectory(home);
    if (root === undefined)
      throw new DomainError(
        `The home directory ${home} does not exist; set ${WORKDIR_ROOT_VARIABLE} to the directory work directories must be under.`,
        400,
      );
    return root;
  }
  const root = isAbsolute(explicit)
    ? await existingDirectory(explicit)
    : undefined;
  if (root === undefined)
    throw new DomainError(
      `${WORKDIR_ROOT_VARIABLE} must be an absolute path to an existing directory.`,
      400,
    );
  return root;
}

const UNKNOWN_ZONE = "Etc/Unknown";

function canonicalTimeZone(name: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: name,
    }).resolvedOptions().timeZone;
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

export function resolveTimeZone(env: Env, resolved: string | undefined) {
  if (resolved === undefined || resolved === UNKNOWN_ZONE)
    throw new DomainError(
      `${ZONE_VARIABLE} must name an IANA time zone such as America/Chicago; the process resolved none.`,
      400,
    );
  const configured = env[ZONE_VARIABLE];
  if (configured === undefined) return resolved;
  const name = configured.startsWith(":") ? configured.slice(1) : configured;
  const canonical = canonicalTimeZone(name);
  if (canonical === undefined)
    throw new DomainError(
      `${ZONE_VARIABLE}=${configured} is not an IANA time zone such as America/Chicago.`,
      400,
    );
  if (canonical !== resolved)
    throw new DomainError(
      `${ZONE_VARIABLE}=${configured} was not applied; the process resolved ${resolved}. Use an IANA zone such as America/Chicago.`,
      400,
    );
  return resolved;
}

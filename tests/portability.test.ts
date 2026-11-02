import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_VALUES } from "./forbidden-values";

const ENV_KEYS = [
  "SESSIONMAXXING_UID",
  "SESSIONMAXXING_GID",
  "SESSIONMAXXING_HOME",
  "SESSIONMAXXING_BIND_ADDRESS",
  "SESSIONMAXXING_PORT",
  "SESSIONMAXXING_EDITION",
  "TZ",
  "SESSIONMAXXING_ALLOWED_HOSTS",
];
const OPTIONAL_KEY = "SESSIONMAXXING_ALLOWED_HOSTS";
const PORTABLE_FILES = ["compose.yaml", ".env.example"];
const INTERPOLATION = /\$\{([A-Z][A-Z0-9_]*)(:[?-][^}]*)?\}/g;

const read = (path: string) => readFile(resolve(path), "utf8");

function interpolations(text: string) {
  return [...text.matchAll(INTERPOLATION)].map((match) => ({
    name: match[1],
    modifier: match[2] ?? "",
  }));
}

function lines(text: string) {
  return text.split("\n");
}

describe("compose.yaml", () => {
  it("requires every field with a :? error except the optional extra hosts", async () => {
    const found = interpolations(await read("compose.yaml"));
    expect(found.length).toBeGreaterThan(0);
    for (const { name, modifier } of found) {
      if (name === OPTIONAL_KEY) expect(modifier).toBe(":-");
      else expect(modifier, `${name} must be required`).toMatch(/^:\?\S/);
    }
    expect(found.some((entry) => entry.name === OPTIONAL_KEY)).toBe(true);
  });

  it("approves the bind address followed by the optional extra names", async () => {
    const line = lines(await read("compose.yaml")).find((candidate) =>
      candidate.includes(`${OPTIONAL_KEY}:`),
    );
    expect(line).toMatch(
      /SESSIONMAXXING_ALLOWED_HOSTS: "\$\{SESSIONMAXXING_BIND_ADDRESS:\?[^}]+\},\$\{SESSIONMAXXING_ALLOWED_HOSTS:-\}"/,
    );
  });

  it("publishes exactly one port from interpolated values", async () => {
    const text = await read("compose.yaml");
    const published = lines(text).filter((line) => /^\s*published:/.test(line));
    expect(published).toHaveLength(1);
    expect(published[0]).toContain("${SESSIONMAXXING_PORT:?");
    expect(text).toMatch(/host_ip: "\$\{SESSIONMAXXING_BIND_ADDRESS:\?/);
    expect(text).toMatch(/target: 4317\b/);
  });

  it("leaves the image to set the in-container host and port", async () => {
    const text = await read("compose.yaml");
    expect(text).not.toMatch(/^\s*SESSIONMAXXING_HOST:/m);
    expect(text).not.toMatch(/^\s*SESSIONMAXXING_PORT:/m);
  });

  it("mounts only the home directory and no data directory", async () => {
    const text = await read("compose.yaml");
    expect(text.match(/type: bind/g)).toHaveLength(1);
    expect(text).not.toContain("./data");
    expect(text).not.toContain("/app/data");
    expect(text).toMatch(/source: "\$\{SESSIONMAXXING_HOME:\?[^}]+\}"/);
    expect(text).toMatch(/target: "\$\{SESSIONMAXXING_HOME:\?[^}]+\}"/);
  });

  it("takes the container user and the build args from the same fields", async () => {
    const text = await read("compose.yaml");
    expect(text).toMatch(
      /^\s*user: "\$\{SESSIONMAXXING_UID:\?[^}]+\}:\$\{SESSIONMAXXING_GID:\?[^}]+\}"/m,
    );
    for (const [arg, key] of [
      ["RUNTIME_UID", "SESSIONMAXXING_UID"],
      ["RUNTIME_GID", "SESSIONMAXXING_GID"],
      ["RUNTIME_HOME", "SESSIONMAXXING_HOME"],
    ])
      expect(text).toMatch(new RegExp(`${arg}: "\\$\\{${key}:\\?`));
  });

  it("passes the zone and edition into the container", async () => {
    const text = await read("compose.yaml");
    expect(text).toMatch(/^\s*TZ: "\$\{TZ:\?/m);
    expect(text).toMatch(
      /^\s*SESSIONMAXXING_EDITION: "\$\{SESSIONMAXXING_EDITION:\?/m,
    );
  });
});

describe(".env.example", () => {
  it("lists exactly the eight Compose fields", async () => {
    const keys = lines(await read(".env.example"))
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((key): key is string => key !== undefined);
    expect(keys).toEqual(ENV_KEYS);
  });

  it("names every variable compose.yaml interpolates", async () => {
    const used = new Set(
      interpolations(await read("compose.yaml")).map((entry) => entry.name),
    );
    expect([...used].sort()).toEqual([...ENV_KEYS].sort());
  });

  it("starts the extra allowed hosts empty", async () => {
    expect(await read(".env.example")).toMatch(
      /^SESSIONMAXXING_ALLOWED_HOSTS=$/m,
    );
  });
});

describe(".gitignore", () => {
  it("keeps .env, compose.override.yaml and data/ out of git", async () => {
    const entries = lines(await read(".gitignore")).map((line) => line.trim());
    for (const entry of [".env", "compose.override.yaml", "data/"])
      expect(entries).toContain(entry);
  });
});

describe("personal values", () => {
  it.each(PORTABLE_FILES)("%s holds none", async (path) => {
    const text = await read(path);
    for (const pattern of FORBIDDEN_VALUES)
      expect(text, `${path} matches ${pattern}`).not.toMatch(pattern);
  });
});

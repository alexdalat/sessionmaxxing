import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_VALUES } from "./forbidden-values";

const ROOT = resolve(__dirname, "..");
const SEARCHED_DIRECTORIES = [
  "app",
  "server",
  "shared",
  "scripts",
  "skills",
  "tests",
  "deploy",
];
const SEARCHED_FILES = [
  "compose.yaml",
  "Dockerfile",
  ".env.example",
  "README.md",
  "AGENTS.md",
];
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".tmp", ".next"]);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".json",
  ".jsonl",
  ".md",
  ".css",
  ".svg",
  ".sh",
  ".yaml",
  ".yml",
  ".path",
  ".service",
]);

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, directory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : filesUnder(path);
      return TEXT_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    }),
  );
  return nested.flat();
}

async function searchedFiles() {
  const nested = await Promise.all(SEARCHED_DIRECTORIES.map(filesUnder));
  return [...nested.flat(), ...SEARCHED_FILES];
}

describe("personal values", () => {
  it("appear in none of the shipped files", async () => {
    const hits: string[] = [];
    for (const path of await searchedFiles()) {
      const text = await readFile(join(ROOT, path), "utf8");
      text.split("\n").forEach((line, index) => {
        if (FORBIDDEN_VALUES.some((pattern) => pattern.test(line)))
          hits.push(`${path}:${index + 1}`);
      });
    }
    expect(hits, `personal values found at:\n${hits.join("\n")}`).toEqual([]);
  });

  it("searches the source, script, deploy and documentation files", async () => {
    const files = await searchedFiles();
    for (const expected of [
      "server/data-directory.ts",
      "deploy/host-deploy.sh",
      "tests/personal-values.test.ts",
      "README.md",
      "compose.yaml",
    ])
      expect(files).toContain(expected);
  });
});

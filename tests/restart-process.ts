import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";

/** Ignores SIGTERM, forks a grandchild in the same process group and idles; argv[1] and argv[2] receive their pids. */
export const IDLE_SCRIPT = [
  'const { spawn } = require("node:child_process")',
  'const { writeFileSync } = require("node:fs")',
  'process.on("SIGTERM", () => {})',
  'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
  "writeFileSync(process.argv[1], String(process.pid))",
  "writeFileSync(process.argv[2], String(grandchild.pid))",
  "setInterval(() => {}, 1000)",
].join(";");

export const idleCommand = (directory: string) => ({
  kind: "command" as const,
  argv: [
    process.execPath,
    "-e",
    IDLE_SCRIPT,
    join(directory, "child.pid"),
    join(directory, "grandchild.pid"),
  ],
});

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** The pids the idle script wrote, once both exist. */
export async function idlePids(directory: string) {
  return vi.waitFor(async () => {
    const [child, grandchild] = await Promise.all(
      ["child.pid", "grandchild.pid"].map(async (name) =>
        Number(await readFile(join(directory, name), "utf8")),
      ),
    );
    if (!child || !grandchild) throw new Error("pids not written yet");
    return { child, grandchild };
  });
}

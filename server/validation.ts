import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import {
  AUTO_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  type TaskInput,
} from "../shared/types.js";
import { DomainError } from "./storage.js";

export const ALLOWED_HOME = "/home/user";
export function underHome(path: string, home = ALLOWED_HOME) {
  const rel = relative(home, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}
export async function validateWorkdir(path: string) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new DomainError(
      "Work directory must be an existing absolute directory under /home/user.",
      400,
    );
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!underHome(canonical) || !(await stat(canonical)).isDirectory())
      throw new Error("Invalid directory");
  } catch {
    throw new DomainError(
      "Work directory must be an existing absolute directory under /home/user.",
      400,
    );
  }
  return canonical;
}
export function validateFields(input: TaskInput) {
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 120
  )
    throw new DomainError("Title must contain 1–120 characters.", 400);
  if (
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    input.prompt.length > 50_000 ||
    input.prompt.includes("\0")
  )
    throw new DomainError(
      "Prompt must contain 1–50000 characters without NUL bytes.",
      400,
    );
  if (!["claude", "codex"].includes(input.provider))
    throw new DomainError("Select a supported provider.", 400);
  if (
    input.model !== undefined &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(input.model)
  )
    throw new DomainError("Model must be a valid model name.", 400);
  if (
    !Number.isInteger(input.priority) ||
    input.priority < 0 ||
    input.priority > 1_000_000
  )
    throw new DomainError(
      "Priority must be an integer from 0 to 1000000.",
      400,
    );
  if (
    !Number.isInteger(input.maxTurns) ||
    input.maxTurns < 1 ||
    input.maxTurns > 1000
  )
    throw new DomainError(
      "Maximum turns must be an integer from 1 to 1000.",
      400,
    );
  if (
    input.outputTokens !== AUTO_OUTPUT_TOKENS &&
    (!Number.isInteger(input.outputTokens) ||
      input.outputTokens < MIN_OUTPUT_TOKENS ||
      input.outputTokens > MAX_OUTPUT_TOKENS)
  )
    throw new DomainError(
      `Output tokens must be an integer from ${MIN_OUTPUT_TOKENS} to ${MAX_OUTPUT_TOKENS}, or "auto".`,
      400,
    );
  if (
    input.preferredWindowStart !== null &&
    (!Number.isInteger(input.preferredWindowStart) ||
      input.preferredWindowStart < 0 ||
      input.preferredWindowStart > 23)
  )
    throw new DomainError(
      "Preferred window must be a local hour from 0 to 23.",
      400,
    );
  if (
    input.earliestStart !== null &&
    (typeof input.earliestStart !== "string" ||
      !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(input.earliestStart) ||
      !Number.isFinite(Date.parse(input.earliestStart)))
  )
    throw new DomainError(
      "Earliest start must be an ISO timestamp with a timezone.",
      400,
    );
}

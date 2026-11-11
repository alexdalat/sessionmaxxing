import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  AUTO_TOKENS,
  type Edition,
  MAX_DEPENDENCIES,
  MAX_TOKENS,
  MIN_TOKENS,
  type TaskInput,
  type TokensInput,
} from "../shared/types.js";
import { DomainError } from "./storage.js";

export const TASK_ID = /^[a-f0-9]{24}$/;
export function underRoot(path: string, root: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export async function validateWorkdir(path: string, root: string) {
  const rejection = new DomainError(
    `Work directory must be an existing absolute directory under ${root}.`,
    400,
  );
  if (typeof path !== "string" || !isAbsolute(path)) throw rejection;
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!underRoot(canonical, root) || !(await stat(canonical)).isDirectory())
      throw rejection;
  } catch {
    throw rejection;
  }
  return canonical;
}
export const TOKENS_MESSAGE = `Tokens must be an integer from ${MIN_TOKENS} to ${MAX_TOKENS}, or "auto".`;
const tokensInRange = (tokens: unknown) =>
  typeof tokens === "number" &&
  Number.isInteger(tokens) &&
  tokens >= MIN_TOKENS &&
  tokens <= MAX_TOKENS;
export function validateFields(
  input: Omit<TaskInput, "tokens"> & { tokens?: TokensInput | null },
  edition: Edition,
) {
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
  const tokensAllowed =
    edition === "full"
      ? input.tokens === AUTO_TOKENS || tokensInRange(input.tokens)
      : input.tokens == null || tokensInRange(input.tokens);
  if (!tokensAllowed) throw new DomainError(TOKENS_MESSAGE, 400);
  if (
    !Array.isArray(input.dependsOn) ||
    input.dependsOn.length > MAX_DEPENDENCIES ||
    new Set(input.dependsOn).size !== input.dependsOn.length ||
    input.dependsOn.some((taskId) => !TASK_ID.test(taskId))
  )
    throw new DomainError(
      `Depends on must list up to ${MAX_DEPENDENCIES} distinct task ids.`,
      400,
    );
  if (input.commit !== undefined && typeof input.commit !== "boolean")
    throw new DomainError("Commit must be true or false.", 400);
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

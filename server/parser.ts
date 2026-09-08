import { basename } from "node:path";
import type { ActivityEvent, ParseResult } from "../shared/types.js";

const UUID = /[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/gi;
const SESSION_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const INTERACTIVE_ENTRYPOINT = "cli";
export function safeProject(cwd: unknown): string {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return "Unknown project";
  const CREDENTIAL_SHAPED =
    /(?:^|[^a-z0-9])(?:api[_-]?key|authorization|bearer|credential|oauth|password|secret|token)(?:$|[^a-z0-9])/i;
  const project = basename(cwd);
  if (CREDENTIAL_SHAPED.test(project)) return "[redacted project]";
  return project.replace(UUID, "[redacted]").slice(0, 80) || "Home";
}
export function counter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
export function parseTranscript(input: string): ParseResult {
  const result: ParseResult = { events: [], warnings: 0, lines: 0 };
  for (const line of input.split("\n")) {
    if (!line.trim()) continue;
    result.lines++;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      result.warnings++;
      continue;
    }
    if (!record || typeof record !== "object" || record.type !== "assistant")
      continue;
    const message = record.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    const timestamp =
      typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) {
      result.warnings++;
      continue;
    }
    const event: ActivityEvent = {
      timestamp: new Date(timestamp).toISOString(),
      project: safeProject(record.cwd),
      model:
        typeof message?.model === "string" &&
        /^claude-(?:(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)*|\d+(?:-\d+)*-(?:opus|sonnet|haiku|fable)(?:-\d+)*|\d+(?:\.\d+)?)(?:-latest)?$/.test(
          message.model,
        )
          ? message.model
          : "Unknown model",
      source:
        record.entrypoint === INTERACTIVE_ENTRYPOINT ? "local" : "unknown",
      inputTokens: counter(usage?.input_tokens),
      outputTokens: counter(usage?.output_tokens),
      cacheReadTokens: counter(usage?.cache_read_input_tokens),
      cacheCreationTokens: counter(usage?.cache_creation_input_tokens),
    };
    result.events.push({
      event,
      messageId: typeof message?.id === "string" ? message.id : null,
      sessionId:
        typeof record.sessionId === "string" &&
        SESSION_ID.test(record.sessionId)
          ? record.sessionId
          : null,
    });
  }
  return result;
}

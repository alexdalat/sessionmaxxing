import { DomainError } from "./storage.js";

export type ProviderMigration = "drop" | "stripped" | "unchanged";

const CLAUDE_PROVIDER = "claude";
const REMOVED_PROVIDER = "codex";

// One-time migration for records stored before the second provider was removed (2026-10).
// This file and its test are the only places that may name that provider.
export function migrateProvider(
  record: object,
  label: string,
): ProviderMigration {
  if (!("provider" in record)) return "unchanged";
  if (record.provider === REMOVED_PROVIDER) return "drop";
  if (record.provider !== CLAUDE_PROVIDER)
    throw new DomainError(`${label} has an unsupported provider.`, 500);
  delete record.provider;
  return "stripped";
}

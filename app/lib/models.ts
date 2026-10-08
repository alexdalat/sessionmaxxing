import { CLAUDE_MODELS } from "@/shared/types";

const CLAUDE_PREFIX = "claude-";

export const modelLabel = (model: string) =>
  model.startsWith(CLAUDE_PREFIX) ? model.slice(CLAUDE_PREFIX.length) : model;

export function modelOptions(current?: string) {
  if (!current || CLAUDE_MODELS.some((option) => option.value === current))
    return CLAUDE_MODELS;
  return [...CLAUDE_MODELS, { value: current, label: current }];
}

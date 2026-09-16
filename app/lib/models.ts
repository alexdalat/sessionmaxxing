import { PROVIDER_MODELS, type Provider } from "@/shared/types";

const CLAUDE_PREFIX = "claude-";

export const DEFAULT_MODEL: Record<Provider, string> = {
  claude: "opus",
  codex: PROVIDER_MODELS.codex[0].value,
};

export const modelLabel = (model: string) =>
  model.startsWith(CLAUDE_PREFIX) ? model.slice(CLAUDE_PREFIX.length) : model;

export function modelOptions(provider: Provider, current?: string) {
  const options = PROVIDER_MODELS[provider];
  if (!current || options.some((option) => option.value === current))
    return options;
  return [...options, { value: current, label: current }];
}

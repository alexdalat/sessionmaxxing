import { PROVIDER_MODELS, type Provider } from "@/shared/types";

export function modelOptions(provider: Provider, current?: string) {
  const options = PROVIDER_MODELS[provider];
  if (!current || options.some((option) => option.value === current))
    return options;
  return [...options, { value: current, label: current }];
}

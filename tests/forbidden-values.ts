const FRAGMENTS: readonly (readonly string[])[] = [
  ["/home", "/alex\\b"],
  ["\\b10", "01\\b"],
  ["100\\.", "98\\.", "196\\.", "62"],
  ["tail", "537c71"],
  ["delta", "beta"],
  ["America", "/New_York"],
  ["Det", "roit"],
  ["alex", "dalat"],
  ["-home", "-alex-"],
];

// Fragments keep this file and its callers free of the complete strings the PORT-01 search looks for.
export const FORBIDDEN_VALUES: readonly RegExp[] = FRAGMENTS.map(
  (parts) => new RegExp(parts.join(""), "i"),
);

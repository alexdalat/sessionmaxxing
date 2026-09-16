import {
  AUTO_OUTPUT_TOKENS,
  DEFAULT_MAX_TURNS,
  type TaskInput,
} from "@/shared/types";

const TITLE_MAX = 120;
const ELLIPSIS = "…";
const TRAILING_PUNCTUATION = /[\s.,;:!?…—–-]+$/;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function quickTitle(prompt: string) {
  const firstLine = collapse(prompt.split("\n")[0]);
  const source = (firstLine || collapse(prompt)).replace(
    TRAILING_PUNCTUATION,
    "",
  );
  if (source.length <= TITLE_MAX) return source;
  const clipped = source.slice(0, TITLE_MAX - ELLIPSIS.length);
  const lastSpace = clipped.lastIndexOf(" ");
  const cut = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.replace(TRAILING_PUNCTUATION, "")}${ELLIPSIS}`;
}

/** Task the overview quick-add queues for a bare prompt; null when the text is blank. */
export function quickTask(
  text: string,
  { workdir, model }: { workdir: string; model: string },
): TaskInput | null {
  const prompt = text.trim();
  if (!prompt) return null;
  return {
    title: quickTitle(prompt),
    prompt,
    workdir,
    provider: "claude",
    model,
    priority: 0,
    earliestStart: null,
    preferredWindowStart: null,
    maxTurns: DEFAULT_MAX_TURNS,
    outputTokens: AUTO_OUTPUT_TOKENS,
  };
}

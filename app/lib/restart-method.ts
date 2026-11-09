import type { RestartMethod } from "@/shared/types";

export type RestartKind = RestartMethod["kind"];

export const RESTART_KIND_LABELS: Record<RestartKind, string> = {
  none: "None",
  compose: "Docker Compose",
  command: "Command",
};

export const RESTART_KINDS = Object.keys(RESTART_KIND_LABELS) as RestartKind[];

/** One argument per line; the server rejects the empty ones, so none are dropped here. */
export const argvFromText = (text: string) =>
  text.split("\n").map((line) => line.replace(/\r$/, ""));

export const textFromArgv = (argv: string[]) => argv.join("\n");

export function restartDraft(kind: RestartKind, text: string): RestartMethod {
  if (kind === "command") return { kind, argv: argvFromText(text) };
  return { kind };
}

export function sameRestartMethod(a: RestartMethod, b: RestartMethod) {
  if (a.kind !== "command" || b.kind !== "command") return a.kind === b.kind;
  return (
    a.argv.length === b.argv.length &&
    a.argv.every((argument, index) => argument === b.argv[index])
  );
}

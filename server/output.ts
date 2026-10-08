import { counter } from "./parser.js";

const MAX_LINE = 16_384;
const MAX_PREVIEW = 8192;
const MAX_LINES = 80;
export const MAX_SUMMARY_CHARS = 8000;
const ELLIPSIS = "…";
/** The tail of the text, which is where a provider's closing summary sits. */
const capTail = (text: string) =>
  text.length <= MAX_SUMMARY_CHARS
    ? text
    : ELLIPSIS + text.slice(text.length - MAX_SUMMARY_CHARS + ELLIPSIS.length);
type Channel = "stdout" | "stderr";
export function safePreviewLine(line: string): boolean {
  return /^(?:\[redacted (?:stdout|stderr|oversized output)\]|Provider initialized|Assistant response · output tokens: \d+|Result: (?:completed|failed) · turns: \d+)$/.test(
    line,
  );
}
export class OutputPreview {
  private buffers: Record<Channel, string> = { stdout: "", stderr: "" };
  private dropping: Record<Channel, boolean> = { stdout: false, stderr: false };
  private preview: string[] = [];
  private resultText: string | null = null;
  failed = false;
  constructor(saved: string[] = []) {
    for (const line of saved)
      this.add(safePreviewLine(line) ? line : "[redacted stdout]");
  }
  private add(line: string) {
    if (this.preview.at(-1) === line && line.startsWith("[redacted")) return;
    this.preview.push(line);
    while (
      this.preview.length > MAX_LINES ||
      this.preview.join("\n").length > MAX_PREVIEW
    )
      this.preview.shift();
  }
  private consume(channel: Channel, line: string) {
    if (!line.trim()) return;
    if (channel === "stdout") {
      try {
        const event = JSON.parse(line);
        if (event?.type === "system" && event.subtype === "init") {
          this.add("Provider initialized");
          return;
        }
        if (event?.type === "assistant") {
          this.add(
            `Assistant response · output tokens: ${counter(event.message?.usage?.output_tokens)}`,
          );
          return;
        }
        if (event?.type === "result") {
          this.failed ||= event.is_error === true;
          if (typeof event.result === "string" && event.result.trim())
            this.resultText = capTail(event.result);
          this.add(
            `Result: ${event.is_error === true ? "failed" : "completed"} · turns: ${counter(event.num_turns)}`,
          );
          return;
        }
      } catch {
        this.add("[redacted stdout]");
        return;
      }
    }
    this.add(`[redacted ${channel}]`);
  }
  push(channel: Channel, chunk: string) {
    const pieces = chunk.split("\n");
    for (let i = 0; i < pieces.length; i++) {
      if (!this.dropping[channel]) {
        if (this.buffers[channel].length + pieces[i].length > MAX_LINE) {
          this.buffers[channel] = "";
          this.dropping[channel] = true;
          this.add("[redacted oversized output]");
        } else this.buffers[channel] += pieces[i];
      }
      if (i < pieces.length - 1) {
        if (!this.dropping[channel])
          this.consume(channel, this.buffers[channel]);
        this.buffers[channel] = "";
        this.dropping[channel] = false;
      }
    }
  }
  flush() {
    for (const channel of ["stdout", "stderr"] as const) {
      if (!this.dropping[channel]) this.consume(channel, this.buffers[channel]);
      this.buffers[channel] = "";
    }
  }
  lines() {
    return [...this.preview];
  }
  /** Claude's closing message from its result event. */
  summary(): string | null {
    return this.resultText;
  }
}

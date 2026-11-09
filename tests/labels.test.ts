import { describe, expect, it } from "vitest";
import { ACTION_LABELS, FIELD_LABELS } from "../app/lib/labels";

const VERBS = [
  "Add",
  "Queue",
  "Queuing",
  "Run",
  "Edit",
  "Delete",
  "Cancel",
  "Save",
  "Saving",
  "Discard",
  "Close",
  "Keep",
  "Refresh",
  "Refreshing",
  "Reload",
  "Mark",
  "Retry",
  "Commit",
  "Show",
  "Skip",
];
const ELLIPSIS = "…";
const MIN_WORDS = 2;
const MAX_WORDS = 3;

const labels = Object.entries(ACTION_LABELS);
const words = (label: string) => label.replace(ELLIPSIS, "").split(" ");

describe("ACTION_LABELS", () => {
  it.each(labels)("%s is two or three words", (_key, label) => {
    expect(words(label).length).toBeGreaterThanOrEqual(MIN_WORDS);
    expect(words(label).length).toBeLessThanOrEqual(MAX_WORDS);
  });

  it.each(labels)("%s starts with a verb from the contract", (_key, label) => {
    expect(VERBS).toContain(words(label)[0]);
  });

  it.each(labels)("%s is sentence case", (_key, label) => {
    const [first, ...rest] = words(label);
    expect(first[0]).toBe(first[0].toUpperCase());
    for (const word of rest) expect(word[0]).toBe(word[0].toLowerCase());
  });

  it("gives no two keys the same label", () => {
    const values = labels.map(([, label]) => label);
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses the single ellipsis character for busy labels", () => {
    expect(ACTION_LABELS.queuingTask).toBe("Queuing task…");
    expect(ACTION_LABELS.savingTask).toBe("Saving task…");
    expect(ACTION_LABELS.refreshingUsage).toBe("Refreshing usage…");
    expect(Object.values(ACTION_LABELS).join("")).not.toContain("...");
  });

  it("holds the labels the Runs route and dialogs read", () => {
    expect(ACTION_LABELS.runTask).toBe("Run task");
    expect(ACTION_LABELS.closeDialog).toBe("Close dialog");
    expect(ACTION_LABELS.reloadRuns).toBe("Reload runs");
    expect(ACTION_LABELS.savingSettings).toBe("Saving settings…");
    expect(ACTION_LABELS.markRunReviewed).toBe("Mark run reviewed");
    expect(ACTION_LABELS.retryRun).toBe("Retry run");
    expect(ACTION_LABELS.commitChanges).toBe("Commit changes");
    expect(ACTION_LABELS.showPrompt).toBe("Show prompt");
    expect(ACTION_LABELS.showRestartOutput).toBe("Show restart output");
    expect(ACTION_LABELS.showChangedFiles).toBe("Show changed files");
    expect(ACTION_LABELS.skipToContent).toBe("Skip to content");
  });
});

describe("FIELD_LABELS", () => {
  it("names the four field controls", () => {
    expect(FIELD_LABELS).toEqual({
      range: "Range",
      breakdown: "Breakdown",
      model: "Model",
      filterTasks: "Filter tasks",
    });
  });
});

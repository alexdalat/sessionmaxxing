import { useState } from "react";
import type { Provider, PublicTask, TaskInput } from "../shared/types";
import { HOURS } from "../shared/types";
import { hour } from "./time";
export function TaskForm({
  task,
  initialWindow,
  onSave,
  busy,
  onCancel,
}: {
  task?: PublicTask;
  initialWindow?: number;
  onSave: (input: TaskInput | Partial<TaskInput>) => Promise<boolean>;
  busy: boolean;
  onCancel?: () => void;
}) {
  const [provider, setProvider] = useState<Provider>(
    task?.provider ?? "claude",
  );
  const [model, setModel] = useState(task?.model ?? "opus");
  const browserDate = task?.earliestStart
    ? new Date(
        Date.parse(task.earliestStart) -
          new Date(task.earliestStart).getTimezoneOffset() * 60_000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  return (
    <form
      className="panel task-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = new FormData(form);
        const prompt = String(fields.get("prompt"));
        const workdir = String(fields.get("workdir")).trim();
        const earliest = String(fields.get("earliestStart"));
        const window = String(fields.get("preferredWindowStart"));
        const parsedEarliest = earliest ? Date.parse(earliest) : Number.NaN;
        const input = {
          title: String(fields.get("title")),
          ...(prompt ? { prompt } : {}),
          provider,
          model,
          ...(!task || workdir ? { workdir } : {}),
          priority: Number(fields.get("priority")),
          maxTurns: Number(fields.get("maxTurns")),
          earliestStart: Number.isFinite(parsedEarliest)
            ? new Date(parsedEarliest).toISOString()
            : null,
          preferredWindowStart: window === "" ? null : Number(window),
        };
        if (await onSave(input)) {
          form.reset();
          if (!task) {
            setProvider("claude");
            setModel("opus");
          }
        }
      }}
    >
      <h2>{task ? "Edit pending task" : "Create task"}</h2>
      <div className="form-grid">
        <label className="full">
          Title
          <input
            name="title"
            required
            maxLength={120}
            defaultValue={task?.title}
            placeholder="A short, recognizable task name"
          />
        </label>
        <label className="full">
          {task ? "Replacement prompt (optional)" : "Prompt"}
          <textarea
            name="prompt"
            required={!task}
            maxLength={50000}
            rows={4}
            placeholder={
              task
                ? "Leave blank to keep the saved prompt"
                : "Describe the coding task…"
            }
          />
        </label>
        <p className="muted full">
          Prompts stay on the local server after saving and are never returned
          to this page.
        </p>
        <label className="full">
          {task ? "Replacement work directory (optional)" : "Work directory"}
          <input
            name="workdir"
            required={!task}
            defaultValue={task ? "" : "/home/user/workspace"}
            placeholder={
              task
                ? "Leave blank to keep the saved directory"
                : "/home/user/workspace/project"
            }
          />
        </label>
        <label>
          Provider
          <select
            name="provider"
            value={provider}
            onChange={(e) => {
              const p = e.target.value as Provider;
              setProvider(p);
              setModel(p === "claude" ? "opus" : "gpt-6-astra");
            }}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label>
          Model
          <input
            name="model"
            required
            pattern="[a-zA-Z0-9][a-zA-Z0-9._:\-]{0,79}"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label>
          Priority (lower runs first)
          <input
            name="priority"
            type="number"
            min={0}
            max={1000000}
            required
            defaultValue={task?.priority ?? 0}
          />
        </label>
        <label>
          Maximum turns
          <input
            name="maxTurns"
            type="number"
            min={1}
            max={1000}
            required
            defaultValue={task?.maxTurns ?? 20}
          />
        </label>
        <label>
          Earliest start (browser local time)
          <input
            name="earliestStart"
            type="datetime-local"
            defaultValue={browserDate}
          />
        </label>
        <label>
          Preferred five-hour window (Eastern)
          <select
            name="preferredWindowStart"
            defaultValue={task?.preferredWindowStart ?? initialWindow ?? ""}
          >
            <option value="">Any time</option>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hour(h)} → {hour((h + 5) % 24)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {provider === "codex" && (
        <p className="muted">
          Codex uses workspace-write with approvals disabled. Maximum turns
          applies to Claude only.
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Saving…" : task ? "Save changes" : "Add task"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel edit
          </button>
        )}
      </div>
    </form>
  );
}

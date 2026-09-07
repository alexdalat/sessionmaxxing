"use client";
import { useEffect, useRef, useState } from "react";
import type { Provider, PublicTask, TaskInput } from "../shared/types";
import { HOURS, PROVIDER_MODELS } from "../shared/types";
import { hour } from "./time";

const DEFAULT_MODEL: Record<Provider, string> = {
  claude: "opus",
  codex: PROVIDER_MODELS.codex[0].value,
};

export function modelOptions(provider: Provider, current?: string) {
  const options = PROVIDER_MODELS[provider];
  if (!current || options.some((option) => option.value === current))
    return options;
  return [...options, { value: current, label: current }];
}

export function TaskFormDialog({
  open,
  task,
  onSave,
  busy,
  onClose,
}: {
  open: boolean;
  task?: PublicTask;
  onSave: (input: TaskInput | Partial<TaskInput>) => Promise<boolean>;
  busy: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [provider, setProvider] = useState<Provider>(
    task?.provider ?? "claude",
  );
  const [model, setModel] = useState(task?.model ?? DEFAULT_MODEL.claude);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const browserDate = task?.earliestStart
    ? new Date(
        Date.parse(task.earliestStart) -
          new Date(task.earliestStart).getTimezoneOffset() * 60_000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users close with Escape via onCancel
    <dialog
      ref={dialogRef}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="modal-body">
        <form
          className="task-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const fields = new FormData(form);
            const earliest = String(fields.get("earliestStart"));
            const window = String(fields.get("preferredWindowStart"));
            const parsedEarliest = earliest ? Date.parse(earliest) : Number.NaN;
            const input = {
              title: String(fields.get("title")),
              prompt: String(fields.get("prompt")),
              provider,
              model,
              workdir: String(fields.get("workdir")).trim(),
              priority: Number(fields.get("priority")),
              maxTurns: Number(fields.get("maxTurns")),
              earliestStart: Number.isFinite(parsedEarliest)
                ? new Date(parsedEarliest).toISOString()
                : null,
              preferredWindowStart: window === "" ? null : Number(window),
            };
            if (await onSave(input)) onClose();
          }}
        >
          <h2>{task ? "Edit task" : "Add task"}</h2>
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
              Prompt
              <textarea
                name="prompt"
                required
                maxLength={50000}
                rows={4}
                defaultValue={task?.prompt}
                placeholder="Describe the coding task…"
              />
            </label>
            <label className="full">
              Work directory
              <input
                name="workdir"
                required
                defaultValue={task?.workdir ?? "/home/user/workspace"}
                placeholder="/home/user/workspace/project"
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
                  setModel(DEFAULT_MODEL[p]);
                }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              Model
              <select
                name="model"
                required
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {modelOptions(provider, model).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
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
                defaultValue={task?.preferredWindowStart ?? ""}
              >
                <option value="">Any quiet hour (automatic)</option>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hour(h)} → {hour((h + 5) % 24)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Saving…" : task ? "Save changes" : "Add task"}
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

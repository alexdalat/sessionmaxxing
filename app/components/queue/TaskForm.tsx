"use client";
import { useId, useState } from "react";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Textarea } from "@/app/components/ui/textarea";
import { modelOptions } from "@/app/lib/models";
import type { Provider, PublicTask, TaskInput } from "@/shared/types";
import { HOURS, hourLabel, PROVIDER_MODELS } from "@/shared/types";

const DEFAULT_MODEL: Record<Provider, string> = {
  claude: "opus",
  codex: PROVIDER_MODELS.codex[0].value,
};

const ANY_WINDOW = "any";

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
  const fieldId = useId();
  const [provider, setProvider] = useState<Provider>(
    task?.provider ?? "claude",
  );
  const [model, setModel] = useState(task?.model ?? DEFAULT_MODEL.claude);
  const [windowStart, setWindowStart] = useState(
    String(task?.preferredWindowStart ?? ANY_WINDOW),
  );
  const browserDate = task?.earliestStart
    ? new Date(
        Date.parse(task.earliestStart) -
          new Date(task.earliestStart).getTimezoneOffset() * 60_000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[640px]"
      >
        <DialogHeader>
          <DialogTitle>{task ? "Edit task" : "Add task"}</DialogTitle>
        </DialogHeader>
        <form
          className="task-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const fields = new FormData(form);
            const earliest = String(fields.get("earliestStart"));
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
              preferredWindowStart:
                windowStart === ANY_WINDOW ? null : Number(windowStart),
            };
            if (await onSave(input)) onClose();
          }}
        >
          <div className="form-grid">
            <div className="full grid gap-1.5">
              <Label htmlFor={`${fieldId}-title`}>Title</Label>
              <Input
                id={`${fieldId}-title`}
                name="title"
                required
                maxLength={120}
                defaultValue={task?.title}
                placeholder="Task name"
              />
            </div>
            <div className="full grid gap-1.5">
              <Label htmlFor={`${fieldId}-prompt`}>Prompt</Label>
              <Textarea
                id={`${fieldId}-prompt`}
                name="prompt"
                required
                maxLength={50000}
                rows={4}
                defaultValue={task?.prompt}
                placeholder="What Claude Code should do"
              />
            </div>
            <div className="full grid gap-1.5">
              <Label htmlFor={`${fieldId}-workdir`}>Work directory</Label>
              <Input
                id={`${fieldId}-workdir`}
                name="workdir"
                required
                defaultValue={task?.workdir ?? "/home/user/workspace"}
                placeholder="/home/user/workspace/project"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-provider`}>Provider</Label>
              <Select
                name="provider"
                value={provider}
                onValueChange={(value) => {
                  const next = value as Provider;
                  setProvider(next);
                  setModel(DEFAULT_MODEL[next]);
                }}
              >
                <SelectTrigger id={`${fieldId}-provider`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-model`}>Model</Label>
              <Select
                name="model"
                required
                value={model}
                onValueChange={setModel}
              >
                <SelectTrigger id={`${fieldId}-model`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions(provider, model).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-priority`}>
                Priority (lower runs first)
              </Label>
              <Input
                id={`${fieldId}-priority`}
                name="priority"
                type="number"
                min={0}
                max={1000000}
                required
                defaultValue={task?.priority ?? 0}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-max-turns`}>Maximum turns</Label>
              <Input
                id={`${fieldId}-max-turns`}
                name="maxTurns"
                type="number"
                min={1}
                max={1000}
                required
                defaultValue={task?.maxTurns ?? 20}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-earliest-start`}>
                Earliest start (local time)
              </Label>
              <Input
                id={`${fieldId}-earliest-start`}
                name="earliestStart"
                type="datetime-local"
                defaultValue={browserDate}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-window`}>
                Preferred five-hour window (Eastern)
              </Label>
              <Select
                name="preferredWindowStart"
                value={windowStart}
                onValueChange={setWindowStart}
              >
                <SelectTrigger id={`${fieldId}-window`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_WINDOW}>Any quiet hour</SelectItem>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hourLabel(h)} → {hourLabel((h + 5) % 24)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="actions">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : task ? "Save changes" : "Add task"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

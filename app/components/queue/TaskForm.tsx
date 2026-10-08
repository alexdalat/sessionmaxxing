"use client";
import { useId, useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Checkbox } from "@/app/components/ui/checkbox";
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
import type { PublicTask, TaskInput } from "@/shared/types";
import {
  AUTO_TOKENS,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  formatTokens,
  HOURS,
  hourLabel,
} from "@/shared/types";
import { WorkdirField } from "./WorkdirField";

const ANY_WINDOW = "any";
const TOKEN_PRESETS = [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];

export function TaskFormDialog({
  open,
  task,
  tasks,
  onSave,
  busy,
  onClose,
}: {
  open: boolean;
  task?: PublicTask;
  tasks: PublicTask[];
  onSave: (input: TaskInput | Partial<TaskInput>) => Promise<boolean>;
  busy: boolean;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [model, setModel] = useState(task?.model ?? DEFAULT_MODEL);
  const [windowStart, setWindowStart] = useState(
    String(task?.preferredWindowStart ?? ANY_WINDOW),
  );
  const [workdir, setWorkdir] = useState(task?.workdir ?? "");
  const [tokens, setTokens] = useState(
    task ? String(task.tokens) : AUTO_TOKENS,
  );
  const [dependsOn, setDependsOn] = useState<string[]>(task?.dependsOn ?? []);
  const dependencyOptions = tasks.filter(
    (candidate) =>
      candidate.id !== task?.id &&
      (candidate.status === "pending" ||
        candidate.status === "running" ||
        dependsOn.includes(candidate.id)),
  );
  const tokenChoices =
    task && !TOKEN_PRESETS.includes(task.tokens)
      ? [...TOKEN_PRESETS, task.tokens].sort((a, b) => a - b)
      : TOKEN_PRESETS;
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
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[640px]"
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
            const input: TaskInput = {
              title: String(fields.get("title")),
              prompt: String(fields.get("prompt")),
              model,
              workdir: String(fields.get("workdir")).trim(),
              priority: Number(fields.get("priority")),
              maxTurns: Number(fields.get("maxTurns")),
              tokens: tokens === AUTO_TOKENS ? AUTO_TOKENS : Number(tokens),
              earliestStart: Number.isFinite(parsedEarliest)
                ? new Date(parsedEarliest).toISOString()
                : null,
              preferredWindowStart:
                windowStart === ANY_WINDOW ? null : Number(windowStart),
              dependsOn,
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
              <WorkdirField
                id={`${fieldId}-workdir`}
                value={workdir}
                onChange={setWorkdir}
                defaultToRecent={!task}
              />
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
                  {modelOptions(model).map((option) => (
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
                defaultValue={task?.maxTurns ?? DEFAULT_MAX_TURNS}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-tokens`}>Tokens</Label>
              <Select name="tokens" value={tokens} onValueChange={setTokens}>
                <SelectTrigger id={`${fieldId}-tokens`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_TOKENS}>Auto</SelectItem>
                  {tokenChoices.map((choice) => (
                    <SelectItem key={choice} value={String(choice)}>
                      {formatTokens(choice)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                Preferred five-hour window (ET)
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
                  <SelectItem value={ANY_WINDOW}>Any hour</SelectItem>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hourLabel(h)} → {hourLabel((h + 5) % 24)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {dependencyOptions.length > 0 && (
              <div className="full grid gap-1.5">
                <Label>Depends on</Label>
                <div className="grid max-h-40 gap-2 overflow-y-auto rounded-md border border-input p-3">
                  {dependencyOptions.map((option) => (
                    <div key={option.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`${fieldId}-depends-${option.id}`}
                        checked={dependsOn.includes(option.id)}
                        onCheckedChange={(checked) =>
                          setDependsOn((ids) =>
                            checked === true
                              ? [...ids, option.id]
                              : ids.filter((id) => id !== option.id),
                          )
                        }
                      />
                      <Label
                        htmlFor={`${fieldId}-depends-${option.id}`}
                        className="font-normal"
                      >
                        {option.title}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>
            )}
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

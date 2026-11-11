"use client";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { Button } from "@/app/components/ui/button";
import { Checkbox } from "@/app/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
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
import { useClock } from "@/app/hooks/useClock";
import { api } from "@/app/lib/api";
import { ACTION_LABELS, FIELD_LABELS } from "@/app/lib/labels";
import { modelOptions } from "@/app/lib/models";
import {
  RESTART_KIND_LABELS,
  RESTART_KINDS,
  type RestartKind,
  restartDraft,
  sameRestartMethod,
  textFromArgv,
} from "@/app/lib/restart-method";
import { earliestStartFromInput, earliestStartInput } from "@/app/lib/schedule";
import { zoneName } from "@/shared/local-time";
import type { PublicTask, RestartMethod, TaskInput } from "@/shared/types";
import {
  AUTO_TOKENS,
  DEFAULT_COMMIT,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  formatTokens,
  HOURS,
  hourLabel,
} from "@/shared/types";
import { DEBOUNCE_MS, WorkdirField } from "./WorkdirField";

const RESTART_METHODS_PATH = "/api/restart-methods";
const ANY_WINDOW = "any";

interface LoadedMethod {
  workdir: string;
  method: RestartMethod;
}

const failureMessage = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback;
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
  const taskTokens = task?.tokens ?? null;
  const [tokens, setTokens] = useState(
    taskTokens === null ? AUTO_TOKENS : String(taskTokens),
  );
  const [dependsOn, setDependsOn] = useState<string[]>(task?.dependsOn ?? []);
  const [commit, setCommit] = useState(task?.commit ?? DEFAULT_COMMIT);
  const [probe, setProbe] = useState(workdir.trim());
  const [loaded, setLoaded] = useState<LoadedMethod>();
  const [restartKind, setRestartKind] = useState<RestartKind>("none");
  const [commandText, setCommandText] = useState("");
  const [restartError, setRestartError] = useState("");
  const [savingMethod, setSavingMethod] = useState(false);
  const methodReady = loaded?.workdir === workdir.trim();

  useEffect(() => {
    const timer = setTimeout(() => setProbe(workdir.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [workdir]);

  useEffect(() => {
    setRestartKind("none");
    setCommandText("");
    if (!probe) return;
    let live = true;
    api<{ method: RestartMethod }>(
      `${RESTART_METHODS_PATH}?workdir=${encodeURIComponent(probe)}`,
    )
      .then(({ method }) => {
        if (!live) return;
        setLoaded({ workdir: probe, method });
        setRestartKind(method.kind);
        setCommandText(
          method.kind === "command" ? textFromArgv(method.argv) : "",
        );
        setRestartError("");
      })
      .catch((failure: unknown) => {
        if (!live) return;
        setLoaded(undefined);
        setRestartError(
          failureMessage(failure, "Could not load the restart method."),
        );
      });
    return () => {
      live = false;
    };
  }, [probe]);

  const dependencyOptions = tasks.filter(
    (candidate) =>
      candidate.id !== task?.id &&
      (candidate.status === "pending" ||
        candidate.status === "running" ||
        dependsOn.includes(candidate.id)),
  );
  const tokenChoices =
    taskTokens !== null && !TOKEN_PRESETS.includes(taskTokens)
      ? [...TOKEN_PRESETS, taskTokens].sort((a, b) => a - b)
      : TOKEN_PRESETS;
  const { timeZone, edition } = useEnvironment();
  const now = useClock();
  const zoneLabel = zoneName(timeZone, now);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
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
            const input: TaskInput = {
              title: String(fields.get("title")),
              prompt: String(fields.get("prompt")),
              model,
              workdir: String(fields.get("workdir")).trim(),
              priority: Number(fields.get("priority")),
              maxTurns: Number(fields.get("maxTurns")),
              ...(edition === "full" && {
                tokens: tokens === AUTO_TOKENS ? AUTO_TOKENS : Number(tokens),
              }),
              earliestStart: earliestStartFromInput(
                String(fields.get("earliestStart")),
                timeZone,
              ),
              preferredWindowStart:
                windowStart === ANY_WINDOW ? null : Number(windowStart),
              dependsOn,
              commit,
            };
            const draft = restartDraft(restartKind, commandText);
            if (
              loaded?.workdir === input.workdir &&
              !sameRestartMethod(draft, loaded.method)
            ) {
              setSavingMethod(true);
              try {
                const saved = await api<{ method: RestartMethod }>(
                  RESTART_METHODS_PATH,
                  {
                    method: "PUT",
                    body: JSON.stringify({
                      workdir: input.workdir,
                      method: draft,
                    }),
                  },
                );
                setLoaded({ workdir: input.workdir, method: saved.method });
                setRestartError("");
              } catch (failure) {
                setRestartError(
                  failureMessage(failure, "Could not save the restart method."),
                );
                return;
              } finally {
                setSavingMethod(false);
              }
            }
            if (await onSave(input)) onClose();
          }}
        >
          <div className="form-grid">
            <div className="full grid gap-2">
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
            <div className="full grid gap-2">
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
            <div className="full grid gap-2">
              <Label htmlFor={`${fieldId}-workdir`}>Work directory</Label>
              <WorkdirField
                id={`${fieldId}-workdir`}
                value={workdir}
                onChange={setWorkdir}
                defaultToRecent={!task}
              />
            </div>
            <div className="full grid gap-2">
              <Label htmlFor={`${fieldId}-restart`}>Restart</Label>
              <Select
                value={restartKind}
                disabled={!methodReady}
                onValueChange={(next) => setRestartKind(next as RestartKind)}
              >
                <SelectTrigger id={`${fieldId}-restart`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESTART_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {RESTART_KIND_LABELS[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {restartError && (
                <p className="error mb-0" role="alert">
                  {restartError}
                </p>
              )}
            </div>
            {restartKind === "command" && (
              <div className="full grid gap-2">
                <Label htmlFor={`${fieldId}-command`}>Command</Label>
                <Textarea
                  id={`${fieldId}-command`}
                  className="font-mono"
                  rows={3}
                  disabled={!methodReady}
                  value={commandText}
                  onChange={(event) => setCommandText(event.target.value)}
                />
              </div>
            )}
            <div className="full flex items-center gap-2">
              <Checkbox
                id={`${fieldId}-commit`}
                checked={commit}
                onCheckedChange={(checked) => setCommit(checked === true)}
              />
              <Label htmlFor={`${fieldId}-commit`} className="font-normal">
                {FIELD_LABELS.commit}
              </Label>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${fieldId}-model`}>{FIELD_LABELS.model}</Label>
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
            <div className="grid gap-2">
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
            <div className="grid gap-2">
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
            {edition === "full" && (
              <div className="grid gap-2">
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
            )}
            <div className="grid gap-2">
              <Label htmlFor={`${fieldId}-earliest-start`}>
                Earliest start ({zoneLabel})
              </Label>
              <Input
                id={`${fieldId}-earliest-start`}
                name="earliestStart"
                type="datetime-local"
                defaultValue={earliestStartInput(
                  task?.earliestStart ?? null,
                  timeZone,
                )}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${fieldId}-window`}>
                Preferred five-hour window ({zoneLabel})
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
              <div className="full grid gap-2">
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
            <Button type="button" variant="secondary" onClick={onClose}>
              {ACTION_LABELS.discardChanges}
            </Button>
            <Button type="submit" disabled={busy || savingMethod}>
              {busy
                ? ACTION_LABELS.savingTask
                : task
                  ? ACTION_LABELS.saveChanges
                  : ACTION_LABELS.addTask}
            </Button>
          </div>
        </form>
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="dialog-close"
            aria-label={ACTION_LABELS.closeDialog}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

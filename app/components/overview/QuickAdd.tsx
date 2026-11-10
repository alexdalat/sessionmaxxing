"use client";
import { useId, useRef, useState } from "react";
import { WorkdirField } from "@/app/components/queue/WorkdirField";
import { Button } from "@/app/components/ui/button";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Textarea } from "@/app/components/ui/textarea";
import { useNotice } from "@/app/hooks/useNotice";
import { api, QUEUE_CHANGED } from "@/app/lib/api";
import { ACTION_LABELS, FIELD_LABELS } from "@/app/lib/labels";
import { modelOptions } from "@/app/lib/models";
import { quickTask } from "@/app/lib/quickTask";
import { DEFAULT_MODEL } from "@/shared/types";

const PROMPT_MAX = 50_000;

export function QuickAdd({ onQueued }: { onQueued: () => void }) {
  const fieldId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [prompt, setPrompt] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useNotice();
  const input = quickTask(prompt, { workdir, model });
  return (
    <section aria-label="Quick add">
      <form
        ref={formRef}
        className="composer"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!input) return;
          setBusy(true);
          setError("");
          setNotice("");
          try {
            await api("/api/tasks", {
              method: "POST",
              body: JSON.stringify(input),
            });
            setPrompt("");
            setNotice("Task queued");
            onQueued();
            window.dispatchEvent(new Event(QUEUE_CHANGED));
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Label htmlFor={`${fieldId}-prompt`} className="sr-only">
          Prompt
        </Label>
        <Textarea
          id={`${fieldId}-prompt`}
          name="prompt"
          placeholder="New task"
          required
          rows={1}
          maxLength={PROMPT_MAX}
          value={prompt}
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              formRef.current?.requestSubmit();
          }}
        />
        {prompt.trim() && (
          <div className="composer-row">
            <div className="composer-workdir">
              <Label htmlFor={`${fieldId}-workdir`} className="sr-only">
                Work directory
              </Label>
              <WorkdirField
                id={`${fieldId}-workdir`}
                value={workdir}
                onChange={setWorkdir}
                defaultToRecent
              />
            </div>
            <Label htmlFor={`${fieldId}-model`} className="sr-only">
              {FIELD_LABELS.model}
            </Label>
            <Select name="model" value={model} onValueChange={setModel}>
              <SelectTrigger id={`${fieldId}-model`}>
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
            <Button
              type="submit"
              size="sm"
              className="composer-submit"
              disabled={busy || !input}
            >
              {busy ? ACTION_LABELS.queuingTask : ACTION_LABELS.queueTask}
            </Button>
          </div>
        )}
      </form>
      {error && (
        <p className="error mt-3" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="toast">
          {notice}
        </p>
      )}
    </section>
  );
}

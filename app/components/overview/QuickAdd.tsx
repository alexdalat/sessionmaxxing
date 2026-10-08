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
import { modelOptions } from "@/app/lib/models";
import { quickTask } from "@/app/lib/quickTask";
import { DEFAULT_MODEL } from "@/shared/types";

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
    <section className="panel" aria-label="Quick add">
      <div className="section-heading">
        <h2>Quick add</h2>
      </div>
      <form
        ref={formRef}
        className="form-grid"
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
            setNotice("Task added.");
            onQueued();
            window.dispatchEvent(new Event(QUEUE_CHANGED));
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : "Could not queue.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="full grid gap-1.5">
          <Label htmlFor={`${fieldId}-prompt`}>Prompt</Label>
          <Textarea
            id={`${fieldId}-prompt`}
            name="prompt"
            required
            rows={3}
            maxLength={50000}
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                formRef.current?.requestSubmit();
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${fieldId}-workdir`}>Work directory</Label>
          <WorkdirField
            id={`${fieldId}-workdir`}
            value={workdir}
            onChange={setWorkdir}
            defaultToRecent
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${fieldId}-model`}>Model</Label>
          <Select name="model" value={model} onValueChange={setModel}>
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
        <div className="actions full">
          <Button type="submit" disabled={busy || !input}>
            {busy ? "Queuing…" : "Queue"}
          </Button>
        </div>
        {error && (
          <p className="error full mb-0" role="alert">
            {error}
          </p>
        )}
      </form>
      {notice && (
        <p role="status" className="toast">
          {notice}
        </p>
      )}
    </section>
  );
}

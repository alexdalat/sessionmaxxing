"use client";
import { useEffect, useId, useState } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
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
  readCachedAnalytics,
  writeCachedAnalytics,
} from "@/app/lib/analyticsCache";
import { api } from "@/app/lib/api";
import {
  type Analytics,
  type DispatchSettings,
  MAX_BUSY_HOURS_RESERVE_PERCENT,
  MAX_CONCURRENT_RUNS,
  MAX_QUIET_START_HOURS,
  MAX_RUN_COST_PERCENT,
  MAX_SESSION_RESERVE_PERCENT,
  MAX_WEEKLY_MARGIN_PERCENT,
  type Opportunity,
  type PlanningSnapshot,
  type RangeDays,
} from "@/shared/types";
import { QuietHoursStrip } from "./QuietHoursStrip";

const ANALYTICS_DAYS: RangeDays = 30;

function useQuietOpportunities(open: boolean) {
  const [opportunities, setOpportunities] = useState<Opportunity[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    const cached = readCachedAnalytics(localStorage, ANALYTICS_DAYS);
    if (cached) setOpportunities(cached.opportunities);
    api<Analytics>(`/api/analytics?days=${ANALYTICS_DAYS}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        setOpportunities(value.opportunities);
        writeCachedAnalytics(localStorage, ANALYTICS_DAYS, value);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setError((failure as Error).message);
      });
    return () => controller.abort();
  }, [open]);
  return { opportunities, error };
}

const draftFrom = (settings: DispatchSettings) => ({
  autoApply: settings.autoApply,
  keepSessionActive: settings.keepSessionActive,
  sessionReservePercent: String(settings.sessionReservePercent),
  busyHoursReservePercent: String(settings.busyHoursReservePercent),
  weeklyMarginPercent: String(settings.weeklyMarginPercent),
  quietStartHours: String(settings.quietStartHours),
  maxConcurrentRuns: String(settings.maxConcurrentRuns),
  runWeeklyCostPercent: String(settings.runWeeklyCostPercent),
  runSessionHoldPercent: String(settings.runSessionHoldPercent),
});

type Draft = ReturnType<typeof draftFrom>;

interface NumberFieldSpec {
  key: keyof Omit<Draft, "autoApply" | "keepSessionActive">;
  label: string;
  min: number;
  max: number;
  step: number | "any";
}

const SESSION_RESERVE_LITE: NumberFieldSpec = {
  key: "sessionReservePercent",
  label: "Session kept for you (%)",
  min: 0,
  max: MAX_SESSION_RESERVE_PERCENT,
  step: "any",
};
const SESSION_RESERVE_FULL: NumberFieldSpec = {
  ...SESSION_RESERVE_LITE,
  label: "Session kept for you in quiet hours (%)",
};
const SESSION_HOLD: NumberFieldSpec = {
  key: "runSessionHoldPercent",
  label: "Session held per running Claude task (%)",
  min: 0,
  max: MAX_RUN_COST_PERCENT,
  step: "any",
};
const BUSY_RESERVE: NumberFieldSpec = {
  key: "busyHoursReservePercent",
  label: "Session kept for you outside quiet hours (%)",
  min: 0,
  max: MAX_BUSY_HOURS_RESERVE_PERCENT,
  step: "any",
};
const WEEKLY_MARGIN: NumberFieldSpec = {
  key: "weeklyMarginPercent",
  label: "Weekly margin above pace (%)",
  min: 0,
  max: MAX_WEEKLY_MARGIN_PERCENT,
  step: "any",
};
const QUIET_START_HOURS: NumberFieldSpec = {
  key: "quietStartHours",
  label: "Quiet start hours per day",
  min: 1,
  max: MAX_QUIET_START_HOURS,
  step: 1,
};
const CONCURRENT_RUNS: NumberFieldSpec = {
  key: "maxConcurrentRuns",
  label: "Tasks running at once",
  min: 1,
  max: MAX_CONCURRENT_RUNS,
  step: 1,
};
const WEEKLY_HOLD: NumberFieldSpec = {
  key: "runWeeklyCostPercent",
  label: "Weekly held per running Claude task (%)",
  min: 0,
  max: MAX_RUN_COST_PERCENT,
  step: "any",
};

const FULL_FIELDS = [
  SESSION_RESERVE_FULL,
  BUSY_RESERVE,
  WEEKLY_MARGIN,
  QUIET_START_HOURS,
  CONCURRENT_RUNS,
  WEEKLY_HOLD,
];
const LITE_FIELDS = [
  SESSION_RESERVE_LITE,
  SESSION_HOLD,
  WEEKLY_MARGIN,
  WEEKLY_HOLD,
  CONCURRENT_RUNS,
];

function QuietHoursField({
  open,
  allowed,
}: {
  open: boolean;
  allowed: number;
}) {
  const quiet = useQuietOpportunities(open);
  return (
    <div className="full">
      <span className="field-label">Quiet hours</span>
      {quiet.error ? (
        <p role="alert" className="error">
          {quiet.error}
        </p>
      ) : (
        <QuietHoursStrip
          opportunities={quiet.opportunities}
          allowed={allowed}
        />
      )}
    </div>
  );
}

export function DispatchSettingsDialog({
  open,
  settings,
  onClose,
  onSaved,
}: {
  open: boolean;
  settings: DispatchSettings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const fieldId = useId();
  const { edition } = useEnvironment();
  const [draft, setDraft] = useState(() => draftFrom(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
          <DialogTitle>Queue settings</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              const body: DispatchSettings = {
                autoApply: draft.autoApply,
                keepSessionActive: draft.keepSessionActive,
                sessionReservePercent: Number(draft.sessionReservePercent),
                busyHoursReservePercent: Number(draft.busyHoursReservePercent),
                weeklyMarginPercent: Number(draft.weeklyMarginPercent),
                quietStartHours: Number(draft.quietStartHours),
                maxConcurrentRuns: Number(draft.maxConcurrentRuns),
                runWeeklyCostPercent: Number(draft.runWeeklyCostPercent),
                runSessionHoldPercent: Number(draft.runSessionHoldPercent),
              };
              await api<PlanningSnapshot>("/api/dispatch-settings", {
                method: "PUT",
                body: JSON.stringify(body),
              });
              onSaved();
              onClose();
            } catch (failure) {
              setError((failure as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <fieldset disabled={busy} className="guardrail-fields">
            <div className="form-grid">
              {(edition === "full" ? FULL_FIELDS : LITE_FIELDS).map((field) => (
                <div key={field.key} className="grid gap-1.5">
                  <Label htmlFor={`${fieldId}-${field.key}`}>
                    {field.label}
                  </Label>
                  <Input
                    id={`${fieldId}-${field.key}`}
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    required
                    value={draft[field.key]}
                    onChange={(event) =>
                      setDraft({ ...draft, [field.key]: event.target.value })
                    }
                  />
                </div>
              ))}
              <div className="full">
                <span className="field-label">
                  Apply and restart without review
                </span>
                <Button
                  type="button"
                  role="switch"
                  aria-checked={draft.autoApply}
                  variant={draft.autoApply ? "default" : "outline"}
                  className="rounded-full"
                  onClick={() =>
                    setDraft({ ...draft, autoApply: !draft.autoApply })
                  }
                >
                  {draft.autoApply ? "On" : "Off"}
                </Button>
              </div>
              <div className="full">
                <span className="field-label">
                  Start each 5-hour session automatically
                </span>
                <Button
                  type="button"
                  role="switch"
                  aria-checked={draft.keepSessionActive}
                  variant={draft.keepSessionActive ? "default" : "outline"}
                  className="rounded-full"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      keepSessionActive: !draft.keepSessionActive,
                    })
                  }
                >
                  {draft.keepSessionActive ? "On" : "Off"}
                </Button>
              </div>
              {edition === "full" && (
                <QuietHoursField
                  open={open}
                  allowed={Number(draft.quietStartHours)}
                />
              )}
            </div>
          </fieldset>
          <div className="actions">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

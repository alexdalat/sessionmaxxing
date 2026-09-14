"use client";
import { useEffect, useId, useState } from "react";
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
  sessionReservePercent: String(settings.sessionReservePercent),
  busyHoursReservePercent: String(settings.busyHoursReservePercent),
  weeklyMarginPercent: String(settings.weeklyMarginPercent),
  quietStartHours: String(settings.quietStartHours),
  maxConcurrentRuns: String(settings.maxConcurrentRuns),
  runSessionCostPercent: String(settings.runSessionCostPercent),
  runWeeklyCostPercent: String(settings.runWeeklyCostPercent),
});

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
  const [draft, setDraft] = useState(() => draftFrom(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const quiet = useQuietOpportunities(open);
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
          <DialogTitle>Queue settings</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api<PlanningSnapshot>("/api/dispatch-settings", {
                method: "PUT",
                body: JSON.stringify({
                  sessionReservePercent: Number(draft.sessionReservePercent),
                  busyHoursReservePercent: Number(
                    draft.busyHoursReservePercent,
                  ),
                  weeklyMarginPercent: Number(draft.weeklyMarginPercent),
                  quietStartHours: Number(draft.quietStartHours),
                  maxConcurrentRuns: Number(draft.maxConcurrentRuns),
                  runSessionCostPercent: Number(draft.runSessionCostPercent),
                  runWeeklyCostPercent: Number(draft.runWeeklyCostPercent),
                }),
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
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldId}-session-reserve`}>
                  Session kept for you in quiet hours (%)
                </Label>
                <Input
                  id={`${fieldId}-session-reserve`}
                  type="number"
                  min={0}
                  max={MAX_SESSION_RESERVE_PERCENT}
                  step="any"
                  required
                  value={draft.sessionReservePercent}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      sessionReservePercent: event.target.value,
                    })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldId}-busy-reserve`}>
                  Session kept for you outside quiet hours (%)
                </Label>
                <Input
                  id={`${fieldId}-busy-reserve`}
                  type="number"
                  min={0}
                  max={MAX_BUSY_HOURS_RESERVE_PERCENT}
                  step="any"
                  required
                  value={draft.busyHoursReservePercent}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      busyHoursReservePercent: event.target.value,
                    })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldId}-weekly-margin`}>
                  Weekly margin above pace (%)
                </Label>
                <Input
                  id={`${fieldId}-weekly-margin`}
                  type="number"
                  min={0}
                  max={MAX_WEEKLY_MARGIN_PERCENT}
                  step="any"
                  required
                  value={draft.weeklyMarginPercent}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      weeklyMarginPercent: event.target.value,
                    })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldId}-quiet-hours`}>
                  Quiet start hours per day
                </Label>
                <Input
                  id={`${fieldId}-quiet-hours`}
                  type="number"
                  min={1}
                  max={MAX_QUIET_START_HOURS}
                  step={1}
                  required
                  value={draft.quietStartHours}
                  onChange={(event) =>
                    setDraft({ ...draft, quietStartHours: event.target.value })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldId}-concurrent-runs`}>
                  Tasks running at once
                </Label>
                <Input
                  id={`${fieldId}-concurrent-runs`}
                  type="number"
                  min={1}
                  max={MAX_CONCURRENT_RUNS}
                  step={1}
                  required
                  value={draft.maxConcurrentRuns}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      maxConcurrentRuns: event.target.value,
                    })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldId}-session-cost`}>
                  Session held per running Claude task (%)
                </Label>
                <Input
                  id={`${fieldId}-session-cost`}
                  type="number"
                  min={0}
                  max={MAX_RUN_COST_PERCENT}
                  step="any"
                  required
                  value={draft.runSessionCostPercent}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      runSessionCostPercent: event.target.value,
                    })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldId}-weekly-cost`}>
                  Weekly held per running Claude task (%)
                </Label>
                <Input
                  id={`${fieldId}-weekly-cost`}
                  type="number"
                  min={0}
                  max={MAX_RUN_COST_PERCENT}
                  step="any"
                  required
                  value={draft.runWeeklyCostPercent}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      runWeeklyCostPercent: event.target.value,
                    })
                  }
                />
              </div>
              <div className="full">
                <span className="field-label">Quiet hours</span>
                {quiet.error ? (
                  <p role="alert" className="error">
                    {quiet.error}
                  </p>
                ) : (
                  <QuietHoursStrip
                    opportunities={quiet.opportunities}
                    allowed={Number(draft.quietStartHours)}
                  />
                )}
              </div>
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

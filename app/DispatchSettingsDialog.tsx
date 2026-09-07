"use client";
import { useEffect, useRef, useState } from "react";
import {
  type Analytics,
  type DispatchSettings,
  MAX_QUIET_START_HOURS,
  MAX_SESSION_RESERVE_PERCENT,
  MAX_WEEKLY_MARGIN_PERCENT,
  type Opportunity,
  type PlanningSnapshot,
  type RangeDays,
} from "../shared/types";
import { readCachedAnalytics, writeCachedAnalytics } from "./analyticsCache";
import { api } from "./api";
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
  weeklyMarginPercent: String(settings.weeklyMarginPercent),
  quietHoursOnly: settings.quietHoursOnly,
  quietStartHours: String(settings.quietStartHours),
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => draftFrom(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const quiet = useQuietOpportunities(open);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
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
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api<PlanningSnapshot>("/api/dispatch-settings", {
                method: "PUT",
                body: JSON.stringify({
                  sessionReservePercent: Number(draft.sessionReservePercent),
                  weeklyMarginPercent: Number(draft.weeklyMarginPercent),
                  quietHoursOnly: draft.quietHoursOnly,
                  quietStartHours: Number(draft.quietStartHours),
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
          <h2>Dispatch settings</h2>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <fieldset disabled={busy} className="guardrail-fields">
            <div className="form-grid">
              <label>
                Session reserve (%)
                <input
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
              </label>
              <label>
                Weekly margin over pace (%)
                <input
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
              </label>
              <label className="toggle-field">
                <span>
                  <input
                    type="checkbox"
                    checked={draft.quietHoursOnly}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        quietHoursOnly: event.target.checked,
                      })
                    }
                  />{" "}
                  Quiet hours only
                </span>
              </label>
              <label>
                Quietest start hours to allow
                <input
                  type="number"
                  min={1}
                  max={MAX_QUIET_START_HOURS}
                  step={1}
                  required
                  disabled={!draft.quietHoursOnly}
                  value={draft.quietStartHours}
                  onChange={(event) =>
                    setDraft({ ...draft, quietStartHours: event.target.value })
                  }
                />
              </label>
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
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

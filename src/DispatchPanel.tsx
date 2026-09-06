import { useEffect, useRef, useState } from "react";
import {
  type DispatchSettings,
  MAX_SESSION_RESERVE_PERCENT,
  MAX_WEEKLY_MARGIN_PERCENT,
  type PlanningSnapshot,
  type PublicTask,
} from "../shared/types";
import { api } from "./api";

const draftFrom = (settings: DispatchSettings) => ({
  sessionReservePercent: String(settings.sessionReservePercent),
  weeklyMarginPercent: String(settings.weeklyMarginPercent),
});

export function DispatchPanel({
  planning,
  tasks,
  autoDispatch,
  onSaved,
  onOpenQueue,
}: {
  planning: PlanningSnapshot;
  tasks: PublicTask[] | undefined;
  autoDispatch: boolean | undefined;
  onSaved: () => void;
  onOpenQueue: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFrom(planning.settings));
  const dirty = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!dirty.current) setDraft(draftFrom(planning.settings));
  }, [planning.settings]);
  const pending = tasks?.filter((task) => task.status === "pending") ?? [];
  const counts = [
    ["Pending", pending.length],
    ["Ready", pending.filter((t) => t.gate?.status === "ready").length],
    ["Waiting", pending.filter((t) => t.gate?.status === "waiting").length],
    ["Running", tasks?.filter((t) => t.status === "running").length ?? 0],
  ] as const;
  const claude = planning.providers.claude;
  async function toggleAuto(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      await api("/api/queue/auto", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      onSaved();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel dispatch-panel" aria-label="Auto-dispatch">
      <div className="section-heading">
        <h2>Auto-dispatch</h2>
        <span className={`gate gate-${claude.status}`}>
          {claude.status === "ready" ? "Claude ready" : "Claude waiting"}
        </span>
      </div>
      <p className="dispatch-reason">{claude.reason}</p>
      <label className="toggle">
        <input
          type="checkbox"
          checked={autoDispatch ?? false}
          disabled={autoDispatch === undefined || busy}
          onChange={(event) => void toggleAuto(event.target.checked)}
        />
        Run queued tasks automatically while this server is alive
      </label>
      <dl className="queue-counts">
        {counts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="metric">
              <span className="sr-only">{label} tasks </span>
              {tasks ? value : "—"}
            </dd>
          </div>
        ))}
      </dl>
      <form
        className="dispatch-settings"
        aria-label="Dispatch settings"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          setNotice("");
          try {
            const saved = await api<PlanningSnapshot>(
              "/api/dispatch-settings",
              {
                method: "PUT",
                body: JSON.stringify({
                  sessionReservePercent: Number(draft.sessionReservePercent),
                  weeklyMarginPercent: Number(draft.weeklyMarginPercent),
                }),
              },
            );
            setDraft(draftFrom(saved.settings));
            dirty.current = false;
            setNotice("Dispatch settings saved.");
            onSaved();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
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
                onChange={(event) => {
                  dirty.current = true;
                  setDraft({
                    ...draft,
                    sessionReservePercent: event.target.value,
                  });
                }}
              />
              <small>
                Kept free for your own work. Tasks stop at{" "}
                {100 - Number(draft.sessionReservePercent || 0)}% of the 5-hour
                window.
              </small>
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
                onChange={(event) => {
                  dirty.current = true;
                  setDraft({
                    ...draft,
                    weeklyMarginPercent: event.target.value,
                  });
                }}
              />
              <small>
                Tasks run while weekly usage stays within this much of the
                straight-line pace to the reset.
              </small>
            </label>
          </div>
        </fieldset>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
          <button type="button" onClick={onOpenQueue}>
            Go to task queue
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

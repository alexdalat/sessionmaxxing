"use client";
import { useState } from "react";
import type {
  BucketGate,
  PlanningSnapshot,
  PublicTask,
  QuietHours,
} from "../shared/types";
import { DispatchSettingsDialog } from "./DispatchSettingsDialog";
import { hour } from "./time";

/** Collapses sorted hours into ranges, wrapping past midnight: 10 PM–7 AM, 12 PM. */
export function describeHours(hours: number[]) {
  if (hours.length === 0) return "none";
  if (hours.length === 24) return "all day";
  const set = new Set(hours);
  const starts = hours.filter((h) => !set.has((h + 23) % 24));
  return starts
    .map((start) => {
      let end = start;
      while (set.has((end + 1) % 24)) end = (end + 1) % 24;
      return start === end ? hour(start) : `${hour(start)}–${hour(end)}`;
    })
    .join(", ");
}
export function quietSummary(quiet: QuietHours, enabled: boolean) {
  if (!enabled) return "Quiet hours off";
  if (quiet.startHours === null)
    return `Quiet hours not computed yet${quiet.error ? ` (${quiet.error})` : ""}`;
  const list = `Quiet hours ${describeHours(quiet.startHours)}`;
  if (quiet.active) return `${list} · in effect`;
  return `${list} · next ${quiet.nextStartHour === null ? "never" : hour(quiet.nextStartHour)}`;
}
const GREEN_HUE = 145;
/** Green at zero, amber midway, red at or past the ceiling. */
export function usageHue(percent: number, ceiling: number) {
  const ratio = ceiling > 0 ? Math.min(1, Math.max(0, percent / ceiling)) : 1;
  return Math.round(GREEN_HUE * (1 - ratio));
}
function Bucket({ name, gate }: { name: string; gate: BucketGate }) {
  const percent = gate.percent ?? 0;
  return (
    <>
      {name}{" "}
      <strong
        className="metric"
        style={{ color: `hsl(${usageHue(percent, gate.ceiling)} 45% 66%)` }}
      >
        {percent}%
      </strong>{" "}
      of {gate.ceiling}%
    </>
  );
}

export function DispatchPanel({
  planning,
  tasks,
  queueOn,
  onSaved,
}: {
  planning: PlanningSnapshot;
  tasks: PublicTask[] | undefined;
  queueOn: boolean | undefined;
  onSaved: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pending = tasks?.filter((task) => task.status === "pending") ?? [];
  const counts = [
    ["pending", pending.length],
    ["ready", pending.filter((t) => t.gate?.status === "ready").length],
    ["waiting", pending.filter((t) => t.gate?.status === "waiting").length],
    ["running", tasks?.filter((t) => t.status === "running").length ?? 0],
  ] as const;
  const claude = planning.providers.claude;
  const queueLabel =
    queueOn === undefined ? "Queue …" : queueOn ? "Queue on" : "Queue off";
  return (
    <section className="panel dispatch-panel" aria-label="Auto-dispatch">
      <div className="section-heading">
        <h2>Auto-dispatch</h2>
        <div className="gate-row">
          <span className={`gate gate-${claude.status}`}>
            {claude.status === "ready" ? "Claude ready" : "Claude waiting"}
          </span>
          <span className={`gate ${queueOn ? "gate-ready" : "gate-waiting"}`}>
            {queueLabel}
          </span>
        </div>
      </div>
      <p className="dispatch-reason">
        {claude.status === "ready" ? (
          <>
            <Bucket name="Session" gate={planning.session} />
            {" · "}
            <Bucket name="Weekly" gate={planning.weekly} />
            {planning.fable && (
              <>
                {" · "}
                <Bucket name="Fable" gate={planning.fable} />
              </>
            )}
          </>
        ) : (
          claude.reason
        )}
      </p>
      <p className="dispatch-quiet">
        {quietSummary(planning.quiet, planning.settings.quietHoursOnly)}
      </p>
      <p className="dispatch-counts">
        {counts.map(([label, value], index) => (
          <span key={label}>
            {index > 0 && " · "}
            <span className="metric">{tasks ? value : "—"}</span> {label}
          </span>
        ))}
      </p>
      <div className="actions">
        <button type="button" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </div>
      <DispatchSettingsDialog
        key={settingsOpen ? "open" : "closed"}
        open={settingsOpen}
        settings={planning.settings}
        onClose={() => setSettingsOpen(false)}
        onSaved={onSaved}
      />
    </section>
  );
}

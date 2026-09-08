"use client";
import { useState } from "react";
import { DispatchSettingsDialog } from "@/app/components/DispatchSettingsDialog";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { quietSummary, usageHue } from "@/app/lib/dispatchSummary";
import { displayOrder } from "@/app/lib/queueOrder";
import type { BucketGate, PlanningSnapshot, PublicTask } from "@/shared/types";

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
    queueOn === undefined ? "…" : queueOn ? "Queue on" : "Queue off";
  const next = tasks
    ? displayOrder(tasks).find((task) => task.status === "pending")
    : undefined;
  const nextLine = !tasks
    ? ""
    : tasks.some((task) => task.status === "running")
      ? `Running ${tasks.find((task) => task.status === "running")?.title}`
      : next
        ? `Next ${next.title}`
        : "Queue empty";
  return (
    <section className="panel dispatch-panel" aria-label="Queue">
      <div className="section-heading">
        <h2>Queue</h2>
        <div className="gate-row">
          <Badge variant={claude.status === "ready" ? "success" : "warning"}>
            {claude.status === "ready" ? "Claude ready" : "Claude waiting"}
          </Badge>
          <Badge variant={queueOn ? "success" : "warning"}>{queueLabel}</Badge>
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
        {quietSummary(planning.quiet, planning.settings)}
      </p>
      <p className="dispatch-counts">
        {nextLine && <span>{nextLine} · </span>}
        {counts.map(([label, value], index) => (
          <span key={label}>
            {index > 0 && " · "}
            <span className="metric">{tasks ? value : "—"}</span> {label}
          </span>
        ))}
      </p>
      <div className="actions">
        <Button
          type="button"
          variant="outline"
          onClick={() => setSettingsOpen(true)}
        >
          Settings
        </Button>
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

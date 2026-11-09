"use client";
import { useState } from "react";
import { DispatchSettingsDialog } from "@/app/components/DispatchSettingsDialog";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { QueueBadges } from "@/app/components/QueueBadges";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { quietSummary } from "@/app/lib/dispatchSummary";
import { ACTION_LABELS } from "@/app/lib/labels";
import { queuePreview } from "@/app/lib/queuePreview";
import { localClock } from "@/shared/local-time";
import type {
  BucketGate,
  FullPlanning,
  PublicTask,
  SessionKeeperState,
} from "@/shared/types";

function Bucket({ name, gate }: { name: string; gate: BucketGate }) {
  const percent = gate.percent ?? 0;
  return (
    <>
      {name} <strong className="metric">{percent}%</strong>
      {gate.reserved > 0 && (
        <>
          {" "}
          + <span className="metric">{gate.reserved}%</span> held
        </>
      )}{" "}
      of {gate.ceiling}%
    </>
  );
}

export function DispatchPanel({
  planning,
  keeper,
  tasks,
  queueOn,
  now,
  onSaved,
}: {
  planning: FullPlanning;
  keeper: SessionKeeperState | undefined;
  tasks: PublicTask[] | undefined;
  queueOn: boolean | undefined;
  now: number;
  onSaved: () => void;
}) {
  const { timeZone } = useEnvironment();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pending = tasks?.filter((task) => task.status === "pending") ?? [];
  const counts = [
    ["pending", String(pending.length)],
    ["ready", String(pending.filter((t) => t.gate?.status === "ready").length)],
    [
      "waiting",
      String(pending.filter((t) => t.gate?.status === "waiting").length),
    ],
    [
      "running",
      `${planning.load.running}/${planning.settings.maxConcurrentRuns}`,
    ],
  ] as const;
  const gate = planning.gate;
  const queueLabel =
    queueOn === undefined ? "…" : queueOn ? "Queue on" : "Queue off";
  const rows = tasks ? queuePreview(tasks, now) : null;
  return (
    <section
      className="panel span-5 dispatch-panel"
      data-tone="pink"
      aria-label="Queue"
    >
      <h2 className="panel-label">Queue</h2>
      <div className="panel-tools">
        <div className="tool-group">
          <Badge variant={queueOn ? "success" : "warning"}>{queueLabel}</Badge>
          <QueueBadges planning={planning} />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSettingsOpen(true)}
        >
          {ACTION_LABELS.editSettings}
        </Button>
      </div>
      <p className="dispatch-reason">
        {gate.status === "ready" ? (
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
          gate.reason
        )}
      </p>
      <p className="dispatch-quiet">
        {quietSummary(planning.quiet, planning.settings)}
      </p>
      {planning.settings.keepSessionActive && keeper?.lastStartedAt && (
        <p className="dispatch-quiet">
          Session keeper · last start{" "}
          {localClock(keeper.lastStartedAt, timeZone)}
        </p>
      )}
      {keeper?.error && (
        <p role="alert" className="error">
          {keeper.error}
        </p>
      )}
      <ol className="dispatch-list">
        {rows?.map((row) => (
          <li
            className="dispatch-task"
            data-state={row.state}
            key={row.id}
            title={row.reason}
          >
            <span className="dispatch-title">{row.title}</span>
            <span className="dispatch-note">{row.note}</span>
          </li>
        ))}
        {rows?.length === 0 && (
          <li className="dispatch-task muted">Queue empty</li>
        )}
      </ol>
      <p className="dispatch-counts">
        {counts.map(([label, value], index) => (
          <span key={label}>
            {index > 0 && " · "}
            <span className="metric">{tasks ? value : "—"}</span> {label}
          </span>
        ))}
      </p>
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

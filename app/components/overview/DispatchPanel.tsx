"use client";
import { Settings2 } from "lucide-react";
import { useId, useState } from "react";
import { DispatchSettingsDialog } from "@/app/components/DispatchSettingsDialog";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { QueueStatus } from "@/app/components/QueueStatus";
import { Button } from "@/app/components/ui/button";
import { quietSummary } from "@/app/lib/dispatchSummary";
import { ACTION_LABELS } from "@/app/lib/labels";
import { queuePreview } from "@/app/lib/queuePreview";
import { localClock } from "@/shared/local-time";
import type {
  FullPlanning,
  PublicTask,
  SessionKeeperState,
} from "@/shared/types";

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
  const headingId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pending = tasks?.filter((task) => task.status === "pending") ?? [];
  const count = (status: "ready" | "waiting") =>
    tasks
      ? String(pending.filter((task) => task.gate?.status === status).length)
      : "—";
  const { settings } = planning;
  const stats: [string, string][] = [
    ["Ready", count("ready")],
    ["Waiting", count("waiting")],
    ["Running", `${planning.load.running}/${settings.maxConcurrentRuns}`],
  ];
  if (settings.keepSessionActive)
    stats.push([
      "Session keeper",
      keeper?.lastStartedAt
        ? `Pinged ${localClock(keeper.lastStartedAt, timeZone)}`
        : "On",
    ]);
  if (settings.autoApply) stats.push(["Auto-apply", "On"]);
  const rows = tasks ? queuePreview(tasks, now) : null;
  return (
    <section className="section cols-side" aria-labelledby={headingId}>
      <div className="section-head">
        <div className="flex items-center gap-4">
          <h2 className="section-title" id={headingId}>
            Queue
          </h2>
          <QueueStatus planning={planning} queueOn={queueOn} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={ACTION_LABELS.editSettings}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 />
        </Button>
      </div>
      {planning.gate.status === "waiting" && (
        <p className="queue-gate">{planning.gate.reason}</p>
      )}
      <p className="queue-quiet">{quietSummary(planning.quiet, settings)}</p>
      {keeper?.error && (
        <p role="alert" className="error mt-3">
          {keeper.error}
        </p>
      )}
      <ol className="queue-list">
        {rows?.map((row) => (
          <li
            className="queue-row"
            data-state={row.state}
            key={row.id}
            title={row.reason}
          >
            <span className="queue-title">{row.title}</span>
            <span className="queue-note">{row.note}</span>
          </li>
        ))}
        {rows?.length === 0 && (
          <li className="queue-row" data-state="empty">
            Nothing queued
          </li>
        )}
      </ol>
      <dl className="stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <DispatchSettingsDialog
        key={settingsOpen ? "open" : "closed"}
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSaved={onSaved}
      />
    </section>
  );
}

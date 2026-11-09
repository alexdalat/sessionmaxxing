"use client";
import { useState } from "react";
import { QueueSkeleton } from "@/app/components/Skeletons";
import { useClock } from "@/app/hooks/useClock";
import { usePolling } from "@/app/hooks/usePolling";
import { api } from "@/app/lib/api";
import type { Analytics, QueueSnapshot, UsageReport } from "@/shared/types";
import { DispatchPanel } from "./DispatchPanel";
import { QuickAdd } from "./QuickAdd";
import { SessionWindows } from "./SessionWindows";
import { UsagePanel } from "./UsagePanel";
import { WeeklyPace } from "./WeeklyPace";

const USAGE_POLL_MS = 30_000;
export function Overview({
  data,
  queue,
}: {
  data: Analytics;
  queue: { data?: QueueSnapshot; reload: () => void };
}) {
  const usage = usePolling<UsageReport>("/api/usage", USAGE_POLL_MS);
  const [refreshing, setRefreshing] = useState(false);
  const now = useClock();
  const queuePlanning = queue.data?.planning;
  const planning =
    queuePlanning?.edition === "full" ? queuePlanning : undefined;
  return (
    <>
      {usage.error && (
        <section className="panel span-12" data-tone="paper" role="alert">
          <h2 className="panel-label">Error</h2>
          <p className="error-message">{usage.error}</p>
        </section>
      )}
      <UsagePanel
        usage={usage.data}
        planning={planning}
        budgets={data.claudeBudgets}
        now={now}
        busy={refreshing}
        onRefresh={async () => {
          setRefreshing(true);
          try {
            await api("/api/usage/refresh", { method: "POST" });
            usage.reload();
            queue.reload();
          } finally {
            setRefreshing(false);
          }
        }}
      />
      <QuickAdd onQueued={queue.reload} />
      <SessionWindows windows={usage.data?.windows} now={now} />
      {planning ? (
        <DispatchPanel
          planning={planning}
          keeper={queue.data?.sessionKeeper}
          tasks={queue.data?.tasks}
          queueOn={queue.data?.autoDispatch}
          now={now}
          onSaved={queue.reload}
        />
      ) : (
        <QueueSkeleton />
      )}
      <WeeklyPace
        samples={usage.data?.samples}
        snapshot={usage.data?.snapshot ?? null}
        marginPercent={planning?.settings.weeklyMarginPercent ?? 0}
      />
    </>
  );
}

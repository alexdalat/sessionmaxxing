"use client";
import { useEffect, useState } from "react";
import type { Analytics, QueueSnapshot, UsageReport } from "../shared/types";
import { api } from "./api";
import { DispatchPanel } from "./DispatchPanel";
import { SessionWindows } from "./SessionWindows";
import { PanelSkeleton } from "./Skeleton";
import { UsagePanel } from "./UsagePanel";
import { usePolling } from "./usePolling";
import { WeeklyPace } from "./WeeklyPace";

const CLOCK_TICK_MS = 60_000;
const USAGE_POLL_MS = 30_000;
function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
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
  const planning = queue.data?.planning;
  return (
    <>
      {usage.error && (
        <p className="error" role="alert">
          {usage.error}
        </p>
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
      <div className="two-column">
        <SessionWindows windows={usage.data?.windows} now={now} />
        {planning ? (
          <DispatchPanel
            planning={planning}
            tasks={queue.data?.tasks}
            queueOn={queue.data?.autoDispatch}
            onSaved={queue.reload}
          />
        ) : (
          <PanelSkeleton />
        )}
      </div>
      <WeeklyPace
        samples={usage.data?.samples}
        snapshot={usage.data?.snapshot ?? null}
        marginPercent={planning?.settings.weeklyMarginPercent ?? 0}
      />
    </>
  );
}

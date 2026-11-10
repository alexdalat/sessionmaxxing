"use client";
import { RotateCw } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/app/components/PageHeader";
import { KpisSkeleton, QueueSkeleton } from "@/app/components/Skeletons";
import { UsageKpis } from "@/app/components/UsageKpis";
import { Button } from "@/app/components/ui/button";
import { Skeleton } from "@/app/components/ui/skeleton";
import { useClock } from "@/app/hooks/useClock";
import { usePolling } from "@/app/hooks/usePolling";
import { ACTIVE_QUEUE_PATH, api } from "@/app/lib/api";
import { ACTION_LABELS } from "@/app/lib/labels";
import { fetchedLabel, usageStripRows } from "@/app/lib/usageStrip";
import {
  CLAUDE_BUCKETS,
  planLabel,
  type QueueSnapshot,
  type UsageReport,
} from "@/shared/types";
import { DispatchPanel } from "./DispatchPanel";
import { QuickAdd } from "./QuickAdd";
import { SessionWindows } from "./SessionWindows";
import { WeeklyPace } from "./WeeklyPace";

const USAGE_POLL_MS = 30_000;

export function Overview() {
  const usage = usePolling<UsageReport>("/api/usage", USAGE_POLL_MS);
  const queue = usePolling<QueueSnapshot>(ACTIVE_QUEUE_PATH);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const now = useClock();
  const queuePlanning = queue.data?.planning;
  const planning =
    queuePlanning?.edition === "full" ? queuePlanning : undefined;
  const snapshot = usage.data?.snapshot ?? null;
  const fetched = fetchedLabel(snapshot, now);
  const errors = [
    usage.error,
    usage.data?.error,
    queue.error,
    refreshError,
  ].filter(Boolean);
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError("");
    try {
      await api("/api/usage/refresh", { method: "POST" });
      usage.reload();
      queue.reload();
    } catch (failure) {
      setRefreshError(
        failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="page">
      <PageHeader
        title="Overview"
        status={
          usage.data ? (
            <>
              <span>{planLabel(snapshot?.plan ?? null)}</span>
              <span data-tone={fetched.stale ? "attention" : undefined}>
                {fetched.text}
              </span>
            </>
          ) : (
            <Skeleton className="h-5 w-48" />
          )
        }
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={
              refreshing
                ? ACTION_LABELS.refreshingUsage
                : ACTION_LABELS.refreshUsage
            }
            disabled={refreshing}
            onClick={refresh}
          >
            <RotateCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
        }
      />
      {errors.map((error) => (
        <p className="error" role="alert" key={error}>
          {error}
        </p>
      ))}
      <QuickAdd onQueued={queue.reload} />
      {planning ? (
        <UsageKpis rows={usageStripRows(planning, now)} />
      ) : (
        <KpisSkeleton count={CLAUDE_BUCKETS.length} />
      )}
      <div className="cols">
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
      </div>
      <WeeklyPace
        samples={usage.data?.samples}
        snapshot={snapshot}
        marginPercent={planning?.settings.weeklyMarginPercent ?? 0}
      />
    </div>
  );
}

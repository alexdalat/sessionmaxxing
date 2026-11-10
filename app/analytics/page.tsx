"use client";
import { RotateCw } from "lucide-react";
import { AnalyticsView } from "@/app/components/analytics/Analytics";
import { PageHeader } from "@/app/components/PageHeader";
import { Segmented } from "@/app/components/Segmented";
import { AnalyticsSkeleton } from "@/app/components/Skeletons";
import { Button } from "@/app/components/ui/button";
import { useAnalytics } from "@/app/hooks/useAnalytics";
import { usePolling } from "@/app/hooks/usePolling";
import { ACTION_LABELS, FIELD_LABELS } from "@/app/lib/labels";
import {
  type PlanningSnapshot,
  RANGE_DAYS,
  type RangeDays,
} from "@/shared/types";

const SETTINGS_POLL_MS = 60_000;
const RANGE_OPTIONS = RANGE_DAYS.map((days) => ({
  value: String(days),
  label: `${days}d`,
}));

export default function AnalyticsPage() {
  const { days, setDays, analytics, error, loading, refresh } = useAnalytics();
  const planning = usePolling<PlanningSnapshot>(
    "/api/dispatch-settings",
    SETTINGS_POLL_MS,
  );
  return (
    <div className="page">
      <PageHeader
        title="Analytics"
        status="Local Claude Code activity"
        actions={
          <>
            <Segmented
              label={FIELD_LABELS.range}
              value={String(days)}
              options={RANGE_OPTIONS}
              onChange={(value) => setDays(Number(value) as RangeDays)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={ACTION_LABELS.refreshAnalytics}
              onClick={refresh}
            >
              <RotateCw className={loading ? "animate-spin" : undefined} />
            </Button>
          </>
        }
      />
      {[error, planning.error].filter(Boolean).map((message) => (
        <p className="error" role="alert" key={message}>
          {message}
        </p>
      ))}
      {loading && !analytics && <AnalyticsSkeleton />}
      {analytics && (
        <AnalyticsView
          data={analytics}
          quietStartHours={planning.data?.settings.quietStartHours}
        />
      )}
    </div>
  );
}

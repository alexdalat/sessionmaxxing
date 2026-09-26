"use client";
import { AnalyticsView } from "@/app/components/analytics/Analytics";
import { RangeControls } from "@/app/components/analytics/RangeControls";
import { AnalyticsSkeleton } from "@/app/components/Skeletons";
import { Button } from "@/app/components/ui/button";
import { useAnalytics } from "@/app/hooks/useAnalytics";
import { usePolling } from "@/app/hooks/usePolling";
import type { PlanningSnapshot } from "@/shared/types";

const SETTINGS_POLL_MS = 60_000;

export default function AnalyticsPage() {
  const { days, setDays, analytics, error, loading, refresh } = useAnalytics();
  const planning = usePolling<PlanningSnapshot>(
    "/api/dispatch-settings",
    SETTINGS_POLL_MS,
  );
  return (
    <>
      <header className="page-header">
        <h1>Analytics</h1>
        <RangeControls days={days} onChange={setDays} onRefresh={refresh} />
      </header>
      {error && (
        <div className="error" role="alert">
          {error}{" "}
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}
      {planning.error && (
        <p className="error" role="alert">
          {planning.error}
        </p>
      )}
      {loading && <AnalyticsSkeleton />}
      {analytics && (
        <AnalyticsView
          data={analytics}
          quietStartHours={planning.data?.settings.quietStartHours}
        />
      )}
    </>
  );
}

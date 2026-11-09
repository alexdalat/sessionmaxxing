"use client";
import { AnalyticsView } from "@/app/components/analytics/Analytics";
import { RangeControls } from "@/app/components/analytics/RangeControls";
import { AnalyticsSkeleton } from "@/app/components/Skeletons";
import { Button } from "@/app/components/ui/button";
import { useAnalytics } from "@/app/hooks/useAnalytics";
import { usePolling } from "@/app/hooks/usePolling";
import { ACTION_LABELS } from "@/app/lib/labels";
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
      <h1 className="sr-only">Analytics</h1>
      <div className="bento">
        {error && (
          <section className="panel span-12" data-tone="paper" role="alert">
            <h2 className="panel-label">Error</h2>
            <p className="error-message">{error}</p>
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              {ACTION_LABELS.reloadAnalytics}
            </Button>
          </section>
        )}
        {planning.error && (
          <section className="panel span-12" data-tone="paper" role="alert">
            <h2 className="panel-label">Error</h2>
            <p className="error-message">{planning.error}</p>
          </section>
        )}
        <section className="panel span-4" data-tone="pink">
          <h2 className="panel-label">Range · local Claude Code</h2>
          <RangeControls days={days} onChange={setDays} onRefresh={refresh} />
        </section>
        {loading && <AnalyticsSkeleton />}
        {analytics && (
          <AnalyticsView
            data={analytics}
            quietStartHours={planning.data?.settings.quietStartHours}
          />
        )}
      </div>
    </>
  );
}

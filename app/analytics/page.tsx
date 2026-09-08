"use client";
import { AnalyticsView } from "@/app/components/analytics/Analytics";
import { RangeControls } from "@/app/components/analytics/RangeControls";
import { AnalyticsSkeleton } from "@/app/components/Skeletons";
import { Button } from "@/app/components/ui/button";
import { useAnalytics } from "@/app/hooks/useAnalytics";

export default function AnalyticsPage() {
  const { days, setDays, analytics, error, loading, refresh } = useAnalytics();
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
      {loading && <AnalyticsSkeleton />}
      {analytics && <AnalyticsView data={analytics} />}
    </>
  );
}

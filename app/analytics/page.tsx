"use client";
import { AnalyticsView } from "../Analytics";
import { RangeControls } from "../RangeControls";
import { AnalyticsSkeleton } from "../Skeleton";
import { useAnalytics } from "../useAnalytics";

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
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {loading && <AnalyticsSkeleton />}
      {analytics && <AnalyticsView data={analytics} />}
    </>
  );
}

"use client";
import { Overview } from "@/app/components/overview/Overview";
import { OverviewSkeleton } from "@/app/components/Skeletons";
import { Button } from "@/app/components/ui/button";
import { useAnalytics } from "@/app/hooks/useAnalytics";
import { usePolling } from "@/app/hooks/usePolling";
import type { QueueSnapshot } from "@/shared/types";

export default function OverviewPage() {
  const { analytics, error, loading, refresh } = useAnalytics();
  const queue = usePolling<QueueSnapshot>("/api/queue");
  return (
    <>
      <header className="page-header">
        <h1>Overview</h1>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}{" "}
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}
      {loading && <OverviewSkeleton />}
      {analytics && <Overview data={analytics} queue={queue} />}
    </>
  );
}

"use client";
import type { QueueSnapshot } from "../shared/types";
import { Overview } from "./Overview";
import { OverviewSkeleton } from "./Skeleton";
import { useAnalytics } from "./useAnalytics";
import { usePolling } from "./usePolling";

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
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {loading && <OverviewSkeleton />}
      {analytics && <Overview data={analytics} queue={queue} />}
    </>
  );
}

"use client";
import { Overview } from "@/app/components/overview/Overview";
import { OverviewSkeleton } from "@/app/components/Skeletons";
import { Button } from "@/app/components/ui/button";
import { useAnalytics } from "@/app/hooks/useAnalytics";
import { usePolling } from "@/app/hooks/usePolling";
import { ACTIVE_QUEUE_PATH } from "@/app/lib/api";
import { ACTION_LABELS } from "@/app/lib/labels";
import type { QueueSnapshot } from "@/shared/types";

export default function OverviewPage() {
  const { analytics, error, loading, refresh } = useAnalytics();
  const queue = usePolling<QueueSnapshot>(ACTIVE_QUEUE_PATH);
  return (
    <>
      <h1 className="sr-only">Overview</h1>
      <div className="bento">
        {error && (
          <section className="panel span-12" data-tone="paper" role="alert">
            <h2 className="panel-label">Error</h2>
            <p className="error-message">{error}</p>
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              {ACTION_LABELS.reloadOverview}
            </Button>
          </section>
        )}
        {loading && <OverviewSkeleton />}
        {analytics && <Overview data={analytics} queue={queue} />}
      </div>
    </>
  );
}

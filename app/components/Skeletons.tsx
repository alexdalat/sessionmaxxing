import { Skeleton } from "@/app/components/ui/skeleton";

const STAT_TILE_KEYS = ["active-minutes", "responses", "tokens", "cache-reads"];
const LIST_ROW_KEYS = ["first", "second", "third"];

export function PanelSkeleton() {
  return (
    <section className="panel">
      <Skeleton className="mb-4 h-4 w-48" />
      <div className="chart">
        <Skeleton className="h-full w-full" />
      </div>
    </section>
  );
}

const USAGE_ROW_KEYS = ["session", "weekly", "fable"];
const TABLE_ROW_KEYS = ["r1", "r2", "r3", "r4", "r5", "r6"];
const WINDOW_ROW_KEYS = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];

function HeadingSkeleton() {
  return (
    <div className="section-heading">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}
function TableSkeleton() {
  return (
    <section className="panel">
      <HeadingSkeleton />
      <div className="table-scroll">
        {TABLE_ROW_KEYS.map((key) => (
          <Skeleton className="mb-2 h-8 w-full" key={key} />
        ))}
      </div>
    </section>
  );
}

export function QueueSkeleton() {
  return (
    <section className="panel">
      <HeadingSkeleton />
      <Skeleton className="mb-3 h-4 w-3/4" />
      <Skeleton className="mb-3 h-3 w-1/2" />
      <Skeleton className="mb-5 h-3 w-2/3" />
      <Skeleton className="h-8 w-24" />
    </section>
  );
}

export function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <section className="panel usage-panel">
        <HeadingSkeleton />
        {USAGE_ROW_KEYS.map((key) => (
          <div className="usage-row" key={key}>
            <div className="usage-head">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-24" />
            </div>
            <Skeleton className="usage-track" />
          </div>
        ))}
      </section>
      <div className="two-column">
        <section className="panel">
          <HeadingSkeleton />
          <div className="windows">
            {WINDOW_ROW_KEYS.map((key) => (
              <div className="windows-row" key={key}>
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-[22px] w-full rounded-[5px]" />
              </div>
            ))}
          </div>
        </section>
        <QueueSkeleton />
      </div>
      <PanelSkeleton />
      <PanelSkeleton />
    </div>
  );
}

export function AnalyticsSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <div className="stats-grid">
        {STAT_TILE_KEYS.map((key) => (
          <section className="panel stat" key={key}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-6 w-28" />
          </section>
        ))}
      </div>
      <PanelSkeleton />
      <TableSkeleton />
    </div>
  );
}

export function ListSkeleton() {
  return (
    <section className="panel" role="status" aria-label="Loading">
      {LIST_ROW_KEYS.map((key) => (
        <Skeleton className="mb-3 h-10 w-full" key={key} />
      ))}
    </section>
  );
}

export function TaskListSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      {LIST_ROW_KEYS.map((key) => (
        <article className="task-card" key={key}>
          <div>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="mt-2 h-3 w-32" />
            <Skeleton className="mt-2 h-3 w-64" />
          </div>
          <div className="task-budget">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-8 w-full" />
        </article>
      ))}
    </div>
  );
}

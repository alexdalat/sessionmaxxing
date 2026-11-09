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

const STRIP_ROW_KEYS = ["session", "weekly"];
const USAGE_ROW_KEYS = [...STRIP_ROW_KEYS, "fable"];
const TABLE_ROW_KEYS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"];
const MIX_PANEL_KEYS = ["models", "projects", "sources"];
const MIX_ROW_KEYS = ["m1", "m2", "m3", "m4", "m5"];
const RUN_KEYS = ["run1", "run2", "run3"];
const FACT_KEYS = ["model", "started", "duration", "exit"];
const WINDOW_ROW_KEYS = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];

function HeadingSkeleton() {
  return (
    <div className="section-heading">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}
function UsageRowSkeleton() {
  return (
    <div className="usage-row">
      <div className="usage-head">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="usage-track" />
    </div>
  );
}
export function UsageStripSkeleton() {
  return (
    <section
      className="panel usage-panel"
      role="status"
      aria-label="Loading usage"
    >
      <HeadingSkeleton />
      {STRIP_ROW_KEYS.map((key) => (
        <UsageRowSkeleton key={key} />
      ))}
    </section>
  );
}
function TableSkeleton() {
  return (
    <section className="panel">
      <HeadingSkeleton />
      <div className="table-scroll">
        {TABLE_ROW_KEYS.map((key) => (
          <Skeleton className="mb-1 h-[25px] w-full rounded-[3px]" key={key} />
        ))}
      </div>
    </section>
  );
}
function MixListSkeleton() {
  return (
    <section className="panel">
      <Skeleton className="mb-4 h-4 w-40" />
      {MIX_ROW_KEYS.map((key) => (
        <div className="mt-3.5" key={key}>
          <div className="flex justify-between gap-3">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-10" />
          </div>
          <Skeleton className="mt-2 h-1 w-full rounded-none" />
        </div>
      ))}
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
          <UsageRowSkeleton key={key} />
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
      <TableSkeleton />
      <PanelSkeleton />
      <div className="three-column">
        {MIX_PANEL_KEYS.map((key) => (
          <MixListSkeleton key={key} />
        ))}
      </div>
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      {RUN_KEYS.map((key) => (
        <section className="panel" key={key}>
          <div className="section-heading">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-5 w-20 rounded-4xl" />
          </div>
          <dl className="facts">
            {FACT_KEYS.map((fact) => (
              <div key={fact}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-4 w-28" />
              </div>
            ))}
          </dl>
          <Skeleton className="mt-4 h-3 w-16" />
        </section>
      ))}
    </div>
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

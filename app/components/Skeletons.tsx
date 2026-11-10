import { Skeleton } from "@/app/components/ui/skeleton";

const KPI_KEYS = ["k1", "k2", "k3", "k4"];
const ROW_KEYS = ["r1", "r2", "r3"];
const MIX_KEYS = ["models", "projects", "sources"];
const MIX_ROW_KEYS = ["m1", "m2", "m3", "m4"];
const FACT_KEYS = ["f1", "f2", "f3", "f4"];

export function KpisSkeleton({ count }: { count: number }) {
  return (
    <div className="kpis" role="status" aria-label="Loading usage">
      {KPI_KEYS.slice(0, count).map((key) => (
        <div className="kpi" key={key}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-8 w-20" />
          <Skeleton className="mt-5 h-1.5 w-full" />
          <Skeleton className="mt-3 h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

function HeadSkeleton() {
  return (
    <div className="section-head">
      <Skeleton className="h-5 w-32" />
    </div>
  );
}

export function QueueSkeleton() {
  return (
    <section className="section cols-side" role="status" aria-label="Loading">
      <HeadSkeleton />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="mt-3 h-3 w-1/2" />
      {ROW_KEYS.map((key) => (
        <Skeleton className="mt-4 h-6 w-full" key={key} />
      ))}
    </section>
  );
}

export function AnalyticsSkeleton() {
  return (
    <div className="contents" role="status" aria-label="Loading">
      <div className="kpis">
        {KPI_KEYS.map((key) => (
          <div className="kpi" key={key}>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-8 w-20" />
          </div>
        ))}
      </div>
      <section className="section">
        <HeadSkeleton />
        <Skeleton className="h-56 w-full" />
      </section>
      <section className="section">
        <HeadSkeleton />
        <div className="chart">
          <Skeleton className="h-full w-full" />
        </div>
      </section>
      <div className="trio">
        {MIX_KEYS.map((key) => (
          <section className="section" key={key}>
            <HeadSkeleton />
            {MIX_ROW_KEYS.map((row) => (
              <Skeleton className="mt-4 h-4 w-full" key={row} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="list" role="status" aria-label="Loading">
      {ROW_KEYS.map((key) => (
        <div className="run" key={key}>
          <Skeleton className="h-5 w-64" />
          <dl className="facts">
            {FACT_KEYS.map((fact) => (
              <div key={fact}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-4 w-24" />
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

export function TaskListSkeleton() {
  return (
    <div className="list" role="status" aria-label="Loading">
      {ROW_KEYS.map((key) => (
        <div className="task-card" key={key}>
          <div>
            <Skeleton className="h-5 w-56" />
            <Skeleton className="mt-2 h-3 w-40" />
          </div>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-28" />
        </div>
      ))}
    </div>
  );
}

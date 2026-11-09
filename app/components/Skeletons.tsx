import { Skeleton } from "@/app/components/ui/skeleton";

const STAT_TILE_KEYS = ["active-minutes", "responses", "tokens", "cache-reads"];
const LIST_ROW_KEYS = ["first", "second", "third"];
const STRIP_ROW_KEYS = ["session", "weekly"];
const USAGE_ROW_KEYS = [...STRIP_ROW_KEYS, "fable"];
const FIELD_KEYS = ["workdir", "prompt", "model"];
const TABLE_ROW_KEYS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"];
const MIX_PANELS = [
  { key: "models", tone: "pink" },
  { key: "projects", tone: "paper" },
  { key: "sources", tone: "pink" },
] as const;
const MIX_ROW_KEYS = ["m1", "m2", "m3", "m4", "m5"];
const RUN_KEYS = ["run1", "run2", "run3"];
const FACT_KEYS = ["model", "started", "duration", "exit"];
const WINDOW_ROW_KEYS = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];

type Tone = "pink" | "paper";

function LabelSlot() {
  return <Skeleton className="mx-auto mb-4 h-4 w-24" />;
}

function ChartPanelSkeleton({ tone, span }: { tone: Tone; span: string }) {
  return (
    <section className={`panel ${span}`} data-tone={tone}>
      <LabelSlot />
      <div className="chart">
        <Skeleton className="h-full w-full" />
      </div>
    </section>
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
      className="panel span-12 usage-panel"
      data-tone="pink"
      role="status"
      aria-label="Loading usage"
    >
      <LabelSlot />
      <div className="strip-rows">
        {STRIP_ROW_KEYS.map((key) => (
          <UsageRowSkeleton key={key} />
        ))}
      </div>
    </section>
  );
}

function TableSkeleton() {
  return (
    <section className="panel span-12" data-tone="paper">
      <LabelSlot />
      <div className="table-scroll">
        {TABLE_ROW_KEYS.map((key) => (
          <Skeleton className="mb-1 h-7 w-full" key={key} />
        ))}
      </div>
    </section>
  );
}

function MixListSkeleton({ tone }: { tone: Tone }) {
  return (
    <section className="panel span-4" data-tone={tone}>
      <LabelSlot />
      {MIX_ROW_KEYS.map((key) => (
        <div className="mt-4" key={key}>
          <div className="flex justify-between gap-3">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-10" />
          </div>
          <Skeleton className="mt-2 h-1 w-full" />
        </div>
      ))}
    </section>
  );
}

export function QueueSkeleton() {
  return (
    <section className="panel span-5 dispatch-panel" data-tone="pink">
      <LabelSlot />
      <Skeleton className="mb-4 h-4 w-3/4" />
      <Skeleton className="mb-4 h-3 w-1/2" />
      <Skeleton className="mb-4 h-3 w-2/3" />
      <Skeleton className="h-8 w-24" />
    </section>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="contents" role="status" aria-label="Loading">
      <section className="panel span-7 usage-panel" data-tone="pink">
        <LabelSlot />
        {USAGE_ROW_KEYS.map((key) => (
          <UsageRowSkeleton key={key} />
        ))}
      </section>
      <section className="panel span-5" data-tone="paper">
        <LabelSlot />
        {FIELD_KEYS.map((key) => (
          <Skeleton className="mb-2 h-8 w-full" key={key} />
        ))}
      </section>
      <section className="panel span-7" data-tone="paper">
        <LabelSlot />
        <div className="windows">
          {WINDOW_ROW_KEYS.map((key) => (
            <div className="windows-row" key={key}>
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-6 w-full" />
            </div>
          ))}
        </div>
      </section>
      <QueueSkeleton />
      <ChartPanelSkeleton tone="paper" span="span-12" />
    </div>
  );
}

export function AnalyticsSkeleton() {
  return (
    <div className="contents" role="status" aria-label="Loading">
      {STAT_TILE_KEYS.map((key) => (
        <section className="panel span-2 stat" data-tone="paper" key={key}>
          <LabelSlot />
          <Skeleton className="mx-auto h-8 w-28" />
        </section>
      ))}
      <TableSkeleton />
      <ChartPanelSkeleton tone="paper" span="span-12" />
      {MIX_PANELS.map(({ key, tone }) => (
        <MixListSkeleton key={key} tone={tone} />
      ))}
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="contents" role="status" aria-label="Loading">
      {RUN_KEYS.map((key) => (
        <section className="panel span-12" data-tone="paper" key={key}>
          <LabelSlot />
          <div className="panel-tools">
            <Skeleton className="h-8 w-20" />
          </div>
          <dl className="facts">
            {FACT_KEYS.map((fact) => (
              <div key={fact}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-4 w-28" />
              </div>
            ))}
          </dl>
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

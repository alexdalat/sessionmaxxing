"use client";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/app/components/ui/skeleton";
import { usePolling } from "@/app/hooks/usePolling";
import { WEEKLY_COLOR } from "@/app/lib/chart";
import { scoreSeries } from "@/app/lib/planScore";
import type { PlanScore as PlanScoreData } from "@/shared/types";

const USAGE_POLL_MS = 30_000;
const CHART_HEIGHT = 220;
const PACE_COLOR = "#8a8f98";
const WEEKLY_LINE_COLOR = "#d0d6e0";
const dash = (value: number | null) => (value === null ? "–" : String(value));

export function PlanScore() {
  const plan = usePolling<PlanScoreData>("/api/plan-score", USAGE_POLL_MS);
  const series = plan.data ? scoreSeries(plan.data) : null;
  return (
    <section className="panel" aria-label="Plan score over the last 28 days">
      <div className="section-heading">
        <h2>Plan score · last 28 days</h2>
        {plan.data ? (
          <div className="flex items-baseline gap-3">
            <strong className="metric text-2xl font-normal">
              {dash(plan.data.score)}
            </strong>
            <span className="muted">
              {`Sessions ${
                plan.data.sessionCoverage === null
                  ? "–"
                  : `${plan.data.sessionCoverage}%`
              } · Week ${plan.data.weeklyScore === null ? "–" : `${plan.data.weeklyScore}%`}`}
            </span>
          </div>
        ) : (
          <Skeleton className="h-3 w-64" />
        )}
      </div>
      {plan.error && (
        <p className="error" role="alert">
          {plan.error}
        </p>
      )}
      <div
        className="chart"
        style={{ height: CHART_HEIGHT, minHeight: CHART_HEIGHT }}
      >
        {series ? (
          <ResponsiveContainer
            width="100%"
            height={CHART_HEIGHT}
            initialDimension={{ width: 700, height: CHART_HEIGHT }}
          >
            <ComposedChart data={series} accessibilityLayer>
              <CartesianGrid stroke="#ffffff10" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(date: string) => date.slice(5)}
                minTickGap={25}
                stroke="#8a8f98"
              />
              <YAxis domain={[0, 100]} unit="%" stroke="#8a8f98" width={40} />
              <Tooltip
                formatter={(value, name) => [`${value}%`, name]}
                contentStyle={{
                  background: "#191a1b",
                  border: "1px solid #ffffff20",
                  borderRadius: 8,
                }}
                separator=": "
              />
              <Legend itemSorter={() => 0} />
              <ReferenceLine
                y={100}
                stroke={PACE_COLOR}
                strokeDasharray="4 4"
              />
              <Bar
                dataKey="coverage"
                name="Session capacity used"
                fill={WEEKLY_COLOR}
                fillOpacity={0.55}
              />
              <Line
                type="stepAfter"
                dataKey="weekly"
                name="Week score"
                stroke={WEEKLY_LINE_COLOR}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <Skeleton className="h-full w-full" />
        )}
      </div>
    </section>
  );
}

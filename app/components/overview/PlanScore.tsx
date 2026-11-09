"use client";
import { useState } from "react";
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
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Skeleton } from "@/app/components/ui/skeleton";
import { usePolling } from "@/app/hooks/usePolling";
import {
  BREAKDOWNS,
  type Breakdown,
  seriesColor,
  seriesLabel,
} from "@/app/lib/activitySeries";
import {
  AXIS_TEXT_COLOR,
  BAR_SEPARATOR,
  CHART_CURSOR_FILL,
  CHART_MARGIN,
  GRID_COLOR,
  PACE_COLOR,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
  WEEKLY_COLOR,
} from "@/app/lib/chart";
import { FIELD_LABELS } from "@/app/lib/labels";
import { type ScoreRow, scoreSeries } from "@/app/lib/planScore";
import type { PlanScore as PlanScoreData } from "@/shared/types";

const USAGE_POLL_MS = 30_000;
const CHART_HEIGHT = 240;
const AXIS_TICK = { fill: AXIS_TEXT_COLOR, fontSize: 12 };
const dash = (value: number | null) => (value === null ? "–" : String(value));

export function PlanScore() {
  const { timeZone } = useEnvironment();
  const plan = usePolling<PlanScoreData>("/api/plan-score", USAGE_POLL_MS);
  const [breakdown, setBreakdown] = useState<Breakdown>("source");
  const series = plan.data ? scoreSeries(plan.data, breakdown, timeZone) : null;
  return (
    <section
      className="panel span-12"
      data-tone="paper"
      aria-label={`Plan score over the last 28 days by ${breakdown}`}
    >
      <h2 className="panel-label">Plan score · last 28 days</h2>
      <div className="panel-tools">
        <div className="flex flex-wrap items-center gap-3">
          {plan.data ? (
            <div className="flex flex-wrap items-baseline gap-3">
              <strong className="metric display-value">
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
          <div className="grid gap-2">
            <Label htmlFor="plan-breakdown" className="sr-only">
              {FIELD_LABELS.breakdown}
            </Label>
            <Select
              value={breakdown}
              onValueChange={(value) => setBreakdown(value as Breakdown)}
            >
              <SelectTrigger id="plan-breakdown">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BREAKDOWNS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
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
            <ComposedChart
              data={series.rows}
              margin={CHART_MARGIN}
              accessibilityLayer
            >
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(date: string) => date.slice(5)}
                minTickGap={25}
                stroke={AXIS_TEXT_COLOR}
                tick={AXIS_TICK}
              />
              <YAxis
                domain={[0, 100]}
                unit="%"
                stroke={AXIS_TEXT_COLOR}
                tick={AXIS_TICK}
                width={40}
              />
              <Tooltip
                formatter={(value, name) => [`${value}%`, name]}
                labelFormatter={(date, payload) => {
                  const row = payload[0]?.payload as ScoreRow | undefined;
                  return row && row.coverage !== null
                    ? `${date} · ${row.coverage}% used`
                    : date;
                }}
                contentStyle={TOOLTIP_STYLE}
                itemStyle={TOOLTIP_ITEM_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                cursor={{ fill: CHART_CURSOR_FILL }}
                separator=": "
              />
              <Legend itemSorter={() => 0} />
              <ReferenceLine
                y={100}
                stroke={PACE_COLOR}
                strokeDasharray="4 4"
              />
              {series.keys.map((key, index) => (
                <Bar
                  key={key}
                  stackId="coverage"
                  dataKey={key}
                  name={seriesLabel(breakdown, key)}
                  fill={seriesColor(breakdown, key, index)}
                  {...BAR_SEPARATOR}
                  isAnimationActive={false}
                />
              ))}
              <Line
                type="stepAfter"
                dataKey="weekly"
                name="Week score"
                stroke={WEEKLY_COLOR}
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

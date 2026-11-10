"use client";
import { useId } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { HatchFill } from "@/app/components/HatchFill";
import { Legend, type LegendItem } from "@/app/components/Legend";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  AXIS_PROPS,
  CHART_CURSOR_FILL,
  CHART_MARGIN,
  CUTOFF_COLOR,
  FABLE_COLOR,
  GRID_COLOR,
  NOW_LINE_COLOR,
  PACE_COLOR,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
  WEEKLY_COLOR,
} from "@/app/lib/chart";
import { dayTicks, paceSeries } from "@/app/lib/pace";
import { PAGE } from "@/app/lib/palette";
import { localTimestamp } from "@/shared/local-time";
import type { UsageSample, UsageSnapshot } from "@/shared/types";

const CHART_HEIGHT = 300;
const HATCH_ID = "weekly-hatch";
const PERCENT_TICKS = [0, 25, 50, 75, 100];
const ACTIVE_DOT = { r: 4, stroke: PAGE, strokeWidth: 2 };

export function WeeklyPace({
  samples,
  snapshot,
  marginPercent,
}: {
  samples: UsageSample[] | undefined;
  snapshot: UsageSnapshot | null;
  marginPercent: number;
}) {
  const { timeZone } = useEnvironment();
  const headingId = useId();
  const series =
    samples && snapshot ? paceSeries(samples, snapshot, marginPercent) : null;
  const ticks = series
    ? dayTicks(series[0].t, series[series.length - 1].t, timeZone)
    : [];
  const legend: LegendItem[] = [
    { label: "Weekly", color: WEEKLY_COLOR, shape: "line" },
    ...(snapshot?.fable
      ? [{ label: "Fable", color: FABLE_COLOR, shape: "line" as const }]
      : []),
    { label: "Pace", color: PACE_COLOR, shape: "dash" },
    { label: "Queue cutoff", color: CUTOFF_COLOR, shape: "line" },
    { label: "Now", color: NOW_LINE_COLOR, shape: "tick" },
  ];
  return (
    <section className="section" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 className="section-title" id={headingId}>
          Weekly pace
        </h2>
        {series && <Legend items={legend} />}
      </div>
      {series && snapshot ? (
        <div className="chart chart-tall">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 900, height: CHART_HEIGHT }}
          >
            <ComposedChart
              data={series}
              margin={CHART_MARGIN}
              accessibilityLayer
            >
              <HatchFill
                id={HATCH_ID}
                color={WEEKLY_COLOR}
                height={CHART_HEIGHT}
              />
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis
                {...AXIS_PROPS}
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                ticks={ticks}
                interval={0}
                tickFormatter={(t: number) =>
                  new Date(t).toLocaleDateString("en-US", {
                    weekday: "short",
                    timeZone,
                  })
                }
              />
              <YAxis
                {...AXIS_PROPS}
                domain={[0, 100]}
                ticks={PERCENT_TICKS}
                unit="%"
                width={44}
              />
              <Tooltip
                cursor={{ stroke: GRID_COLOR, fill: CHART_CURSOR_FILL }}
                labelFormatter={(t) => localTimestamp(Number(t), timeZone)}
                formatter={(value) => `${value}%`}
                contentStyle={TOOLTIP_STYLE}
                itemStyle={TOOLTIP_ITEM_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                separator=" "
              />
              <ReferenceLine
                x={Date.parse(snapshot.fetchedAt)}
                stroke={NOW_LINE_COLOR}
                strokeDasharray="2 3"
              />
              <Area
                type="monotone"
                dataKey="weekly"
                name="Weekly"
                stroke={WEEKLY_COLOR}
                strokeWidth={2}
                fill={`url(#${HATCH_ID})`}
                fillOpacity={1}
                dot={false}
                activeDot={ACTIVE_DOT}
                connectNulls
                isAnimationActive={false}
              />
              {snapshot.fable && (
                <Line
                  type="monotone"
                  dataKey="fable"
                  name="Fable"
                  stroke={FABLE_COLOR}
                  strokeWidth={2}
                  dot={false}
                  activeDot={ACTIVE_DOT}
                  connectNulls
                  isAnimationActive={false}
                />
              )}
              <Line
                type="linear"
                dataKey="pace"
                name="Pace"
                stroke={PACE_COLOR}
                strokeDasharray="4 4"
                strokeWidth={1.5}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="ceiling"
                name="Queue cutoff"
                stroke={CUTOFF_COLOR}
                strokeWidth={1.5}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : samples === undefined ? (
        <div className="chart chart-tall">
          <Skeleton className="h-full w-full" />
        </div>
      ) : (
        <p className="empty">No weekly window reported</p>
      )}
    </section>
  );
}

"use client";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  AXIS_TEXT_COLOR,
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
import { localTimestamp } from "@/shared/local-time";
import {
  type UsageSample,
  type UsageSnapshot,
  WEEKLY_HARD_CEILING_PERCENT,
} from "@/shared/types";

const AXIS_TICK = { fill: AXIS_TEXT_COLOR, fontSize: 12 };

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
  const series =
    samples && snapshot ? paceSeries(samples, snapshot, marginPercent) : null;
  const ticks = series
    ? dayTicks(series[0].t, series[series.length - 1].t, timeZone)
    : [];
  return (
    <figure
      className="panel span-12"
      data-tone="paper"
      aria-label="Weekly usage against pace"
    >
      <h2 className="panel-label">Weekly usage vs pace</h2>
      <div className="panel-tools">
        {samples === undefined ? (
          <Skeleton className="h-3 w-64" />
        ) : (
          <span className="panel-meta">
            {snapshot?.weekly.resetsAt
              ? `Queue cutoff pace + ${marginPercent}%, max ${WEEKLY_HARD_CEILING_PERCENT}% · resets ${localTimestamp(snapshot.weekly.resetsAt, timeZone)}`
              : "No weekly window reported"}
          </span>
        )}
      </div>
      {series && snapshot ? (
        <div className="chart">
          <ResponsiveContainer
            width="100%"
            height={240}
            initialDimension={{ width: 700, height: 240 }}
          >
            <LineChart data={series} margin={CHART_MARGIN} accessibilityLayer>
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis
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
                stroke={AXIS_TEXT_COLOR}
                tick={AXIS_TICK}
              />
              <YAxis
                domain={[0, 100]}
                unit="%"
                stroke={AXIS_TEXT_COLOR}
                tick={AXIS_TICK}
                width={45}
              />
              <Tooltip
                labelFormatter={(t) => localTimestamp(Number(t), timeZone)}
                formatter={(value) => `${value}%`}
                contentStyle={TOOLTIP_STYLE}
                itemStyle={TOOLTIP_ITEM_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                separator=": "
              />
              <Legend itemSorter={() => 0} />
              <ReferenceLine
                x={Date.parse(snapshot.fetchedAt)}
                stroke={NOW_LINE_COLOR}
                strokeWidth={1}
                label={{
                  value: "now",
                  position: "insideTopRight",
                  fill: AXIS_TEXT_COLOR,
                  fontSize: 12,
                }}
              />
              <Line
                type="monotone"
                dataKey="weekly"
                name="Weekly"
                stroke={WEEKLY_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
              {snapshot.fable && (
                <Line
                  type="monotone"
                  dataKey="fable"
                  name="Fable weekly"
                  stroke={FABLE_COLOR}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls
                />
              )}
              <Line
                type="linear"
                dataKey="pace"
                name="Pace · week elapsed"
                stroke={PACE_COLOR}
                strokeDasharray="4 4"
                strokeWidth={1.5}
                dot={false}
              />
              <Line
                type="linear"
                dataKey="ceiling"
                name="Queue cutoff"
                stroke={CUTOFF_COLOR}
                strokeWidth={1.5}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : samples === undefined ? (
        <div className="chart">
          <Skeleton className="h-full w-full" />
        </div>
      ) : (
        <p className="muted">No weekly window reported yet.</p>
      )}
    </figure>
  );
}

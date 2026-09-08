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
import { Skeleton } from "@/app/components/ui/skeleton";
import { FABLE_COLOR, WEEKLY_COLOR } from "@/app/lib/chart";
import { dayTicks, paceSeries } from "@/app/lib/pace";
import {
  localTimestamp,
  type UsageSample,
  type UsageSnapshot,
  WEEKLY_HARD_CEILING_PERCENT,
} from "@/shared/types";

const PACE_COLOR = "#8a8f98";
const CEILING_COLOR = "#f7f8f8";

export function WeeklyPace({
  samples,
  snapshot,
  marginPercent,
}: {
  samples: UsageSample[] | undefined;
  snapshot: UsageSnapshot | null;
  marginPercent: number;
}) {
  const series =
    samples && snapshot ? paceSeries(samples, snapshot, marginPercent) : null;
  const ticks = series
    ? dayTicks(series[0].t, series[series.length - 1].t)
    : [];
  return (
    <figure className="panel" aria-label="Weekly usage against pace">
      <div className="section-heading">
        <h2>Weekly usage vs pace</h2>
        {samples === undefined ? (
          <Skeleton className="h-3 w-64" />
        ) : (
          <span className="muted">
            {snapshot?.weekly.resetsAt
              ? `Queue cutoff pace + ${marginPercent}%, max ${WEEKLY_HARD_CEILING_PERCENT}% · resets ${localTimestamp(snapshot.weekly.resetsAt)}`
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
            <LineChart data={series} accessibilityLayer>
              <CartesianGrid stroke="#ffffff10" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                ticks={ticks}
                interval={0}
                tickFormatter={(t: number) =>
                  new Date(t).toLocaleDateString("en-US", {
                    weekday: "short",
                    timeZone: "America/New_York",
                  })
                }
                stroke="#8a8f98"
              />
              <YAxis domain={[0, 100]} unit="%" stroke="#8a8f98" width={45} />
              <Tooltip
                labelFormatter={(t) => localTimestamp(Number(t))}
                formatter={(value) => `${value}%`}
                contentStyle={{
                  background: "#191a1b",
                  border: "1px solid #ffffff20",
                  borderRadius: 8,
                }}
                separator=": "
              />
              <Legend itemSorter={() => 0} />
              <ReferenceLine
                x={Date.parse(snapshot.fetchedAt)}
                stroke="#f7f8f8"
                strokeOpacity={0.5}
                label={{
                  value: "now",
                  position: "insideTopRight",
                  fill: "#8a8f98",
                  fontSize: 10,
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
                stroke={CEILING_COLOR}
                strokeOpacity={0.7}
                strokeWidth={1}
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

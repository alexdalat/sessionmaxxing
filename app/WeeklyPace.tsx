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
import {
  MINUTE_MS,
  resetMinute,
  type UsageSample,
  type UsageSnapshot,
  WEEK_MINUTES,
  WEEKLY_HARD_CEILING_PERCENT,
} from "../shared/types";
import { easternDay, localTimestamp } from "./time";

const WEEK_MS = WEEK_MINUTES * MINUTE_MS;
const DAY_MS = 86_400_000;
export const WEEKLY_COLOR = "#7170ff";
export const FABLE_COLOR = "#b8893f";
const PACE_COLOR = "#8a8f98";
const CEILING_COLOR = "#e5484d";
const round = (value: number) => Math.round(value * 10) / 10;

export interface PacePoint {
  t: number;
  weekly?: number;
  fable?: number;
  pace: number;
  ceiling: number;
}
/** Samples inside the current weekly window plus the linear pace to its reset. */
export function paceSeries(
  samples: UsageSample[],
  snapshot: UsageSnapshot,
  marginPercent: number,
): PacePoint[] | null {
  if (snapshot.weekly.resetsAt === null) return null;
  const reset = Date.parse(snapshot.weekly.resetsAt);
  const week = resetMinute(snapshot.weekly.resetsAt);
  const start = reset - WEEK_MS;
  const paceAt = (t: number) =>
    round(Math.min(1, Math.max(0, (t - start) / WEEK_MS)) * 100);
  const ceilingAt = (t: number) =>
    Math.min(WEEKLY_HARD_CEILING_PERCENT, round(paceAt(t) + marginPercent));
  const points: PacePoint[] = samples
    .filter(
      (sample) =>
        sample.weeklyResetsAt !== null &&
        resetMinute(sample.weeklyResetsAt) === week,
    )
    .map((sample) => {
      const t = Date.parse(sample.at);
      return {
        t,
        weekly: sample.weekly,
        ...(sample.fable === null ? {} : { fable: sample.fable }),
        pace: paceAt(t),
        ceiling: ceilingAt(t),
      };
    });
  const lastSampleT = points.length
    ? points[points.length - 1].t
    : Number.NEGATIVE_INFINITY;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  const nowPoint: PacePoint | null =
    fetchedAt > lastSampleT && fetchedAt < reset
      ? {
          t: fetchedAt,
          weekly: snapshot.weekly.percent,
          ...(snapshot.fable === null ? {} : { fable: snapshot.fable.percent }),
          pace: paceAt(fetchedAt),
          ceiling: ceilingAt(fetchedAt),
        }
      : null;
  return [
    { t: start, pace: 0, ceiling: ceilingAt(start) },
    ...points,
    ...(nowPoint ? [nowPoint] : []),
    { t: reset, pace: 100, ceiling: ceilingAt(reset) },
  ].sort((a, b) => a.t - b.t);
}

/** Eastern midnights inside [start, end], one tick per calendar day. */
export function dayTicks(start: number, end: number): number[] {
  const ticks: number[] = [];
  for (let t = start; t <= end + DAY_MS; t += DAY_MS) {
    const midnight = t - easternDay(t).fraction * DAY_MS;
    if (midnight >= start && midnight <= end && !ticks.includes(midnight))
      ticks.push(midnight);
  }
  return ticks;
}

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
        <span className="muted">
          {snapshot?.weekly.resetsAt
            ? `Auto-dispatch limit = pace + ${marginPercent}% margin, capped at ${WEEKLY_HARD_CEILING_PERCENT}% · resets ${localTimestamp(snapshot.weekly.resetsAt)}`
            : "No weekly window reported"}
        </span>
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
              />
              <Legend />
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
                name="Pace"
                stroke={PACE_COLOR}
                strokeDasharray="4 4"
                strokeWidth={1.5}
                dot={false}
              />
              <Line
                type="linear"
                dataKey="ceiling"
                name="Auto-dispatch limit"
                stroke={CEILING_COLOR}
                strokeOpacity={0.7}
                strokeWidth={1}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="muted">
          Charts official weekly usage against a straight line to the reset once
          Anthropic reports a weekly window.
        </p>
      )}
    </figure>
  );
}

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type UsageSample,
  type UsageSnapshot,
  WEEK_MINUTES,
  WEEKLY_HARD_CEILING_PERCENT,
} from "../shared/types";
import { localTimestamp } from "./time";

const WEEK_MS = WEEK_MINUTES * 60_000;
export const WEEKLY_COLOR = "#7170ff";
export const FABLE_COLOR = "#b8893f";
const PACE_COLOR = "#8a8f98";
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
  const start = reset - WEEK_MS;
  const paceAt = (t: number) =>
    round(Math.min(1, Math.max(0, (t - start) / WEEK_MS)) * 100);
  const ceilingAt = (t: number) =>
    Math.min(WEEKLY_HARD_CEILING_PERCENT, round(paceAt(t) + marginPercent));
  const points: PacePoint[] = samples
    .filter((sample) => sample.weeklyResetsAt === snapshot.weekly.resetsAt)
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
  return [
    { t: start, pace: 0, ceiling: ceilingAt(start) },
    ...points,
    { t: reset, pace: 100, ceiling: ceilingAt(reset) },
  ];
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
  return (
    <figure className="panel" aria-label="Weekly usage against pace">
      <div className="section-heading">
        <h2>Weekly usage vs pace</h2>
        <span className="muted">
          {snapshot?.weekly.resetsAt
            ? `Window resets ${localTimestamp(snapshot.weekly.resetsAt)}`
            : "No weekly window reported"}
        </span>
      </div>
      {series ? (
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
                tickFormatter={(t: number) =>
                  new Date(t).toLocaleDateString("en-US", {
                    weekday: "short",
                    timeZone: "America/New_York",
                  })
                }
                stroke="#8a8f98"
                minTickGap={40}
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
              <Line
                type="stepAfter"
                dataKey="weekly"
                name="Weekly"
                stroke={WEEKLY_COLOR}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="stepAfter"
                dataKey="fable"
                name="Fable weekly"
                stroke={FABLE_COLOR}
                strokeWidth={2}
                dot={false}
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
                name="Dispatch ceiling"
                stroke={PACE_COLOR}
                strokeDasharray="1 3"
                strokeWidth={1.5}
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

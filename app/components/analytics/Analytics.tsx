"use client";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatNumber,
  runningTotals,
  sourceRows,
} from "@/app/lib/analyticsRows";
import { WEEKLY_COLOR } from "@/app/lib/chart";
import type { Analytics, Mix, SourceActivity } from "@/shared/types";
import { HOURS, hourLabel, shortHourLabel } from "@/shared/types";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function MixList({ title, items }: { title: string; items: Mix[] }) {
  const max = Math.max(1, ...items.map((i) => i.responses));
  return (
    <section className="panel">
      <h2>{title}</h2>
      {items.length ? (
        <ul className="mix-list">
          {items.map((item) => (
            <li key={item.name}>
              <div>
                <span>{item.name}</span>
                <span className="metric">{formatNumber(item.responses)}</span>
              </div>
              <meter
                min={0}
                max={max}
                value={item.responses}
                aria-label={`${item.name} responses`}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No responses in this range.</p>
      )}
    </section>
  );
}

const EXTERNAL_SOURCE_TITLE = "claude.ai and other machines";

function SourceMix({ sources }: { sources: SourceActivity[] }) {
  const rows = sourceRows(sources);
  const max = Math.max(1, ...rows.map((row) => row.responses));
  return (
    <section className="panel">
      <h2>Source mix · responses</h2>
      <ul className="mix-list">
        {rows.map((row) => (
          <li
            key={row.label}
            title={
              row.measured
                ? `${formatNumber(row.activeMinutes)} active minutes · ${formatNumber(row.outputTokens)} output tokens`
                : EXTERNAL_SOURCE_TITLE
            }
          >
            <div>
              <span>{row.label}</span>
              <span className="metric">
                {row.measured ? formatNumber(row.responses) : "–"}
              </span>
            </div>
            {row.measured && (
              <meter
                min={0}
                max={max}
                value={row.responses}
                aria-label={`${row.label} responses`}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AnalyticsView({ data }: { data: Analytics }) {
  const max = Math.max(1, ...data.heatmap.map((c) => c.activeMinutes));
  const cumulative = runningTotals(data.daily);
  return (
    <>
      <div className="section-heading">
        <h2>Last {data.days} days · local Claude Code</h2>
      </div>
      {!data.totals.responses && (
        <div className="empty">
          <h2>No Claude activity in this range</h2>
          <p>Use Claude Code locally, then refresh.</p>
        </div>
      )}
      <div className="stats-grid">
        {[
          ["Active minutes", data.totals.activeMinutes],
          ["Responses", data.totals.responses],
          [
            "Input + output tokens",
            data.totals.inputTokens + data.totals.outputTokens,
          ],
          ["Cache-read tokens", data.totals.cacheReadTokens],
        ].map(([label, value]) => (
          <section className="panel stat" key={label}>
            <h2>{label}</h2>
            <strong className="metric">{formatNumber(Number(value))}</strong>
          </section>
        ))}
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>Busy hours by weekday</h2>
          <span className="muted">Less ░ ▒ ▓ More</span>
        </div>
        <div className="table-scroll">
          <table className="heatmap">
            <thead>
              <tr>
                <th scope="col">Day</th>
                {HOURS.map((h) => (
                  <th scope="col" key={h}>
                    {shortHourLabel(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weekdays.map((day, d) => (
                <tr key={day}>
                  <th scope="row">{day}</th>
                  {data.heatmap
                    .filter((c) => c.day === d)
                    .map((c) => (
                      <td key={c.hour}>
                        <button
                          type="button"
                          style={{
                            backgroundColor: c.activeMinutes
                              ? `rgb(113 112 255 / ${0.2 + (0.8 * c.activeMinutes) / max})`
                              : "#191a1b",
                          }}
                          aria-label={`${day} ${hourLabel(c.hour)}, ${c.activeMinutes} active minutes, ${c.responses} responses`}
                          title={`${c.activeMinutes} active minutes · ${c.responses} responses`}
                        >
                          <span className="sr-only">{c.activeMinutes}</span>
                        </button>
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <figure
        className="panel cumulative"
        aria-label={`Cumulative Claude activity over the last ${data.days} days`}
      >
        <div className="section-heading">
          <h2>Cumulative active minutes</h2>
          <span className="muted">Since {data.daily[0]?.date}</span>
        </div>
        <div className="chart">
          <ResponsiveContainer
            width="100%"
            height={240}
            initialDimension={{ width: 700, height: 240 }}
          >
            <LineChart data={cumulative} accessibilityLayer>
              <CartesianGrid stroke="#ffffff10" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(date) => date.slice(5)}
                stroke="#8a8f98"
                minTickGap={25}
              />
              <YAxis stroke="#8a8f98" allowDecimals={false} width={50} />
              <Tooltip
                formatter={(value, _name, item) => [
                  `${formatNumber(Number(value))} min · ${formatNumber(item.payload.responses)} responses`,
                  "To date",
                ]}
                contentStyle={{
                  background: "#191a1b",
                  border: "1px solid #ffffff20",
                  borderRadius: 8,
                }}
                separator=": "
              />
              <Line
                type="stepAfter"
                dataKey="activeMinutes"
                name="Active minutes to date"
                stroke={WEEKLY_COLOR}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </figure>
      <div className="three-column">
        <MixList title="Model mix · responses" items={data.models} />
        <MixList title="Project mix · responses" items={data.projects} />
        <SourceMix sources={data.sources} />
      </div>
      {data.health.warnings > 0 && (
        <p className="warning" role="status">
          {data.health.warnings} malformed transcript records were skipped.
        </p>
      )}
    </>
  );
}

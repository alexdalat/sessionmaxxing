"use client";
import { useId, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Legend } from "@/app/components/Legend";
import { Segmented } from "@/app/components/Segmented";
import {
  type ActivityRow,
  activitySeries,
  BREAKDOWNS,
  type Breakdown,
  seriesColor,
  seriesLabel,
} from "@/app/lib/activitySeries";
import {
  formatMetric,
  formatNumber,
  sourceRows,
} from "@/app/lib/analyticsRows";
import {
  AXIS_PROPS,
  BAR_SEPARATOR,
  CHART_CURSOR_FILL,
  CHART_MARGIN,
  GRID_COLOR,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
} from "@/app/lib/chart";
import { FIELD_LABELS } from "@/app/lib/labels";
import type { Analytics, Mix, SourceActivity } from "@/shared/types";
import { Heatmap } from "./Heatmap";

const CHART_HEIGHT = 260;
const EXTERNAL_SOURCE_TITLE = "claude.ai and other machines";
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

interface MixRow {
  name: string;
  responses: number | null;
  title?: string;
}

function MixList({ title, rows }: { title: string; rows: MixRow[] }) {
  const headingId = useId();
  const max = Math.max(1, ...rows.map((row) => row.responses ?? 0));
  return (
    <section className="section" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 className="section-title" id={headingId}>
          {title}
        </h2>
        <span className="muted">Responses</span>
      </div>
      {rows.length ? (
        <ul className="mix-list">
          {rows.map((row) => (
            <li key={row.name} title={row.title}>
              <div className="mix-row">
                <span>{row.name}</span>
                <span>
                  {row.responses === null ? "–" : formatNumber(row.responses)}
                </span>
              </div>
              {row.responses !== null && (
                <meter
                  min={0}
                  max={max}
                  value={row.responses}
                  aria-label={`${row.name} responses`}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No responses in this range</p>
      )}
    </section>
  );
}

const mixRows = (items: Mix[]): MixRow[] =>
  items.map((item) => ({ name: item.name, responses: item.responses }));

const sourceMixRows = (sources: SourceActivity[]): MixRow[] =>
  sourceRows(sources).map((row) => ({
    name: row.label,
    responses: row.measured ? row.responses : null,
    title: row.measured
      ? `${formatNumber(row.activeMinutes)} active minutes, ${formatNumber(Math.round(row.tokens))} weighted tokens`
      : EXTERNAL_SOURCE_TITLE,
  }));

export function AnalyticsView({
  data,
  quietStartHours,
}: {
  data: Analytics;
  quietStartHours?: number;
}) {
  const chartHeadingId = useId();
  const [breakdown, setBreakdown] = useState<Breakdown>("source");
  const { keys, rows } = activitySeries(data.daily, breakdown);
  const kpis: [string, number][] = [
    ["Active minutes", data.totals.activeMinutes],
    ["Responses", data.totals.responses],
    [
      "Input + output tokens",
      data.totals.inputTokens + data.totals.outputTokens,
    ],
    ["Cache-read tokens", data.totals.cacheReadTokens],
  ];
  return (
    <>
      <section className="kpis" aria-label="Totals">
        {kpis.map(([label, value]) => (
          <div className="kpi" key={label}>
            <p className="kpi-label">{label}</p>
            <p className="kpi-figure">
              <span className="kpi-value" title={formatNumber(value)}>
                {formatMetric(value)}
              </span>
            </p>
          </div>
        ))}
      </section>
      {!data.totals.responses && (
        <p className="empty">No Claude activity in this range</p>
      )}
      <Heatmap data={data} quietStartHours={quietStartHours} />
      <section className="section" aria-labelledby={chartHeadingId}>
        <div className="section-head">
          <h2 className="section-title" id={chartHeadingId}>
            Active minutes
          </h2>
          <div className="section-tools">
            <Legend
              items={keys.map((key, index) => ({
                label: seriesLabel(breakdown, key),
                color: seriesColor(breakdown, key, index),
              }))}
            />
            <Segmented
              label={FIELD_LABELS.breakdown}
              value={breakdown}
              options={BREAKDOWNS}
              onChange={setBreakdown}
            />
          </div>
        </div>
        <div className="chart">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 900, height: CHART_HEIGHT }}
          >
            <BarChart data={rows} margin={CHART_MARGIN} accessibilityLayer>
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis
                {...AXIS_PROPS}
                dataKey="date"
                tickFormatter={dayLabel}
                minTickGap={24}
              />
              <YAxis {...AXIS_PROPS} allowDecimals={false} width={44} />
              <Tooltip
                formatter={(value, name) => [
                  `${formatNumber(Number(value))} min`,
                  name,
                ]}
                labelFormatter={(date, payload) => {
                  const row = payload[0]?.payload as ActivityRow | undefined;
                  const day = dayLabel(String(date));
                  return row
                    ? `${day} · ${formatNumber(row.activeMinutes)} min · ${formatNumber(row.responses)} responses`
                    : day;
                }}
                contentStyle={TOOLTIP_STYLE}
                itemStyle={TOOLTIP_ITEM_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                cursor={{ fill: CHART_CURSOR_FILL }}
                separator=" "
              />
              {keys.map((key, index) => (
                <Bar
                  key={key}
                  stackId="minutes"
                  dataKey={key}
                  name={seriesLabel(breakdown, key)}
                  fill={seriesColor(breakdown, key, index)}
                  isAnimationActive={false}
                  {...BAR_SEPARATOR}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
      <div className="trio">
        <MixList title="Models" rows={mixRows(data.models)} />
        <MixList title="Projects" rows={mixRows(data.projects)} />
        <MixList title="Sources" rows={sourceMixRows(data.sources)} />
      </div>
      {data.health.warnings > 0 && (
        <p className="warning" role="status">
          Skipped {formatNumber(data.health.warnings)} malformed transcript
          records
        </p>
      )}
    </>
  );
}

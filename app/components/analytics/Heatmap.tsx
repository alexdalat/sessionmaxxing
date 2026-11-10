"use client";
import { useId } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { Legend, type LegendItem } from "@/app/components/Legend";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import { useClock } from "@/app/hooks/useClock";
import {
  formatMetric,
  formatNumber,
  heatmapTotals,
} from "@/app/lib/analyticsRows";
import { TOOLTIP_CLASS } from "@/app/lib/chart";
import { blueAlpha, FIELD, INK, ORANGE } from "@/app/lib/palette";
import { allowedStartHours } from "@/app/lib/quietHours";
import { localCell, WEEKDAYS } from "@/app/lib/time";
import type { Analytics, HeatCell, HeatShare } from "@/shared/types";
import {
  ACTIVITY_SOURCE_LABELS,
  ACTIVITY_SOURCES,
  formatTokens,
  HOURS,
  hourLabel,
  shortHourLabel,
} from "@/shared/types";

const HOURS_PER_DAY = 24;
const CELL_BASE_ALPHA = 0.12;
const CELL_RANGE_ALPHA = 0.88;
const shade = (value: number, max: number) =>
  value ? blueAlpha(CELL_BASE_ALPHA + (CELL_RANGE_ALPHA * value) / max) : FIELD;
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
const minutes = (value: number) => `${formatNumber(Math.round(value))} min`;
const cellTitle = (cell: HeatCell) =>
  `${WEEKDAYS[cell.day]} ${hourLabel(cell.hour)} – ${hourLabel((cell.hour + 1) % HOURS_PER_DAY)}`;
const cellDescription = (cell: HeatCell) =>
  `${cellTitle(cell)}, ${cell.activeMinutes} active minutes, ${cell.responses} responses, ${cell.sources.dispatched} dispatched minutes`;
const dispatchedShare = (cell: HeatCell) =>
  cell.activeMinutes ? cell.sources.dispatched / cell.activeMinutes : 0;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="heat-row">
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}
function Shares({ title, items }: { title: string; items: HeatShare[] }) {
  if (!items.length) return null;
  return (
    <>
      <span className="heat-group">{title}</span>
      {items.map((item) => (
        <Row
          key={item.name}
          label={item.name}
          value={minutes(item.activeMinutes)}
        />
      ))}
    </>
  );
}
function CellDetails({ cell }: { cell: HeatCell }) {
  return (
    <>
      <strong className="font-medium">{cellTitle(cell)}</strong>
      {cell.activeMinutes ? (
        <>
          <Row label="Active" value={minutes(cell.activeMinutes)} />
          <Row label="Responses" value={formatNumber(cell.responses)} />
          <Row label="Avg" value={minutes(cell.averageActiveMinutes)} />
          <Row label="Tokens" value={formatTokens(cell.tokens)} />
          <span className="heat-group">Source</span>
          {ACTIVITY_SOURCES.filter((source) => cell.sources[source] > 0).map(
            (source) => (
              <Row
                key={source}
                label={ACTIVITY_SOURCE_LABELS[source]}
                value={minutes(cell.sources[source])}
              />
            ),
          )}
          <Shares title="Models" items={cell.models} />
          <Shares title="Projects" items={cell.projects} />
        </>
      ) : (
        <span>0 min</span>
      )}
    </>
  );
}

export function Heatmap({
  data,
  quietStartHours,
}: {
  data: Analytics;
  quietStartHours: number | undefined;
}) {
  const { timeZone } = useEnvironment();
  const now = localCell(useClock(), timeZone);
  const max = Math.max(1, ...data.heatmap.map((cell) => cell.activeMinutes));
  const headingId = useId();
  const totals = heatmapTotals(data.heatmap);
  const quiet =
    quietStartHours === undefined
      ? new Set<number>()
      : allowedStartHours(data.opportunities, quietStartHours);
  const flag = (hour: number, day?: number) =>
    [
      hour === now.hour && (day === undefined || day === now.day) ? "now" : "",
      day === undefined && quiet.has(hour) ? "quiet" : "",
    ]
      .filter(Boolean)
      .join(" ");
  const legend: LegendItem[] = [
    { label: "Now", color: INK, shape: "ring" },
    ...(quietStartHours === undefined
      ? []
      : [{ label: "Quiet start", color: ORANGE }]),
    { label: "Dispatched", color: ORANGE, shape: "bar" },
  ];
  return (
    <section className="section" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 className="section-title" id={headingId}>
          Busy hours
        </h2>
        <Legend items={legend} />
      </div>
      <div className="table-scroll">
        <table className="heatmap">
          <thead>
            <tr>
              <th scope="col">Day</th>
              {HOURS.map((hour) => (
                <th scope="col" key={hour} className={flag(hour)}>
                  {shortHourLabel(hour)}
                </th>
              ))}
              <th scope="col" className="heat-total">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {WEEKDAYS.map((day, d) => (
              <tr key={day}>
                <th scope="row" className={d === now.day ? "now" : ""}>
                  {day}
                </th>
                {data.heatmap
                  .filter((cell) => cell.day === d)
                  .map((cell) => (
                    <td key={cell.hour}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className={flag(cell.hour, d)}
                            style={{
                              backgroundColor: shade(cell.activeMinutes, max),
                            }}
                            aria-label={cellDescription(cell)}
                          >
                            {cell.sources.dispatched > 0 && (
                              <span
                                className="heat-dispatched"
                                style={{ width: pct(dispatchedShare(cell)) }}
                                aria-hidden="true"
                              />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className={TOOLTIP_CLASS}>
                          <CellDetails cell={cell} />
                        </TooltipContent>
                      </Tooltip>
                    </td>
                  ))}
                <td className="heat-total">{formatMetric(totals.days[d])}</td>
              </tr>
            ))}
            <tr className="heat-totals">
              <th scope="row">Total</th>
              {HOURS.map((hour) => (
                <td key={hour} className="heat-total">
                  {formatMetric(totals.hours[hour])}
                </td>
              ))}
              <td className="heat-total heat-grand">
                {formatMetric(totals.total)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

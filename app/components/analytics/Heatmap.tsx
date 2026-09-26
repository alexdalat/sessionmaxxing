"use client";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import { useClock } from "@/app/hooks/useClock";
import { formatNumber, heatmapTotals } from "@/app/lib/analyticsRows";
import { TOOLTIP_CLASS } from "@/app/lib/chart";
import { allowedStartHours } from "@/app/lib/quietHours";
import { easternCell, WEEKDAYS } from "@/app/lib/time";
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
const CELL_BASE_ALPHA = 0.2;
const CELL_RANGE_ALPHA = 0.8;
const TOTAL_BASE_ALPHA = 0.04;
const TOTAL_RANGE_ALPHA = 0.28;
const EMPTY_CELL = "#191a1b";
const accent = (alpha: number) => `rgb(113 112 255 / ${alpha})`;
const shade = (value: number, max: number, base: number, range: number) =>
  value ? accent(base + (range * value) / max) : EMPTY_CELL;
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
      <span className="metric">{value}</span>
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
  const now = easternCell(useClock());
  const max = Math.max(1, ...data.heatmap.map((cell) => cell.activeMinutes));
  const totals = heatmapTotals(data.heatmap);
  const dayMax = Math.max(1, ...totals.days);
  const hourMax = Math.max(1, ...totals.hours);
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
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Busy hours by weekday</h2>
        <ul className="heat-legend" aria-label="Legend">
          <li>
            <span className="heat-key now" /> Now
          </li>
          {quietStartHours !== undefined && (
            <li>
              <span className="heat-key quiet" /> Quiet start
            </li>
          )}
          <li>
            <span className="heat-key dispatched" /> Dispatched
          </li>
        </ul>
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
                              backgroundColor: shade(
                                cell.activeMinutes,
                                max,
                                CELL_BASE_ALPHA,
                                CELL_RANGE_ALPHA,
                              ),
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
                <td
                  className="heat-total metric"
                  style={{
                    backgroundColor: shade(
                      totals.days[d],
                      dayMax,
                      TOTAL_BASE_ALPHA,
                      TOTAL_RANGE_ALPHA,
                    ),
                  }}
                >
                  {formatNumber(totals.days[d])}
                </td>
              </tr>
            ))}
            <tr className="heat-totals">
              <th scope="row">Total</th>
              {HOURS.map((hour) => (
                <td
                  key={hour}
                  className="heat-total metric"
                  style={{
                    backgroundColor: shade(
                      totals.hours[hour],
                      hourMax,
                      TOTAL_BASE_ALPHA,
                      TOTAL_RANGE_ALPHA,
                    ),
                  }}
                >
                  {formatNumber(totals.hours[hour])}
                </td>
              ))}
              <td className="heat-total heat-grand metric">
                {formatNumber(totals.total)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

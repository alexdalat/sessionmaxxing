"use client";
import type { ReactNode } from "react";
import { Legend, type LegendItem } from "@/app/components/Legend";
import { CUTOFF_COLOR, PACE_COLOR } from "@/app/lib/chart";
import { blueAlpha } from "@/app/lib/palette";
import type { StripRow } from "@/app/lib/usageStrip";

const HELD_ALPHA = 0.32;
const pct = (value: number) => `${value}%`;

function Kpi({ row }: { row: StripRow }) {
  return (
    <div className="kpi">
      <p className="kpi-label">{row.label}</p>
      <p className="kpi-figure">
        <span className="kpi-value">{row.percentText}</span>
        {row.paceText && (
          <span
            className="kpi-delta"
            data-tone={row.paceTone === "under" ? "good" : "bad"}
          >
            {row.paceText}
          </span>
        )}
      </p>
      <div
        className="meter"
        data-bucket={row.bucket}
        role="img"
        aria-label={row.ariaLabel}
      >
        <div className="meter-fill" style={{ width: pct(row.fill) }} />
        {row.held > 0 && (
          <div
            className="meter-held"
            style={{ left: pct(row.fill), width: pct(row.held) }}
          />
        )}
        {row.pace !== null && (
          <div
            className="meter-mark meter-pace"
            style={{ left: pct(row.pace) }}
          />
        )}
        <div
          className="meter-mark meter-cutoff"
          style={{ left: pct(row.ceiling) }}
        />
      </div>
      <p className="kpi-note">
        <span>{row.cutoffText}</span>
        {row.heldText && <span>{row.heldText}</span>}
        <span>{row.resetNote}</span>
      </p>
    </div>
  );
}

export function UsageKpis({
  rows,
  head,
}: {
  rows: StripRow[];
  head?: ReactNode;
}) {
  const legend: LegendItem[] = [
    ...(rows.some((row) => row.pace !== null)
      ? [{ label: "Pace", color: PACE_COLOR, shape: "tick" as const }]
      : []),
    { label: "Queue cutoff", color: CUTOFF_COLOR, shape: "tick" },
    ...(rows.some((row) => row.held > 0)
      ? [
          {
            label: "Held by running tasks",
            color: blueAlpha(HELD_ALPHA),
            shape: "bar" as const,
          },
        ]
      : []),
  ];
  return (
    <section className="section" aria-label="Usage">
      {head && <div className="section-head">{head}</div>}
      <div className="kpis">
        {rows.map((row) => (
          <Kpi key={row.bucket} row={row} />
        ))}
      </div>
      <div className="mt-6">
        <Legend items={legend} />
      </div>
    </section>
  );
}

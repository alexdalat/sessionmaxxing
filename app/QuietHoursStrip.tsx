"use client";
import { hourLabel, type Opportunity } from "../shared/types";
import { Skeleton } from "./Skeleton";

const HOURS = 24;
const AXIS_HOURS = [0, 6, 12, 18];
const SKELETON_KEYS = Array.from({ length: HOURS }, (_, hour) => hour);
const BASE_ALPHA = 0.15;
const ACTIVE_ALPHA = 0.85;
const ACCENT_RGB = "113, 112, 255";

export function allowedStartHours(
  opportunities: Opportunity[],
  allowed: number,
) {
  const count = Math.min(HOURS, Math.max(0, Math.trunc(allowed)));
  return new Set(
    opportunities.slice(0, count).map((opportunity) => opportunity.startHour),
  );
}

const cellShade = (utilization: number) =>
  `rgba(${ACCENT_RGB}, ${BASE_ALPHA + ACTIVE_ALPHA * Math.min(1, Math.max(0, utilization))})`;

const cellLabel = (opportunity: Opportunity) =>
  `${hourLabel(opportunity.startHour)} · avg ${Math.round(opportunity.averageActiveMinutes)} min`;

export function QuietHoursStrip({
  opportunities,
  allowed,
}: {
  opportunities: Opportunity[] | undefined;
  allowed: number;
}) {
  if (!opportunities)
    return (
      <div className="quiet-strip">
        {SKELETON_KEYS.map((hour) => (
          <Skeleton className="h-[18px] w-full" key={hour} />
        ))}
      </div>
    );
  const allowedHours = allowedStartHours(opportunities, allowed);
  const byClock = [...opportunities].sort((a, b) => a.startHour - b.startHour);
  return (
    <>
      <div className="quiet-strip">
        {byClock.map((opportunity) => (
          <span
            key={opportunity.startHour}
            className={allowedHours.has(opportunity.startHour) ? "allowed" : ""}
            role="img"
            aria-label={cellLabel(opportunity)}
            style={{ background: cellShade(opportunity.utilization) }}
          />
        ))}
      </div>
      <div className="quiet-axis" aria-hidden="true">
        {AXIS_HOURS.map((hour) => (
          <span key={hour} style={{ left: `${(hour / HOURS) * 100}%` }}>
            {hourLabel(hour)}
          </span>
        ))}
      </div>
    </>
  );
}

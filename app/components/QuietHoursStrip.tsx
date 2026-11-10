"use client";
import { Skeleton } from "@/app/components/ui/skeleton";
import { blueAlpha } from "@/app/lib/palette";
import { allowedStartHours } from "@/app/lib/quietHours";
import { hourLabel, type Opportunity } from "@/shared/types";

const HOURS = 24;
const AXIS_HOURS = [0, 6, 12, 18];
const SKELETON_KEYS = Array.from({ length: HOURS }, (_, hour) => hour);
const BASE_ALPHA = 0.12;
const ACTIVE_ALPHA = 0.8;
const cellShade = (utilization: number) =>
  blueAlpha(BASE_ALPHA + ACTIVE_ALPHA * Math.min(1, Math.max(0, utilization)));

const cellLabel = (opportunity: Opportunity) =>
  `${hourLabel(opportunity.startHour)}, average ${Math.round(opportunity.averageActiveMinutes)} active minutes`;

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
          <Skeleton className="h-6 w-full" key={hour} />
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

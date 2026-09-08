import type { Opportunity } from "@/shared/types";

const HOURS = 24;

export function allowedStartHours(
  opportunities: Opportunity[],
  allowed: number,
) {
  const count = Math.min(HOURS, Math.max(0, Math.trunc(allowed)));
  return new Set(
    opportunities.slice(0, count).map((opportunity) => opportunity.startHour),
  );
}

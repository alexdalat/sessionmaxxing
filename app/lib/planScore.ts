import type { PlanScore } from "@/shared/types";

/** 16:00Z is noon EST and 1 PM EDT, so the same suffix stays inside the Eastern day in either offset. */
const EASTERN_MIDDAY_SUFFIX = "T16:00:00Z";

export interface ScorePoint {
  date: string;
  coverage: number | null;
  weekly: number | null;
}
/** One point per sampled day: its session coverage and the score of the week containing it. */
export function scoreSeries(plan: PlanScore): ScorePoint[] {
  return plan.days.map((day) => {
    const midday = Date.parse(`${day.date}${EASTERN_MIDDAY_SUFFIX}`);
    const week = plan.weeks.find(
      (candidate) =>
        midday >= Date.parse(candidate.start) &&
        midday < Date.parse(candidate.end),
    );
    return {
      date: day.date,
      coverage: day.coverage,
      weekly: week ? week.score : null,
    };
  });
}

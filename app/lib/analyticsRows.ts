import {
  ACTIVITY_SOURCE_LABELS,
  EXTERNAL_SOURCE_LABEL,
  type SourceActivity,
} from "@/shared/types";

export const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US").format(value);

export interface SourceRow {
  label: string;
  responses: number;
  activeMinutes: number;
  outputTokens: number;
  measured: boolean;
}

export function sourceRows(sources: SourceActivity[]): SourceRow[] {
  const measured = sources
    .filter((entry) => entry.source !== "unknown" || entry.responses > 0)
    .map(({ source, activeMinutes, responses, outputTokens }) => ({
      label: ACTIVITY_SOURCE_LABELS[source],
      responses,
      activeMinutes,
      outputTokens,
      measured: true,
    }));
  return [
    ...measured,
    {
      label: EXTERNAL_SOURCE_LABEL,
      responses: 0,
      activeMinutes: 0,
      outputTokens: 0,
      measured: false,
    },
  ];
}

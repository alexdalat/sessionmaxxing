import type { ActivitySource } from "@/shared/types";

export const WEEKLY_COLOR = "#7170ff";
export const FABLE_COLOR = "#b8893f";
export const MUTED_COLOR = "#8a8f98";
export const accentAlpha = (alpha: number) => `rgba(113, 112, 255, ${alpha})`;
export const ACTIVITY_SOURCE_COLORS: Record<ActivitySource, string> = {
  local: WEEKLY_COLOR,
  dispatched: accentAlpha(0.45),
  unknown: MUTED_COLOR,
};
export const MODEL_SERIES_COLORS = [
  WEEKLY_COLOR,
  "#4f7cff",
  "#3aa7a0",
  MUTED_COLOR,
];
export const CHART_CURSOR_FILL = "#ffffff0a";
/** shadcn TooltipContent on the panel surface, stacked rows. */
export const TOOLTIP_CLASS =
  "flex-col items-start gap-0.5 bg-popover text-popover-foreground ring-1 ring-foreground/10 [&_svg]:bg-popover [&_svg]:fill-popover";
export const TOOLTIP_STYLE = {
  background: "#191a1b",
  border: "1px solid #ffffff20",
  borderRadius: 8,
};

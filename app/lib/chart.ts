import {
  BLUE,
  INK,
  INK_MUTED,
  inkAlpha,
  LINE,
  MAGENTA,
  ORANGE,
  PAGE,
  RAISED,
  SUBTLE,
  TEAL,
  VIOLET,
} from "@/app/lib/palette";
import type { ActivitySource } from "@/shared/types";

export const WEEKLY_COLOR = BLUE;
export const FABLE_COLOR = TEAL;
export const MUTED_COLOR = SUBTLE;
export const ACTIVITY_SOURCE_COLORS: Record<ActivitySource, string> = {
  local: BLUE,
  dispatched: ORANGE,
  unknown: SUBTLE,
};
/** Teal stays out so no other model takes Fable's color. */
export const MODEL_SERIES_COLORS = [BLUE, ORANGE, VIOLET, MAGENTA];
export const PACE_COLOR = SUBTLE;
export const CUTOFF_COLOR = ORANGE;
export const NOW_LINE_COLOR = INK_MUTED;
export const GRID_COLOR = LINE;
export const AXIS_TEXT_COLOR = INK_MUTED;
export const CHART_CURSOR_FILL = inkAlpha(0.04);
export const CHART_MARGIN = { top: 8, right: 4, bottom: 0, left: 0 };
export const AXIS_TICK = { fill: AXIS_TEXT_COLOR, fontSize: 12 };
export const AXIS_PROPS = {
  axisLine: false,
  tickLine: false,
  tick: AXIS_TICK,
} as const;
export const BAR_SEPARATOR = { stroke: PAGE, strokeWidth: 1 };
export const TOOLTIP_CLASS = "flex-col items-start gap-1";
export const TOOLTIP_STYLE = {
  background: RAISED,
  border: `1px solid ${LINE}`,
  borderRadius: 10,
  padding: "8px 12px",
  color: INK,
  boxShadow: "var(--shadow-pop)",
  fontSize: 12,
};
export const TOOLTIP_ITEM_STYLE = { color: INK, padding: 0 };
export const TOOLTIP_LABEL_STYLE = {
  color: INK,
  fontWeight: 500,
  marginBottom: 4,
};

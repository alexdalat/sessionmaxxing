import {
  COBALT,
  INK,
  INK_MUTED,
  inkAlpha,
  NOW_LINE,
  OLIVE,
  PAPER,
  PLUM,
  paperAlpha,
  SUBTLE,
  TEAL,
} from "@/app/lib/palette";
import type { ActivitySource } from "@/shared/types";

export const WEEKLY_COLOR = INK;
export const FABLE_COLOR = PLUM;
export const MUTED_COLOR = SUBTLE;
export const ACTIVITY_SOURCE_COLORS: Record<ActivitySource, string> = {
  local: INK,
  dispatched: COBALT,
  unknown: SUBTLE,
};
export const MODEL_SERIES_COLORS = [INK, COBALT, TEAL, OLIVE];
export const PACE_COLOR = SUBTLE;
export const CUTOFF_COLOR = COBALT;
export const NOW_LINE_COLOR = NOW_LINE;
export const GRID_COLOR = inkAlpha(0.12);
export const AXIS_TEXT_COLOR = INK_MUTED;
export const CHART_CURSOR_FILL = inkAlpha(0.06);
export const CHART_MARGIN = { top: 8, right: 8, bottom: 8, left: 8 };
export const BAR_SEPARATOR = { stroke: PAPER, strokeWidth: 1 };
export const TOOLTIP_CLASS = "flex-col items-start gap-1";
export const TOOLTIP_STYLE = {
  background: INK,
  border: `1px solid ${paperAlpha(0.24)}`,
  borderRadius: 12,
  padding: "8px 12px",
  color: PAPER,
};
export const TOOLTIP_ITEM_STYLE = { color: PAPER };
export const TOOLTIP_LABEL_STYLE = { color: PAPER };

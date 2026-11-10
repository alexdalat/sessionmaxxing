export type Theme = "light" | "dark";

export type Palette = {
  page: string;
  sidebar: string;
  raised: string;
  field: string;
  fieldHover: string;
  line: string;
  ink: string;
  inkMuted: string;
  primaryHover: string;
  blue: string;
  orange: string;
  teal: string;
  violet: string;
  magenta: string;
  subtle: string;
  success: string;
  warning: string;
  destructive: string;
};

export const LIGHT: Palette = {
  page: "#FFFFFF",
  sidebar: "#F7F7F8",
  raised: "#FFFFFF",
  field: "#F2F2F4",
  fieldHover: "#E9E9EC",
  line: "#E6E6EA",
  ink: "#111113",
  inkMuted: "#62626B",
  primaryHover: "#2E2E33",
  blue: "#2E63E6",
  orange: "#D9541E",
  teal: "#0E8C74",
  violet: "#7B5CE0",
  magenta: "#C2338A",
  subtle: "#8B8B94",
  success: "#15793A",
  warning: "#A0590A",
  destructive: "#C4281F",
};

export const DARK: Palette = {
  page: "#0E0E10",
  sidebar: "#161619",
  raised: "#1B1B1F",
  field: "#222227",
  fieldHover: "#2C2C32",
  line: "#29292F",
  ink: "#EDEDF0",
  inkMuted: "#A3A3AD",
  primaryHover: "#D2D2D9",
  blue: "#3987E5",
  orange: "#D95926",
  teal: "#199E70",
  violet: "#9085E9",
  magenta: "#D55181",
  subtle: "#74747E",
  success: "#4CC38A",
  warning: "#E6A84C",
  destructive: "#FF7D74",
};

export const PALETTES: Record<Theme, Palette> = { light: LIGHT, dark: DARK };

/** CSS custom property that holds a palette entry, e.g. `inkMuted` → `--ink-muted`. */
export const tokenName = (key: keyof Palette) =>
  `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

export const tokenVar = (key: keyof Palette) => `var(${tokenName(key)})`;

export const PAGE = tokenVar("page");
export const RAISED = tokenVar("raised");
export const FIELD = tokenVar("field");
export const LINE = tokenVar("line");
export const INK = tokenVar("ink");
export const INK_MUTED = tokenVar("inkMuted");
export const BLUE = tokenVar("blue");
export const ORANGE = tokenVar("orange");
export const TEAL = tokenVar("teal");
export const VIOLET = tokenVar("violet");
export const MAGENTA = tokenVar("magenta");
export const SUBTLE = tokenVar("subtle");

const PERCENT = 100;
const mix = (key: keyof Palette) => (alpha: number) =>
  `color-mix(in srgb, ${tokenVar(key)} ${Math.round(alpha * PERCENT * PERCENT) / PERCENT}%, transparent)`;

export const blueAlpha = mix("blue");
export const inkAlpha = mix("ink");

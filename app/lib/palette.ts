export type Theme = "light" | "dark";

export type Palette = {
  frame: string;
  paper: string;
  pink: string;
  ink: string;
  inkMuted: string;
  inkMutedOnPink: string;
  inset: string;
  insetOnPink: string;
  fieldBorder: string;
  primaryHover: string;
  cobalt: string;
  plum: string;
  teal: string;
  olive: string;
  subtle: string;
  nowLine: string;
  success: string;
  warning: string;
  destructive: string;
};

export const LIGHT: Palette = {
  frame: "#E9E4DF",
  paper: "#F4F1EE",
  pink: "#F2D3D0",
  ink: "#111111",
  inkMuted: "#5C5550",
  inkMutedOnPink: "#4F4945",
  inset: "#E9E3DD",
  insetOnPink: "#E0C3C1",
  fieldBorder: "#77706B",
  primaryHover: "#2B2B2B",
  cobalt: "#2A3FD1",
  plum: "#8E2F8E",
  teal: "#0B6E66",
  olive: "#5A6410",
  subtle: "#6F6761",
  nowLine: "#838180",
  success: "#176B33",
  warning: "#7A4F00",
  destructive: "#961A14",
};

export const DARK: Palette = {
  frame: "#0A0A0A",
  paper: "#181614",
  pink: "#36222A",
  ink: "#F4F1EE",
  inkMuted: "#B3ACA6",
  inkMutedOnPink: "#C7BCBA",
  inset: "#2C2826",
  insetOnPink: "#4C3337",
  fieldBorder: "#8A827C",
  primaryHover: "#DDD6D0",
  cobalt: "#8E9CFF",
  plum: "#E28CE2",
  teal: "#4FC4B9",
  olive: "#B7C25B",
  subtle: "#9C938C",
  nowLine: "#8A8785",
  success: "#62C988",
  warning: "#E2AA4E",
  destructive: "#FF8077",
};

export const PALETTES: Record<Theme, Palette> = { light: LIGHT, dark: DARK };

/** CSS custom property that holds a palette entry, e.g. `inkMuted` → `--ink-muted`. */
export const tokenName = (key: keyof Palette) =>
  `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

export const tokenVar = (key: keyof Palette) => `var(${tokenName(key)})`;

export const PAPER = tokenVar("paper");
export const INK = tokenVar("ink");
export const INK_MUTED = tokenVar("inkMuted");
export const INSET = tokenVar("inset");
export const COBALT = tokenVar("cobalt");
export const PLUM = tokenVar("plum");
export const TEAL = tokenVar("teal");
export const OLIVE = tokenVar("olive");
export const SUBTLE = tokenVar("subtle");
export const NOW_LINE = tokenVar("nowLine");

const PERCENT = 100;
const mix = (key: keyof Palette) => (alpha: number) =>
  `color-mix(in srgb, ${tokenVar(key)} ${Math.round(alpha * PERCENT * PERCENT) / PERCENT}%, transparent)`;

export const inkAlpha = mix("ink");
export const paperAlpha = mix("paper");

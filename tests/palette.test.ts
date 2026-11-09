import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COBALT,
  DESTRUCTIVE,
  FIELD_BORDER,
  FRAME,
  INK,
  INK_MUTED,
  INK_MUTED_ON_PINK,
  INSET,
  INSET_ON_PINK,
  inkAlpha,
  NOW_LINE,
  OLIVE,
  PAPER,
  PINK,
  PLUM,
  PRIMARY_HOVER,
  paperAlpha,
  SIDEBAR_ACCENT,
  SIDEBAR_BORDER,
  SUBTLE,
  SUCCESS,
  TEAL,
  WARNING,
} from "../app/lib/palette";
import {
  quantizeWindowAlpha,
  WINDOW_ALPHA_STEPS,
  windowPercent,
} from "../app/lib/sessionWindows";
import { BLOCK_MINUTES, type SessionWindow } from "../shared/types";

const CONTRAST_TOLERANCE = 0.05;
const TEXT_FLOOR = 4.5;
const MARK_FLOOR = 3;
const HEX_RADIX = 16;
const CHANNEL_MAX = 255;

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), HEX_RADIX);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function linear(channel: number) {
  const unit = channel / CHANNEL_MAX;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function ratioOfRgb(a: Rgb, b: Rgb) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function ratio(foreground: string, background: string) {
  return ratioOfRgb(hexToRgb(foreground), hexToRgb(background));
}

function blendOverPaper(rgba: string): Rgb {
  const match = rgba.match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/);
  if (!match) throw new Error(`not an rgba string: ${rgba}`);
  const alpha = Number(match[4]);
  const paper = hexToRgb(PAPER);
  const source: Rgb = [Number(match[1]), Number(match[2]), Number(match[3])];
  return source.map((channel, i) =>
    Math.round(channel * alpha + paper[i] * (1 - alpha)),
  ) as Rgb;
}

function expectRatio(foreground: string, background: string, expected: number) {
  expect(
    Math.abs(ratio(foreground, background) - expected),
  ).toBeLessThanOrEqual(CONTRAST_TOLERANCE);
}

describe("palette contrast on paper", () => {
  it.each([
    ["ink", INK, 16.78],
    ["plum", PLUM, 6.33],
    ["subtle", SUBTLE, 4.93],
    ["cobalt", COBALT, 6.84],
    ["now line", NOW_LINE, 3.45],
    ["teal", TEAL, 5.43],
    ["olive", OLIVE, 5.72],
    ["success", SUCCESS, 5.86],
    ["waiting", WARNING, 6.34],
    ["error", DESTRUCTIVE, 7.6],
    ["muted ink", INK_MUTED, 6.5],
  ])("%s matches the spec ratio", (_name, color, expected) => {
    expectRatio(color, PAPER, expected);
  });
});

describe("palette contrast on pink", () => {
  it.each([
    ["ink", INK, 13.49],
    ["plum", PLUM, 5.09],
    ["subtle", SUBTLE, 3.96],
    ["cobalt", COBALT, 5.5],
    ["success", SUCCESS, 4.71],
    ["waiting", WARNING, 5.09],
    ["error", DESTRUCTIVE, 6.11],
    ["muted ink on pink", INK_MUTED_ON_PINK, 6.33],
  ])("%s matches the spec ratio", (_name, color, expected) => {
    expectRatio(color, PINK, expected);
  });
});

describe("palette contrast pairs", () => {
  it("pink reads against the page frame at 14.15", () => {
    expectRatio(PINK, FRAME, 14.15);
  });

  it("paper text on the primary hover fill reads at 12.58", () => {
    expectRatio(PAPER, PRIMARY_HOVER, 12.58);
  });
});

describe("palette contrast floors", () => {
  it.each([
    ["ink", INK],
    ["muted ink", INK_MUTED],
    ["success", SUCCESS],
    ["waiting", WARNING],
    ["error", DESTRUCTIVE],
    ["cobalt", COBALT],
  ])("text role %s reaches 4.5 on paper and pink", (_name, color) => {
    expect(ratio(color, PAPER)).toBeGreaterThanOrEqual(TEXT_FLOOR);
    expect(ratio(color, PINK)).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });

  it.each([
    ["subtle", SUBTLE],
    ["plum", PLUM],
    ["teal", TEAL],
    ["olive", OLIVE],
    ["now line", NOW_LINE],
  ])("mark %s reaches 3 on paper", (_name, color) => {
    expect(ratio(color, PAPER)).toBeGreaterThanOrEqual(MARK_FLOOR);
  });
});

describe("alpha helpers", () => {
  it("builds an ink rgba string", () => {
    expect(inkAlpha(0.12)).toBe("rgba(17, 17, 17, 0.12)");
  });

  it("builds a paper rgba string", () => {
    expect(paperAlpha(0.24)).toBe("rgba(244, 241, 238, 0.24)");
  });
});

describe("quantizeWindowAlpha", () => {
  it.each([
    [0, 0.18, INK],
    [24.9, 0.18, INK],
    [25, 0.4, INK],
    [49.9, 0.4, INK],
    [50, 0.75, PAPER],
    [74.9, 0.75, PAPER],
    [75, 1, PAPER],
    [100, 1, PAPER],
    [130, 1, PAPER],
  ])("maps %s percent to alpha %s", (percent, alpha, label) => {
    expect(quantizeWindowAlpha(percent)).toMatchObject({ alpha, label });
  });

  it("uses the lightest step for a negative percent", () => {
    expect(quantizeWindowAlpha(-5)).toMatchObject({ alpha: 0.18, label: INK });
  });

  it.each(WINDOW_ALPHA_STEPS.map((step) => [step.alpha, step.label] as const))(
    "label on the %s step reaches 4.5 against its blend over paper",
    (alpha, label) => {
      const background = blendOverPaper(inkAlpha(alpha));
      expect(ratioOfRgb(hexToRgb(label), background)).toBeGreaterThanOrEqual(
        TEXT_FLOOR,
      );
    },
  );
});

describe("windowPercent", () => {
  const window = (
    peakPercent: number | null,
    activeMinutes: number,
  ): SessionWindow => ({
    start: "2026-11-02T08:00:00.000Z",
    end: "2026-11-02T13:00:00.000Z",
    peakPercent,
    activeMinutes,
    samples: 1,
  });

  it("returns the official peak when the window has one", () => {
    expect(windowPercent(window(40, BLOCK_MINUTES))).toBe(40);
  });

  it("returns the active share of the block when there is no peak", () => {
    expect(windowPercent(window(null, BLOCK_MINUTES / 2))).toBe(50);
  });
});

const STYLES = readFileSync(resolve(__dirname, "..", "app/styles.css"), "utf8");

function blockBody(selector: string) {
  const start = STYLES.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`block not found: ${selector}`);
  const open = STYLES.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < STYLES.length; i++) {
    if (STYLES[i] === "{") depth++;
    if (STYLES[i] === "}") depth--;
    if (depth === 0) return STYLES.slice(open + 1, i);
  }
  throw new Error(`unclosed block: ${selector}`);
}

function tokens(selector: string) {
  const found = new Map<string, string>();
  for (const m of blockBody(selector).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    found.set(m[1], m[2].trim().toLowerCase());
  }
  return found;
}

function expectTokens(selector: string, expected: Record<string, string>) {
  const found = tokens(selector);
  for (const [name, value] of Object.entries(expected)) {
    expect(found.get(name), `${selector} ${name}`).toBe(value.toLowerCase());
  }
}

describe("styles.css tokens match the palette", () => {
  it("sets every shadcn token in :root", () => {
    expectTokens(":root", {
      "--frame": FRAME,
      "--background": PAPER,
      "--foreground": INK,
      "--card": PAPER,
      "--card-foreground": INK,
      "--popover": PAPER,
      "--popover-foreground": INK,
      "--primary": INK,
      "--primary-foreground": PAPER,
      "--secondary": INSET,
      "--secondary-foreground": INK,
      "--muted": INSET,
      "--muted-foreground": INK_MUTED,
      "--accent": PINK,
      "--accent-foreground": INK,
      "--destructive": DESTRUCTIVE,
      "--border": INK,
      "--input": FIELD_BORDER,
      "--ring": COBALT,
      "--success": SUCCESS,
      "--warning": WARNING,
      "--info": COBALT,
      "--chart-1": INK,
      "--chart-2": COBALT,
      "--chart-3": TEAL,
      "--chart-4": OLIVE,
      "--chart-5": PLUM,
      "--sidebar": FRAME,
      "--sidebar-foreground": PAPER,
      "--sidebar-primary": PINK,
      "--sidebar-primary-foreground": INK,
      "--sidebar-accent": SIDEBAR_ACCENT,
      "--sidebar-accent-foreground": PAPER,
      "--sidebar-border": SIDEBAR_BORDER,
      "--sidebar-ring": PINK,
    });
  });

  it("sets the panel fill on paper", () => {
    expectTokens(".panel", { "--panel-fill": PAPER });
  });

  it("sets the pink panel scope", () => {
    expectTokens('.panel[data-tone="pink"]', {
      "--panel-fill": PINK,
      "--muted": INSET_ON_PINK,
      "--muted-foreground": INK_MUTED_ON_PINK,
    });
  });

  it("sets the sidebar focus ring to pink", () => {
    expectTokens(".sidebar", { "--ring": PINK });
  });

  it("names the missing block in the failure", () => {
    expect(() => blockBody(".no-such-block")).toThrow(".no-such-block");
  });
});

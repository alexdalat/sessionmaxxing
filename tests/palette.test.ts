import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DARK,
  INK,
  inkAlpha,
  LIGHT,
  PALETTES,
  type Palette,
  paperAlpha,
  type Theme,
  tokenName,
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
const THEMES = Object.keys(PALETTES) as Theme[];

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

function blend(foreground: string, alpha: number, background: string): Rgb {
  const source = hexToRgb(foreground);
  const base = hexToRgb(background);
  return source.map((channel, i) =>
    Math.round(channel * alpha + base[i] * (1 - alpha)),
  ) as Rgb;
}

function expectRatio(foreground: string, background: string, expected: number) {
  expect(
    Math.abs(ratio(foreground, background) - expected),
  ).toBeLessThanOrEqual(CONTRAST_TOLERANCE);
}

describe("light palette contrast on paper", () => {
  it.each([
    ["ink", LIGHT.ink, 16.78],
    ["plum", LIGHT.plum, 6.33],
    ["subtle", LIGHT.subtle, 4.93],
    ["cobalt", LIGHT.cobalt, 6.84],
    ["now line", LIGHT.nowLine, 3.45],
    ["teal", LIGHT.teal, 5.43],
    ["olive", LIGHT.olive, 5.72],
    ["success", LIGHT.success, 5.86],
    ["waiting", LIGHT.warning, 6.34],
    ["error", LIGHT.destructive, 7.6],
    ["muted ink", LIGHT.inkMuted, 6.5],
  ])("%s matches the spec ratio", (_name, color, expected) => {
    expectRatio(color, LIGHT.paper, expected);
  });
});

describe("light palette contrast on pink", () => {
  it.each([
    ["ink", LIGHT.ink, 13.49],
    ["plum", LIGHT.plum, 5.09],
    ["subtle", LIGHT.subtle, 3.96],
    ["cobalt", LIGHT.cobalt, 5.5],
    ["success", LIGHT.success, 4.71],
    ["waiting", LIGHT.warning, 5.09],
    ["error", LIGHT.destructive, 6.11],
    ["muted ink on pink", LIGHT.inkMutedOnPink, 6.33],
  ])("%s matches the spec ratio", (_name, color, expected) => {
    expectRatio(color, LIGHT.pink, expected);
  });
});

describe.each(THEMES)("%s palette floors", (theme) => {
  const palette = PALETTES[theme];
  const textRoles: (keyof Palette)[] = [
    "ink",
    "inkMuted",
    "success",
    "warning",
    "destructive",
    "cobalt",
  ];
  const markRoles: (keyof Palette)[] = [
    "subtle",
    "plum",
    "teal",
    "olive",
    "nowLine",
    "fieldBorder",
  ];

  it.each(textRoles)("text role %s reaches 4.5 on paper and pink", (role) => {
    expect(ratio(palette[role], palette.paper)).toBeGreaterThanOrEqual(
      TEXT_FLOOR,
    );
    expect(ratio(palette[role], palette.pink)).toBeGreaterThanOrEqual(
      TEXT_FLOOR,
    );
  });

  it.each(markRoles)("mark %s reaches 3 on paper", (role) => {
    expect(ratio(palette[role], palette.paper)).toBeGreaterThanOrEqual(
      MARK_FLOOR,
    );
  });

  it("muted ink on pink reaches 4.5", () => {
    expect(ratio(palette.inkMutedOnPink, palette.pink)).toBeGreaterThanOrEqual(
      TEXT_FLOOR,
    );
  });

  it("muted ink reads on the page frame for inactive navigation", () => {
    expect(ratio(palette.inkMuted, palette.frame)).toBeGreaterThanOrEqual(
      TEXT_FLOOR,
    );
  });

  it("paper text reads on the primary hover fill", () => {
    expect(ratio(palette.paper, palette.primaryHover)).toBeGreaterThanOrEqual(
      TEXT_FLOOR,
    );
  });

  it.each(WINDOW_ALPHA_STEPS.map((step) => [step.alpha, step.label] as const))(
    "window label on the %s step reaches 4.5 against its blend over paper",
    (alpha, label) => {
      const background = blend(palette.ink, alpha, palette.paper);
      expect(
        ratioOfRgb(hexToRgb(palette[label]), background),
      ).toBeGreaterThanOrEqual(TEXT_FLOOR);
    },
  );
});

describe("palette tokens", () => {
  it("names a camel-case key as a kebab-case custom property", () => {
    expect(tokenName("inkMutedOnPink")).toBe("--ink-muted-on-pink");
  });

  it("reads a palette color through its custom property", () => {
    expect(INK).toBe("var(--ink)");
  });

  it("mixes ink at the given alpha", () => {
    expect(inkAlpha(0.12)).toBe(
      "color-mix(in srgb, var(--ink) 12%, transparent)",
    );
  });

  it("mixes paper at the given alpha", () => {
    expect(paperAlpha(0.24)).toBe(
      "color-mix(in srgb, var(--paper) 24%, transparent)",
    );
  });
});

describe("quantizeWindowAlpha", () => {
  it.each([
    [0, 0.18, "ink"],
    [24.9, 0.18, "ink"],
    [25, 0.4, "ink"],
    [49.9, 0.4, "ink"],
    [50, 0.75, "paper"],
    [74.9, 0.75, "paper"],
    [75, 1, "paper"],
    [100, 1, "paper"],
    [130, 1, "paper"],
  ])("maps %s percent to alpha %s", (percent, alpha, label) => {
    expect(quantizeWindowAlpha(percent)).toMatchObject({ alpha, label });
  });

  it("uses the lightest step for a negative percent", () => {
    expect(quantizeWindowAlpha(-5)).toMatchObject({
      alpha: 0.18,
      label: "ink",
    });
  });
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

const SHADCN_TOKENS = {
  "--background": "var(--paper)",
  "--foreground": "var(--ink)",
  "--card": "var(--paper)",
  "--card-foreground": "var(--ink)",
  "--popover": "var(--paper)",
  "--popover-foreground": "var(--ink)",
  "--primary": "var(--ink)",
  "--primary-foreground": "var(--paper)",
  "--secondary": "var(--inset)",
  "--secondary-foreground": "var(--ink)",
  "--muted": "var(--inset)",
  "--muted-foreground": "var(--ink-muted)",
  "--accent": "var(--pink)",
  "--accent-foreground": "var(--ink)",
  "--border": "var(--ink)",
  "--input": "var(--field-border)",
  "--ring": "var(--cobalt)",
  "--info": "var(--cobalt)",
  "--chart-1": "var(--ink)",
  "--chart-2": "var(--cobalt)",
  "--chart-3": "var(--teal)",
  "--chart-4": "var(--olive)",
  "--chart-5": "var(--plum)",
  "--sidebar": "var(--frame)",
  "--sidebar-foreground": "var(--ink)",
};

const paletteTokens = (palette: Palette) =>
  Object.fromEntries(
    (Object.keys(palette) as (keyof Palette)[]).map((key) => [
      tokenName(key),
      palette[key],
    ]),
  );

describe("styles.css tokens match the palette", () => {
  it("sets the light palette on :root", () => {
    expectTokens(":root", paletteTokens(LIGHT));
  });

  it("sets the dark palette on the dark theme root", () => {
    expectTokens(':root[data-theme="dark"]', paletteTokens(DARK));
  });

  it("derives every shadcn token from the palette", () => {
    expectTokens(":root", SHADCN_TOKENS);
  });

  it("sets the panel fill on paper", () => {
    expectTokens(".panel", { "--panel-fill": "var(--paper)" });
  });

  it("sets the pink panel scope", () => {
    expectTokens('.panel[data-tone="pink"]', {
      "--panel-fill": "var(--pink)",
      "--muted": "var(--inset-on-pink)",
      "--muted-foreground": "var(--ink-muted-on-pink)",
    });
  });

  it("names the missing block in the failure", () => {
    expect(() => blockBody(".no-such-block")).toThrow(".no-such-block");
  });
});

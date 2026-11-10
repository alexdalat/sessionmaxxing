import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blueAlpha,
  DARK,
  INK,
  inkAlpha,
  LIGHT,
  PALETTES,
  type Palette,
  type Theme,
  tokenName,
} from "../app/lib/palette";
import {
  quantizeWindowAlpha,
  WINDOW_ALPHA_STEPS,
  windowPercent,
} from "../app/lib/sessionWindows";
import { BLOCK_MINUTES, type SessionWindow } from "../shared/types";

const TEXT_FLOOR = 4.5;
const MARK_FLOOR = 3;
const HEX_RADIX = 16;
const CHANNEL_MAX = 255;
const PERCENT = 100;
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

const STYLES = readFileSync(resolve(__dirname, "..", "app/styles.css"), "utf8");

/** Alphas of every `color-mix` tint of a token in styles.css. */
function tintsOf(key: keyof Palette) {
  const pattern = new RegExp(
    `color-mix\\(in srgb, var\\(${tokenName(key)}\\) (\\d+)%, transparent\\)`,
    "g",
  );
  return [...STYLES.matchAll(pattern)].map(
    (match) => Number(match[1]) / PERCENT,
  );
}

describe("tintsOf", () => {
  it("finds the tints styles.css mixes from a token", () => {
    expect(tintsOf("destructive").length).toBeGreaterThan(0);
  });

  it("finds nothing for a token styles.css never tints", () => {
    expect(tintsOf("magenta")).toEqual([]);
  });
});

describe.each(THEMES)("%s palette contrast", (theme) => {
  const palette = PALETTES[theme];
  const surfaces: (keyof Palette)[] = ["page", "sidebar", "raised"];
  const textRoles: (keyof Palette)[] = [
    "ink",
    "inkMuted",
    "success",
    "warning",
    "destructive",
  ];
  const seriesRoles: (keyof Palette)[] = [
    "blue",
    "orange",
    "teal",
    "violet",
    "magenta",
    "subtle",
  ];
  const textOnSurfaces = textRoles.flatMap((role) =>
    surfaces.map((surface) => [role, surface] as const),
  );

  it.each(textOnSurfaces)("text %s reaches 4.5 on %s", (role, surface) => {
    expect(ratio(palette[role], palette[surface])).toBeGreaterThanOrEqual(
      TEXT_FLOOR,
    );
  });

  it.each([
    ["ink", "field"],
    ["inkMuted", "field"],
    ["ink", "fieldHover"],
    ["inkMuted", "fieldHover"],
  ] as const)("text %s reaches 4.5 on %s controls", (role, surface) => {
    expect(ratio(palette[role], palette[surface])).toBeGreaterThanOrEqual(
      TEXT_FLOOR,
    );
  });

  it.each(seriesRoles)("series %s reaches 3 on the page", (role) => {
    expect(ratio(palette[role], palette.page)).toBeGreaterThanOrEqual(
      MARK_FLOOR,
    );
  });

  it.each(["blue", "teal"] as const)(
    "meter fill %s reaches 3 on its field track",
    (role) => {
      expect(ratio(palette[role], palette.field)).toBeGreaterThanOrEqual(
        MARK_FLOOR,
      );
    },
  );

  it.each(["ink", "primaryHover"] as const)(
    "page text reads on the %s primary fill",
    (fill) => {
      expect(ratio(palette.page, palette[fill])).toBeGreaterThanOrEqual(
        TEXT_FLOOR,
      );
    },
  );

  it.each(["destructive", "warning"] as const)(
    "%s text reads on every tint of itself over the page and dialogs",
    (role) => {
      for (const alpha of tintsOf(role)) {
        for (const surface of ["page", "raised"] as const) {
          const background = blend(palette[role], alpha, palette[surface]);
          expect(
            ratioOfRgb(hexToRgb(palette[role]), background),
            `${alpha} over ${surface}`,
          ).toBeGreaterThanOrEqual(TEXT_FLOOR);
        }
      }
    },
  );

  it.each(WINDOW_ALPHA_STEPS.map((step) => [step.alpha, step.label] as const))(
    "window label on the %s step reaches 4.5 against its blend over the page",
    (alpha, label) => {
      const background = blend(palette.blue, alpha, palette.page);
      expect(
        ratioOfRgb(hexToRgb(palette[label]), background),
      ).toBeGreaterThanOrEqual(TEXT_FLOOR);
    },
  );
});

describe("palette tokens", () => {
  it("names a camel-case key as a kebab-case custom property", () => {
    expect(tokenName("primaryHover")).toBe("--primary-hover");
  });

  it("reads a palette color through its custom property", () => {
    expect(INK).toBe("var(--ink)");
  });

  it("mixes blue at the given alpha", () => {
    expect(blueAlpha(0.32)).toBe(
      "color-mix(in srgb, var(--blue) 32%, transparent)",
    );
  });

  it("rounds away float noise in the mixed percent", () => {
    expect(inkAlpha(0.14)).toBe(
      "color-mix(in srgb, var(--ink) 14%, transparent)",
    );
  });
});

describe("quantizeWindowAlpha", () => {
  it.each([
    [-5, 0],
    [0, 0],
    [24.9, 0],
    [25, 1],
    [49.9, 1],
    [50, 2],
    [74.9, 2],
    [75, 3],
    [100, 3],
    [130, 3],
  ])("maps %s percent to step %s", (percent, step) => {
    expect(quantizeWindowAlpha(percent)).toBe(WINDOW_ALPHA_STEPS[step]);
  });

  it("darkens each step over the one before it", () => {
    const alphas = WINDOW_ALPHA_STEPS.map((step) => step.alpha);
    expect(alphas).toEqual([...alphas].sort((a, b) => a - b));
    expect(new Set(alphas).size).toBe(alphas.length);
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
  "--background": "var(--page)",
  "--foreground": "var(--ink)",
  "--card": "var(--page)",
  "--card-foreground": "var(--ink)",
  "--popover": "var(--raised)",
  "--popover-foreground": "var(--ink)",
  "--primary": "var(--ink)",
  "--primary-foreground": "var(--page)",
  "--secondary": "var(--field)",
  "--secondary-foreground": "var(--ink)",
  "--muted": "var(--field)",
  "--muted-foreground": "var(--ink-muted)",
  "--accent": "var(--field)",
  "--accent-foreground": "var(--ink)",
  "--border": "var(--line)",
  "--input": "var(--line)",
  "--ring": "var(--blue)",
  "--info": "var(--blue)",
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

  it("names the missing block in the failure", () => {
    expect(() => blockBody(".no-such-block")).toThrow(".no-such-block");
  });
});

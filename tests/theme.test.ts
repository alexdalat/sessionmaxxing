import { describe, expect, it } from "vitest";
import { parseStoredTheme, resolveTheme } from "../app/lib/theme";

describe("parseStoredTheme", () => {
  it.each(["light", "dark"] as const)("accepts %s", (theme) => {
    expect(parseStoredTheme(theme)).toBe(theme);
  });

  it.each([null, "", "system", "Dark"])("treats %s as no choice", (value) => {
    expect(parseStoredTheme(value)).toBeNull();
  });
});

describe("resolveTheme", () => {
  it("follows a dark system setting when nothing is stored", () => {
    expect(resolveTheme(null, true)).toBe("dark");
  });

  it("follows a light system setting when nothing is stored", () => {
    expect(resolveTheme(null, false)).toBe("light");
  });

  it("keeps a stored light choice over a dark system setting", () => {
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("keeps a stored dark choice over a light system setting", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

import { describe, expect, it } from "vitest";
import { windowRangeLabel } from "../app/lib/schedule";
import { TEST_TIME_ZONE } from "./helpers.js";

const KOLKATA = "Asia/Kolkata";
const SEPTEMBER = Date.parse("2026-09-06T12:00:00Z");
const JANUARY = Date.parse("2026-01-15T12:00:00Z");

describe("windowRangeLabel", () => {
  it("spans five hours and names the zone", () => {
    expect(windowRangeLabel(8, TEST_TIME_ZONE, SEPTEMBER)).toBe(
      "8 AM → 1 PM ET",
    );
  });

  it("wraps a window that ends after midnight and names a half-hour zone", () => {
    expect(windowRangeLabel(22, KOLKATA, SEPTEMBER)).toBe(
      "10 PM → 3 AM India Time",
    );
  });

  it("keeps the generic zone name in winter", () => {
    expect(windowRangeLabel(8, TEST_TIME_ZONE, JANUARY)).toBe("8 AM → 1 PM ET");
  });
});

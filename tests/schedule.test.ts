import { describe, expect, it } from "vitest";
import {
  earliestStartFromInput,
  earliestStartInput,
  windowRangeLabel,
} from "../app/lib/schedule";
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

describe("earliestStartInput", () => {
  it("is empty when the task has no earliest start", () => {
    expect(earliestStartInput(null, TEST_TIME_ZONE)).toBe("");
  });

  it("shows an instant as wall time in the server zone", () => {
    expect(earliestStartInput("2026-09-08T02:00:00.000Z", TEST_TIME_ZONE)).toBe(
      "2026-09-07T22:00",
    );
  });

  it("shows an instant in a half-hour zone", () => {
    expect(earliestStartInput("2026-09-06T12:30:00.000Z", KOLKATA)).toBe(
      "2026-09-06T18:00",
    );
  });
});

describe("earliestStartFromInput", () => {
  it("is null for an empty field", () => {
    expect(earliestStartFromInput("", TEST_TIME_ZONE)).toBeNull();
  });

  it("converts a typed wall time to an instant in the server zone", () => {
    expect(earliestStartFromInput("2026-09-07T22:00", TEST_TIME_ZONE)).toBe(
      "2026-09-08T02:00:00.000Z",
    );
  });

  it("converts a typed wall time in a half-hour zone", () => {
    expect(earliestStartFromInput("2026-09-06T18:00", KOLKATA)).toBe(
      "2026-09-06T12:30:00.000Z",
    );
  });

  it("moves a wall time inside a spring-forward gap forward by the gap", () => {
    expect(earliestStartFromInput("2026-03-08T02:30", TEST_TIME_ZONE)).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  it("throws on a malformed value instead of guessing", () => {
    expect(() => earliestStartFromInput("garbage", TEST_TIME_ZONE)).toThrow(
      RangeError,
    );
  });
});

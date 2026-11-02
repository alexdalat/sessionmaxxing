import { describe, expect, it } from "vitest";
import {
  localParts,
  localStart,
  nextLocalHour,
  shiftDate,
  weekdayIndex,
} from "../shared/local-time.js";
import { TEST_TIME_ZONE } from "./helpers.js";

const KOLKATA = "Asia/Kolkata";
const KATHMANDU = "Asia/Kathmandu";
const ADELAIDE = "Australia/Adelaide";
const BERLIN = "Europe/Berlin";
const HOUR_MS = 3_600_000;

const at = (iso: string) => Date.parse(iso);

describe("localStart", () => {
  it("finds local midnight in a +05:30 zone", () => {
    expect(localStart("2026-09-06", 0, KOLKATA)).toBe(
      at("2026-09-05T18:30:00Z"),
    );
  });

  it("finds local midnight in a +05:45 zone", () => {
    expect(localStart("2026-09-06", 0, KATHMANDU)).toBe(
      at("2026-09-05T18:15:00Z"),
    );
  });

  it("finds local midnight in a +09:30 zone", () => {
    expect(localStart("2026-09-06", 0, ADELAIDE)).toBe(
      at("2026-09-05T14:30:00Z"),
    );
  });

  it("makes Adelaide's spring-forward day 23 hours long", () => {
    expect(localStart("2026-10-04", 0, ADELAIDE)).toBe(
      at("2026-10-03T14:30:00Z"),
    );
    expect(localStart("2026-10-05", 0, ADELAIDE)).toBe(
      at("2026-10-04T13:30:00Z"),
    );
  });

  it("moves a nonexistent Toronto wall time forward by the gap", () => {
    expect(localStart("2026-03-08", 2, TEST_TIME_ZONE)).toBe(
      at("2026-03-08T07:00:00Z"),
    );
  });

  it("resolves an ambiguous Toronto wall time to the earlier instant", () => {
    expect(localStart("2026-11-01", 1, TEST_TIME_ZONE)).toBe(
      at("2026-11-01T05:00:00Z"),
    );
  });

  it("makes Toronto's fall-back day 25 hours long", () => {
    const length =
      localStart("2026-11-02", 0, TEST_TIME_ZONE) -
      localStart("2026-11-01", 0, TEST_TIME_ZONE);
    expect(length).toBe(25 * HOUR_MS);
  });

  it("moves a nonexistent Berlin wall time forward by the gap", () => {
    expect(localStart("2026-03-29", 2, BERLIN)).toBe(
      at("2026-03-29T01:00:00Z"),
    );
  });

  it("resolves an ambiguous Berlin wall time to the earlier instant", () => {
    expect(localStart("2026-10-25", 2, BERLIN)).toBe(
      at("2026-10-25T00:00:00Z"),
    );
  });

  it("honors a minute argument", () => {
    expect(localStart("2026-09-06", 18, KOLKATA, 0)).toBe(
      at("2026-09-06T12:30:00Z"),
    );
    expect(localStart("2026-09-06", 18, KOLKATA, 30)).toBe(
      at("2026-09-06T13:00:00Z"),
    );
  });
});

describe("nextLocalHour", () => {
  const noon = at("2026-09-06T12:00:00Z");

  it("lands on :30 UTC in a +05:30 zone", () => {
    expect(nextLocalHour(noon, KOLKATA)).toBe(at("2026-09-06T12:30:00Z"));
  });

  it("lands on :15 UTC in a +05:45 zone", () => {
    expect(nextLocalHour(noon, KATHMANDU)).toBe(at("2026-09-06T12:15:00Z"));
  });

  it("lands on the next UTC hour in a whole-hour zone", () => {
    expect(nextLocalHour(noon, TEST_TIME_ZONE)).toBe(
      at("2026-09-06T13:00:00Z"),
    );
  });

  it("returns the following boundary when called on a boundary", () => {
    expect(nextLocalHour(at("2026-09-06T12:30:00Z"), KOLKATA)).toBe(
      at("2026-09-06T13:30:00Z"),
    );
    expect(nextLocalHour(noon, TEST_TIME_ZONE)).toBeGreaterThan(noon);
  });
});

describe("localParts", () => {
  it("reads a +05:30 zone across midnight", () => {
    expect(localParts("2026-09-06T18:45:00Z", KOLKATA)).toEqual({
      date: "2026-09-07",
      hour: 0,
      minute: 15,
      day: 1,
      offsetMs: 19_800_000,
    });
  });

  it("reads a whole-hour zone on a Sunday morning", () => {
    expect(localParts("2026-09-06T12:00:00Z", TEST_TIME_ZONE)).toEqual({
      date: "2026-09-06",
      hour: 8,
      minute: 0,
      day: 0,
      offsetMs: -4 * HOUR_MS,
    });
  });

  it("reports hour 0 at local midnight, never 24", () => {
    const parts = localParts("2026-09-06T04:00:00Z", TEST_TIME_ZONE);
    expect(parts.hour).toBe(0);
    expect(parts.date).toBe("2026-09-06");
  });
});

describe("date arithmetic", () => {
  it("shifts a date across a DST change by whole calendar days", () => {
    expect(shiftDate("2026-03-08", 1)).toBe("2026-03-09");
  });

  it("shifts a date backwards across a year boundary", () => {
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("numbers weekdays from Sunday", () => {
    expect(weekdayIndex("2026-09-06")).toBe(0);
    expect(weekdayIndex("2026-09-07")).toBe(1);
  });
});

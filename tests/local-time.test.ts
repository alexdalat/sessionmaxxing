import { describe, expect, it } from "vitest";
import {
  fromLocalInput,
  localClock,
  localParts,
  localStart,
  localTimestamp,
  nextLocalHour,
  shiftDate,
  toLocalInput,
  weekdayIndex,
  zoneName,
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

describe("localTimestamp", () => {
  it("formats an EDT instant with its short zone name", () => {
    expect(localTimestamp("2026-09-08T02:00:00Z", TEST_TIME_ZONE)).toBe(
      "Sep 7, 10:00 PM EDT",
    );
  });

  it("formats a winter instant with EST", () => {
    expect(localTimestamp("2026-01-15T12:00:00Z", TEST_TIME_ZONE)).toBe(
      "Jan 15, 7:00 AM EST",
    );
  });

  it("names a zone without an abbreviation by its offset", () => {
    expect(localTimestamp("2026-09-06T12:00:00Z", KOLKATA)).toBe(
      "Sep 6, 5:30 PM GMT+5:30",
    );
  });

  it("accepts epoch milliseconds", () => {
    expect(localTimestamp(at("2026-09-08T02:00:00Z"), TEST_TIME_ZONE)).toBe(
      "Sep 7, 10:00 PM EDT",
    );
  });
});

describe("localClock", () => {
  it("formats a +05:45 zone to the minute", () => {
    expect(localClock("2026-09-06T12:00:00Z", KATHMANDU)).toBe("5:45 PM");
  });

  it("accepts epoch milliseconds", () => {
    expect(localClock(at("2026-09-06T12:00:00Z"), KATHMANDU)).toBe("5:45 PM");
  });
});

describe("zoneName", () => {
  const noon = at("2026-09-06T12:00:00Z");

  it("uses the generic abbreviation for a North American zone", () => {
    expect(zoneName(TEST_TIME_ZONE, noon)).toBe("ET");
  });

  it("uses the generic name for India", () => {
    expect(zoneName(KOLKATA, noon)).toBe("India Time");
  });
});

describe("toLocalInput", () => {
  it("writes a datetime-local value in the given zone", () => {
    expect(toLocalInput("2026-09-08T02:00:00Z", TEST_TIME_ZONE)).toBe(
      "2026-09-07T22:00",
    );
  });

  it("writes a half-hour zone value", () => {
    expect(toLocalInput("2026-09-06T12:30:00Z", KOLKATA)).toBe(
      "2026-09-06T18:00",
    );
  });
});

describe("fromLocalInput", () => {
  it("reads a datetime-local value in the given zone", () => {
    expect(fromLocalInput("2026-09-07T22:00", TEST_TIME_ZONE)).toBe(
      "2026-09-08T02:00:00.000Z",
    );
  });

  it("reads a half-hour zone value", () => {
    expect(fromLocalInput("2026-09-06T18:00", KOLKATA)).toBe(
      "2026-09-06T12:30:00.000Z",
    );
  });

  it("moves a nonexistent wall time forward by the gap", () => {
    expect(fromLocalInput("2026-03-08T02:30", TEST_TIME_ZONE)).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  it.each([
    ["a date without a time", "2026-09-07"],
    ["an empty string", ""],
    ["a value with seconds", "2026-09-07T22:00:00"],
  ])("rejects %s", (_name, value) => {
    expect(() => fromLocalInput(value, TEST_TIME_ZONE)).toThrow(RangeError);
  });
});

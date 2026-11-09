import { describe, expect, it } from "vitest";
import {
  fetchedLabel,
  stripHeading,
  usageStripRows,
} from "../app/lib/usageStrip";
import {
  type BucketGate,
  MINUTE_MS,
  USAGE_STALE_MS,
  type UsageSnapshot,
} from "../shared/types";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const isoAfter = (ms: number) => new Date(NOW + ms).toISOString();

const gate = (overrides: Partial<BucketGate> = {}): BucketGate => ({
  percent: 42,
  ceiling: 75,
  pace: null,
  reserved: 0,
  ok: true,
  ...overrides,
});

const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  fetchedAt: isoAfter(-3 * MINUTE_MS),
  plan: "max",
  session: { percent: 42, resetsAt: isoAfter(125 * MINUTE_MS) },
  weekly: { percent: 40, resetsAt: isoAfter(26 * 60 * MINUTE_MS) },
  fable: null,
  ...overrides,
});

const planning = (
  session: BucketGate,
  weekly: BucketGate,
  usage: UsageSnapshot | null = snapshot(),
) => ({ session, weekly, usage });

describe("usageStripRows", () => {
  it("returns the session row then the weekly row", () => {
    const rows = usageStripRows(planning(gate(), gate()), NOW);
    expect(rows.map((row) => row.bucket)).toEqual(["session", "weekly"]);
    expect(rows.map((row) => row.label)).toEqual(["Session (5h)", "Weekly"]);
  });

  it("formats the session percent, fill, cutoff and reset", () => {
    const [session] = usageStripRows(planning(gate(), gate()), NOW);
    expect(session).toMatchObject({
      percentText: "42%",
      fill: 42,
      ceiling: 75,
      cutoffText: "Cutoff 75%",
      heldText: null,
      pace: null,
      paceText: null,
      paceTone: null,
      resetText: "2h 5m",
    });
  });

  it("rounds a fractional percent", () => {
    const [session] = usageStripRows(
      planning(gate({ percent: 41.6 }), gate()),
      NOW,
    );
    expect(session.percentText).toBe("42%");
  });

  it("shows held points only when above zero", () => {
    const [held] = usageStripRows(
      planning(gate({ reserved: 10 }), gate()),
      NOW,
    );
    const [none] = usageStripRows(planning(gate({ reserved: 0 }), gate()), NOW);
    expect(held.heldText).toBe("Held 10%");
    expect(none.heldText).toBeNull();
  });

  it("marks a weekly percent under pace", () => {
    const rows = usageStripRows(
      planning(gate(), gate({ percent: 40, ceiling: 60, pace: 50 })),
      NOW,
    );
    expect(rows[1]).toMatchObject({
      pace: 50,
      paceText: "10% under pace",
      paceTone: "under",
    });
  });

  it("marks a weekly percent over pace", () => {
    const rows = usageStripRows(
      planning(gate(), gate({ percent: 61, ceiling: 60, pace: 50 })),
      NOW,
    );
    expect(rows[1]).toMatchObject({
      paceText: "11% over pace",
      paceTone: "over",
    });
  });

  it("treats a weekly percent equal to pace as under pace", () => {
    const rows = usageStripRows(
      planning(gate(), gate({ percent: 50, pace: 50 })),
      NOW,
    );
    expect(rows[1]).toMatchObject({
      paceText: "0% under pace",
      paceTone: "under",
    });
  });

  it("never gives the session row a pace even when its gate carries one", () => {
    const [session] = usageStripRows(
      planning(gate({ pace: 30 }), gate({ pace: 50 })),
      NOW,
    );
    expect(session.pace).toBeNull();
    expect(session.paceText).toBeNull();
    expect(session.paceTone).toBeNull();
  });

  it("shows a dash and an empty fill when the percent is unknown", () => {
    const [session] = usageStripRows(
      planning(gate({ percent: null }), gate(), null),
      NOW,
    );
    expect(session.percentText).toBe("—");
    expect(session.fill).toBe(0);
  });

  it("gives no pace text when the weekly percent is unknown", () => {
    const rows = usageStripRows(
      planning(gate(), gate({ percent: null, pace: 50 })),
      NOW,
    );
    expect(rows[1].pace).toBe(50);
    expect(rows[1].paceText).toBeNull();
    expect(rows[1].paceTone).toBeNull();
  });

  it("caps the fill at 100 when the percent is above 100", () => {
    const [session] = usageStripRows(
      planning(gate({ percent: 104 }), gate()),
      NOW,
    );
    expect(session.fill).toBe(100);
    expect(session.percentText).toBe("104%");
  });

  it("reads not started when the reset time is null", () => {
    const usage = snapshot({ session: { percent: 0, resetsAt: null } });
    const [session] = usageStripRows(planning(gate(), gate(), usage), NOW);
    expect(session.resetText).toBe("not started");
  });

  it("reads not started when the reset time has passed", () => {
    const usage = snapshot({
      session: { percent: 90, resetsAt: isoAfter(-MINUTE_MS) },
    });
    const [session] = usageStripRows(planning(gate(), gate(), usage), NOW);
    expect(session.resetText).toBe("not started");
  });

  it("reads not started for both rows when there is no snapshot", () => {
    const rows = usageStripRows(planning(gate(), gate(), null), NOW);
    expect(rows.map((row) => row.resetText)).toEqual([
      "not started",
      "not started",
    ]);
  });

  it("formats the weekly reset in days and hours", () => {
    const rows = usageStripRows(planning(gate(), gate()), NOW);
    expect(rows[1].resetText).toBe("1d 2h");
  });

  it("describes the session row for assistive tech", () => {
    const [session] = usageStripRows(
      planning(gate({ reserved: 10 }), gate()),
      NOW,
    );
    expect(session.ariaLabel).toBe(
      "Session (5h): 42% used. resets in 2h 5m. queue cutoff 75%. held 10%",
    );
  });

  it("adds the pace to the weekly description", () => {
    const rows = usageStripRows(
      planning(gate(), gate({ percent: 40, ceiling: 60, pace: 50 })),
      NOW,
    );
    expect(rows[1].ariaLabel).toBe(
      "Weekly: 40% used. resets in 1d 2h. queue cutoff 60%. pace 50%",
    );
  });

  it("omits the reset, held and pace parts when they are absent", () => {
    const rows = usageStripRows(
      planning(gate({ percent: null }), gate(), null),
      NOW,
    );
    expect(rows[0].ariaLabel).toBe("Session (5h): unknown. queue cutoff 75%");
  });
});

describe("fetchedLabel", () => {
  it("reports no snapshot as not fetched and not stale", () => {
    expect(fetchedLabel(null, NOW)).toEqual({
      text: "Not fetched yet",
      stale: false,
    });
  });

  it("reports the age of a fresh snapshot", () => {
    expect(fetchedLabel(snapshot(), NOW)).toEqual({
      text: "Fetched 3m ago",
      stale: false,
    });
  });

  it("is not stale exactly at the stale limit", () => {
    const usage = snapshot({ fetchedAt: isoAfter(-USAGE_STALE_MS) });
    expect(fetchedLabel(usage, NOW)).toEqual({
      text: "Fetched 15m ago",
      stale: false,
    });
  });

  it("is stale one minute past the stale limit", () => {
    const usage = snapshot({
      fetchedAt: isoAfter(-(USAGE_STALE_MS + MINUTE_MS)),
    });
    expect(fetchedLabel(usage, NOW)).toEqual({
      text: "Fetched 16m ago",
      stale: true,
    });
  });
});

describe("stripHeading", () => {
  it("names the plan from the snapshot", () => {
    expect(stripHeading(snapshot({ plan: "max" }))).toBe("Claude Max usage");
  });

  it("falls back to Claude while the plan is unknown", () => {
    expect(stripHeading(snapshot({ plan: null }))).toBe("Claude usage");
    expect(stripHeading(null)).toBe("Claude usage");
  });
});

import type { SessionWindow } from "../shared/types";
import { BLOCK_MINUTES } from "../shared/types";
import { easternDay, localClock, shiftDate, weekdayOf } from "./time";

const DAYS = 7;
const HOURS = 24;
const WEEK_HOURS = DAYS * HOURS;
const BLOCK_HOURS = BLOCK_MINUTES / 60;
const pct = (fraction: number) => `${Math.round(fraction * 10000) / 100}%`;

interface Segment {
  date: string;
  from: number;
  to: number;
  window: SessionWindow;
}
export function daySegments(windows: SessionWindow[]): Segment[] {
  return windows.flatMap((window) => {
    const start = easternDay(window.start);
    const end = easternDay(window.end);
    if (start.date === end.date)
      return [
        { date: start.date, from: start.fraction, to: end.fraction, window },
      ];
    return [
      { date: start.date, from: start.fraction, to: 1, window },
      { date: end.date, from: 0, to: end.fraction, window },
    ];
  });
}

export function SessionWindows({
  windows,
  now,
}: {
  windows: SessionWindow[] | undefined;
  now: number;
}) {
  const today = easternDay(now);
  const dates = Array.from({ length: DAYS }, (_, i) =>
    shiftDate(today.date, i - DAYS + 1),
  );
  const segments = daySegments(windows ?? []);
  const used = windows?.length ?? 0;
  const idleShare = 1 - Math.min(1, (used * BLOCK_HOURS) / WEEK_HOURS);
  const averagePeak = used
    ? (windows ?? []).reduce((sum, w) => sum + w.peakPercent, 0) / used
    : 0;
  return (
    <section
      className="panel"
      aria-label="Session windows over the last 7 days"
    >
      <div className="section-heading">
        <h2>Session windows · last 7 days</h2>
        <span className="muted">
          {windows === undefined
            ? "Loading…"
            : used
              ? `${used} window${used === 1 ? "" : "s"} · avg peak ${Math.round(averagePeak)}% · ${Math.round(idleShare * 100)}% of the week idle`
              : "No windows recorded yet · fills in as the dashboard runs"}
        </span>
      </div>
      <ul className="windows">
        {dates.map((date) => (
          <li className="windows-row" key={date}>
            <span className="windows-day">
              {weekdayOf(date)} <small>{date.slice(5)}</small>
            </span>
            <div className="windows-track">
              {segments
                .filter((segment) => segment.date === date)
                .map((segment) => (
                  <div
                    key={`${segment.window.start}-${segment.from}`}
                    className="windows-block"
                    style={{
                      left: pct(segment.from),
                      width: pct(segment.to - segment.from),
                      opacity: 0.3 + 0.7 * (segment.window.peakPercent / 100),
                    }}
                    title={`${localClock(segment.window.start)} – ${localClock(segment.window.end)} · peak ${Math.round(segment.window.peakPercent)}%`}
                  >
                    {segment.to - segment.from > 0.08 &&
                      `${Math.round(segment.window.peakPercent)}%`}
                  </div>
                ))}
              {date === today.date && (
                <div
                  className="windows-now"
                  style={{ left: pct(today.fraction) }}
                  aria-hidden="true"
                />
              )}
            </div>
          </li>
        ))}
        <li className="windows-row windows-axis" aria-hidden="true">
          <span className="windows-day" />
          <div className="windows-track">
            {[0, 6, 12, 18].map((h) => (
              <span key={h} style={{ left: pct(h / HOURS) }}>
                {String(h).padStart(2, "0")}
              </span>
            ))}
          </div>
        </li>
      </ul>
      <ul className="windows-list">
        {(windows ?? []).map((window) => (
          <li key={window.start}>
            {localClock(window.start)} – {localClock(window.end)}{" "}
            {easternDay(window.start).date.slice(5)} · peak{" "}
            {Math.round(window.peakPercent)}%
          </li>
        ))}
      </ul>
    </section>
  );
}

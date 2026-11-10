"use client";
import { type MouseEvent, useId, useState } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import { TOOLTIP_CLASS } from "@/app/lib/chart";
import { formatRemaining } from "@/app/lib/duration";
import { blueAlpha, tokenVar } from "@/app/lib/palette";
import {
  clockOfFraction,
  daySegments,
  quantizeWindowAlpha,
  windowPercent,
} from "@/app/lib/sessionWindows";
import { localDay, weekdayOf } from "@/app/lib/time";
import { localClock, shiftDate } from "@/shared/local-time";
import type { SessionWindow } from "@/shared/types";
import { BLOCK_MINUTES, hourLabel, MINUTE_MS } from "@/shared/types";

const DAYS = 7;
const HOURS = 24;
const WEEK_HOURS = DAYS * HOURS;
const BLOCK_HOURS = BLOCK_MINUTES / 60;
const pct = (fraction: number) => `${Math.round(fraction * 10000) / 100}%`;

const activeLabel = (window: SessionWindow) =>
  formatRemaining(window.activeMinutes * MINUTE_MS);
const blockLabel = (window: SessionWindow) =>
  window.peakPercent === null
    ? activeLabel(window)
    : `${Math.round(window.peakPercent)}%`;
const blockDescription = (window: SessionWindow, timeZone: string) =>
  `${localClock(window.start, timeZone)} – ${localClock(window.end, timeZone)}, ${
    window.peakPercent === null
      ? `active ${activeLabel(window)}`
      : `used ${Math.round(window.peakPercent)}%`
  }`;

export function SessionWindows({
  windows,
  now,
}: {
  windows: SessionWindow[] | undefined;
  now: number;
}) {
  const { timeZone } = useEnvironment();
  const headingId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const track = (event: MouseEvent<HTMLUListElement>) => {
    const element = (event.target as HTMLElement).closest(".windows-track");
    if (!element) {
      setHover(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    setHover((event.clientX - rect.left) / rect.width);
  };
  const today = localDay(now, timeZone);
  const dates = Array.from({ length: DAYS }, (_, i) =>
    shiftDate(today.date, i - DAYS + 1),
  );
  const segments = daySegments(windows ?? [], timeZone);
  const used = windows?.length ?? 0;
  const idleShare = 1 - Math.min(1, (used * BLOCK_HOURS) / WEEK_HOURS);
  const peaks = (windows ?? []).flatMap((w) =>
    w.peakPercent === null ? [] : [w.peakPercent],
  );
  const averagePeak = peaks.length
    ? Math.round(peaks.reduce((sum, peak) => sum + peak, 0) / peaks.length)
    : null;
  const stats = [
    ["Idle", `${Math.round(idleShare * 100)}%`],
    ["Windows", String(used)],
    ...(averagePeak === null ? [] : [["Avg used", `${averagePeak}%`]]),
  ];
  return (
    <section className="section cols-main" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 className="section-title" id={headingId}>
          Session windows
        </h2>
        {windows === undefined ? (
          <Skeleton className="h-4 w-56" />
        ) : (
          <dl className="stats">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <ul
        className="windows"
        onMouseMove={track}
        onMouseLeave={() => setHover(null)}
      >
        {dates.map((date) => (
          <li className="windows-row" key={date}>
            <span
              className="windows-day"
              data-today={date === today.date || undefined}
            >
              {weekdayOf(date)}
            </span>
            <div className="windows-track">
              {segments
                .filter((segment) => segment.date === date)
                .map((segment) => {
                  const step = quantizeWindowAlpha(
                    windowPercent(segment.window),
                  );
                  return (
                    <Tooltip key={`${segment.window.start}-${segment.from}`}>
                      <TooltipTrigger asChild>
                        <div
                          className="windows-block"
                          style={{
                            left: pct(segment.from),
                            width: pct(segment.to - segment.from),
                            background: blueAlpha(step.alpha),
                            color: tokenVar(step.label),
                          }}
                          role="img"
                          aria-label={blockDescription(
                            segment.window,
                            timeZone,
                          )}
                        >
                          {segment.to - segment.from > 0.08 &&
                            blockLabel(segment.window)}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className={TOOLTIP_CLASS}>
                        <strong className="font-medium">
                          {weekdayOf(
                            localDay(segment.window.start, timeZone).date,
                          )}{" "}
                          {localClock(segment.window.start, timeZone)} –{" "}
                          {localClock(segment.window.end, timeZone)}
                        </strong>
                        <span>
                          {segment.window.peakPercent === null
                            ? "From local transcripts"
                            : `Used ${Math.round(segment.window.peakPercent)}%`}
                        </span>
                        <span>Active {activeLabel(segment.window)}</span>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              {date === today.date && (
                <div
                  className="windows-now"
                  style={{ left: pct(today.fraction) }}
                  aria-hidden="true"
                />
              )}
              {hover !== null && (
                <div
                  className="windows-hover"
                  style={{ left: pct(hover) }}
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
                {hourLabel(h)}
              </span>
            ))}
            {hover !== null && (
              <span
                className="windows-hover-label"
                style={{ left: pct(hover) }}
              >
                {clockOfFraction(hover)}
              </span>
            )}
          </div>
        </li>
      </ul>
    </section>
  );
}

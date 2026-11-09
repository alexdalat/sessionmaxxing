"use client";
import { ClockIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { api } from "@/app/lib/api";
import {
  fetchedLabel,
  NOT_STARTED,
  type StripRow,
  stripHeading,
  usageStripRows,
} from "@/app/lib/usageStrip";
import type { PlanningBase } from "@/shared/types";

function Row({ row }: { row: StripRow }) {
  const details = [row.cutoffText, row.heldText].filter(Boolean).join(" · ");
  return (
    <div className="usage-row" data-bucket={row.bucket}>
      <div className="usage-head">
        <span className="usage-label">{row.label}</span>
        <span className="usage-percent metric">{row.percentText}</span>
        <span className="usage-reset">
          {row.resetText === NOT_STARTED ? (
            row.resetText
          ) : (
            <>
              <ClockIcon aria-hidden="true" className="size-3" />
              {row.resetText}
            </>
          )}
        </span>
      </div>
      <div className="usage-track" role="img" aria-label={row.ariaLabel}>
        <div
          className="usage-fill"
          data-fill={row.bucket}
          style={{ width: `${row.fill}%` }}
        />
        {row.pace !== null && (
          <div
            className="usage-mark usage-pace"
            style={{ left: `${row.pace}%` }}
          />
        )}
        <div
          className="usage-mark usage-ceiling"
          title={row.cutoffText}
          style={{ left: `${row.ceiling}%` }}
        />
      </div>
      <p className="usage-local">
        {row.paceText && (
          <span
            className={row.paceTone === "under" ? "usage-under" : "usage-over"}
          >
            {row.paceText}
            {" · "}
          </span>
        )}
        {details}
      </p>
    </div>
  );
}

export function UsageStrip({
  planning,
  now,
  onRefreshed,
}: {
  planning: Pick<PlanningBase, "session" | "weekly" | "usage" | "usageError">;
  now: number;
  onRefreshed: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const heading = stripHeading(planning.usage);
  const fetched = fetchedLabel(planning.usage, now);
  return (
    <section className="panel usage-panel" aria-label={heading}>
      <div className="section-heading">
        <h2>{heading}</h2>
        <span className="usage-meta">
          <span className={fetched.stale ? "muted usage-over" : "muted"}>
            {fetched.text}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              setRefreshError("");
              try {
                await api("/api/usage/refresh", { method: "POST" });
                onRefreshed();
              } catch (error) {
                setRefreshError(
                  error instanceof Error ? error.message : String(error),
                );
              } finally {
                setRefreshing(false);
              }
            }}
          >
            {refreshing ? "Refreshing…" : "Refresh usage"}
          </Button>
        </span>
      </div>
      {refreshError && (
        <p className="error" role="alert">
          {refreshError}
        </p>
      )}
      {planning.usageError && (
        <p className="error" role="alert">
          {planning.usageError}
        </p>
      )}
      {usageStripRows(planning, now).map((row) => (
        <Row key={row.bucket} row={row} />
      ))}
      <ul className="usage-legend" aria-hidden="true">
        <li className="key-pace">Pace</li>
        <li className="key-ceiling">Queue cutoff</li>
      </ul>
    </section>
  );
}

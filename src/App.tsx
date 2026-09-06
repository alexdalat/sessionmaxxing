import { useEffect, useState } from "react";
import type { Analytics, RangeDays } from "../shared/types";
import { RANGE_DAYS } from "../shared/types";
import { api } from "./api";
import { Overview } from "./Overview";
import { Planner } from "./Planner";
import { Runs } from "./Runs";
import { TaskQueue } from "./TaskQueue";

export function App() {
  const [initialWindow, setInitialWindow] = useState<number>();
  const [section, setSection] = useState("Overview");
  const [request, setRequest] = useState<{ days: RangeDays }>({ days: 30 });
  const days = request.days;
  const [analytics, setAnalytics] = useState<Analytics>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Analytics>(`/api/analytics?days=${request.days}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setAnalytics(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [request]);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>{" "}
          Capacity
        </div>
        <p className="sidebar-caption">CLAUDE MAX · LOCAL</p>
        <nav aria-label="Main navigation">
          {["Overview", "Capacity planner", "Task queue", "Runs"].map(
            (item) => (
              <button
                type="button"
                key={item}
                aria-current={section === item ? "page" : undefined}
                onClick={() => setSection(item)}
              >
                {item}
              </button>
            ),
          )}
        </nav>
        <div className="local-note">
          <span aria-hidden="true">●</span> Local data only
          <br />
          <small>America/New_York</small>
        </div>
      </aside>
      <main id="main" tabIndex={-1}>
        <header className="page-header">
          <h1>{section === "Overview" ? "Claude Max" : section}</h1>
          {(section === "Overview" || section === "Capacity planner") && (
            <div className="header-controls">
              <label>
                Date range
                <select
                  aria-label="Date range"
                  value={days}
                  onChange={(e) =>
                    setRequest({ days: Number(e.target.value) as RangeDays })
                  }
                >
                  {RANGE_DAYS.map((n) => (
                    <option key={n} value={n}>
                      {n} days
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setRequest((previous) => ({ ...previous }))}
              >
                Refresh
              </button>
            </div>
          )}
        </header>
        {loading &&
          (section === "Overview" || section === "Capacity planner") && (
            <p role="status">Loading local activity…</p>
          )}
        {error &&
          (section === "Overview" || section === "Capacity planner") && (
            <div className="error" role="alert">
              {error}{" "}
              <button
                type="button"
                onClick={() => setRequest((previous) => ({ ...previous }))}
              >
                Try again
              </button>
            </div>
          )}
        {analytics &&
          !loading &&
          !error &&
          (section === "Overview" || section === "Capacity planner") &&
          (section === "Overview" ? (
            <Overview
              data={analytics}
              onOpenQueue={() => setSection("Task queue")}
            />
          ) : (
            <Planner
              data={analytics}
              onSchedule={(start) => {
                setInitialWindow(start);
                setSection("Task queue");
              }}
            />
          ))}
        {section === "Task queue" && (
          <TaskQueue
            initialWindow={initialWindow}
            onOpenDispatch={() => setSection("Overview")}
          />
        )}
        {section === "Runs" && <Runs />}
      </main>
    </div>
  );
}

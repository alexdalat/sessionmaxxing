import { type Analytics, BLOCK_MINUTES } from "../shared/types";
import { hour, localTimestamp } from "./time";
export function Planner({
  data,
  onSchedule,
}: {
  data: Analytics;
  onSchedule?: (startHour: number) => void;
}) {
  const block = data.currentBlock;
  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <h2>Current five-hour block</h2>
          <span className="muted">Inferred from local transcripts</span>
        </div>
        {block ? (
          <>
            <p>
              {localTimestamp(block.start)} → {localTimestamp(block.end)}
            </p>
            <div className="block-value">
              <strong className="metric">
                {(block.utilization * 100).toFixed(1)}%
              </strong>
              <span className="muted">of 300 minutes active</span>
            </div>
            <progress
              max={BLOCK_MINUTES}
              value={block.activeMinutes}
              aria-label="Estimated active-minute utilization"
            />
            <dl className="facts">
              <div>
                <dt>Elapsed</dt>
                <dd>{block.elapsedMinutes} min</dd>
              </div>
              <div>
                <dt>Active minutes</dt>
                <dd>{block.activeMinutes}</dd>
              </div>
              <div>
                <dt>Responses</dt>
                <dd>{block.responses}</dd>
              </div>
              <div>
                <dt>Headroom left</dt>
                <dd>{block.remainingMinutes} min</dd>
              </div>
            </dl>
          </>
        ) : (
          <p>No current five-hour block. New activity starts one.</p>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Quiet five-hour windows</h2>
          <span className="muted">Best starts for queued work</span>
        </div>
        <p className="muted">
          Ranked by your average active minutes over the last 30 days, quietest
          first. Eastern time.
        </p>
        {!data.totals.responses && (
          <p className="warning">
            No local activity yet, so every window ranks equal.
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Local window</th>
                <th>Avg. active min</th>
                <th>Avg. responses</th>
                <th>Utilization</th>
                {onSchedule && <th>Queue</th>}
              </tr>
            </thead>
            <tbody>
              {data.opportunities.map((window, i) => (
                <tr key={window.startHour}>
                  <td>{i + 1}</td>
                  <th>
                    {hour(window.startHour)} → {hour(window.endHour)}
                    {window.endHour < window.startHour && (
                      <small> +1 day</small>
                    )}
                  </th>
                  <td>{window.averageActiveMinutes.toFixed(1)}</td>
                  <td>{window.averageResponses.toFixed(1)}</td>
                  <td>{(window.utilization * 100).toFixed(1)}%</td>
                  {onSchedule && (
                    <td>
                      <button
                        type="button"
                        aria-label={`Schedule at ${hour(window.startHour)}`}
                        onClick={() => onSchedule(window.startHour)}
                      >
                        Use window
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

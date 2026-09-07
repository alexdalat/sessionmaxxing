import type { RangeDays } from "../shared/types";
import { RANGE_DAYS } from "../shared/types";

export function RangeControls({
  days,
  onChange,
  onRefresh,
}: {
  days: RangeDays;
  onChange: (days: RangeDays) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="header-controls">
      <label>
        Local activity range
        <select
          aria-label="Local activity range"
          value={days}
          onChange={(e) => onChange(Number(e.target.value) as RangeDays)}
        >
          {RANGE_DAYS.map((n) => (
            <option key={n} value={n}>
              {n} days
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  );
}

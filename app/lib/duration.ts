import { MINUTE_MS } from "@/shared/types";

const HOUR = 60;
const DAY = 24 * HOUR;
const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;

export function formatRemaining(ms: number) {
  const total = Math.floor(Math.max(0, ms) / MINUTE_MS);
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  const minutes = total % HOUR;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return minutes > 0 ? `${minutes}m` : "<1m";
}

/** Run length to the second under an hour: 42s, 3m 5s, 1h 20m. */
export function formatDuration(ms: number) {
  const seconds = Math.round(Math.max(0, ms) / SECOND_MS);
  if (seconds < MINUTE_SECONDS) return `${seconds}s`;
  const minutes = Math.floor(seconds / MINUTE_SECONDS);
  if (minutes < HOUR) return `${minutes}m ${seconds % MINUTE_SECONDS}s`;
  return `${Math.floor(minutes / HOUR)}h ${minutes % HOUR}m`;
}

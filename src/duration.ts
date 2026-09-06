const MINUTE_MS = 60_000;
const HOUR = 60;
const DAY = 24 * HOUR;

export function formatRemaining(ms: number) {
  const total = Math.floor(Math.max(0, ms) / MINUTE_MS);
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  const minutes = total % HOUR;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return minutes > 0 ? `${minutes}m` : "<1m";
}

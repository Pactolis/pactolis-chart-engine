export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const MONTH_TOKEN_MS = 30 * DAY_MS;

const MONTH_SPANS = new Set([1, 2, 3, 6, 12]);

function utcMonthStart(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export function monthSpan(intervalMs: number): number {
  const months = intervalMs / MONTH_TOKEN_MS;
  return Number.isInteger(months) && MONTH_SPANS.has(months) ? months : 0;
}

export function bucketStart(time: number, intervalMs: number): number {
  const months = monthSpan(intervalMs);
  if (months) {
    const d = new Date(time);
    const month = Math.floor(d.getUTCMonth() / months) * months;
    return utcMonthStart(d.getUTCFullYear(), month);
  }
  if (intervalMs === WEEK_MS || intervalMs === 2 * WEEK_MS) {
    const day = Math.floor(time / DAY_MS) * DAY_MS;
    const d = new Date(day);
    const monday = day - ((d.getUTCDay() + 6) % 7) * DAY_MS;
    if (intervalMs === WEEK_MS) return monday;
    const anchor = Date.UTC(1970, 0, 5);
    return anchor + Math.floor((monday - anchor) / intervalMs) * intervalMs;
  }
  return Math.floor(time / intervalMs) * intervalMs;
}

export function bucketEnd(startTime: number, intervalMs: number): number {
  const months = monthSpan(intervalMs);
  if (months) {
    const d = new Date(startTime);
    return utcMonthStart(d.getUTCFullYear(), d.getUTCMonth() + months);
  }
  return bucketStart(startTime + intervalMs, intervalMs);
}

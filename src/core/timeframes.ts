// Candle interval (timeframe) options for the chart.

export interface Timeframe {
  label: string;
  ms: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY; // approximate

export const TIMEFRAMES: Timeframe[] = [
  { label: "1m", ms: MIN },
  { label: "5m", ms: 5 * MIN },
  { label: "15m", ms: 15 * MIN },
  { label: "30m", ms: 30 * MIN },
  { label: "1h", ms: HOUR },
  { label: "2h", ms: 2 * HOUR },
  { label: "4h", ms: 4 * HOUR },
  { label: "6h", ms: 6 * HOUR },
  { label: "8h", ms: 8 * HOUR },
  { label: "12h", ms: 12 * HOUR },
  { label: "1d", ms: DAY },
  { label: "3d", ms: 3 * DAY },
  { label: "1w", ms: WEEK },
  { label: "2w", ms: 2 * WEEK },
  { label: "1M", ms: MONTH },
  { label: "2M", ms: 2 * MONTH },
  { label: "3M", ms: 3 * MONTH },
  { label: "6M", ms: 6 * MONTH },
  { label: "12M", ms: 12 * MONTH },
];

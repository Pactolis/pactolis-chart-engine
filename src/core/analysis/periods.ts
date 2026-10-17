import { DAY_MS, MONTH_TOKEN_MS, WEEK_MS, bucketEnd, bucketStart } from "../time.js";
import type { FootprintBar } from "../types.js";
import { t } from "../chartLocale.js";

export type AnalysisPeriod =
  | "daily" | "weekly" | "monthly"
  | "quarterly" | "half-yearly" | "yearly";

export const ANALYSIS_PERIODS: readonly AnalysisPeriod[] = [
  "daily", "weekly", "monthly", "quarterly", "half-yearly", "yearly",
];

export const PERIOD_INTERVAL: Record<AnalysisPeriod, number> = {
  daily: DAY_MS,
  weekly: WEEK_MS,
  monthly: MONTH_TOKEN_MS,
  quarterly: 3 * MONTH_TOKEN_MS,
  "half-yearly": 6 * MONTH_TOKEN_MS,
  yearly: 12 * MONTH_TOKEN_MS,
};

/** Calendar-aligned start of the period containing `time`. */
export function analysisPeriodStart(time: number, period: AnalysisPeriod): number {
  return bucketStart(time, PERIOD_INTERVAL[period]);
}

/** Calendar-aligned start of the period immediately before the one containing `time`. */
export function previousAnalysisPeriodStart(time: number, period: AnalysisPeriod): number {
  const currentStart = analysisPeriodStart(time, period);
  return bucketStart(currentStart - 1, PERIOD_INTERVAL[period]);
}

export interface PeriodCandle {
  period: AnalysisPeriod;
  start: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  complete: boolean;
}

export function aggregatePeriodCandles(
  bars: readonly FootprintBar[],
  period: AnalysisPeriod,
  now = Date.now(),
  sourceIntervalMs?: number
): PeriodCandle[] {
  const interval = PERIOD_INTERVAL[period];
  const groups = new Map<number, FootprintBar[]>();
  for (const bar of [...bars].sort((a, b) => a.startTime - b.startTime)) {
    const start = bucketStart(bar.startTime, interval);
    const group = groups.get(start);
    if (group) group.push(bar);
    else groups.set(start, [bar]);
  }
  return [...groups].sort((a, b) => a[0] - b[0]).map(([start, group]) => {
    const end = bucketEnd(start, interval);
    // `partial` is an envelope-level quality signal and may only mean that
    // footprint cells are incomplete. The OHLC fields still come from the
    // canonical kline source and remain valid for PW/EQ/current OPEN analysis.
    // Reject missing/non-finite OHLC rows here, and let time coverage plus the
    // `provisional` marker decide whether a CLOSED period is complete.
    const ohlcBars = group.filter(hasUsableOhlc);
    return {
      period,
      start,
      end,
      open: ohlcBars[0]?.open ?? NaN,
      high: Math.max(...ohlcBars.map((bar) => bar.high)),
      low: Math.min(...ohlcBars.map((bar) => bar.low)),
      close: ohlcBars[ohlcBars.length - 1]?.close ?? NaN,
      complete: end <= now && completeCoverage(ohlcBars, start, end, sourceIntervalMs),
    };
  });
}

function hasUsableOhlc(bar: FootprintBar): boolean {
  return bar.hasRef
    && Number.isFinite(bar.open)
    && Number.isFinite(bar.high)
    && Number.isFinite(bar.low)
    && Number.isFinite(bar.close);
}

function completeCoverage(
  bars: readonly FootprintBar[],
  start: number,
  end: number,
  sourceIntervalMs?: number
): boolean {
  if (!sourceIntervalMs || sourceIntervalMs <= 0) return completeDailyCoverage(bars, start, end);
  if (!bars.length || bars.some((bar) => bar.completeness === "provisional")) return false;

  let cursor = start;
  for (const bar of [...bars].sort((a, b) => a.startTime - b.startTime)) {
    const barStart = bucketStart(bar.startTime, sourceIntervalMs);
    const barEnd = bucketEnd(barStart, sourceIntervalMs);
    if (barEnd <= cursor) continue;
    // Allow a tiny tolerance so millisecond rounding at calendar/month boundaries
    // never marks an otherwise exact source candle as incomplete.
    if (barStart > cursor + 1) return false;
    cursor = Math.max(cursor, Math.min(barEnd, end));
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

function completeDailyCoverage(bars: readonly FootprintBar[], start: number, end: number): boolean {
  const expected = Math.round((end - start) / DAY_MS);
  if (bars.length < expected || bars.some((bar) => bar.completeness === "provisional")) return false;
  return new Set(bars.map((bar) => bucketStart(bar.startTime, DAY_MS))).size >= expected;
}

export function periodPrefix(period: AnalysisPeriod): string {
  return period === "daily" ? "D"
    : period === "weekly" ? "W"
    : period === "monthly" ? "M"
    : period === "quarterly" ? "Q"
    : period === "half-yearly" ? "H"
    : "Y";
}

export function periodUnit(period: AnalysisPeriod): string {
  return period === "daily" ? t("period.day")
    : period === "weekly" ? t("period.week")
    : period === "monthly" ? t("period.month")
    : period === "quarterly" ? t("period.quarter")
    : period === "half-yearly" ? t("period.halfYear")
    : t("period.year");
}

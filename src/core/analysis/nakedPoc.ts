import { bucketEnd, bucketStart } from "../time.js";
import type { FootprintBar } from "../types.js";
import { hasCompleteFootprintCoverage } from "./footprintIntegrity.js";
import { PERIOD_INTERVAL, type AnalysisPeriod } from "./periods.js";

export type NakedPocPeriod = AnalysisPeriod;

export interface NakedPocLevel {
  id: string;
  market: string;
  period: NakedPocPeriod;
  periodStart: number;
  periodEnd: number;
  price: number;
  age: number;
  complete: true;
}

interface PeriodProfile {
  start: number;
  end: number;
  low: number;
  high: number;
  poc: number;
}

export function calculateNakedPocs(
  bars: readonly FootprintBar[],
  market: string,
  period: NakedPocPeriod,
  now = Date.now(),
  sourceIntervalMs?: number
): NakedPocLevel[] {
  const profiles = buildProfiles(bars, period, now, sourceIntervalMs);
  const levels: NakedPocLevel[] = [];
  const prices = [...new Set(profiles.map((profile) => profile.poc))].sort((a, b) => a - b);
  const coverage = new RangeCoverage(prices.length);
  for (let i = profiles.length - 1; i >= 0; i--) {
    const candidate = profiles[i];
    const priceIndex = lowerBound(prices, candidate.poc);
    const touched = coverage.at(priceIndex) > 0;
    const age = profiles.length - i - 1;
    // A completed period's POC becomes "naked" only after at least one newer
    // completed period has closed without touching it. Touches from the current
    // in-progress period are intentionally ignored until that period closes.
    if (!touched && age >= 1) {
      levels.push({
        id: `${market}|${period}|${candidate.start}`,
        market,
        period,
        periodStart: candidate.start,
        periodEnd: candidate.end,
        price: candidate.poc,
        age,
        complete: true,
      });
    }
    const firstCovered = lowerBound(prices, candidate.low);
    const afterCovered = upperBound(prices, candidate.high);
    coverage.add(firstCovered, afterCovered);
  }
  return levels.reverse();
}

class RangeCoverage {
  private readonly tree: Int32Array;

  constructor(size: number) {
    this.tree = new Int32Array(size + 2);
  }

  add(from: number, toExclusive: number): void {
    if (from >= toExclusive) return;
    this.increment(from + 1, 1);
    this.increment(toExclusive + 1, -1);
  }

  at(index: number): number {
    let value = 0;
    for (let cursor = index + 1; cursor > 0; cursor -= cursor & -cursor) value += this.tree[cursor];
    return value;
  }

  private increment(index: number, delta: number): void {
    for (let cursor = index; cursor < this.tree.length; cursor += cursor & -cursor) this.tree[cursor] += delta;
  }
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function buildProfiles(
  bars: readonly FootprintBar[],
  period: NakedPocPeriod,
  now: number,
  sourceIntervalMs?: number
): PeriodProfile[] {
  const interval = PERIOD_INTERVAL[period];
  const currentStart = bucketStart(now, interval);
  const groups = new Map<number, FootprintBar[]>();
  for (const bar of bars) {
    const start = bucketStart(bar.startTime, interval);
    const group = groups.get(start);
    if (group) group.push(bar);
    else groups.set(start, [bar]);
  }

  const profiles: PeriodProfile[] = [];
  for (const [start, periodBars] of [...groups].sort((a, b) => a[0] - b[0])) {
    const end = bucketEnd(start, interval);
    if (start === currentStart || end > now || !hasCompleteFootprintCoverage(periodBars, start, end, sourceIntervalMs)) continue;
    const volumeByPrice = new Map<number, number>();
    let low = Infinity;
    let high = -Infinity;
    for (const bar of periodBars) {
      low = Math.min(low, bar.low);
      high = Math.max(high, bar.high);
      for (const cell of bar.cells.values()) {
        volumeByPrice.set(
          cell.priceBin,
          (volumeByPrice.get(cell.priceBin) ?? 0) + cell.buyVol + cell.sellVol
        );
      }
    }
    let poc: number | null = null;
    let maxVolume = -1;
    for (const [price, volume] of volumeByPrice) {
      if (volume > maxVolume || (volume === maxVolume && (poc === null || price < poc))) {
        poc = price;
        maxVolume = volume;
      }
    }
    if (poc !== null) profiles.push({ start, end, low, high, poc });
  }
  return profiles;
}

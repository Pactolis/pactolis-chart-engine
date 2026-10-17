import { bucketEnd, bucketStart } from "../time.js";
import type { FootprintBar } from "../types.js";
import {
  aggregatePeriodCandles,
  analysisPeriodStart,
  periodPrefix,
  previousAnalysisPeriodStart,
  PERIOD_INTERVAL,
  type AnalysisPeriod,
  type PeriodCandle,
} from "./periods.js";
import { calculateVolumeProfile } from "./volumeProfile.js";
import { hasCompleteFootprintCoverage, hasValidPositiveFootprintVolume } from "./footprintIntegrity.js";
import { referenceLevelPalette } from "../ui/seriesPalette.js";

export type ReferenceLevelFamily = "eq" | "open" | "level" | "valueArea";
export type ValueAreaKind = "val" | "vah";

export interface ReferenceLevel {
  id: string;
  market: string;
  family: ReferenceLevelFamily;
  period: AnalysisPeriod;
  sourceStart: number;
  sourceEnd: number;
  pairStart?: number;
  valueAreaKind?: ValueAreaKind;
  /** Set on value areas that came from the backend instead of footprint bars. */
  fromBackend?: true;
  price: number;
  age: number;
  complete: boolean;
  label: string;
  color: string;
}

const EQ_OPEN_PERIODS: readonly AnalysisPeriod[] = [
  "daily", "weekly", "monthly", "quarterly", "half-yearly", "yearly",
];
const UNTOUCHED_PERIODS: readonly AnalysisPeriod[] = [
  "daily", "weekly", "monthly", "quarterly", "half-yearly", "yearly",
];
const VALUE_AREA_PERIODS: readonly AnalysisPeriod[] = UNTOUCHED_PERIODS;

const LEGACY_EQ_COLORS: Partial<Record<AnalysisPeriod, string>> = {
  monthly: "#66c2a5",
  quarterly: "#41ae76",
  "half-yearly": "#238b45",
  yearly: "#006d2c",
};
const LEGACY_OPEN_COLORS: Partial<Record<AnalysisPeriod, string>> = {
  monthly: "#fdae6b",
  quarterly: "#fd8d3c",
  "half-yearly": "#e6550d",
  yearly: "#a63603",
};

export function calculateReferenceLevels(
  bars: readonly FootprintBar[],
  market: string,
  priceStep: number,
  now = Date.now(),
  sourceIntervalMs?: number
): ReferenceLevel[] {
  return [
    ...calculateEqLevels(bars, market, now, sourceIntervalMs),
    ...calculateOpenLevels(bars, market, now, sourceIntervalMs),
    ...calculateValueAreaLevels(bars, market, now, sourceIntervalMs),
    ...calculateUntouchedLevels(bars, market, priceStep, now, sourceIntervalMs),
  ];
}

export function calculateEqLevels(
  bars: readonly FootprintBar[],
  market: string,
  now = Date.now(),
  sourceIntervalMs?: number,
  periods: readonly AnalysisPeriod[] = EQ_OPEN_PERIODS
): ReferenceLevel[] {
  return periods.flatMap((period) => {
    const expectedStart = previousAnalysisPeriodStart(now, period);
    const candle = aggregatePeriodCandles(bars, period, now, sourceIntervalMs).find(
      (item) => item.complete && item.start === expectedStart
    );
    if (!candle) return [];
    return [makeLevel(market, "eq", candle, (candle.high + candle.low) / 2, 0,
      `P${periodPrefix(period)}-EQ`, color("eq", period))];
  });
}

export function calculateOpenLevels(
  bars: readonly FootprintBar[],
  market: string,
  now = Date.now(),
  _sourceIntervalMs?: number,
  periods: readonly AnalysisPeriod[] = EQ_OPEN_PERIODS
): ReferenceLevel[] {
  return periods.flatMap((period) => {
    const expectedStart = analysisPeriodStart(now, period);
    const first = bars.find((bar) => bar.startTime === expectedStart && hasUsableOpen(bar));
    if (!first) return [];
    const candle: PeriodCandle = {
      period,
      start: expectedStart,
      end: bucketEnd(expectedStart, PERIOD_INTERVAL[period]),
      open: first.open,
      high: first.high,
      low: first.low,
      close: first.close,
      complete: false,
    };
    return [makeLevel(market, "open", candle, first.open, 0,
      `${periodPrefix(period)}-OPEN`, color("open", period), false)];
  });
}

export function calculateValueAreaLevels(
  bars: readonly FootprintBar[],
  market: string,
  now = Date.now(),
  sourceIntervalMs?: number,
  periods: readonly AnalysisPeriod[] = VALUE_AREA_PERIODS,
): ReferenceLevel[] {
  return periods.flatMap((period) => {
    const start = previousAnalysisPeriodStart(now, period);
    const end = bucketEnd(start, PERIOD_INTERVAL[period]);
    const periodBars = bars.filter((bar) => bucketStart(bar.startTime, PERIOD_INTERVAL[period]) === start);
    if (!hasCompleteFootprintCoverage(periodBars, start, end, sourceIntervalMs)
      || !hasValidPositiveFootprintVolume(periodBars)) return [];
    const profile = calculateVolumeProfile(periodBars);
    if (profile.val === null || profile.vah === null
      || !Number.isFinite(profile.val) || !Number.isFinite(profile.vah)
      || profile.totalVolume <= 0) return [];
    return [
      makeValueAreaLevel(market, period, start, end, "val", profile.val),
      makeValueAreaLevel(market, period, start, end, "vah", profile.vah),
    ];
  });
}

/** A previous-period value area computed by the backend nPOC worker (`/api/npoc`). */
export interface BackendValueArea {
  period: AnalysisPeriod;
  periodStart: number;
  vah: number;
  val: number;
}

/**
 * VAL/VAH levels from backend value areas. Only the immediately previous period of
 * each kind is drawn, like the locally computed levels; an older area (the backend
 * has not processed the latest Vision day yet) yields nothing, so the local
 * calculation stays in charge for that period.
 */
export function backendValueAreaLevels(
  areas: readonly BackendValueArea[],
  market: string,
  now = Date.now(),
): ReferenceLevel[] {
  return VALUE_AREA_PERIODS.flatMap((period) => {
    const start = previousAnalysisPeriodStart(now, period);
    const area = areas.find((item) => item.period === period && item.periodStart === start);
    if (!area || !Number.isFinite(area.val) || !Number.isFinite(area.vah) || area.val > area.vah) return [];
    const end = bucketEnd(start, PERIOD_INTERVAL[period]);
    return [
      { ...makeValueAreaLevel(market, period, start, end, "val", area.val), fromBackend: true as const },
      { ...makeValueAreaLevel(market, period, start, end, "vah", area.vah), fromBackend: true as const },
    ];
  });
}

/**
 * Backend value areas replace the locally computed ones period by period. Periods the
 * backend does not cover (spot markets, a backend that is behind) keep the local
 * levels. Earlier backend levels are always replaced by `backend`, so one that is no
 * longer the previous period disappears instead of lingering.
 */
export function mergeBackendValueAreas(
  levels: readonly ReferenceLevel[],
  backend: readonly ReferenceLevel[],
): ReferenceLevel[] {
  const covered = new Set(backend.map((level) => level.period));
  return [
    ...levels.filter((level) => level.family !== "valueArea"
      || (!level.fromBackend && !covered.has(level.period))),
    ...backend,
  ];
}

export function calculateUntouchedLevels(
  bars: readonly FootprintBar[],
  market: string,
  priceStep: number,
  now = Date.now(),
  sourceIntervalMs?: number,
  periods: readonly AnalysisPeriod[] = UNTOUCHED_PERIODS
): ReferenceLevel[] {
  const result: ReferenceLevel[] = [];
  for (const period of periods) {
    const candles = aggregatePeriodCandles(bars, period, now, sourceIntervalMs).filter((item) => item.complete);
    for (let i = 0; i < candles.length - 1; i++) {
      const first = candles[i];
      const second = candles[i + 1];
      if (!oppositeColors(first, second)) continue;
      const candidates = [
        matchedPrice(first.open, second.close, priceStep),
        matchedPrice(first.close, second.open, priceStep),
      ].filter((value): value is number => value !== null);
      for (const price of [...new Set(candidates)]) {
        if (candles.slice(i + 2).some((later) => later.low <= price && price <= later.high)) continue;
        result.push({
          id: `${market}|level|${period}|${first.start}|${second.start}|${price}`,
          market,
          family: "level",
          period,
          sourceStart: second.start,
          sourceEnd: second.end,
          pairStart: first.start,
          price,
          age: candles.length - i - 2,
          complete: true,
          label: `${periodPrefix(period)}-LVL`,
          color: color("level", period),
        });
      }
    }
  }
  return result;
}

function makeValueAreaLevel(
  market: string,
  period: AnalysisPeriod,
  sourceStart: number,
  sourceEnd: number,
  kind: ValueAreaKind,
  price: number,
): ReferenceLevel {
  return {
    id: `${market}|valueArea|${period}|${sourceStart}|${kind}`,
    market,
    family: "valueArea",
    period,
    sourceStart,
    sourceEnd,
    valueAreaKind: kind,
    price,
    age: 0,
    complete: true,
    label: `P${periodPrefix(period)}-${kind.toUpperCase()}`,
    color: color("valueArea", period),
  };
}

function makeLevel(
  market: string,
  family: ReferenceLevelFamily,
  candle: PeriodCandle,
  price: number,
  age: number,
  label: string,
  levelColor: string,
  complete = true
): ReferenceLevel {
  return {
    id: `${market}|${family}|${candle.period}|${candle.start}`,
    market,
    family,
    period: candle.period,
    sourceStart: candle.start,
    sourceEnd: candle.end,
    price,
    age,
    complete,
    label,
    color: levelColor,
  };
}

function hasUsableOpen(bar: FootprintBar): boolean {
  return bar.hasRef && Number.isFinite(bar.open);
}

function oppositeColors(a: PeriodCandle, b: PeriodCandle): boolean {
  const first = Math.sign(a.close - a.open);
  const second = Math.sign(b.close - b.open);
  return first !== 0 && second !== 0 && first !== second;
}

function matchedPrice(a: number, b: number, step: number): number | null {
  // A level forms when an open and a close of opposite candles agree within one
  // price step. The level itself is the precise midpoint of the two prices — it
  // must NOT be snapped to the footprint price-step grid, otherwise a level on a
  // coarse step (e.g. BTC step 15) is pulled several ticks off the real price.
  if (Math.abs(a - b) > step) return null;
  return (a + b) / 2;
}

function color(family: ReferenceLevelFamily, period: AnalysisPeriod): string {
  if (family === "eq" && LEGACY_EQ_COLORS[period]) return LEGACY_EQ_COLORS[period]!;
  if (family === "open" && LEGACY_OPEN_COLORS[period]) return LEGACY_OPEN_COLORS[period]!;
  const base = referenceLevelPalette[family];
  const order: AnalysisPeriod[] = ["daily", "weekly", "monthly", "quarterly", "half-yearly", "yearly"];
  return base[Math.min(base.length - 1, order.indexOf(period))];
}

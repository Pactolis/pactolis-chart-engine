import type { FootprintBar } from "../types.js";
import { bucketStart, DAY_MS, MONTH_TOKEN_MS, WEEK_MS } from "../time.js";
import type { TpoBracketSize, TpoProfilePeriod } from "../settings.js";
import { neighbourBin, quantizeToStep } from "../priceStep.js";

/**
 * TPO (Time-Price Opportunity / Market Profile) profile.
 *
 * Mirrors `calculateVolumeProfile` but, instead of summing traded volume per
 * price bin, it counts how many time brackets (bars) touched each price level.
 * Each bar is one bracket; a bracket "touches" every price bin spanned by its
 * low..high range, contributing one TPO to each. No per-cell data is needed —
 * only OHLC + priceStep.
 */

export interface TpoProfileLevel {
  priceBin: number;
  /** Number of brackets (bars) that traded at this price level. */
  count: number;
  /** Profile-local bracket indices that touched this price level. */
  bracketIndices: number[];
}

export interface TpoProfileResult {
  levels: TpoProfileLevel[];
  totalCount: number;
  /** Price with the most TPOs (Point of Control). */
  poc: number | null;
  /** Value Area High / Low (bounds of the value-area % of TPOs). */
  vah: number | null;
  val: number | null;
  fromTime: number | null;
  toTime: number | null;
}

export interface TpoSessionSpan {
  sessionStart: number;
  firstIdx: number;
  lastIdx: number;
}

export interface TpoBracketBar {
  bar: FootprintBar;
  firstIdx: number;
  lastIdx: number;
}

export interface TpoBracketSpan {
  sessionStart: number;
  firstBracketIndex: number;
  lastBracketIndex: number;
  firstIdx: number;
  lastIdx: number;
}

export interface TpoMergedSessionGroup {
  sessionStarts: number[];
  firstBracketIndex: number;
  lastBracketIndex: number;
  firstIdx: number;
  lastIdx: number;
  firstSpanIndex: number;
  lastSpanIndex: number;
}

/** Defensive cap on bins per bar to avoid blow-up on degenerate ranges. */
const MAX_BINS_PER_BAR = 10_000;

const TPO_BRACKET_MS: Record<Exclude<TpoBracketSize, "auto">, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
};

export function tpoProfilePeriodMs(period: TpoProfilePeriod): number | null {
  if (period === "daily") return DAY_MS;
  if (period === "weekly") return WEEK_MS;
  if (period === "monthly") return MONTH_TOKEN_MS;
  return null;
}

export function tpoRequestedBracketMs(size: TpoBracketSize, chartIntervalMs: number): number {
  if (size === "auto") return chartIntervalMs;
  return TPO_BRACKET_MS[size];
}

export function effectiveTpoBracketMs(size: TpoBracketSize, chartIntervalMs: number): number {
  const requested = tpoRequestedBracketMs(size, chartIntervalMs);
  return Math.max(chartIntervalMs, requested);
}

export function buildTpoSessionSpans(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
  sessionMs: number
): TpoSessionSpan[] {
  const spans: TpoSessionSpan[] = [];
  let cur: TpoSessionSpan | null = null;
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(bars.length, Math.max(start, Math.floor(to)));
  for (let i = start; i < end; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const sessionStart = bucketStart(bar.startTime, sessionMs);
    if (!cur || cur.sessionStart !== sessionStart) {
      cur = { sessionStart, firstIdx: i, lastIdx: i };
      spans.push(cur);
    } else {
      cur.lastIdx = i;
    }
  }
  return spans;
}

export function aggregateTpoBrackets(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
  bracketMs: number
): TpoBracketBar[] {
  const brackets: TpoBracketBar[] = [];
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(bars.length, Math.max(start, Math.floor(to)));
  let current: TpoBracketBar | null = null;

  for (let i = start; i < end; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const startTime = bucketStart(bar.startTime, bracketMs);
    if (!current || current.bar.startTime !== startTime) {
      current = {
        firstIdx: i,
        lastIdx: i,
        bar: {
          ...bar,
          startTime,
          cells: new Map(),
        },
      };
      brackets.push(current);
      continue;
    }
    current.lastIdx = i;
    current.bar.high = Math.max(current.bar.high, bar.high);
    current.bar.low = Math.min(current.bar.low, bar.low);
    current.bar.close = bar.close;
    current.bar.volume += bar.volume;
    current.bar.delta += bar.delta;
    current.bar.count += bar.count;
    current.bar.liquidationBuyVol = (current.bar.liquidationBuyVol ?? 0) + (bar.liquidationBuyVol ?? 0);
    current.bar.liquidationSellVol = (current.bar.liquidationSellVol ?? 0) + (bar.liquidationSellVol ?? 0);
    current.bar.hasRef = current.bar.hasRef || bar.hasRef;
    current.bar.updatedAt = Math.max(current.bar.updatedAt ?? 0, bar.updatedAt ?? 0);
    current.bar.sources = [...new Set([...(current.bar.sources ?? []), ...(bar.sources ?? [])])];
  }

  return brackets;
}

export function buildTpoBracketSpans(
  brackets: readonly TpoBracketBar[],
  profilePeriod: TpoProfilePeriod
): TpoBracketSpan[] {
  if (!brackets.length) return [];
  if (profilePeriod === "visible") {
    return [{
      sessionStart: brackets[0].bar.startTime,
      firstBracketIndex: 0,
      lastBracketIndex: brackets.length - 1,
      firstIdx: brackets[0].firstIdx,
      lastIdx: brackets[brackets.length - 1].lastIdx,
    }];
  }

  const sessionMs = tpoProfilePeriodMs(profilePeriod) ?? DAY_MS;
  const spans: TpoBracketSpan[] = [];
  let cur: TpoBracketSpan | null = null;
  for (let i = 0; i < brackets.length; i++) {
    const bracket = brackets[i];
    const sessionStart = bucketStart(bracket.bar.startTime, sessionMs);
    if (!cur || cur.sessionStart !== sessionStart) {
      cur = {
        sessionStart,
        firstBracketIndex: i,
        lastBracketIndex: i,
        firstIdx: bracket.firstIdx,
        lastIdx: bracket.lastIdx,
      };
      spans.push(cur);
    } else {
      cur.lastBracketIndex = i;
      cur.lastIdx = bracket.lastIdx;
    }
  }
  return spans;
}

export function mergeTpoSessionSpans(
  spans: readonly (TpoSessionSpan | TpoBracketSpan)[],
  mergeLeftSessionStarts: ReadonlySet<number>
): TpoMergedSessionGroup[] {
  const groups: TpoMergedSessionGroup[] = [];
  spans.forEach((span, spanIndex) => {
    const previous = groups[groups.length - 1];
    if (previous && mergeLeftSessionStarts.has(span.sessionStart)) {
      previous.sessionStarts.push(span.sessionStart);
      previous.lastIdx = span.lastIdx;
      previous.lastBracketIndex = "lastBracketIndex" in span ? span.lastBracketIndex : span.lastIdx;
      previous.lastSpanIndex = spanIndex;
      return;
    }
    groups.push({
      sessionStarts: [span.sessionStart],
      firstBracketIndex: "firstBracketIndex" in span ? span.firstBracketIndex : span.firstIdx,
      lastBracketIndex: "lastBracketIndex" in span ? span.lastBracketIndex : span.lastIdx,
      firstIdx: span.firstIdx,
      lastIdx: span.lastIdx,
      firstSpanIndex: spanIndex,
      lastSpanIndex: spanIndex,
    });
  });
  return groups;
}

export function calculateTpoProfile(
  bars: readonly FootprintBar[],
  priceStep: number,
  valueAreaPercent = 0.7
): TpoProfileResult {
  const byPrice = new Map<number, TpoProfileLevel>();
  let fromTime: number | null = null;
  let toTime: number | null = null;

  if (priceStep > 0) {
    for (let bracketIndex = 0; bracketIndex < bars.length; bracketIndex++) {
      const bar = bars[bracketIndex];
      fromTime = fromTime === null ? bar.startTime : Math.min(fromTime, bar.startTime);
      toTime = toTime === null ? bar.startTime : Math.max(toTime, bar.startTime);

      const lo = quantizeToStep(bar.low, priceStep);
      const hi = quantizeToStep(bar.high, priceStep);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue;
      const spanBins = Math.round((hi - lo) / priceStep);
      if (!Number.isFinite(spanBins) || spanBins > MAX_BINS_PER_BAR) continue; // degenerate, skip

      let bin = lo;
      for (let index = 0; index <= spanBins; index += 1) {
        const level = byPrice.get(bin);
        if (level) {
          level.count += 1;
          level.bracketIndices.push(bracketIndex);
        } else {
          byPrice.set(bin, { priceBin: bin, count: 1, bracketIndices: [bracketIndex] });
        }
        if (index < spanBins) bin = neighbourBin(bin, priceStep, 1);
      }
    }
  }

  const levels = [...byPrice.values()].sort((a, b) => a.priceBin - b.priceBin);
  const totalCount = levels.reduce((sum, level) => sum + level.count, 0);
  if (!levels.length || totalCount <= 0) {
    return { levels, totalCount, poc: null, vah: null, val: null, fromTime, toTime };
  }

  let pocIndex = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].count > levels[pocIndex].count) pocIndex = i;
  }

  const target = totalCount * clamp(valueAreaPercent, 0.5, 0.99);
  let low = pocIndex;
  let high = pocIndex;
  let included = levels[pocIndex].count;
  while (included < target && (low > 0 || high < levels.length - 1)) {
    const below = low > 0 ? levels[low - 1].count : -1;
    const above = high < levels.length - 1 ? levels[high + 1].count : -1;
    if (above > below) {
      high++;
      included += levels[high].count;
    } else {
      low--;
      included += levels[low].count;
    }
  }

  return {
    levels,
    totalCount,
    poc: levels[pocIndex].priceBin,
    vah: levels[high].priceBin,
    val: levels[low].priceBin,
    fromTime,
    toTime,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Classic TPO bracket label for a session-relative bracket index:
 * 0..25 → A..Z, 26..51 → a..z, beyond → the raw index as text.
 */
export function tpoBracketLabel(index: number): string {
  if (index < 0) return "";
  if (index < 26) return String.fromCharCode(65 + index);
  if (index < 52) return String.fromCharCode(97 + (index - 26));
  return String(index);
}

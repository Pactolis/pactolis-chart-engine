import type { FootprintBar } from "../types.js";
import { bucketEnd, bucketStart, DAY_MS, MONTH_TOKEN_MS, WEEK_MS } from "../time.js";
import type { TpoBracketSize, TpoProfilePeriod } from "../settings.js";
import { quantizeToStep } from "../priceStep.js";

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

export interface TpoProfileRun {
  startPrice: number;
  endPrice: number;
  count: number;
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
  /** Compact run-length summary of non-zero TPO price bins in ascending order. */
  runs?: readonly TpoProfileRun[];
  /** True when total bracket-bin entries exceed the dense level-table budget. */
  truncated?: boolean;
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

export interface TpoProfileGroup extends TpoMergedSessionGroup {
  /** Whether the loaded bars fail to cover every interval in this profile group. */
  partial: boolean;
  result: TpoProfileResult;
}

export interface TpoProfileGroupSet {
  from: number;
  to: number;
  brackets: TpoBracketBar[];
  groups: TpoProfileGroup[];
}

/** Maximum total bracket-bin entries materialized into dense `levels`. */
const MAX_TPO_LEVEL_ENTRIES = 250_000;

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

function lowerBoundStartTime(bars: readonly FootprintBar[], lo: number, hi: number, targetTime: number): number {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = low + ((high - low) >>> 1);
    if (bars[mid].startTime < targetTime) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Expand a viewport to complete loaded sessions, including connected user merges.
 * The input series is already the replay as-of projection: never read another series.
 */
export function tpoSessionRange(
  bars: readonly FootprintBar[], from: number, to: number, period: TpoProfilePeriod,
  mergeLeft: ReadonlySet<number> = new Set(),
): [number, number] {
  let first = Math.max(0, Math.min(bars.length, Math.floor(from)));
  let end = Math.max(first, Math.min(bars.length, Math.ceil(to)));
  const sessionMs = tpoProfilePeriodMs(period);
  if (sessionMs === null || first === end) return [first, end];

  const sessionAt = (index: number): number => bucketStart(bars[index].startTime, sessionMs);

  let curSession = sessionAt(first);
  if (first > 0) {
    first = lowerBoundStartTime(bars, 0, first, curSession);
    while (first > 0 && mergeLeft.has(curSession)) {
      curSession = sessionAt(first - 1);
      first = lowerBoundStartTime(bars, 0, first, curSession);
    }
  }

  if (end < bars.length) {
    const prevSession = sessionAt(end - 1);
    end = lowerBoundStartTime(bars, end, bars.length, bucketEnd(prevSession, sessionMs));
    while (end < bars.length) {
      const nextSession = sessionAt(end);
      if (!mergeLeft.has(nextSession)) break;
      end = lowerBoundStartTime(bars, end + 1, bars.length, bucketEnd(nextSession, sessionMs));
    }
  }

  return [first, end];
}

export function tpoSessionPartial(
  bars: readonly FootprintBar[], first: number, last: number, period: TpoProfilePeriod, intervalMs: number,
): boolean {
  const sessionMs = tpoProfilePeriodMs(period);
  if (sessionMs === null || !bars[first] || !bars[last]) return false;
  const sessionStart = bucketStart(bars[first].startTime, sessionMs);
  const sessionEnd = bucketEnd(bucketStart(bars[last].startTime, sessionMs), sessionMs);
  if (bars[first].startTime > sessionStart || bucketEnd(bars[last].startTime, intervalMs) < sessionEnd) return true;
  for (let i = first + 1; i <= last; i++) {
    if (bars[i].startTime > bucketEnd(bars[i - 1].startTime, intervalMs)) return true;
  }
  return false;
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
          sources: bar.sources ? bar.sources.slice() : undefined,
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
    if (bar.sources?.length) {
      let targetSources = current.bar.sources;
      if (!targetSources) {
        current.bar.sources = bar.sources.slice();
      } else {
        for (let s = 0; s < bar.sources.length; s++) {
          const src = bar.sources[s];
          if (!targetSources.includes(src)) targetSources.push(src);
        }
      }
    }
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

/** Build the exact profile groups shared by the chart renderer and analysis snapshots. */
export function buildTpoProfileGroups(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
  period: TpoProfilePeriod,
  bracketMs: number,
  intervalMs: number,
  priceStep: number,
  valueAreaPercent = 0.7,
  mergeLeftSessionStarts: ReadonlySet<number> = new Set(),
): TpoProfileGroupSet {
  const [sessionFrom, sessionTo] = tpoSessionRange(bars, from, to, period, mergeLeftSessionStarts);
  const brackets = aggregateTpoBrackets(bars, sessionFrom, sessionTo, bracketMs);
  const spans = buildTpoBracketSpans(brackets, period);
  const groups = mergeTpoSessionSpans(spans, mergeLeftSessionStarts).map((group) => ({
    ...group,
    partial: tpoSessionPartial(bars, group.firstIdx, group.lastIdx, period, intervalMs),
    result: calculateTpoProfile(
      brackets.slice(group.firstBracketIndex, group.lastBracketIndex + 1).map((bracket) => bracket.bar),
      priceStep,
      valueAreaPercent,
    ),
  }));
  return { from: sessionFrom, to: sessionTo, brackets, groups };
}

function binAtOffset(refBin: number, priceStep: number, offset: number): number {
  return offset === 0 ? refBin : quantizeToStep(refBin + offset * priceStep, priceStep);
}

export function calculateTpoProfile(
  bars: readonly FootprintBar[],
  priceStep: number,
  valueAreaPercent = 0.7
): TpoProfileResult {
  let fromTime: number | null = null;
  let toTime: number | null = null;

  if (!(priceStep > 0) || !Number.isFinite(priceStep) || bars.length === 0) {
    return { levels: [], totalCount: 0, poc: null, vah: null, val: null, fromTime, toTime, truncated: false };
  }

  let refBin: number | null = null;
  const validBrackets: { bracketIndex: number; loIdx: number; hiIdx: number }[] = [];
  const events: { pos: number; delta: number }[] = [];

  for (let bracketIndex = 0; bracketIndex < bars.length; bracketIndex++) {
    const bar = bars[bracketIndex];
    fromTime = fromTime === null ? bar.startTime : Math.min(fromTime, bar.startTime);
    toTime = toTime === null ? bar.startTime : Math.max(toTime, bar.startTime);

    const lo = quantizeToStep(bar.low, priceStep);
    const hi = quantizeToStep(bar.high, priceStep);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue;
    if (refBin === null) refBin = lo;

    const loIdx = Math.round((lo - refBin) / priceStep);
    const spanBins = Math.round((hi - lo) / priceStep);
    const hiIdx = loIdx + spanBins;
    if (!Number.isSafeInteger(loIdx) || !Number.isSafeInteger(hiIdx) || spanBins < 0) continue;

    validBrackets.push({ bracketIndex, loIdx, hiIdx });
    events.push({ pos: loIdx, delta: 1 }, { pos: hiIdx + 1, delta: -1 });
  }

  if (refBin === null || events.length === 0) {
    return { levels: [], totalCount: 0, poc: null, vah: null, val: null, fromTime, toTime, truncated: false };
  }

  events.sort((a, b) => a.pos - b.pos);

  const runsInternal: { startIdx: number; endIdx: number; len: number; count: number; levelStart: number }[] = [];
  let activeCount = 0;
  let totalCount = 0;
  let totalBins = 0;
  let eventIdx = 0;
  while (eventIdx < events.length) {
    const pos = events[eventIdx].pos;
    while (eventIdx < events.length && events[eventIdx].pos === pos) {
      activeCount += events[eventIdx].delta;
      eventIdx++;
    }
    if (eventIdx < events.length && activeCount > 0) {
      const nextPos = events[eventIdx].pos;
      const len = nextPos - pos;
      if (len > 0) {
        totalCount += activeCount * len;
        runsInternal.push({ startIdx: pos, endIdx: nextPos - 1, len, count: activeCount, levelStart: totalBins });
        totalBins += len;
      }
    }
  }

  if (!runsInternal.length || totalCount <= 0) {
    return { levels: [], totalCount: 0, poc: null, vah: null, val: null, fromTime, toTime, truncated: false };
  }

  let pocRunIdx = 0;
  for (let i = 1; i < runsInternal.length; i++) {
    if (runsInternal[i].count > runsInternal[pocRunIdx].count) pocRunIdx = i;
  }

  const target = totalCount * clamp(valueAreaPercent, 0.5, 0.99);
  let lowRun = pocRunIdx;
  let lowOffset = 0;
  let highRun = pocRunIdx;
  let highOffset = 0;
  let included = runsInternal[pocRunIdx].count;

  while (included < target) {
    const below = lowOffset > 0
      ? runsInternal[lowRun].count
      : (lowRun > 0 ? runsInternal[lowRun - 1].count : -1);
    const above = highOffset < runsInternal[highRun].len - 1
      ? runsInternal[highRun].count
      : (highRun < runsInternal.length - 1 ? runsInternal[highRun + 1].count : -1);
    if (below < 0 && above < 0) break;

    if (above > below) {
      if (highOffset < runsInternal[highRun].len - 1) {
        const stepCount = runsInternal[highRun].count;
        const avail = runsInternal[highRun].len - 1 - highOffset;
        const take = Math.min(avail, Math.ceil((target - included) / stepCount));
        highOffset += take;
        included += take * stepCount;
      } else {
        highRun++;
        highOffset = 0;
        included += runsInternal[highRun].count;
      }
    } else {
      if (lowOffset > 0) {
        const stepCount = runsInternal[lowRun].count;
        const take = Math.min(lowOffset, Math.ceil((target - included) / stepCount));
        lowOffset -= take;
        included += take * stepCount;
      } else {
        lowRun--;
        lowOffset = runsInternal[lowRun].len - 1;
        included += runsInternal[lowRun].count;
      }
    }
  }

  const poc = binAtOffset(refBin, priceStep, runsInternal[pocRunIdx].startIdx);
  const val = binAtOffset(refBin, priceStep, runsInternal[lowRun].startIdx + lowOffset);
  const vah = binAtOffset(refBin, priceStep, runsInternal[highRun].startIdx + highOffset);

  const runs: TpoProfileRun[] = runsInternal.map((run) => ({
    startPrice: binAtOffset(refBin, priceStep, run.startIdx),
    endPrice: binAtOffset(refBin, priceStep, run.endIdx),
    count: run.count,
  }));

  const truncated = totalCount > MAX_TPO_LEVEL_ENTRIES;
  if (truncated) {
    return { levels: [], totalCount, poc, vah, val, fromTime, toTime, runs, truncated: true };
  }

  const levels = new Array<TpoProfileLevel>(totalBins);
  for (const run of runsInternal) {
    for (let k = 0; k < run.len; k++) {
      levels[run.levelStart + k] = {
        priceBin: binAtOffset(refBin, priceStep, run.startIdx + k),
        count: run.count,
        bracketIndices: [],
      };
    }
  }

  for (const { bracketIndex, loIdx, hiIdx } of validBrackets) {
    let lo = 0;
    let hi = runsInternal.length;
    while (lo < hi) {
      const mid = lo + ((hi - lo) >>> 1);
      if (runsInternal[mid].endIdx < loIdx) lo = mid + 1;
      else hi = mid;
    }
    for (let rIdx = lo; rIdx < runsInternal.length && runsInternal[rIdx].startIdx <= hiIdx; rIdx++) {
      const run = runsInternal[rIdx];
      const fromOff = Math.max(loIdx, run.startIdx) - run.startIdx;
      const toOff = Math.min(hiIdx, run.endIdx) - run.startIdx;
      for (let off = fromOff; off <= toOff; off++) {
        levels[run.levelStart + off].bracketIndices.push(bracketIndex);
      }
    }
  }

  return {
    levels,
    totalCount,
    poc,
    vah,
    val,
    fromTime,
    toTime,
    runs,
    truncated: false,
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

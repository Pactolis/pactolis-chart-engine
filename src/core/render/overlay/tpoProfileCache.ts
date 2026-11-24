import {
  aggregateTpoBrackets,
  calculateTpoProfile,
  effectiveTpoBracketMs,
  mergeTpoSessionSpans,
  tpoProfilePeriodMs,
  tpoSessionPartial,
  tpoSessionRange,
  type TpoBracketBar,
  type TpoProfileGroup,
  type TpoSessionSpan,
} from "../../analysis/tpoProfile.js";
import type { FootprintSeries } from "../../model/footprint.js";
import { incrementPerformanceCounter, isPerformanceTelemetryEnabled, recordPerformanceDuration } from "../../performanceTelemetry.js";
import { quantizeToStep } from "../../priceStep.js";
import type { ChartViewConfig } from "../../settings.js";
import { bucketEnd, bucketStart } from "../../time.js";
import type { FootprintBar } from "../../types.js";
import type { TpoCacheGroup, TpoCacheState } from "./tpoPaintHelpers.js";

type BarInput = Omit<FootprintBar, "cells">;

interface CachedGroup {
  firstIdx: number;
  sourceBars: readonly FootprintBar[];
  closedInputs: BarInput[];
  tailInput: BarInput | null;
  closedBrackets: TpoBracketBar[];
  tailBrackets: TpoBracketBar[];
  partial: boolean;
  result: TpoProfileGroup["result"];
}

interface TpoBracketBacking {
  readonly totalCount: number;
  readonly segments: readonly (readonly TpoBracketBar[])[];
  readonly offsets: readonly number[];
  flat?: TpoBracketBar[];
}

const bracketBackings = new WeakMap<TpoCacheState, TpoBracketBacking>();

export function getTpoCacheBracketCount(cache: TpoCacheState): number {
  const backing = bracketBackings.get(cache);
  return backing ? backing.totalCount : cache.brackets.length;
}

export function getTpoCacheBracket(cache: TpoCacheState, index: number): TpoBracketBar | undefined {
  const backing = bracketBackings.get(cache);
  if (!backing) return cache.brackets[index];
  if (index < 0 || index >= backing.totalCount) return undefined;
  const lastSeg = backing.segments.length - 1;
  if (lastSeg < 0) return undefined;
  if (index >= backing.offsets[lastSeg]) {
    return backing.segments[lastSeg][index - backing.offsets[lastSeg]];
  }
  let lo = 0;
  let hi = lastSeg;
  while (lo < hi) {
    const mid = lo + ((hi - lo + 1) >>> 1);
    if (backing.offsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return backing.segments[lo][index - backing.offsets[lo]];
}

function buildBracketBacking(entries: readonly CachedGroup[]): TpoBracketBacking {
  const segments: (readonly TpoBracketBar[])[] = [];
  const offsets: number[] = [];
  let totalCount = 0;
  for (const entry of entries) {
    if (entry.closedBrackets.length > 0) {
      offsets.push(totalCount);
      segments.push(entry.closedBrackets);
      totalCount += entry.closedBrackets.length;
    }
    if (entry.tailBrackets.length > 0) {
      offsets.push(totalCount);
      segments.push(entry.tailBrackets);
      totalCount += entry.tailBrackets.length;
    }
  }
  return { totalCount, segments, offsets };
}

function createTpoCacheState(key: string, groups: TpoCacheGroup[], backing: TpoBracketBacking): TpoCacheState {
  const state = { key, groups } as TpoCacheState;
  Object.defineProperty(state, "brackets", {
    enumerable: true,
    configurable: true,
    get() {
      if (!backing.flat) {
        const flat = new Array<TpoBracketBar>(backing.totalCount);
        let offset = 0;
        for (const segment of backing.segments) {
          for (let i = 0; i < segment.length; i++) flat[offset++] = segment[i];
        }
        backing.flat = flat;
      }
      return backing.flat;
    },
  });
  bracketBackings.set(state, backing);
  return state;
}

// Store only the previous render's visible groups without changing the exposed cache shape.
const groupCaches = new WeakMap<TpoCacheState, {
  series: FootprintSeries;
  structureRevision: number;
  nonTailRevision: number;
  settingsKey: string;
  bars: readonly FootprintBar[];
  barsLength: number;
  tailStartTime: number | undefined;
  first: number;
  end: number;
  floorFrom: number;
  ceilTo: number;
  mergeKey: string;
  groups: Map<string, CachedGroup>;
  groupEntries: CachedGroup[];
  groupIds: string[];
}>();

function bracketSessionSpans(
  bars: readonly FootprintBar[], from: number, to: number, sessionMs: number | null, bracketMs: number,
): TpoSessionSpan[] {
  if (from === to) return [];
  if (sessionMs === null) {
    return [{ sessionStart: bucketStart(bars[from].startTime, bracketMs), firstIdx: from, lastIdx: to - 1 }];
  }
  const spans: TpoSessionSpan[] = [];
  for (let first = from; first < to;) {
    const sessionStart = bucketStart(bucketStart(bars[first].startTime, bracketMs), sessionMs);
    const sessionEnd = bucketEnd(sessionStart, sessionMs);
    // A bracket can cross a session boundary. Its entire input belongs to the session in which it starts.
    const boundaryBracket = bucketStart(sessionEnd, bracketMs);
    const nextSession = boundaryBracket === sessionEnd ? sessionEnd : bucketEnd(boundaryBracket, bracketMs);
    let low = first + 1;
    let high = to;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (bars[mid].startTime < nextSession) low = mid + 1;
      else high = mid;
    }
    spans.push({ sessionStart, firstIdx: first, lastIdx: low - 1 });
    first = low;
  }
  return spans;
}

function sameBracketMetadata(saved: BarInput, bar: FootprintBar, checkShape: boolean): boolean {
  if (!Object.is(saved.volume, bar.volume) || !Object.is(saved.delta, bar.delta) || saved.count !== bar.count
    || saved.hasRef !== bar.hasRef || saved.completeness !== bar.completeness || saved.deltaBySize !== bar.deltaBySize
    || !Object.is(saved.liquidationBuyVol, bar.liquidationBuyVol) || !Object.is(saved.liquidationSellVol, bar.liquidationSellVol)
    || saved.updatedAt !== bar.updatedAt || saved.cellRevision !== bar.cellRevision) return false;
  const sources = saved.sources;
  if (sources?.length !== bar.sources?.length) return false;
  if (sources && !sources.every((source, index) => source === bar.sources?.[index])) return false;
  if (!checkShape) return true;

  // The first bar is spread into its bracket. A historical replacement can add
  // or remove an own property even if the corresponding field reads as undefined.
  const keys = Object.keys(saved) as (keyof BarInput)[];
  return Object.keys(bar).length === keys.length + 1
    && keys.every((key) => Object.hasOwn(bar, key) && (key === "sources" || Object.is(bar[key], saved[key])));
}

function groupChanges(
  cached: CachedGroup | undefined, bars: readonly FootprintBar[], first: number, last: number, structureChanged: boolean,
): "profile" | "brackets" | "none" {
  const expectedLen = last - first + 1;
  const cachedLen = cached ? cached.closedInputs.length + (cached.tailInput ? 1 : 0) : 0;
  if (!cached || cached.firstIdx !== first || cachedLen !== expectedLen) return "profile";
  let sameMetadata = true;
  for (let index = first; index <= last; index++) {
    const bar = bars[index];
    const localIndex = index - first;
    const saved = localIndex < cached.closedInputs.length ? cached.closedInputs[localIndex] : cached.tailInput!;
    if (saved.startTime !== bar.startTime || !Object.is(saved.high, bar.high) || !Object.is(saved.low, bar.low)) {
      return "profile";
    }
    if (sameMetadata && (
      !Object.is(saved.open, bar.open)
      || !Object.is(saved.close, bar.close)
      || !sameBracketMetadata(saved, bar, structureChanged || cached.sourceBars[localIndex] !== bar)
    )) {
      sameMetadata = false;
    }
  }
  return sameMetadata ? "none" : "brackets";
}

function snapshotSingleInput(bar: FootprintBar): BarInput {
  const { cells: _cells, ...input } = bar;
  if (input.sources) input.sources = [...input.sources];
  return input;
}

function snapshotInputs(bars: readonly FootprintBar[], first: number, last: number): BarInput[] {
  const inputs: BarInput[] = [];
  for (let index = first; index <= last; index++) {
    inputs.push(snapshotSingleInput(bars[index]));
  }
  return inputs;
}

function collectBracketBars(closedBrackets: readonly TpoBracketBar[], tailBrackets: readonly TpoBracketBar[]): FootprintBar[] {
  const result = new Array<FootprintBar>(closedBrackets.length + tailBrackets.length);
  let idx = 0;
  for (let i = 0; i < closedBrackets.length; i++) result[idx++] = closedBrackets[i].bar;
  for (let i = 0; i < tailBrackets.length; i++) result[idx++] = tailBrackets[i].bar;
  return result;
}

export function updateTpoProfileCache(
  previous: TpoCacheState | null, series: FootprintSeries, [from, to]: [number, number],
  { tpoProfilePeriod: period, tpoBracketSize: bracketSize }: Pick<ChartViewConfig, "tpoProfilePeriod" | "tpoBracketSize">,
  vaPercent: number, mergeLeft: ReadonlySet<number>,
): TpoCacheState {
  const bars = series.listReadonly();
  const { intervalMs, priceStep } = series.config;
  const bracketMs = effectiveTpoBracketMs(bracketSize, intervalMs);
  const { structureRevision, nonTailRevision } = series;
  const settingsKey = `${vaPercent}|${priceStep}|${period}|${bracketSize}|${bracketMs}|${intervalMs}`;
  const mergeKey = mergeLeft.size === 0 ? ""
    : mergeLeft.size === 1 ? String(mergeLeft.values().next().value)
    : [...mergeLeft].sort((a, b) => a - b).join("|");
  const floorFrom = Math.floor(from);
  const ceilTo = Math.ceil(to);
  const lastBarIdx = bars.length - 1;
  const tailStartTime = lastBarIdx >= 0 ? bars[lastBarIdx]?.startTime : undefined;

  const prior = previous ? groupCaches.get(previous) : undefined;
  const reusable = prior?.series === series && prior.settingsKey === settingsKey ? prior.groups : undefined;
  const structureChanged = prior?.structureRevision !== structureRevision;
  // Historical trades and OHLC reassertions can mutate a bar without replacing it.
  const closedBarsUnchanged = !structureChanged && typeof nonTailRevision === "number"
    && prior?.nonTailRevision === nonTailRevision;

  const sameSeriesContext = closedBarsUnchanged
    && prior !== undefined
    && prior.series === series
    && prior.bars === bars
    && prior.barsLength === bars.length
    && prior.tailStartTime === tailStartTime
    && prior.settingsKey === settingsKey
    && prior.mergeKey === mergeKey;

  const sameSessionBounds = sameSeriesContext && (
    (prior.floorFrom === floorFrom && prior.ceilTo === ceilTo)
    || (
      period !== "visible"
      && previous !== null
      && previous.groups.length > 0
      && floorFrom < ceilTo
      && floorFrom >= prior.first
      && ceilTo <= prior.end
      && floorFrom <= previous.groups[0].lastIdx
      && (ceilTo - 1) >= previous.groups[previous.groups.length - 1].firstIdx
    )
  );
  const cachedBounds = sameSessionBounds ? prior : undefined;

  const [first, end] = cachedBounds
    ? [cachedBounds.first, cachedBounds.end]
    : tpoSessionRange(bars, from, to, period, mergeLeft);
  const key = mergeKey
    ? `${settingsKey}|${series.revision}|${structureRevision}|${first}|${end}|${mergeKey}`
    : `${settingsKey}|${series.revision}|${structureRevision}|${first}|${end}`;
  if (reusable && previous?.key === key) return previous;

  const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
  let computedGroups = 0;
  let skippedGroups = 0;

  if (
    cachedBounds
    && first === cachedBounds.first
    && end === cachedBounds.end
    && bars.length > 0
    && previous !== null
    && previous.groups.length > 0
    && previous.groups.length === cachedBounds.groupEntries.length
    && previous.groups.length === cachedBounds.groupIds.length
    && previous.groups[previous.groups.length - 1].lastIdx === lastBarIdx
  ) {
    const prevGroups = previous.groups;
    const closedCount = prevGroups.length - 1;
    let fastOk = true;
    for (let gi = 0; gi < closedCount; gi++) {
      const g = prevGroups[gi];
      const entry = cachedBounds.groupEntries[gi];
      const len = g.lastIdx - g.firstIdx + 1;
      if (
        g.lastIdx >= lastBarIdx
        || len <= 0
        || entry.firstIdx !== g.firstIdx
        || entry.sourceBars.length !== len
        || entry.sourceBars[0] !== bars[g.firstIdx]
        || entry.sourceBars[len - 1] !== bars[g.lastIdx]
      ) {
        fastOk = false;
        break;
      }
    }
    const lastPrevGroup = prevGroups[closedCount];
    const cachedTail = cachedBounds.groupEntries[closedCount];
    const tailLen = lastBarIdx - lastPrevGroup.firstIdx + 1;
    const cachedTailInputLen = cachedTail.closedInputs.length + (cachedTail.tailInput ? 1 : 0);
    const lastCachedBracket = cachedTail.tailBrackets[cachedTail.tailBrackets.length - 1];
    if (
      fastOk
      && (
        tailLen <= 0
        || cachedTail.firstIdx !== lastPrevGroup.firstIdx
        || cachedTail.sourceBars.length !== tailLen
        || cachedTailInputLen !== tailLen
        || cachedTail.tailBrackets.length === 0
        || cachedTail.sourceBars[0] !== bars[lastPrevGroup.firstIdx]
        || cachedTail.sourceBars[tailLen - 1] !== bars[lastBarIdx]
        || !lastCachedBracket
        || lastCachedBracket.firstIdx < cachedTail.firstIdx
        || lastCachedBracket.lastIdx !== lastBarIdx
        || lastPrevGroup.lastBracketIndex !== getTpoCacheBracketCount(previous) - 1
      )
    ) {
      fastOk = false;
    }

    if (fastOk) {
      if (startedAt !== null) skippedGroups += closedCount;
      const tailBar = bars[lastBarIdx];
      const savedTail = cachedTail.tailInput;
      const tailChanged = !savedTail
        || savedTail.startTime !== tailBar.startTime
        || !Object.is(savedTail.high, tailBar.high)
        || !Object.is(savedTail.low, tailBar.low)
        || !Object.is(savedTail.open, tailBar.open)
        || !Object.is(savedTail.close, tailBar.close)
        || !sameBracketMetadata(savedTail, tailBar, false);

      if (!tailChanged) {
        const prevBacking = bracketBackings.get(previous) ?? buildBracketBacking(cachedBounds.groupEntries);
        const state = createTpoCacheState(key, previous.groups, prevBacking);
        groupCaches.set(state, {
          series,
          structureRevision,
          nonTailRevision,
          settingsKey,
          bars,
          barsLength: bars.length,
          tailStartTime,
          first,
          end,
          floorFrom,
          ceilTo,
          mergeKey,
          groups: cachedBounds.groups,
          groupEntries: cachedBounds.groupEntries,
          groupIds: cachedBounds.groupIds,
        });
        if (startedAt !== null) {
          incrementPerformanceCounter("chart.tpo.compute.groups", computedGroups);
          incrementPerformanceCounter("chart.tpo.cache.skippedGroups", skippedGroups);
          recordPerformanceDuration("chart.tpo.compute.ms", performance.now() - startedAt);
        }
        return state;
      }

      const tailBrackets = aggregateTpoBrackets(bars, lastCachedBracket.firstIdx, lastBarIdx + 1, bracketMs);
      const quantizeChanged = tailBrackets.length > 0 && (
        priceStep > 0
          ? (
              quantizeToStep(tailBrackets[0].bar.high, priceStep) !== quantizeToStep(lastCachedBracket.bar.high, priceStep)
              || quantizeToStep(tailBrackets[0].bar.low, priceStep) !== quantizeToStep(lastCachedBracket.bar.low, priceStep)
            )
          : (
              !Object.is(tailBrackets[0].bar.high, lastCachedBracket.bar.high)
              || !Object.is(tailBrackets[0].bar.low, lastCachedBracket.bar.low)
            )
      );
      const recompute = !savedTail
        || savedTail.startTime !== tailBar.startTime
        || tailBrackets.length !== 1
        || tailBrackets[0].bar.startTime !== lastCachedBracket.bar.startTime
        || quantizeChanged;

      const nextClosedBrackets = tailBrackets.length <= 1
        ? cachedTail.closedBrackets
        : cachedTail.closedBrackets.concat(tailBrackets.slice(0, -1));
      const nextTailBrackets = tailBrackets.length <= 1
        ? tailBrackets
        : [tailBrackets[tailBrackets.length - 1]];

      const result = recompute
        ? calculateTpoProfile(collectBracketBars(nextClosedBrackets, nextTailBrackets), priceStep, vaPercent)
        : cachedTail.result;
      if (startedAt !== null && recompute) computedGroups++;

      const tailEntry: CachedGroup = {
        firstIdx: cachedTail.firstIdx,
        sourceBars: cachedTail.sourceBars,
        closedInputs: cachedTail.closedInputs,
        tailInput: snapshotSingleInput(tailBar),
        closedBrackets: nextClosedBrackets,
        tailBrackets: nextTailBrackets,
        partial: cachedTail.partial,
        result,
      };
      const nextEntries = cachedBounds.groupEntries.slice();
      nextEntries[closedCount] = tailEntry;
      const nextBacking = buildBracketBacking(nextEntries);
      const nextGroups = prevGroups.slice();
      nextGroups[closedCount] = {
        ...lastPrevGroup,
        firstBracketIndex: lastPrevGroup.firstBracketIndex,
        lastBracketIndex: nextBacking.totalCount - 1,
        partial: tailEntry.partial,
        result: tailEntry.result,
      };
      const nextMap = new Map(cachedBounds.groups);
      nextMap.set(cachedBounds.groupIds[closedCount], tailEntry);
      const state = createTpoCacheState(key, nextGroups, nextBacking);
      groupCaches.set(state, {
        series,
        structureRevision,
        nonTailRevision,
        settingsKey,
        bars,
        barsLength: bars.length,
        tailStartTime,
        first,
        end,
        floorFrom,
        ceilTo,
        mergeKey,
        groups: nextMap,
        groupEntries: nextEntries,
        groupIds: cachedBounds.groupIds,
      });
      if (startedAt !== null) {
        incrementPerformanceCounter("chart.tpo.compute.groups", computedGroups);
        incrementPerformanceCounter("chart.tpo.cache.skippedGroups", skippedGroups);
        recordPerformanceDuration("chart.tpo.compute.ms", performance.now() - startedAt);
      }
      return state;
    }
  }

  const spans = bracketSessionSpans(bars, first, end, tpoProfilePeriodMs(period), bracketMs);
  const groups = new Map<string, CachedGroup>();
  const groupEntries: CachedGroup[] = [];
  const groupIds: string[] = [];
  const stateGroups: TpoCacheGroup[] = [];
  let bracketCount = 0;
  for (const group of mergeTpoSessionSpans(spans, mergeLeft)) {
    const { firstIdx, lastIdx, sessionStarts } = group;
    const id = sessionStarts.join("|");
    const cached = reusable?.get(id);
    const skip = closedBarsUnchanged && lastIdx < lastBarIdx
      && cached?.firstIdx === firstIdx && cached.sourceBars.length === lastIdx - firstIdx + 1
      && cached.sourceBars.every((bar, index) => bar === bars[firstIdx + index]);
    const changes = skip ? "none" : groupChanges(cached, bars, firstIdx, lastIdx, structureChanged);
    if (startedAt !== null && skip) skippedGroups++;
    let entry = cached;
    if (!entry || changes !== "none") {
      const brackets = aggregateTpoBrackets(bars, firstIdx, lastIdx + 1, bracketMs);
      // Brackets copy trade metadata too. Volume-only updates refresh that copy without recalculating the profile.
      const recompute = !cached || changes === "profile";
      const closedBrackets = brackets.length > 1 ? brackets.slice(0, -1) : [];
      const tailBrackets = brackets.length > 0 ? [brackets[brackets.length - 1]] : [];
      entry = {
        firstIdx,
        sourceBars: bars.slice(firstIdx, lastIdx + 1),
        closedInputs: snapshotInputs(bars, firstIdx, lastIdx - 1),
        tailInput: lastIdx >= firstIdx ? snapshotSingleInput(bars[lastIdx]) : null,
        closedBrackets,
        tailBrackets,
        partial: recompute ? tpoSessionPartial(bars, firstIdx, lastIdx, period, intervalMs) : cached.partial,
        result: recompute ? calculateTpoProfile(brackets.map(({ bar }) => bar), priceStep, vaPercent) : cached.result,
      };
      if (startedAt !== null && recompute) computedGroups++;
    } else if (structureChanged) {
      // A history refresh can replace equal bars. Keep the validated references for the next tick.
      entry = { ...entry, sourceBars: bars.slice(firstIdx, lastIdx + 1) };
    }
    groups.set(id, entry);
    groupEntries.push(entry);
    groupIds.push(id);
    const firstBracketIndex = bracketCount;
    bracketCount += entry.closedBrackets.length + entry.tailBrackets.length;
    stateGroups.push({
      ...group,
      firstBracketIndex,
      lastBracketIndex: bracketCount - 1,
      partial: entry.partial,
      result: entry.result,
    });
  }
  const state = createTpoCacheState(key, stateGroups, buildBracketBacking(groupEntries));
  groupCaches.set(state, {
    series,
    structureRevision,
    nonTailRevision,
    settingsKey,
    bars,
    barsLength: bars.length,
    tailStartTime,
    first,
    end,
    floorFrom,
    ceilTo,
    mergeKey,
    groups,
    groupEntries,
    groupIds,
  });
  if (startedAt !== null) {
    incrementPerformanceCounter("chart.tpo.compute.groups", computedGroups);
    incrementPerformanceCounter("chart.tpo.cache.skippedGroups", skippedGroups);
    recordPerformanceDuration("chart.tpo.compute.ms", performance.now() - startedAt);
  }
  return state;
}

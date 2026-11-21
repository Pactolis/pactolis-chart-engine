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
import type { ChartViewConfig } from "../../settings.js";
import { bucketEnd, bucketStart } from "../../time.js";
import type { FootprintBar } from "../../types.js";
import type { TpoCacheState } from "./tpoPaintHelpers.js";

type BarInput = Omit<FootprintBar, "cells">;

interface CachedGroup {
  firstIdx: number;
  sourceBars: readonly FootprintBar[];
  inputs: BarInput[];
  brackets: TpoBracketBar[];
  partial: boolean;
  result: TpoProfileGroup["result"];
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
  if (cached?.firstIdx !== first || cached.inputs.length !== last - first + 1) return "profile";
  let sameMetadata = true;
  for (let index = first; index <= last; index++) {
    const bar = bars[index];
    const localIndex = index - first;
    const saved = cached.inputs[localIndex];
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

function snapshotInputs(bars: readonly FootprintBar[], first: number, last: number): BarInput[] {
  const inputs: BarInput[] = [];
  for (let index = first; index <= last; index++) {
    const { cells: _cells, ...input } = bars[index];
    if (input.sources) input.sources = [...input.sources];
    inputs.push(input);
  }
  return inputs;
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

  const sameSessionBounds = closedBarsUnchanged
    && prior !== undefined
    && prior.series === series
    && prior.bars === bars
    && prior.barsLength === bars.length
    && prior.tailStartTime === tailStartTime
    && prior.settingsKey === settingsKey
    && prior.mergeKey === mergeKey
    && prior.floorFrom === floorFrom
    && prior.ceilTo === ceilTo;
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
    const lastCachedBracket = cachedTail.brackets[cachedTail.brackets.length - 1];
    if (
      fastOk
      && (
        tailLen <= 0
        || cachedTail.firstIdx !== lastPrevGroup.firstIdx
        || cachedTail.sourceBars.length !== tailLen
        || cachedTail.inputs.length !== tailLen
        || cachedTail.brackets.length === 0
        || cachedTail.sourceBars[0] !== bars[lastPrevGroup.firstIdx]
        || cachedTail.sourceBars[tailLen - 1] !== bars[lastBarIdx]
        || !lastCachedBracket
        || lastCachedBracket.firstIdx < cachedTail.firstIdx
        || lastCachedBracket.lastIdx !== lastBarIdx
        || lastPrevGroup.lastBracketIndex !== previous.brackets.length - 1
      )
    ) {
      fastOk = false;
    }

    if (fastOk) {
      if (startedAt !== null) skippedGroups += closedCount;
      const localIndex = tailLen - 1;
      const tailBar = bars[lastBarIdx];
      const savedTail = cachedTail.inputs[localIndex];
      let tailChanges: "profile" | "brackets" | "none" = "none";
      if (savedTail.startTime !== tailBar.startTime || !Object.is(savedTail.high, tailBar.high) || !Object.is(savedTail.low, tailBar.low)) {
        tailChanges = "profile";
      } else if (
        !Object.is(savedTail.open, tailBar.open)
        || !Object.is(savedTail.close, tailBar.close)
        || !sameBracketMetadata(savedTail, tailBar, false)
      ) {
        tailChanges = "brackets";
      }

      if (tailChanges === "none") {
        const state: TpoCacheState = { key, brackets: previous.brackets, groups: previous.groups };
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
      const brackets = cachedTail.brackets.length === 1
        ? tailBrackets
        : [...cachedTail.brackets.slice(0, -1), ...tailBrackets];
      const inputs = cachedTail.inputs.slice();
      const { cells: _cells, ...tailInput } = tailBar;
      if (tailInput.sources) tailInput.sources = [...tailInput.sources];
      inputs[localIndex] = tailInput;
      const recompute = tailChanges === "profile";
      const result = recompute
        ? calculateTpoProfile(brackets.map(({ bar }) => bar), priceStep, vaPercent)
        : cachedTail.result;
      if (startedAt !== null && recompute) computedGroups++;

      const tailEntry: CachedGroup = {
        firstIdx: cachedTail.firstIdx,
        brackets,
        sourceBars: cachedTail.sourceBars,
        inputs,
        partial: cachedTail.partial,
        result,
      };
      const nextBrackets = tailBrackets.length === 1
        ? (() => {
            const copied = previous.brackets.slice();
            copied[copied.length - 1] = tailBrackets[0];
            return copied;
          })()
        : [
            ...previous.brackets.slice(0, previous.brackets.length - 1),
            ...tailBrackets,
          ];
      const nextGroups = prevGroups.slice();
      nextGroups[closedCount] = {
        ...lastPrevGroup,
        firstBracketIndex: lastPrevGroup.firstBracketIndex,
        lastBracketIndex: nextBrackets.length - 1,
        partial: tailEntry.partial,
        result: tailEntry.result,
      };
      const nextEntries = cachedBounds.groupEntries.slice();
      nextEntries[closedCount] = tailEntry;
      const nextMap = new Map(cachedBounds.groups);
      nextMap.set(cachedBounds.groupIds[closedCount], tailEntry);
      const state: TpoCacheState = { key, brackets: nextBrackets, groups: nextGroups };
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
  const state: TpoCacheState = { key, brackets: [], groups: [] };
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
      entry = {
        firstIdx,
        brackets,
        sourceBars: bars.slice(firstIdx, lastIdx + 1),
        inputs: snapshotInputs(bars, firstIdx, lastIdx),
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
    const firstBracketIndex = state.brackets.length;
    for (const bracket of entry.brackets) state.brackets.push(bracket);
    state.groups.push({
      ...group,
      firstBracketIndex,
      lastBracketIndex: state.brackets.length - 1,
      partial: entry.partial,
      result: entry.result,
    });
  }
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

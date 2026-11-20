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
  inputs: BarInput[];
  brackets: TpoBracketBar[];
  partial: boolean;
  result: TpoProfileGroup["result"];
}

// Store only the previous render's visible groups without changing the exposed cache shape.
const groupCaches = new WeakMap<TpoCacheState, { series: FootprintSeries; settingsKey: string; groups: Map<string, CachedGroup> }>();

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

function sameBracketMetadata(saved: BarInput, bar: FootprintBar): boolean {
  if (!Object.is(saved.volume, bar.volume) || !Object.is(saved.delta, bar.delta) || saved.count !== bar.count
    || saved.hasRef !== bar.hasRef || saved.completeness !== bar.completeness || saved.deltaBySize !== bar.deltaBySize
    || !Object.is(saved.liquidationBuyVol, bar.liquidationBuyVol) || !Object.is(saved.liquidationSellVol, bar.liquidationSellVol)
    || saved.updatedAt !== bar.updatedAt || saved.cellRevision !== bar.cellRevision) return false;
  const sources = saved.sources;
  if (sources?.length !== bar.sources?.length) return false;
  return !sources || sources.every((source, index) => source === bar.sources?.[index]);
}

function groupChanges(cached: CachedGroup | undefined, bars: readonly FootprintBar[], first: number, last: number): "profile" | "brackets" | "none" {
  if (cached?.firstIdx !== first || cached.inputs.length !== last - first + 1) return "profile";
  let sameMetadata = true;
  for (let index = first; index <= last; index++) {
    const bar = bars[index];
    const saved = cached.inputs[index - first];
    if (saved.startTime !== bar.startTime || !Object.is(saved.open, bar.open) || !Object.is(saved.high, bar.high)
      || !Object.is(saved.low, bar.low) || !Object.is(saved.close, bar.close)) return "profile";
    if (sameMetadata && !sameBracketMetadata(saved, bar)) sameMetadata = false;
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
  const [first, end] = tpoSessionRange(bars, from, to, period, mergeLeft);
  const settingsKey = [vaPercent, priceStep, period, bracketSize, bracketMs, intervalMs].join("|");
  const key = [settingsKey, series.revision, series.structureRevision, first, end, ...[...mergeLeft].sort((a, b) => a - b)].join("|");
  const prior = previous ? groupCaches.get(previous) : undefined;
  const reusable = prior?.series === series && prior.settingsKey === settingsKey ? prior.groups : undefined;
  if (reusable && previous?.key === key) return previous;

  const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
  let computedGroups = 0;
  const spans = bracketSessionSpans(bars, first, end, tpoProfilePeriodMs(period), bracketMs);
  const groups = new Map<string, CachedGroup>();
  const state: TpoCacheState = { key, brackets: [], groups: [] };
  for (const group of mergeTpoSessionSpans(spans, mergeLeft)) {
    const { firstIdx, lastIdx, sessionStarts } = group;
    const id = sessionStarts.join("|");
    const cached = reusable?.get(id);
    const changes = groupChanges(cached, bars, firstIdx, lastIdx);
    let entry = cached;
    if (!entry || changes !== "none") {
      const brackets = aggregateTpoBrackets(bars, firstIdx, lastIdx + 1, bracketMs);
      // Brackets copy trade metadata too. Volume-only updates refresh that copy without recalculating the profile.
      const recompute = !cached || changes === "profile";
      entry = {
        firstIdx,
        brackets,
        inputs: snapshotInputs(bars, firstIdx, lastIdx),
        partial: recompute ? tpoSessionPartial(bars, firstIdx, lastIdx, period, intervalMs) : cached.partial,
        result: recompute ? calculateTpoProfile(brackets.map(({ bar }) => bar), priceStep, vaPercent) : cached.result,
      };
      if (startedAt !== null && recompute) computedGroups++;
    }
    groups.set(id, entry);
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
  groupCaches.set(state, { series, settingsKey, groups });
  if (startedAt !== null) {
    incrementPerformanceCounter("chart.tpo.compute.groups", computedGroups);
    recordPerformanceDuration("chart.tpo.compute.ms", performance.now() - startedAt);
  }
  return state;
}

import type { FootprintSeries } from "../../../core/model/footprint.js";
import { incrementPerformanceCounter } from "../../../core/performanceTelemetry.js";
import type { IndicatorDrawContext, IndicatorSettings } from "../types.js";

/**
 * Shared incremental-state cache for indicators whose full-series values are expensive but
 * whose live ticks only change the series tail (#128).
 *
 * The cached state is valid while structureRevision and nonTailRevision are unchanged and
 * the bar count is the same: nothing but the tail bar can differ then. A different series
 * revision means the tail moved, so `advance` re-computes only the last index. A pan changes
 * neither revision, so the cached values are reused and only geometry is rebuilt. Anything
 * else (settings, history load, new bar, trimmed bars) calls `build`, the full computation.
 */
export interface IncrementalBase {
  configKey: string;
  structureRevision: number;
  nonTailRevision: number;
  seriesRevision: number;
  length: number;
}

const caches = new Map<string, WeakMap<FootprintSeries, Map<string, IncrementalBase>>>();

export function resolveIncremental<S extends IncrementalBase>(
  kind: string,
  ctx: IndicatorDrawContext<IndicatorSettings>,
  configKey: string,
  build: () => Omit<S, keyof IncrementalBase>,
  advance: (state: S) => boolean,
): S {
  const { series } = ctx;
  let byKind = caches.get(kind);
  if (!byKind) { byKind = new WeakMap(); caches.set(kind, byKind); }
  let perSeries = byKind.get(series);
  if (!perSeries) { perSeries = new Map(); byKind.set(series, perSeries); }
  const length = series.listReadonly().length;
  const cached = perSeries.get(ctx.instance.id) as S | undefined;
  if (
    cached && length > 0
    && cached.configKey === configKey
    && cached.structureRevision === series.structureRevision
    && cached.nonTailRevision === series.nonTailRevision
    && cached.length === length
  ) {
    if (cached.seriesRevision === series.revision) {
      incrementPerformanceCounter(`indicator.incremental.hit.${kind}`);
      return cached;
    }
    if (advance(cached)) {
      cached.seriesRevision = series.revision;
      incrementPerformanceCounter(`indicator.incremental.hit.${kind}`);
      return cached;
    }
  }
  const state = { ...build(), configKey, structureRevision: series.structureRevision, nonTailRevision: series.nonTailRevision, seriesRevision: series.revision, length } as S;
  perSeries.set(ctx.instance.id, state);
  incrementPerformanceCounter(`indicator.incremental.full.${kind}`);
  return state;
}

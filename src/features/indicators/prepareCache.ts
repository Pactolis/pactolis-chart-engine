export interface IndicatorPrepareCacheKey {
  definitionType: string;
  instance: object;
  series: { readonly revision: number };
  rangeFrom: number;
  rangeTo: number;
  market: string;
  timeframe: string;
  intervalMs: number;
  timeBucket?: number;
}

interface CacheEntry<T> {
  definitionType: string;
  instance: object;
  series: IndicatorPrepareCacheKey["series"];
  seriesRevision: number;
  rangeFrom: number;
  rangeTo: number;
  market: string;
  timeframe: string;
  intervalMs: number;
  timeBucket: number;
  value: T;
}

/**
 * Cache for indicator preparation functions that are explicitly declared pure
 * with respect to the series revision, visible range, instance settings and
 * chart identity. Impure/external/crosshair-dependent indicators never use it.
 *
 * By default it keeps one entry per instance. A cache whose callers alternate
 * between a few ranges of the same data (analysis reads of the closed bars
 * and of the visible range) can keep up to `rangesPerInstance` of them; any
 * entry from older data is dropped as soon as a newer one is stored.
 */
export class IndicatorPrepareCache {
  private readonly entries = new Map<string, CacheEntry<unknown>[]>();

  constructor(private readonly rangesPerInstance = 1) {}

  resolve<T>(instanceId: string, key: IndicatorPrepareCacheKey, compute: () => T): T {
    const cached = (this.entries.get(instanceId) ?? []) as CacheEntry<T>[];
    const hit = cached.find((entry) => sameKey(entry, key));
    if (hit) return hit.value;

    const value = compute();
    const entry: CacheEntry<T> = {
      definitionType: key.definitionType,
      instance: key.instance,
      series: key.series,
      seriesRevision: key.series.revision,
      rangeFrom: key.rangeFrom,
      rangeTo: key.rangeTo,
      market: key.market,
      timeframe: key.timeframe,
      intervalMs: key.intervalMs,
      timeBucket: key.timeBucket ?? 0,
      value,
    };
    const kept = cached.filter((other) => sameData(other, entry)).slice(0, this.rangesPerInstance - 1);
    this.entries.set(instanceId, [entry, ...kept]);
    return value;
  }

  delete(instanceId: string): void {
    this.entries.delete(instanceId);
  }

  clear(): void {
    this.entries.clear();
  }
}

function sameData(a: CacheEntry<unknown>, b: CacheEntry<unknown>): boolean {
  return a.definitionType === b.definitionType
    && a.instance === b.instance
    && a.series === b.series
    && a.seriesRevision === b.seriesRevision
    && a.market === b.market
    && a.timeframe === b.timeframe
    && a.intervalMs === b.intervalMs
    && a.timeBucket === b.timeBucket;
}

function sameKey<T>(cached: CacheEntry<T>, key: IndicatorPrepareCacheKey): boolean {
  return cached.definitionType === key.definitionType
    && cached.instance === key.instance
    && cached.series === key.series
    && cached.seriesRevision === key.series.revision
    && cached.rangeFrom === key.rangeFrom
    && cached.rangeTo === key.rangeTo
    && cached.market === key.market
    && cached.timeframe === key.timeframe
    && cached.intervalMs === key.intervalMs
    && cached.timeBucket === (key.timeBucket ?? 0);
}

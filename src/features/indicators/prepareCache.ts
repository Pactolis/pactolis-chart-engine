export interface IndicatorPrepareCacheKey {
  definitionType: string;
  instance: object;
  series: {
    readonly revision: number;
    readonly nonTailRevision?: number;
    readonly resetEpoch?: number;
  };
  rangeFrom: number;
  rangeTo: number;
  market: string;
  timeframe: string;
  intervalMs: number;
  timeBucket?: number;
  generation?: number;
  nonTailRevision?: number;
  resetEpoch?: number;
  settingsRevision?: number;
}

export type IndicatorPrepareCacheInvalidationKind = "hit" | "tail" | "non-tail" | "cold";

interface CacheEntry<T> {
  definitionType: string;
  instance: object;
  series: IndicatorPrepareCacheKey["series"];
  seriesRevision: number;
  nonTailRevision: number;
  resetEpoch: number;
  generation: number;
  settingsRevision: number;
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

  peek<T>(instanceId: string, key: IndicatorPrepareCacheKey): T | undefined {
    const cached = (this.entries.get(instanceId) ?? []) as CacheEntry<T>[];
    const hit = cached.find((entry) => sameKey(entry, key));
    return hit ? hit.value : undefined;
  }

  store<T>(instanceId: string, key: IndicatorPrepareCacheKey, value: T): T {
    const cached = (this.entries.get(instanceId) ?? []) as CacheEntry<T>[];
    const entry: CacheEntry<T> = {
      definitionType: key.definitionType,
      instance: key.instance,
      series: key.series,
      seriesRevision: key.series.revision,
      nonTailRevision: resolveNonTailRevision(key),
      resetEpoch: resolveResetEpoch(key),
      generation: key.generation ?? 0,
      settingsRevision: key.settingsRevision ?? 0,
      rangeFrom: key.rangeFrom,
      rangeTo: key.rangeTo,
      market: key.market,
      timeframe: key.timeframe,
      intervalMs: key.intervalMs,
      timeBucket: key.timeBucket ?? 0,
      value,
    };
    const kept = cached
      .filter((other) => sameData(other, entry) && !(other.rangeFrom === entry.rangeFrom && other.rangeTo === entry.rangeTo))
      .slice(0, this.rangesPerInstance - 1);
    this.entries.set(instanceId, [entry, ...kept]);
    return value;
  }

  classifyInvalidation(instanceId: string, key: IndicatorPrepareCacheKey): IndicatorPrepareCacheInvalidationKind {
    const cached = this.entries.get(instanceId);
    if (!cached || cached.length === 0) return "cold";
    if (cached.some((entry) => sameKey(entry, key))) return "hit";

    const nextResetEpoch = resolveResetEpoch(key);
    const nextGeneration = key.generation ?? 0;
    const nextSettingsRevision = key.settingsRevision ?? 0;
    const nextTimeBucket = key.timeBucket ?? 0;
    const nextNonTailRevision = resolveNonTailRevision(key);

    const compatible = cached.find((entry) =>
      entry.definitionType === key.definitionType
      && entry.instance === key.instance
      && entry.series === key.series
      && entry.resetEpoch === nextResetEpoch
      && entry.generation === nextGeneration
      && entry.settingsRevision === nextSettingsRevision
      && entry.market === key.market
      && entry.timeframe === key.timeframe
      && entry.intervalMs === key.intervalMs
      && entry.timeBucket === nextTimeBucket,
    );
    if (!compatible) return "cold";
    if (compatible.nonTailRevision !== nextNonTailRevision) return "non-tail";
    if (compatible.seriesRevision !== key.series.revision) return "tail";
    return "non-tail";
  }

  resolve<T>(instanceId: string, key: IndicatorPrepareCacheKey, compute: () => T): T {
    const cached = (this.entries.get(instanceId) ?? []) as CacheEntry<T>[];
    const hit = cached.find((entry) => sameKey(entry, key));
    if (hit) return hit.value;

    const value = compute();
    return this.store(instanceId, key, value);
  }

  delete(instanceId: string): void {
    this.entries.delete(instanceId);
  }

  clear(): void {
    this.entries.clear();
  }
}

function resolveNonTailRevision(key: IndicatorPrepareCacheKey): number {
  return key.nonTailRevision ?? key.series.nonTailRevision ?? 0;
}

function resolveResetEpoch(key: IndicatorPrepareCacheKey): number {
  return key.resetEpoch ?? key.series.resetEpoch ?? 0;
}

function sameData(a: CacheEntry<unknown>, b: CacheEntry<unknown>): boolean {
  return a.definitionType === b.definitionType
    && a.instance === b.instance
    && a.series === b.series
    && a.seriesRevision === b.seriesRevision
    && a.nonTailRevision === b.nonTailRevision
    && a.resetEpoch === b.resetEpoch
    && a.generation === b.generation
    && a.settingsRevision === b.settingsRevision
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
    && cached.nonTailRevision === resolveNonTailRevision(key)
    && cached.resetEpoch === resolveResetEpoch(key)
    && cached.generation === (key.generation ?? 0)
    && cached.settingsRevision === (key.settingsRevision ?? 0)
    && cached.rangeFrom === key.rangeFrom
    && cached.rangeTo === key.rangeTo
    && cached.market === key.market
    && cached.timeframe === key.timeframe
    && cached.intervalMs === key.intervalMs
    && cached.timeBucket === (key.timeBucket ?? 0);
}

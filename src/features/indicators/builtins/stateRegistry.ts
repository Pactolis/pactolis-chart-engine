/**
 * Shared registry of per-series built-in indicator incremental state stores (#290).
 *
 * Keeps weak references to per-series Maps so deleting, restoring, or disposing
 * an indicator instance in IndicatorManager purges its built-in state immediately
 * without retaining FootprintSeries or Map instances in memory.
 */

export interface IndicatorSeriesStateStore<S> {
  get(series: object, id: string): S | undefined;
  set(series: object, id: string, state: S): void;
  delete(series: object, id: string): boolean;
  sizeForSeries(series: object): number;
}

interface RegisteredStore {
  purgeId(id: string): void;
  sizeForSeries(series: object): number;
}

const allStores: RegisteredStore[] = [];
const cleanupCallbacks = new Map<string, () => void>();

/**
 * Registers a per-instance cleanup callback invoked when `id` is hidden,
 * removed, restored away, market-switched, or disposed.
 */
export function registerIndicatorCleanup(id: string, fn: () => void): void {
  const prev = cleanupCallbacks.get(id);
  if (prev && prev !== fn) {
    cleanupCallbacks.delete(id);
    prev();
  }
  cleanupCallbacks.set(id, fn);
}

/** Runs and removes any cleanup callback registered under `id`. */
export function runIndicatorCleanup(id: string): void {
  const fn = cleanupCallbacks.get(id);
  if (!fn) return;
  cleanupCallbacks.delete(id);
  fn();
}

/** Returns whether a cleanup callback is currently registered for `id`. */
export function hasIndicatorCleanup(id: string): boolean {
  return cleanupCallbacks.has(id);
}

export function createIndicatorSeriesStateStore<S>(): IndicatorSeriesStateStore<S> {
  const bySeries = new WeakMap<object, Map<string, S>>();
  const activeMaps = new Set<WeakRef<Map<string, S>>>();

  allStores.push({
    purgeId(id: string): void {
      for (const ref of activeMaps) {
        const map = ref.deref();
        if (!map) {
          activeMaps.delete(ref);
          continue;
        }
        map.delete(id);
      }
    },
    sizeForSeries(series: object): number {
      return bySeries.get(series)?.size ?? 0;
    },
  });

  return {
    get(series: object, id: string): S | undefined {
      return bySeries.get(series)?.get(id);
    },
    set(series: object, id: string, state: S): void {
      let map = bySeries.get(series);
      if (!map) {
        map = new Map<string, S>();
        bySeries.set(series, map);
        activeMaps.add(new WeakRef(map));
      }
      map.set(id, state);
    },
    delete(series: object, id: string): boolean {
      return bySeries.get(series)?.delete(id) ?? false;
    },
    sizeForSeries(series: object): number {
      return bySeries.get(series)?.size ?? 0;
    },
  };
}

/** Removes any built-in indicator state cached under `id` across all live series. */
export function purgeIndicatorBuiltinState(id: string): void {
  runIndicatorCleanup(id);
  for (const store of allStores) {
    store.purgeId(id);
  }
}

/** Deterministic, GC-independent count of built-in indicator states held for `series`. */
export function countIndicatorBuiltinStatesForSeries(series: object): number {
  let total = 0;
  for (const store of allStores) {
    total += store.sizeForSeries(series);
  }
  return total;
}

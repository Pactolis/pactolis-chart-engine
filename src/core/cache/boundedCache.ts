export interface BoundedCacheOptions {
  maxEntries: number;
  ttlMs: number;
  errorTtlMs?: number;
  /** TTL for entries set with kind "transient" (e.g. loading placeholders). Defaults to DEFAULT_TRANSIENT_TTL_MS. */
  transientTtlMs?: number;
  now?: () => number;
}

// Loading placeholders should not outlive the request they stand in for by much;
// this keeps a hung request from parking the UI on "loading" for the full
// success TTL (15-30 min in the callers that use "transient").
const DEFAULT_TRANSIENT_TTL_MS = 20_000;

type Entry<T> = {
  value: T;
  expiresAt: number;
};

/** Small LRU+TTL cache for module-level browser data caches. */
export class BoundedCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly now: () => number;

  constructor(private readonly options: BoundedCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    // Map iteration order is the LRU order: re-inserting on every hit moves this
    // key to the end, so the oldest (least-recently-used) key is always first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, kind: "ready" | "error" | "transient" = "ready"): void {
    const now = this.now();
    const ttlMs = kind === "error"
      ? (this.options.errorTtlMs ?? this.options.ttlMs)
      : kind === "transient"
        ? (this.options.transientTtlMs ?? DEFAULT_TRANSIENT_TTL_MS)
        : this.options.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + ttlMs });
    this.evict(now);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  pruneFamily(keepKey: string, belongsToFamily: (key: string) => boolean): void {
    for (const key of this.entries.keys()) {
      if (key !== keepKey && belongsToFamily(key)) this.entries.delete(key);
    }
  }

  get size(): number {
    this.evict(this.now());
    return this.entries.size;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

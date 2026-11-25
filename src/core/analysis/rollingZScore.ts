export const DAY_MS = 86_400_000;
export const DEFAULT_ZSCORE_WINDOW_MS = 30 * DAY_MS;
export const DEFAULT_ZSCORE_MIN_SPAN_MS = 7 * DAY_MS;

export interface RollingZScoreSample {
  t: number;
  value: number;
}

export interface RollingZScoreOptions {
  /** Sliding window width in ms over `[t - windowMs, t)`. Default 30 days. */
  windowMs?: number;
  /** Minimum elapsed span in ms within the window before emitting a z-score. Default 7 days. */
  minSpanMs?: number;
  /** Minimum sample count in the window before emitting a z-score. Default 2. */
  minSamples?: number;
  /** Standard deviation divisor: sample (`n - 1`, default) or population (`n`). */
  stdMode?: "sample" | "population";
}

export interface RollingZScorePoint {
  t: number;
  value: number;
  mean: number | null;
  std: number | null;
  zScore: number | null;
  count: number;
  spanMs: number;
  insufficientData: boolean;
}

interface ResolvedOptions {
  windowMs: number;
  minSpanMs: number;
  minSamples: number;
  stdMode: "sample" | "population";
}

function resolveOptions(options?: RollingZScoreOptions): ResolvedOptions {
  const windowMs =
    typeof options?.windowMs === "number" && Number.isFinite(options.windowMs) && options.windowMs > 0
      ? options.windowMs
      : DEFAULT_ZSCORE_WINDOW_MS;
  const minSpanMs =
    typeof options?.minSpanMs === "number" && Number.isFinite(options.minSpanMs) && options.minSpanMs >= 0
      ? options.minSpanMs
      : DEFAULT_ZSCORE_MIN_SPAN_MS;
  const minSamples =
    typeof options?.minSamples === "number" && Number.isFinite(options.minSamples) && options.minSamples >= 2
      ? Math.floor(options.minSamples)
      : 2;
  const stdMode = options?.stdMode === "population" ? "population" : "sample";
  return { windowMs, minSpanMs, minSamples, stdMode };
}

/**
 * Incremental sliding-window Welford z-score calculator over `[t - windowMs, t)`.
 * Samples must be pushed in non-decreasing timestamp order.
 */
export class RollingZScoreWindow {
  private readonly opts: ResolvedOptions;
  private readonly queue: RollingZScoreSample[] = [];
  private head = 0;
  private count = 0;
  private mean = 0;
  private m2 = 0;
  private opsSinceResync = 0;

  constructor(options?: RollingZScoreOptions) {
    this.opts = resolveOptions(options);
  }

  reset(): void {
    this.queue.length = 0;
    this.head = 0;
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
    this.opsSinceResync = 0;
  }

  /**
   * Evaluates `value` at timestamp `t` against the prior window `[t - windowMs, t)`,
   * then inserts `(t, value)` into the window if `value` is finite.
   */
  push(t: number, value: number): RollingZScorePoint {
    if (!Number.isFinite(t)) {
      return {
        t,
        value,
        mean: null,
        std: null,
        zScore: null,
        count: 0,
        spanMs: 0,
        insufficientData: true,
      };
    }

    this.evictBefore(t - this.opts.windowMs);

    const activeCount = this.count;
    const first = activeCount > 0 ? this.queue[this.head] : null;
    const spanMs = first ? Math.max(0, t - first.t) : 0;

    let mean: number | null = null;
    let std: number | null = null;
    let zScore: number | null = null;
    let insufficientData = true;

    if (
      Number.isFinite(value)
      && activeCount >= this.opts.minSamples
      && spanMs >= this.opts.minSpanMs
    ) {
      const denom = this.opts.stdMode === "population" ? activeCount : activeCount - 1;
      const variance = denom > 0 ? Math.max(0, this.m2) / denom : 0;
      const computedStd = Math.sqrt(variance);
      mean = this.mean;
      std = computedStd;
      if (computedStd > 0 && Number.isFinite(computedStd)) {
        zScore = (value - this.mean) / computedStd;
        insufficientData = !Number.isFinite(zScore);
        if (insufficientData) zScore = null;
      }
    }

    if (Number.isFinite(value)) {
      this.addSample(t, value);
    }

    return {
      t,
      value,
      mean,
      std,
      zScore,
      count: activeCount,
      spanMs,
      insufficientData,
    };
  }

  private evictBefore(cutoff: number): void {
    while (this.head < this.queue.length && this.queue[this.head].t < cutoff) {
      const removed = this.queue[this.head];
      this.head++;
      this.removeValue(removed.value);
    }
    if (this.head > 256 && this.head * 2 >= this.queue.length) {
      this.queue.splice(0, this.head);
      this.head = 0;
    }
  }

  private addSample(t: number, x: number): void {
    this.queue.push({ t, value: x });
    this.count += 1;
    const delta = x - this.mean;
    this.mean += delta / this.count;
    const delta2 = x - this.mean;
    this.m2 += delta * delta2;
    this.maybeResync();
  }

  private removeValue(x: number): void {
    if (this.count <= 1) {
      this.count = 0;
      this.mean = 0;
      this.m2 = 0;
      return;
    }
    const prevCount = this.count;
    const nextCount = prevCount - 1;
    const nextMean = (this.mean * prevCount - x) / nextCount;
    const deltaOld = x - this.mean;
    const deltaNew = x - nextMean;
    this.count = nextCount;
    this.mean = nextMean;
    this.m2 = Math.max(0, this.m2 - deltaOld * deltaNew);
    this.maybeResync();
  }

  private maybeResync(): void {
    this.opsSinceResync += 1;
    if (this.opsSinceResync < 4096) return;
    this.opsSinceResync = 0;
    let count = 0;
    let mean = 0;
    let m2 = 0;
    for (let i = this.head; i < this.queue.length; i++) {
      const x = this.queue[i].value;
      count += 1;
      const delta = x - mean;
      mean += delta / count;
      m2 += delta * (x - mean);
    }
    this.count = count;
    this.mean = mean;
    this.m2 = Math.max(0, m2);
  }
}

/**
 * Computes rolling z-scores over `[t - windowMs, t)` for chronologically ordered samples.
 */
export function rollingZScore(
  samples: readonly RollingZScoreSample[],
  options?: RollingZScoreOptions,
): RollingZScorePoint[] {
  if (!samples.length) return [];
  const win = new RollingZScoreWindow(options);
  const out: RollingZScorePoint[] = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = win.push(samples[i].t, samples[i].value);
  }
  return out;
}

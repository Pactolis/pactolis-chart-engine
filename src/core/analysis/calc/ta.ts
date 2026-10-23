import type { FootprintBar } from "../../types.js";

export interface OhlcvInput {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta?: number;
  count?: number;
}

export interface NumberPoint {
  time: number;
  value: number | null;
}

export interface BandPoint {
  time: number;
  middle: number | null;
  upper: number | null;
  lower: number | null;
}

export interface MacdPoint {
  time: number;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}

export interface KdjPoint {
  time: number;
  k: number | null;
  d: number | null;
  j: number | null;
}

export interface DmiPoint {
  time: number;
  plusDi: number | null;
  minusDi: number | null;
  adx: number | null;
}

export interface SuperTrendPoint {
  time: number;
  trend: number | null;
  direction: 1 | -1 | 0;
}

export interface IchimokuPoint {
  time: number;
  tenkan: number | null;
  kijun: number | null;
  senkouA: number | null;
  senkouB: number | null;
  chikou: number | null;
}

export const SIZE_BUCKET_LIMITS_V1 = Object.freeze([1_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000]);
export const SIZE_BUCKET_COUNT_V1 = SIZE_BUCKET_LIMITS_V1.length + 1;

export function emptyDeltaBySize(): number[] {
  return Array.from({ length: SIZE_BUCKET_COUNT_V1 }, () => 0);
}

export function tradeSizeBucketIndex(notionalUsd: number): number {
  const safe = Number.isFinite(notionalUsd) ? Math.max(0, notionalUsd) : 0;
  for (let i = 0; i < SIZE_BUCKET_LIMITS_V1.length; i++) {
    if (safe < SIZE_BUCKET_LIMITS_V1[i]) return i;
  }
  return SIZE_BUCKET_LIMITS_V1.length;
}

/**
 * Adds `signedQuantity` to the size bucket of `notionalUsd` and returns the array to store.
 * A live bar takes one of these per trade, so an array that is already normalized (one
 * entry per bucket, all finite, writable) is updated in place rather than rebuilt; any
 * other input comes back as a normalized copy. A bar loaded with such an array keeps
 * using it, the way it keeps using the `cells` it was loaded with.
 */
export function addDeltaBySize(target: number[] | undefined, notionalUsd: number, signedQuantity: number): number[] {
  const next = isNormalizedDeltaBySize(target) ? target : normalizeDeltaBySize(target);
  next[tradeSizeBucketIndex(notionalUsd)] += signedQuantity;
  return next;
}

function isNormalizedDeltaBySize(value: readonly number[] | undefined): value is number[] {
  if (!Array.isArray(value) || value.length !== SIZE_BUCKET_COUNT_V1 || Object.isFrozen(value)) return false;
  for (let i = 0; i < SIZE_BUCKET_COUNT_V1; i++) {
    if (!Number.isFinite(value[i])) return false;
  }
  return true;
}

export function normalizeDeltaBySize(value: readonly number[] | undefined): number[] {
  const next = emptyDeltaBySize();
  if (!value) return next;
  for (let i = 0; i < Math.min(value.length, next.length); i++) {
    const item = value[i];
    next[i] = Number.isFinite(item) ? item : 0;
  }
  return next;
}

/**
 * Kahan-Neumaier compensated running total. Rolling windows below add a value in and
 * later subtract it back out (`sum += x`, then N bars later `sum -= x`); with a plain
 * float accumulator that pair doesn't cancel exactly, and the residual compounds over
 * thousands of bars. VWAP is the visible case: its accumulated `price * volume` sits
 * around 1e9, where naive rolling add/subtract drifts by a measurable amount over a
 * multi-day session. Tracking the rounding error dropped on each add and folding it
 * back in on the next keeps the running total accurate to within a couple ULPs
 * regardless of how many terms pass through it, add or subtract alike (subtracting x
 * is just adding -x, so the same compensation applies to both directions).
 */
export interface CompensatedSum {
  sum: number;
  correction: number;
}

export function createCompensatedSum(): CompensatedSum {
  return { sum: 0, correction: 0 };
}

export function addCompensated(acc: CompensatedSum, value: number): number {
  const y = value - acc.correction;
  const t = acc.sum + y;
  acc.correction = (t - acc.sum) - y;
  acc.sum = t;
  return acc.sum;
}

export function barsToOhlcv(bars: readonly FootprintBar[]): OhlcvInput[] {
  return bars.map((bar) => ({
    time: bar.startTime,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    delta: bar.delta,
    count: bar.count,
  }));
}

/**
 * Memoized `barsToOhlcv` over a FootprintSeries.
 *
 * Several indicators recompute per trade flush (the prepare cache is keyed on
 * `series.revision`, which bumps on every applied trade); without this memo each
 * of them rebuilt its own full-length OHLCV object array on every recompute.
 * The memo is invalidated by (revision, structureRevision). When only bar content
 * changes, the existing row storage is refreshed in place; a temporal structure change
 * still rebuilds the array. TA functions treat the rows as read-only, so sharing this
 * reusable storage across indicator instances is safe within one series revision.
 */
interface OhlcvSeriesSource {
  readonly revision: number;
  readonly structureRevision: number;
  listReadonly(): readonly FootprintBar[];
}

interface OhlcvMemoEntry {
  revision: number;
  structureRevision: number;
  rows: OhlcvInput[];
}

const ohlcvMemo = new WeakMap<object, OhlcvMemoEntry>();

function syncOhlcvRow(target: OhlcvInput, bar: FootprintBar): void {
  target.time = bar.startTime;
  target.open = bar.open;
  target.high = bar.high;
  target.low = bar.low;
  target.close = bar.close;
  target.volume = bar.volume;
  target.delta = bar.delta;
  target.count = bar.count;
}

export function seriesOhlcv(series: OhlcvSeriesSource): OhlcvInput[] {
  const cached = ohlcvMemo.get(series);
  if (
    cached &&
    cached.revision === series.revision &&
    cached.structureRevision === series.structureRevision
  ) {
    return cached.rows;
  }

  const bars = series.listReadonly();
  if (
    cached &&
    cached.structureRevision === series.structureRevision &&
    cached.rows.length === bars.length
  ) {
    for (let i = 0; i < bars.length; i++) syncOhlcvRow(cached.rows[i], bars[i]);
    cached.revision = series.revision;
    return cached.rows;
  }

  const rows = barsToOhlcv(bars);
  ohlcvMemo.set(series, { revision: series.revision, structureRevision: series.structureRevision, rows });
  return rows;
}

export function simpleMovingAverage(values: readonly number[], period: number): Array<number | null> {
  const n = positivePeriod(period, 1);
  const out: Array<number | null> = [];
  const rolling = createCompensatedSum(); // see addCompensated doc -- plain add/subtract drifts over long series
  let valid = 0;
  for (let i = 0; i < values.length; i++) {
    const next = finiteOrNull(values[i]);
    if (next !== null) {
      addCompensated(rolling, next);
      valid++;
    }
    if (i >= n) {
      const old = finiteOrNull(values[i - n]);
      if (old !== null) {
        addCompensated(rolling, -old);
        valid--;
      }
    }
    out.push(i + 1 >= n && valid === n ? rolling.sum / n : null);
  }
  return out;
}

export function exponentialMovingAverage(values: readonly number[], period: number): Array<number | null> {
  const n = positivePeriod(period, 1);
  const out: Array<number | null> = Array.from({ length: values.length }, () => null);
  const alpha = 2 / (n + 1);
  let seedSum = 0;
  let seedCount = 0;
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const value = finiteOrNull(values[i]);
    if (value === null) {
      // Gap the output instead of carrying the stale `ema` forward: simpleMovingAverage
      // already emits null for a missing input, and silently republishing the last good
      // EMA value here made macd()'s `signal` line stay populated on bars where `macd`
      // itself was null -- a signal line with no macd value is incoherent. Internal state
      // (`ema`, seed accumulators) is left untouched so the series recovers on the next
      // valid bar rather than needing to reseed from scratch.
      out[i] = null;
      continue;
    }
    if (ema === null) {
      seedSum += value;
      seedCount++;
      if (seedCount === n) {
        ema = seedSum / n;
        out[i] = ema;
      }
      continue;
    }
    ema = value * alpha + ema * (1 - alpha);
    out[i] = ema;
  }
  return out;
}

export function wilderSmooth(values: readonly number[], period: number): Array<number | null> {
  const n = positivePeriod(period, 1);
  const out: Array<number | null> = Array.from({ length: values.length }, () => null);
  let seedSum = 0;
  let seedCount = 0;
  let smooth: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const value = finiteOrNull(values[i]);
    if (value === null) {
      // Propagate a gap instead of the old `?? 0` coercion: wilderSmooth backs RSI, ATR
      // and DMI, so folding a missing bar in as a zero silently pulled all three toward
      // neutral (RSI ~50, shrunken ATR) rather than showing the gap the bad bar actually
      // is -- inconsistent with simpleMovingAverage/exponentialMovingAverage, which both
      // emit null for the same input. Seed/smoothed state is left untouched so the series
      // resumes correctly on the next valid bar instead of staying null forever.
      out[i] = null;
      continue;
    }
    if (smooth === null) {
      seedSum += value;
      seedCount++;
      if (seedCount === n) {
        smooth = seedSum / n;
        out[i] = smooth;
      }
      continue;
    }
    smooth = (smooth * (n - 1) + value) / n;
    out[i] = smooth;
  }
  return out;
}

export function rollingStdDev(values: readonly number[], period: number): Array<number | null> {
  const n = positivePeriod(period, 1);
  const out: Array<number | null> = [];
  const window: number[] = [];
  for (const raw of values) {
    const value = finiteOrNull(raw);
    if (value !== null) window.push(value);
    else window.push(NaN);
    if (window.length > n) window.shift();
    if (window.length === n && window.every(Number.isFinite)) {
      const mean = window.reduce((sum, item) => sum + item, 0) / n;
      const variance = window.reduce((sum, item) => sum + (item - mean) ** 2, 0) / n;
      out.push(Math.sqrt(variance));
    } else {
      out.push(null);
    }
  }
  return out;
}

export function rollingMin(values: readonly number[], period: number): Array<number | null> {
  return rollingExtrema(values, period, "min");
}

export function rollingMax(values: readonly number[], period: number): Array<number | null> {
  return rollingExtrema(values, period, "max");
}

export function trueRange(bars: readonly OhlcvInput[]): number[] {
  return bars.map((bar, index) => {
    const previousClose = index > 0 ? bars[index - 1].close : bar.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
}

export function averageTrueRange(bars: readonly OhlcvInput[], period: number): Array<number | null> {
  return wilderSmooth(trueRange(bars), period);
}

export function bollingerBands(bars: readonly OhlcvInput[], period: number, multiplier: number): BandPoint[] {
  const closes = bars.map((bar) => bar.close);
  const middle = simpleMovingAverage(closes, period);
  const sigma = rollingStdDev(closes, period);
  return bars.map((bar, index) => {
    const mid = middle[index];
    const sd = sigma[index];
    const spread = mid !== null && sd !== null ? sd * multiplier : null;
    return {
      time: bar.time,
      middle: mid,
      upper: spread === null || mid === null ? null : mid + spread,
      lower: spread === null || mid === null ? null : mid - spread,
    };
  });
}

export function superTrend(bars: readonly OhlcvInput[], period: number, multiplier: number): SuperTrendPoint[] {
  const atr = averageTrueRange(bars, period);
  const out: SuperTrendPoint[] = [];
  let finalUpper = 0;
  let finalLower = 0;
  let direction: 1 | -1 | 0 = 0;
  let trend: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const range = atr[i];
    if (range === null) {
      out.push({ time: bars[i].time, trend: null, direction: 0 });
      continue;
    }
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const basicUpper = hl2 + multiplier * range;
    const basicLower = hl2 - multiplier * range;
    if (i === 0 || atr[i - 1] === null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction = bars[i].close >= hl2 ? 1 : -1;
    } else {
      const previousClose = bars[i - 1].close;
      finalUpper = basicUpper < finalUpper || previousClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || previousClose < finalLower ? basicLower : finalLower;
      if (direction === -1 && bars[i].close > finalUpper) direction = 1;
      else if (direction === 1 && bars[i].close < finalLower) direction = -1;
    }
    trend = direction === 1 ? finalLower : finalUpper;
    out.push({ time: bars[i].time, trend, direction });
  }
  return out;
}

export function rsi(bars: readonly OhlcvInput[], period: number): NumberPoint[] {
  const gains: number[] = [NaN];
  const losses: number[] = [NaN];
  for (let i = 1; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  const avgGain = wilderSmooth(gains, period);
  const avgLoss = wilderSmooth(losses, period);
  return bars.map((bar, index) => {
    const gain = avgGain[index];
    const loss = avgLoss[index];
    if (gain === null || loss === null) return { time: bar.time, value: null };
    // A completely flat window (no up move AND no down move) is conventionally neutral
    // (50), not "all gains" -- only checking `loss === 0` misclassified a flat series as
    // maximally overbought (100) because that branch didn't distinguish it from the
    // genuine all-gains case (gain > 0, loss === 0).
    if (gain === 0 && loss === 0) return { time: bar.time, value: 50 };
    if (loss === 0) return { time: bar.time, value: 100 };
    const rs = gain / loss;
    return { time: bar.time, value: 100 - 100 / (1 + rs) };
  });
}

export function stochasticRsi(bars: readonly OhlcvInput[], period: number, kPeriod: number, dPeriod: number): KdjPoint[] {
  const rsiValues = rsi(bars, period).map((point) => point.value ?? NaN);
  const lows = rollingMin(rsiValues, period);
  const highs = rollingMax(rsiValues, period);
  const stoch = rsiValues.map((value, index) => {
    const low = lows[index];
    const high = highs[index];
    return low === null || high === null || !Number.isFinite(value) || high === low ? NaN : ((value - low) / (high - low)) * 100;
  });
  const k = simpleMovingAverage(stoch, kPeriod);
  const d = simpleMovingAverage(k.map((value) => value ?? NaN), dPeriod);
  return bars.map((bar, index) => ({ time: bar.time, k: k[index], d: d[index], j: null }));
}

export function macd(bars: readonly OhlcvInput[], fastPeriod: number, slowPeriod: number, signalPeriod: number): MacdPoint[] {
  const closes = bars.map((bar) => bar.close);
  const fast = exponentialMovingAverage(closes, fastPeriod);
  const slow = exponentialMovingAverage(closes, slowPeriod);
  const macdValues = fast.map((fastValue, index) => fastValue !== null && slow[index] !== null ? fastValue - slow[index]! : NaN);
  const signal = exponentialMovingAverage(macdValues, signalPeriod);
  return bars.map((bar, index) => {
    const macdValue = Number.isFinite(macdValues[index]) ? macdValues[index] : null;
    const signalValue = signal[index];
    return {
      time: bar.time,
      macd: macdValue,
      signal: signalValue,
      histogram: macdValue !== null && signalValue !== null ? macdValue - signalValue : null,
    };
  });
}

export function kdj(bars: readonly OhlcvInput[], period: number, kSmoothing: number, dSmoothing: number): KdjPoint[] {
  const lows = rollingMin(bars.map((bar) => bar.low), period);
  const highs = rollingMax(bars.map((bar) => bar.high), period);
  const rsv = bars.map((bar, index) => {
    const low = lows[index];
    const high = highs[index];
    return low === null || high === null || high === low ? NaN : ((bar.close - low) / (high - low)) * 100;
  });
  // Classic KDJ smooths RSV with alpha = 1/n (Wilder smoothing), not EMA's alpha = 2/(n+1).
  // With the default kSmoothing = 3 that made K/D react ~1.5x faster (alpha 0.5 vs the
  // standard 1/3) than every other platform's KDJ under a label implying the textbook
  // definition. NOTE: this changes the plotted K/D/J values versus the previous release.
  const k = wilderSmooth(rsv, kSmoothing);
  const d = wilderSmooth(k.map((value) => value ?? NaN), dSmoothing);
  return bars.map((bar, index) => {
    const kValue = k[index];
    const dValue = d[index];
    return { time: bar.time, k: kValue, d: dValue, j: kValue !== null && dValue !== null ? 3 * kValue - 2 * dValue : null };
  });
}

export function cci(bars: readonly OhlcvInput[], period: number): NumberPoint[] {
  const typical = bars.map((bar) => (bar.high + bar.low + bar.close) / 3);
  const sma = simpleMovingAverage(typical, period);
  return bars.map((bar, index) => {
    const middle = sma[index];
    if (middle === null || index + 1 < period) return { time: bar.time, value: null };
    const window = typical.slice(index + 1 - period, index + 1);
    const meanDeviation = window.reduce((sum, value) => sum + Math.abs(value - middle), 0) / period;
    // meanDeviation === 0 means the window is undefined for CCI (division by zero), not a
    // genuine "exactly on the mean" reading of 0 -- return null so it renders as a gap
    // rather than an indistinguishable real zero.
    return { time: bar.time, value: meanDeviation > 0 ? (typical[index] - middle) / (0.015 * meanDeviation) : null };
  });
}

export function dmi(bars: readonly OhlcvInput[], period: number, adxPeriod = period): DmiPoint[] {
  const tr = trueRange(bars);
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const trSmooth = wilderSmooth(tr, period);
  const plusSmooth = wilderSmooth(plusDm, period);
  const minusSmooth = wilderSmooth(minusDm, period);
  const dxValues = bars.map((_, index) => {
    const trValue = trSmooth[index];
    const plus = trValue && plusSmooth[index] !== null ? 100 * plusSmooth[index]! / trValue : null;
    const minus = trValue && minusSmooth[index] !== null ? 100 * minusSmooth[index]! / trValue : null;
    if (plus === null || minus === null || plus + minus === 0) return NaN;
    return 100 * Math.abs(plus - minus) / (plus + minus);
  });
  const adx = wilderSmooth(dxValues, adxPeriod);
  return bars.map((bar, index) => {
    const trValue = trSmooth[index];
    const plusDi = trValue && plusSmooth[index] !== null ? 100 * plusSmooth[index]! / trValue : null;
    const minusDi = trValue && minusSmooth[index] !== null ? 100 * minusSmooth[index]! / trValue : null;
    return { time: bar.time, plusDi, minusDi, adx: adx[index] };
  });
}

export function moneyFlowIndex(bars: readonly OhlcvInput[], period: number): NumberPoint[] {
  const positive: number[] = [0];
  const negative: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const prevTp = (bars[i - 1].high + bars[i - 1].low + bars[i - 1].close) / 3;
    const flow = tp * bars[i].volume;
    positive.push(tp > prevTp ? flow : 0);
    negative.push(tp < prevTp ? flow : 0);
  }
  const pos = rollingSum(positive, period);
  const neg = rollingSum(negative, period);
  return bars.map((bar, index) => {
    const p = pos[index];
    const n = neg[index];
    if (p === null || n === null) return { time: bar.time, value: null };
    // Same flat-series miscategorization as rsi(): both positive and negative money flow
    // at zero (no directional flow at all) is neutral (50), not maximally positive (100) --
    // checking only `n === 0` couldn't tell that apart from the genuine all-positive case.
    if (p === 0 && n === 0) return { time: bar.time, value: 50 };
    if (n === 0) return { time: bar.time, value: 100 };
    return { time: bar.time, value: 100 - 100 / (1 + p / n) };
  });
}

export function volumeSeries(bars: readonly OhlcvInput[]): NumberPoint[] {
  return bars.map((bar) => ({ time: bar.time, value: bar.volume }));
}

export function deltaSeries(bars: readonly OhlcvInput[], percent: boolean): NumberPoint[] {
  return bars.map((bar) => ({
    time: bar.time,
    // Zero volume means delta% is undefined (nothing traded), not a genuinely balanced
    // 0% reading -- render it as a gap instead of a real zero. Raw (non-percent) delta is
    // unaffected: 0 there is a legitimate value (buy volume == sell volume), not a marker
    // for missing data.
    value: percent ? (bar.volume > 0 ? (bar.delta ?? 0) / bar.volume * 100 : null) : (bar.delta ?? 0),
  }));
}

export function ichimoku(bars: readonly OhlcvInput[], tenkanPeriod: number, kijunPeriod: number, senkouBPeriod: number, displacement: number): IchimokuPoint[] {
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const tenkanHigh = rollingMax(highs, tenkanPeriod);
  const tenkanLow = rollingMin(lows, tenkanPeriod);
  const kijunHigh = rollingMax(highs, kijunPeriod);
  const kijunLow = rollingMin(lows, kijunPeriod);
  const senkouBHigh = rollingMax(highs, senkouBPeriod);
  const senkouBLow = rollingMin(lows, senkouBPeriod);
  const base = bars.map((_bar, index) => {
    const tenkan = midpoint(tenkanHigh[index], tenkanLow[index]);
    const kijun = midpoint(kijunHigh[index], kijunLow[index]);
    return {
      time: bars[index].time,
      tenkan,
      kijun,
      senkouA: tenkan !== null && kijun !== null ? (tenkan + kijun) / 2 : null,
      senkouB: midpoint(senkouBHigh[index], senkouBLow[index]),
      chikou: null,
    };
  });
  return base.map((point, index) => ({
    ...point,
    senkouA: base[index - displacement]?.senkouA ?? null,
    senkouB: base[index - displacement]?.senkouB ?? null,
    chikou: bars[index + displacement]?.close ?? null,
  }));
}

export function rollingSum(values: readonly number[], period: number): Array<number | null> {
  const n = positivePeriod(period, 1);
  const out: Array<number | null> = [];
  const rolling = createCompensatedSum(); // see addCompensated doc -- plain add/subtract drifts over long series
  let valid = 0;
  for (let i = 0; i < values.length; i++) {
    const next = finiteOrNull(values[i]);
    if (next !== null) {
      addCompensated(rolling, next);
      valid++;
    }
    if (i >= n) {
      const old = finiteOrNull(values[i - n]);
      if (old !== null) {
        addCompensated(rolling, -old);
        valid--;
      }
    }
    out.push(i + 1 >= n && valid === n ? rolling.sum : null);
  }
  return out;
}

/**
 * O(n) sliding-window min/max via a monotonic deque, replacing a per-bar `values.slice()`
 * + `fn(...window)` spread. That old approach was O(n * period) on every recompute (this
 * feeds ichimoku x3, kdj and stochasticRsi) and, worse, a large user-set period spread
 * thousands of arguments into Math.min/Math.max and could throw a RangeError outright.
 *
 * `deque` holds indices of *finite* values only, kept monotonic (increasing values for
 * "min", decreasing for "max") so the current extremum is always at the front; a value
 * entering the window first evicts everything at the back it dominates, since those can
 * never be read again while it's still in range. `invalidInWindow` separately counts
 * non-finite entries in the trailing window (finite or not, they all still occupy a slot
 * in the window) so a NaN/Infinity anywhere in it still nulls the output -- matching the
 * old `window.every(Number.isFinite)` rule exactly, just without re-scanning the window
 * every iteration.
 */
function rollingExtrema(values: readonly number[], period: number, mode: "min" | "max"): Array<number | null> {
  const n = positivePeriod(period, 1);
  const out: Array<number | null> = new Array(values.length);
  const deque: number[] = [];
  let invalidInWindow = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (Number.isFinite(value)) {
      while (deque.length && (mode === "min" ? values[deque[deque.length - 1]] >= value : values[deque[deque.length - 1]] <= value)) {
        deque.pop();
      }
      deque.push(i);
    } else {
      invalidInWindow++;
    }

    const outIndex = i - n; // index that just fell out of the trailing window of size n
    if (outIndex >= 0) {
      if (deque.length && deque[0] === outIndex) deque.shift();
      if (!Number.isFinite(values[outIndex])) invalidInWindow--;
    }

    out[i] = i + 1 >= n && invalidInWindow === 0 ? values[deque[0]] : null;
  }
  return out;
}

function midpoint(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : (a + b) / 2;
}

function positivePeriod(period: number, fallback: number): number {
  return Math.max(1, Math.floor(Number.isFinite(period) ? period : fallback));
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

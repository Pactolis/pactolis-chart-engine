/**
 * Resumable variants of the rolling building blocks in ta.ts, used by the live-tail
 * indicator paths (#128). Each *Full function runs the same arithmetic as its ta.ts
 * counterpart while capturing the running state *before the last index*; each *Advance
 * function resumes from that state and re-runs only the last index. Because the same
 * float operations run in the same order, the tail value is bit-identical to a full
 * recompute. ta.ts is intentionally left untouched.
 */
import { addCompensated, createCompensatedSum } from "./ta.js";

export interface WindowSumState { sum: number; correction: number; valid: number }
export interface WilderState { seedSum: number; seedCount: number; smooth: number | null }

function period1(period: number): number {
  return Math.max(1, Math.floor(Number.isFinite(period) ? period : 1));
}
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function windowStep(values: readonly number[], i: number, n: number, rolling: { sum: number; correction: number }, valid: number): number {
  const next = finiteOrNull(values[i]);
  if (next !== null) { addCompensated(rolling, next); valid++; }
  if (i >= n) {
    const old = finiteOrNull(values[i - n]);
    if (old !== null) { addCompensated(rolling, -old); valid--; }
  }
  return valid;
}

/** Window sums exactly as rollingSum() computes them (SMA is sum / n); `null` while invalid. */
export function windowSumFull(values: readonly number[], period: number): { sums: Array<number | null>; before: WindowSumState | null } {
  const n = period1(period);
  const sums: Array<number | null> = [];
  const rolling = createCompensatedSum();
  let valid = 0;
  let before: WindowSumState | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i === values.length - 1) before = { sum: rolling.sum, correction: rolling.correction, valid };
    valid = windowStep(values, i, n, rolling, valid);
    sums.push(i + 1 >= n && valid === n ? rolling.sum : null);
  }
  return { sums, before };
}

export function windowSumAdvance(values: readonly number[], period: number, before: WindowSumState): number | null {
  const n = period1(period);
  const rolling = { sum: before.sum, correction: before.correction };
  const i = values.length - 1;
  const valid = windowStep(values, i, n, rolling, before.valid);
  return i + 1 >= n && valid === n ? rolling.sum : null;
}

function wilderStep(state: WilderState, value: number, n: number): number | null {
  const v = finiteOrNull(value);
  if (v === null) return null;
  if (state.smooth === null) {
    state.seedSum += v;
    state.seedCount++;
    if (state.seedCount === n) {
      state.smooth = state.seedSum / n;
      return state.smooth;
    }
    return null;
  }
  state.smooth = (state.smooth * (n - 1) + v) / n;
  return state.smooth;
}

/** Same output as wilderSmooth(), plus the state before the last index. */
export function wilderFull(values: readonly number[], period: number): { out: Array<number | null>; before: WilderState | null } {
  const n = period1(period);
  const out: Array<number | null> = [];
  const state: WilderState = { seedSum: 0, seedCount: 0, smooth: null };
  let before: WilderState | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i === values.length - 1) before = { ...state };
    out.push(wilderStep(state, values[i], n));
  }
  return { out, before };
}

/** Value at the last index of `values`, resumed from the state saved before it. */
export function wilderAdvance(values: readonly number[], period: number, before: WilderState): number | null {
  return wilderStep({ ...before }, values[values.length - 1], period1(period));
}

/**
 * Min/max of the `n` values ending at `last`, with rollingMin/rollingMax semantics: null while
 * fewer than `n` values exist or when any value in the window is non-finite. Exact (no
 * float accumulation), so it equals the deque-based full computation.
 */
export function windowExtreme(valueAt: (index: number) => number, last: number, period: number, pick: "min" | "max"): number | null {
  const n = period1(period);
  if (last + 1 < n) return null;
  let result = pick === "min" ? Infinity : -Infinity;
  for (let k = last + 1 - n; k <= last; k++) {
    const v = valueAt(k);
    if (!Number.isFinite(v)) return null;
    if (pick === "min" ? v < result : v > result) result = v;
  }
  return result;
}

export interface SuperTrendState { finalUpper: number; finalLower: number; direction: 1 | -1 | 0 }
interface BarLike { high: number; low: number; close: number }

/**
 * One step of superTrend()'s loop for bar `i`. `range` is atr[i] and `prevRangeNull` is
 * `atr[i - 1] === null`. Mutates `state` and returns the plotted point, matching ta.ts exactly.
 */
export function superTrendStep(state: SuperTrendState, i: number, bar: BarLike, previousClose: number | undefined, range: number | null, prevRangeNull: boolean, multiplier: number): { trend: number | null; direction: 1 | -1 | 0 } {
  if (range === null) return { trend: null, direction: 0 };
  const hl2 = (bar.high + bar.low) / 2;
  const basicUpper = hl2 + multiplier * range;
  const basicLower = hl2 - multiplier * range;
  if (i === 0 || prevRangeNull) {
    state.finalUpper = basicUpper;
    state.finalLower = basicLower;
    state.direction = bar.close >= hl2 ? 1 : -1;
  } else {
    const prev = previousClose as number;
    state.finalUpper = basicUpper < state.finalUpper || prev > state.finalUpper ? basicUpper : state.finalUpper;
    state.finalLower = basicLower > state.finalLower || prev < state.finalLower ? basicLower : state.finalLower;
    if (state.direction === -1 && bar.close > state.finalUpper) state.direction = 1;
    else if (state.direction === 1 && bar.close < state.finalLower) state.direction = -1;
  }
  return { trend: state.direction === 1 ? state.finalLower : state.finalUpper, direction: state.direction };
}

/** SuperTrend recursion state after every bar except the last (resume point for a tail tick). */
export function superTrendBeforeLast(bars: readonly BarLike[], atr: ReadonlyArray<number | null>, multiplier: number): SuperTrendState {
  const state: SuperTrendState = { finalUpper: 0, finalLower: 0, direction: 0 };
  for (let i = 0; i < bars.length - 1; i++) {
    superTrendStep(state, i, bars[i], i > 0 ? bars[i - 1].close : undefined, atr[i], i === 0 ? true : atr[i - 1] === null, multiplier);
  }
  return state;
}

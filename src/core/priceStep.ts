/**
 * Compute a "nice" footprint price-step for a given last price.
 * 0.04% of price, rounded to 1 / 2.5 / 5 / 10 × a power of ten.
 * Example: BTC $100k → $50, ETH $3500 → $1, SOL $150 → $0.05.
 */
export function niceStepForPrice(price: number, fallback = 10): number {
  if (!(price > 0)) return fallback;
  const raw = price * 0.0004;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2.5 : norm < 7 ? 5 : 10;
  return nice * pow;
}

/**
 * Reconcile a market's recorded `canonical` price-step (from the sync sentinel)
 * with the `computed` price-derived step (`niceStepForPrice` of the current price).
 *
 * Normally the canonical step is preferred so the bridge base-store hash stays
 * consistent even when price drifts. But a market can carry a WRONG canonical step
 * — e.g. ETH synced with BTC's global step of 10, producing 10-USD footprint bins.
 * When canonical differs from computed by more than `maxFactor`× (in either
 * direction), it is treated as stale/wrong and the computed step is used instead.
 * A genuine sync stays within a few × even after large price moves, so this only
 * overrides clearly-broken values.
 */
export function reconcilePriceStep(
  canonical: number | undefined,
  computed: number | undefined,
  maxFactor = 8,
): number | undefined {
  if (canonical == null || !(canonical > 0)) return computed;
  if (computed == null || !(computed > 0)) return canonical;
  const ratio = canonical / computed;
  if (ratio > maxFactor || ratio < 1 / maxFactor) return computed;
  return canonical;
}

/**
 * Resolve the fallback priceStep to use when a live priceStep resolution
 * fails (bridge/network error). Prefers the last known good step for this
 * market over a hardcoded constant (bulgu #5 — a bare `10` fallback quietly
 * mis-bins non-BTC markets). Falls back to niceStepForPrice's own heuristic
 * default when nothing is known yet for the market.
 */
export function resolvePriceStepFallback(
  market: string,
  lastKnownStepByMarket: Map<string, number>,
): number {
  const lastKnown = lastKnownStepByMarket.get(market);
  if (lastKnown != null && lastKnown > 0) return lastKnown;
  return niceStepForPrice(NaN);
}

const POWERS_OF_TEN = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];
/** Tick counts whose decimal value has at most this many digits are the ones `toPrecision(15)` leaves intact. */
const MAX_EXACT_UNITS = 1e15;

// The last step seen, as `decimalMantissa / decimalDivisor` with a power-of-ten divisor
// (0.05 is 5 / 100). `decimalDivisor` stays 0 for a step with no such short decimal form.
let decimalStep = Number.NaN;
let decimalMantissa = 0;
let decimalDivisor = 0;

function rememberDecimalStep(step: number): void {
  decimalStep = step;
  decimalMantissa = 0;
  decimalDivisor = 0;
  if (!(step > 0)) return;
  for (const divisor of POWERS_OF_TEN) {
    const mantissa = Math.round(step * divisor);
    if (mantissa >= 1 && mantissa < MAX_EXACT_UNITS && mantissa / divisor === step) {
      decimalMantissa = mantissa;
      decimalDivisor = divisor;
      return;
    }
  }
}

/**
 * Quantize a raw price to a tick grid of the given `step`, the way footprint cells are
 * binned (`FootprintSeries` uses this to key `bar.cells`). Rounds to the nearest tick when
 * a value sits within float rounding noise of one (so `3 * 0.05` lands exactly on `0.15`
 * instead of `0.15000000000000002`), otherwise floors. The result is `tick * step` rounded
 * to 15 significant digits (`Number((tick * step).toPrecision(15))`), which strips the
 * trailing float noise a plain multiplication reintroduces, so it is stable enough to use
 * as a Map key.
 *
 * Formatting and re-parsing that string for every trade (and every neighbour lookup while
 * drawing) is avoided for the common case. When `step` is a short decimal,
 * `mantissa / 10^k`, and the tick count's decimal value fits in 15 digits
 * (`tick * mantissa < 1e15`), `tick * step` is within 2.3e-16 (relative) of that decimal
 * while half the gap between neighbouring 15-digit decimals is above 5e-16 (relative), so
 * the rounding lands exactly on it and the result is the correctly rounded quotient
 * `tick * mantissa / 10^k`. Everything else still takes the string round trip.
 */
export function quantizeToStep(value: number, step: number): number {
  const scaled = value / step;
  const nearest = Math.round(scaled);
  const tick = Math.abs(scaled - nearest) <= 1e-10 * Math.max(1, Math.abs(scaled)) ? nearest : Math.floor(scaled);
  if (step !== decimalStep) rememberDecimalStep(step);
  if (decimalDivisor !== 0) {
    const units = tick * decimalMantissa;
    // `+ 0` turns -0 into 0, as formatting and parsing it does.
    if (Math.abs(units) < MAX_EXACT_UNITS) return units / decimalDivisor + 0;
  }
  return Number((tick * step).toPrecision(15));
}

/**
 * Map key for the cell one price step above (`direction: 1`) or below (`direction: -1`)
 * a given `cell.priceBin`. Plain `bin +/- step` does NOT reproduce the toPrecision(15)
 * normalization `quantizeToStep` applied when that neighbour's key was created -- for
 * fractional steps (0.05, 0.001, ...) that raw arithmetic misses the stored key on
 * ~20-30% of lookups (measured over 200k consecutive bins), e.g.
 * quantizeToStep(3 * 0.05, 0.05) === 0.15 but 0.15 - 0.05 === 0.09999999999999999 while
 * the stored neighbour key is 0.1. Route every neighbour lookup through this helper
 * instead of duplicating the rounding at call sites.
 *
 * Lives in `core` (not `core/model`, where the footprint cell type is defined) because
 * `core/model` already imports from `core/analysis` at runtime (`addDeltaBySize`); a
 * second, opposite-direction runtime edge from `core/analysis` back into `core/model`
 * (needed by orderFlow.ts) would form a module cycle the depgraph gate forbids. `core`
 * itself never imports from `core/analysis` or `core/model` at runtime, so every consumer
 * -- footprint.ts, orderFlow.ts, footprintRenderer.ts -- can import from here safely.
 */
export function neighbourBin(bin: number, step: number, direction: 1 | -1): number {
  return quantizeToStep(bin + direction * step, step);
}

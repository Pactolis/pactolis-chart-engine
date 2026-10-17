/**
 * Conversions between raw prices and logarithmic scale-space.
 *
 * Logarithmic mode maps a price p to sign(p) * (log10(|p| + 10^-k) + k). The
 * small 10^-k term keeps prices near zero finite, and k is raised for narrow
 * ranges so their logical values keep enough resolution. Normal (linear) mode
 * needs no conversion; percentage/indexed modes are not implemented.
 */

import { PriceRange } from "./priceRange.js";

export interface LogFormula {
  /** k: added to every logical value. */
  logicalOffset: number;
  /** 10^-k: added to every magnitude before taking the logarithm. */
  coordOffset: number;
}

const BASE_LOG_OFFSET = 4;
const ZERO_EPSILON = 1e-15;

function formulaWithOffset(offset: number): LogFormula {
  return { logicalOffset: offset, coordOffset: 1 / Math.pow(10, offset) };
}

/** Convert a raw price into logarithmic scale-space. Sign is preserved. */
export function toLog(price: number, logFormula: LogFormula): number {
  if (!Number.isFinite(price)) return NaN;
  if (Math.abs(price) < ZERO_EPSILON) return 0;
  return Math.sign(price) * (Math.log10(Math.abs(price) + logFormula.coordOffset) + logFormula.logicalOffset);
}

/** Convert logarithmic scale-space back into a raw price. Sign is preserved. */
export function fromLog(logical: number, logFormula: LogFormula): number {
  if (!Number.isFinite(logical)) return NaN;
  if (Math.abs(logical) < ZERO_EPSILON) return 0;
  return Math.sign(logical) * (Math.pow(10, Math.abs(logical) - logFormula.logicalOffset) - logFormula.coordOffset);
}

function mapRange(range: PriceRange, convert: (value: number) => number): PriceRange | null {
  const a = convert(range.minValue());
  const b = convert(range.maxValue());
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return new PriceRange(Math.min(a, b), Math.max(a, b));
}

export function convertPriceRangeToLog(range: PriceRange | null, logFormula: LogFormula): PriceRange | null {
  return range === null ? null : mapRange(range, (value) => toLog(value, logFormula));
}

export function convertPriceRangeFromLog(range: PriceRange | null, logFormula: LogFormula): PriceRange | null {
  return range === null ? null : mapRange(range, (value) => fromLog(value, logFormula));
}

export function canConvertPriceRangeFromLog(range: PriceRange | null, logFormula: LogFormula): boolean {
  return convertPriceRangeFromLog(range, logFormula) !== null;
}

/** Pick the log offset for a raw price range: one extra decimal digit of offset per decade the span is below 1. */
export function logFormulaForPriceRange(range: PriceRange | null): LogFormula {
  if (range === null) return formulaWithOffset(BASE_LOG_OFFSET);
  const span = Math.abs(range.length());
  const narrow = Number.isFinite(span) && span >= ZERO_EPSILON && span < 1;
  if (!narrow) return formulaWithOffset(BASE_LOG_OFFSET);
  return formulaWithOffset(BASE_LOG_OFFSET + Math.ceil(-Math.log10(span)));
}

export function logFormulasAreSame(first: LogFormula, second: LogFormula): boolean {
  return first.logicalOffset === second.logicalOffset && first.coordOffset === second.coordOffset;
}

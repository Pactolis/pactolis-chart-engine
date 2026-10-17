/**
 * A vertical price interval used by the price scale and autoscale code.
 *
 * Bounds may be NaN or infinite while sources are still loading; `isEmpty`
 * reports such ranges, and `merge` keeps whichever bound is finite.
 */
export interface RawPriceRange {
  minValue: number;
  maxValue: number;
}

export class PriceRange {
  private low: number;
  private high: number;

  constructor(minValue: number, maxValue: number) {
    this.low = minValue;
    this.high = maxValue;
  }

  static fromRaw(raw: RawPriceRange | null): PriceRange | null {
    if (raw === null) return null;
    return new PriceRange(raw.minValue, raw.maxValue);
  }

  minValue(): number {
    return this.low;
  }

  maxValue(): number {
    return this.high;
  }

  length(): number {
    return this.high - this.low;
  }

  isEmpty(): boolean {
    return Number.isNaN(this.low) || Number.isNaN(this.high) || this.low === this.high;
  }

  equals(other: PriceRange | null): boolean {
    if (other === null) return false;
    return other.low === this.low && other.high === this.high;
  }

  clone(): PriceRange {
    return new PriceRange(this.low, this.high);
  }

  toRaw(): RawPriceRange {
    return { minValue: this.low, maxValue: this.high };
  }

  /** Smallest range covering both; a non-finite bound on one side yields to the other side's bound. */
  merge(other: PriceRange | null): PriceRange {
    if (other === null) return this.clone();
    return new PriceRange(
      pickBound(this.low, other.low, Math.min, -Infinity),
      pickBound(this.high, other.high, Math.max, Infinity),
    );
  }

  /** Stretch (coeff > 1) or shrink (coeff < 1) the range about its midpoint, in place. */
  scaleAroundCenter(coeff: number): void {
    if (!Number.isFinite(coeff) || this.high === this.low) return;
    const mid = (this.low + this.high) * 0.5;
    this.low = mid + (this.low - mid) * coeff;
    this.high = mid + (this.high - mid) * coeff;
  }

  /** Move both bounds by `delta`, in place. */
  shift(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.low += delta;
    this.high += delta;
  }
}

function pickBound(a: number, b: number, choose: (x: number, y: number) => number, neither: number): number {
  const aOk = Number.isFinite(a);
  const bOk = Number.isFinite(b);
  if (aOk && bOk) return choose(a, b);
  if (aOk) return a;
  if (bOk) return b;
  return neither;
}

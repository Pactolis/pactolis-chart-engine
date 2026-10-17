/**
 * Price-axis tick step selection.
 *
 * Steps come from a ladder of round values. Whole-unit steps use the mantissas
 * 5, 4, 2.5, 2 and 1 in every decade, so wide price ranges get a fine choice of
 * spacing. Fractional steps use only 5, 2 and 1, which keeps decimal labels short,
 * and never go below the smallest step the label precision can display.
 *
 * The chosen step is the smallest ladder value that still leaves `minSpacing`
 * price units between neighbouring marks.
 */

const EPSILON = 1e-14;
const WHOLE_MANTISSAS = [5, 4, 2.5, 2, 1] as const;
const FRACTION_MANTISSAS = [5, 2, 1] as const;

/** Smallest step a label with `pricePrecision` decimals can show (1 for whole-number labels). */
export function smallestLabelStep(pricePrecision: number): number {
  if (!Number.isFinite(pricePrecision) || pricePrecision <= 0) return 1;
  return 1 / Math.pow(10, Math.min(12, Math.floor(pricePrecision)));
}

/**
 * @param high upper end of the visible price range
 * @param low lower end of the visible price range
 * @param minSpacing minimum price distance between two marks
 * @param minStep smallest step the labels can display, see `smallestLabelStep`
 */
export function priceTickStep(high: number, low: number, minSpacing: number, minStep: number): number {
  if (!Number.isFinite(high) || !Number.isFinite(low) || high < low) {
    throw new Error("invalid price span");
  }
  if (high === low) return minStep;

  // No step is ever wider than the decade that covers the whole range.
  const topExponent = Math.max(0, Math.ceil(Math.log10(high - low)));
  const widest = Math.pow(10, topExponent);
  const fits = (step: number) => step >= minSpacing - EPSILON;

  if (!fits(widest)) return widest;

  let step = widest;
  for (let exponent = topExponent - 1; exponent >= 0; exponent--) {
    const decade = Math.pow(10, exponent);
    for (const mantissa of WHOLE_MANTISSAS) {
      const candidate = mantissa * decade;
      if (!fits(candidate)) return step;
      step = candidate;
    }
  }

  // The ladder reached one whole price unit and there is still room: continue
  // into fractions, down to the precision of the labels.
  for (let exponent = 1; exponent <= 12; exponent++) {
    const decade = Math.pow(10, exponent);
    for (const mantissa of FRACTION_MANTISSAS) {
      const candidate = mantissa / decade;
      if (candidate < minStep - EPSILON || !fits(candidate)) return step;
      step = candidate;
    }
  }
  return step;
}

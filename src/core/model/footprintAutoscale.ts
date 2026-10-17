/** Autoscale adapter for FootprintSeries.
 *
 * The price scale model should not know about footprint bars. This adapter is the
 * narrow bridge that exposes visible OHLC high/low data through the generic
 * AutoscaleSource interface.
 */

import type { FootprintSeries } from "./footprint.js";
import { PriceRange } from "./priceRange.js";
import type { AutoscaleInfo, AutoscaleSource, LogicalRange } from "./priceScale.js";

export function footprintVisiblePriceRange(series: FootprintSeries, visibleRange: LogicalRange): PriceRange | null {
  const from = Math.max(0, Math.floor(visibleRange.from));
  const to = Math.min(series.length, Math.ceil(visibleRange.to));
  if (from >= to) return null;

  let min = Infinity;
  let max = -Infinity;
  for (let index = from; index < to; index++) {
    const bar = series.at(index);
    if (!bar) continue;
    if (Number.isFinite(bar.low)) min = Math.min(min, bar.low);
    if (Number.isFinite(bar.high)) max = Math.max(max, bar.high);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return new PriceRange(min, max);
}

export function footprintAutoscaleSource(series: FootprintSeries): AutoscaleSource {
  return {
    visible: () => series.length > 0,
    autoscaleInfo: (visibleRange: LogicalRange): AutoscaleInfo | null => {
      const priceRange = footprintVisiblePriceRange(series, visibleRange);
      return priceRange ? { priceRange } : null;
    },
  };
}

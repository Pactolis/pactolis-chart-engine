import type { FootprintBar } from "../types.js";
import {
  calculateOrderFlowProfile,
  type OrderFlowProfileOptions,
  type OrderFlowProfileResult,
} from "./orderFlowProfile.js";
import {
  calculateVolumeProfile,
  type VolumeProfileResult,
} from "./volumeProfile.js";

export interface RangeProfileResult extends VolumeProfileResult {
  requestedFrom: number;
  requestedTo: number;
  /** Selected bars carrying at least one exact footprint cell. */
  coveredBars: number;
  totalBars: number;
  /** Fraction of selected bars carrying exact footprint cells. */
  coverage: number;
  /** Days with one or more selected bars that have no footprint cells. */
  missingDays: number[];
  /** True only when the selection is nonempty and every selected bar has footprint cells. */
  complete: boolean;
}

export interface OrderFlowRangeProfileResult extends OrderFlowProfileResult {
  requestedFrom: number;
  requestedTo: number;
  coveredBars: number;
  totalBars: number;
  coverage: number;
  missingDays: number[];
  complete: boolean;
}

const DAY = 86_400_000;

export function calculateRangeProfile(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
  valueAreaPercent = 0.7
): RangeProfileResult {
  const selection = selectRangeBars(bars, from, to);
  const profile = calculateVolumeProfile(
    selection.selected.filter((bar) => bar.cells.size > 0),
    valueAreaPercent
  );
  return { ...profile, ...selection.meta };
}

export function calculateOrderFlowRangeProfile(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
  options: OrderFlowProfileOptions = {},
): OrderFlowRangeProfileResult {
  const selection = selectRangeBars(bars, from, to);
  const incompleteFootprintCoverage = selection.totalBars > 0 && selection.coveredBars < selection.totalBars;
  const canEstimateWholeRange = incompleteFootprintCoverage
    && options.allowOhlcvEstimate === true
    && typeof options.priceStep === "number"
    && Number.isFinite(options.priceStep)
    && options.priceStep > 0;
  const profileBars = canEstimateWholeRange
    // An incomplete footprint window is estimated from OHLCV for every selected bar.
    // Clearing all cell maps prevents exact and estimated levels from being mixed.
    ? selection.selected.map((bar) => ({ ...bar, cells: new Map() }))
    : selection.selected.filter((bar) => bar.cells.size > 0);
  const profile = calculateOrderFlowProfile(profileBars, options);
  return { ...profile, ...selection.meta };
}

function selectRangeBars(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
): {
  selected: FootprintBar[];
  meta: Pick<RangeProfileResult, "requestedFrom" | "requestedTo" | "coveredBars" | "totalBars" | "coverage" | "missingDays" | "complete">;
} {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const selected = bars.filter((bar) => bar.startTime >= start && bar.startTime <= end);
  const coveredBars = selected.filter((bar) => bar.cells.size > 0).length;
  const missingDays = [...new Set(selected
    .filter((bar) => bar.cells.size === 0)
    .map((bar) => Math.floor(bar.startTime / DAY) * DAY))]
    .sort((a, b) => a - b);
  const totalBars = selected.length;
  return {
    selected,
    meta: {
      requestedFrom: start,
      requestedTo: end,
      coveredBars,
      totalBars,
      coverage: totalBars ? coveredBars / totalBars : 0,
      missingDays,
      complete: totalBars > 0 && coveredBars === totalBars,
    },
  };
}

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
  coveredBars: number;
  totalBars: number;
  coverage: number;
  missingDays: number[];
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
  const profile = calculateOrderFlowProfile(
    selection.selected.filter((bar) => bar.cells.size > 0),
    options,
  );
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
    .filter((bar) => bar.volume > 0 && bar.cells.size === 0)
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
      complete: totalBars > 0 && missingDays.length === 0,
    },
  };
}

import type { FootprintBar } from "./types.js";

/** Candles remain visible before this instant, but footprint data does not. */
export const FOOTPRINT_START_TIME = Date.UTC(2020, 0, 1);

export function footprintEnabledAt(startTime: number): boolean {
  return startTime >= FOOTPRINT_START_TIME;
}

/** Defensive enforcement for history and persisted bars. */
export function enforceFootprintPolicy(bar: FootprintBar): FootprintBar {
  if (footprintEnabledAt(bar.startTime) || bar.cells.size === 0) return bar;
  return {
    ...bar,
    cells: new Map(),
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
  };
}

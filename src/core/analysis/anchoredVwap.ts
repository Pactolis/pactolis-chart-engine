import type { FootprintBar } from "../types.js";
import type { VwapPoint } from "./vwap.js";

export interface AnchoredVwapResult {
  anchorTime: number;
  points: VwapPoint[];
  available: boolean;
}

export function calculateAnchoredVwap(
  bars: readonly FootprintBar[],
  anchorTime: number,
  endTime = Infinity
): AnchoredVwapResult {
  let priceVolume = 0;
  let volume = 0;
  const points: VwapPoint[] = [];
  for (const bar of bars) {
    if (bar.startTime < anchorTime || bar.startTime > endTime) continue;
    if (bar.volume > 0) {
      priceVolume += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
      volume += bar.volume;
    }
    points.push({
      time: bar.startTime,
      value: volume > 0 ? priceVolume / volume : null,
    });
  }
  return { anchorTime, points, available: points.some((point) => point.value !== null) };
}

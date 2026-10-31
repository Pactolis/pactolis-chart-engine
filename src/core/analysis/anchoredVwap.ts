import type { FootprintBar } from "../types.js";
import type { VwapPoint } from "./vwap.js";

export interface AnchoredVwapResult {
  anchorTime: number;
  points: VwapPoint[];
  available: boolean;
}

function findFirstBarIndex(bars: readonly FootprintBar[], anchorTime: number): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (bars[mid].startTime < anchorTime) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function calculateAnchoredVwap(
  bars: readonly FootprintBar[],
  anchorTime: number,
  endTime = Infinity
): AnchoredVwapResult {
  let priceVolume = 0;
  let volume = 0;
  const points: VwapPoint[] = [];
  const startIndex = findFirstBarIndex(bars, anchorTime);
  for (let i = startIndex; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.startTime > endTime) break;
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

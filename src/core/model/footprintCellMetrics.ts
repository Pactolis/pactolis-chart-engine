import type { FootprintBar, FootprintCell } from "../types.js";

export interface CellTradeCounts {
  buy: number;
  sell: number;
  total: number;
}

export interface CellAverageTradeSizes {
  buy: number;
  sell: number;
  total: number;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Returns bid/sell-side trade counts for a cell. New history/live data carries
 * exact buyCount/sellCount. Older caches only carry total count, so split the
 * total by volume ratio as a backward-compatible approximation.
 */
export function cellTradeCounts(cell: FootprintCell): CellTradeCounts {
  const explicitBuy = safeCount(cell.buyCount);
  const explicitSell = safeCount(cell.sellCount);
  const explicitTotal = explicitBuy + explicitSell;
  if (explicitTotal > 0) {
    return { buy: explicitBuy, sell: explicitSell, total: explicitTotal };
  }

  const total = safeCount(cell.count);
  if (total <= 0) return { buy: 0, sell: 0, total: 0 };

  const volumeTotal = cell.buyVol + cell.sellVol;
  if (volumeTotal <= 0) return { buy: 0, sell: 0, total };

  const buy = Math.round(total * (cell.buyVol / volumeTotal));
  const sell = Math.max(0, total - buy);
  return { buy, sell, total };
}

export function cellTotalVolume(cell: FootprintCell): number {
  return cell.buyVol + cell.sellVol;
}

export function cellDelta(cell: FootprintCell): number {
  return cell.buyVol - cell.sellVol;
}

export function cellDeltaPercent(cell: FootprintCell): number {
  const total = cellTotalVolume(cell);
  return total > 0 ? (cellDelta(cell) / total) * 100 : 0;
}

export function cellAverageTradeSize(cell: FootprintCell): number {
  const count = cellTradeCounts(cell).total;
  return count > 0 ? cellTotalVolume(cell) / count : 0;
}

export function cellAverageTradeSizes(cell: FootprintCell): CellAverageTradeSizes {
  const counts = cellTradeCounts(cell);
  return {
    buy: counts.buy > 0 ? cell.buyVol / counts.buy : 0,
    sell: counts.sell > 0 ? cell.sellVol / counts.sell : 0,
    total: counts.total > 0 ? cellTotalVolume(cell) / counts.total : 0,
  };
}

export function quoteVolumeForBar(bar: FootprintBar): number {
  if (bar.cells.size > 0) {
    let cellVolSum = 0;
    let cellNotionalSum = 0;
    for (const cell of bar.cells.values()) {
      const cellVol = cell.buyVol + cell.sellVol;
      cellVolSum += cellVol;
      cellNotionalSum += cell.priceBin * cellVol;
    }
    if (cellVolSum > 0) {
      const total = bar.volume > cellVolSum
        ? cellNotionalSum + (bar.volume - cellVolSum) * bar.close
        : cellNotionalSum;
      if (Number.isFinite(total) && total >= 0) return total;
    }
  }
  return Math.max(0, bar.close * bar.volume);
}

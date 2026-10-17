import type { FootprintBar, FootprintCell } from "../types.js";

export type ProfileMetric =
  | "volume"
  | "delta"
  | "trade-count"
  | "average-trade-size";

export type ProfileSide = "total" | "buy" | "sell";

export interface OrderFlowProfileOptions {
  profileMetric?: ProfileMetric;
  profileSide?: ProfileSide;
  valueAreaPercent?: number;
  developing?: boolean;
}

export interface OrderFlowProfileLevel {
  priceBin: number;
  buyVol: number;
  sellVol: number;
  totalVol: number;
  buyCount: number | null;
  sellCount: number | null;
  totalCount: number | null;
  value: number | null;
  buyValue: number | null;
  sellValue: number | null;
  magnitude: number | null;
  complete: boolean;
}

export interface DevelopingProfilePoint {
  time: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  valid: boolean;
}

export interface OrderFlowProfileResult {
  profileMetric: ProfileMetric;
  profileSide: ProfileSide;
  levels: OrderFlowProfileLevel[];
  summaryValue: number | null;
  totalBuyVolume: number;
  totalSellVolume: number;
  totalVolume: number;
  totalBuyCount: number | null;
  totalSellCount: number | null;
  totalTradeCount: number | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  fromTime: number | null;
  toTime: number | null;
  dataComplete: boolean;
  developing: DevelopingProfilePoint[];
}

interface ResolvedCounts {
  total: number | null;
  buy: number | null;
  sell: number | null;
  valid: boolean;
}

interface AccumulatedLevel {
  priceBin: number;
  buyVol: number;
  sellVol: number;
  totalCount: number;
  buyCount: number;
  sellCount: number;
  totalCountComplete: boolean;
  buyCountComplete: boolean;
  sellCountComplete: boolean;
  volumeComplete: boolean;
}

interface ProfileSnapshot {
  levels: OrderFlowProfileLevel[];
  summaryValue: number | null;
  totalBuyVolume: number;
  totalSellVolume: number;
  totalVolume: number;
  totalBuyCount: number | null;
  totalSellCount: number | null;
  totalTradeCount: number | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  dataComplete: boolean;
}

export function calculateOrderFlowProfile(
  bars: readonly FootprintBar[],
  options: OrderFlowProfileOptions = {},
): OrderFlowProfileResult {
  const profileMetric = normalizeMetric(options.profileMetric);
  const requestedSide = normalizeSide(options.profileSide);
  const profileSide: ProfileSide = profileMetric === "delta" ? "total" : requestedSide;
  const valueAreaPercent = clamp(options.valueAreaPercent ?? 0.7, 0.01, 0.99);
  const byPrice = new Map<number, AccumulatedLevel>();
  const orderedBars = [...bars].sort((a, b) => a.startTime - b.startTime);
  const developing: DevelopingProfilePoint[] = [];
  let fromTime: number | null = null;
  let toTime: number | null = null;

  for (const bar of orderedBars) {
    fromTime = fromTime === null ? bar.startTime : Math.min(fromTime, bar.startTime);
    toTime = toTime === null ? bar.startTime : Math.max(toTime, bar.startTime);
    for (const cell of bar.cells.values()) {
      accumulateCell(byPrice, cell);
    }

    if (options.developing) {
      const snapshot = buildSnapshot(byPrice, profileMetric, profileSide, valueAreaPercent);
      developing.push({
        time: bar.startTime,
        poc: snapshot.dataComplete ? snapshot.poc : null,
        vah: snapshot.dataComplete ? snapshot.vah : null,
        val: snapshot.dataComplete ? snapshot.val : null,
        valid: snapshot.dataComplete,
      });
    }
  }

  const snapshot = buildSnapshot(byPrice, profileMetric, profileSide, valueAreaPercent);
  return {
    profileMetric,
    profileSide,
    ...snapshot,
    fromTime,
    toTime,
    developing,
  };
}

function accumulateCell(
  byPrice: Map<number, AccumulatedLevel>,
  cell: FootprintCell,
): void {
  let level = byPrice.get(cell.priceBin);
  if (!level) {
    level = {
      priceBin: cell.priceBin,
      buyVol: 0,
      sellVol: 0,
      totalCount: 0,
      buyCount: 0,
      sellCount: 0,
      totalCountComplete: true,
      buyCountComplete: true,
      sellCountComplete: true,
      volumeComplete: true,
    };
    byPrice.set(cell.priceBin, level);
  }

  if (isValidVolume(cell.buyVol) && isValidVolume(cell.sellVol)) {
    level.buyVol += cell.buyVol;
    level.sellVol += cell.sellVol;
  } else {
    level.volumeComplete = false;
  }

  const counts = resolveCellCounts(cell);
  if (!counts.valid) {
    level.totalCountComplete = false;
    level.buyCountComplete = false;
    level.sellCountComplete = false;
    return;
  }

  if (counts.total === null) {
    level.totalCountComplete = false;
  } else {
    level.totalCount += counts.total;
  }
  if (counts.buy === null) {
    level.buyCountComplete = false;
  } else {
    level.buyCount += counts.buy;
  }
  if (counts.sell === null) {
    level.sellCountComplete = false;
  } else {
    level.sellCount += counts.sell;
  }
}

function resolveCellCounts(cell: FootprintCell): ResolvedCounts {
  const hasTotal = cell.count !== undefined;
  const hasBuy = cell.buyCount !== undefined;
  const hasSell = cell.sellCount !== undefined;
  const total = hasTotal && isValidCount(cell.count) ? cell.count! : null;
  const buy = hasBuy && isValidCount(cell.buyCount) ? cell.buyCount! : null;
  const sell = hasSell && isValidCount(cell.sellCount) ? cell.sellCount! : null;

  if ((hasTotal && total === null) || (hasBuy && buy === null) || (hasSell && sell === null)) {
    return { total: null, buy: null, sell: null, valid: false };
  }

  if (buy !== null && sell !== null) {
    const derivedTotal = buy + sell;
    if (total !== null && total !== derivedTotal) {
      return { total: null, buy: null, sell: null, valid: false };
    }
    return { total: total ?? derivedTotal, buy, sell, valid: true };
  }

  if (total !== null && buy !== null) {
    const derivedSell = total - buy;
    if (!isValidCount(derivedSell)) {
      return { total: null, buy: null, sell: null, valid: false };
    }
    return { total, buy, sell: derivedSell, valid: true };
  }

  if (total !== null && sell !== null) {
    const derivedBuy = total - sell;
    if (!isValidCount(derivedBuy)) {
      return { total: null, buy: null, sell: null, valid: false };
    }
    return { total, buy: derivedBuy, sell, valid: true };
  }

  return { total, buy, sell, valid: true };
}

function buildSnapshot(
  byPrice: ReadonlyMap<number, AccumulatedLevel>,
  metric: ProfileMetric,
  side: ProfileSide,
  valueAreaPercent: number,
): ProfileSnapshot {
  const levels = [...byPrice.values()]
    .sort((a, b) => a.priceBin - b.priceBin)
    .map((raw) => materializeLevel(raw, metric, side));

  const totalBuyVolume = levels.reduce((sum, level) => sum + level.buyVol, 0);
  const totalSellVolume = levels.reduce((sum, level) => sum + level.sellVol, 0);
  const totalVolume = totalBuyVolume + totalSellVolume;
  const totalTradeCount = sumNullable(levels, "totalCount");
  const totalBuyCount = sumNullable(levels, "buyCount");
  const totalSellCount = sumNullable(levels, "sellCount");
  const dataComplete = levels.every((level) => level.complete);
  const summaryValue = dataComplete
    ? calculateSummary(
        metric,
        side,
        totalBuyVolume,
        totalSellVolume,
        totalTradeCount,
        totalBuyCount,
        totalSellCount,
      )
    : null;

  const supportsLevels = metric === "volume" || metric === "trade-count";
  const staticLevels = supportsLevels && dataComplete
    ? calculateValueArea(levels, valueAreaPercent)
    : { poc: null, vah: null, val: null };

  return {
    levels,
    summaryValue,
    totalBuyVolume,
    totalSellVolume,
    totalVolume,
    totalBuyCount,
    totalSellCount,
    totalTradeCount,
    ...staticLevels,
    dataComplete,
  };
}

function materializeLevel(
  raw: AccumulatedLevel,
  metric: ProfileMetric,
  side: ProfileSide,
): OrderFlowProfileLevel {
  const totalVol = raw.buyVol + raw.sellVol;
  const totalCount = raw.totalCountComplete ? raw.totalCount : null;
  const buyCount = raw.buyCountComplete ? raw.buyCount : null;
  const sellCount = raw.sellCountComplete ? raw.sellCount : null;
  const selectedCount = side === "buy" ? buyCount : side === "sell" ? sellCount : totalCount;
  const selectedVolume = side === "buy" ? raw.buyVol : side === "sell" ? raw.sellVol : totalVol;

  let value: number | null;
  let buyValue: number | null = null;
  let sellValue: number | null = null;
  let complete = raw.volumeComplete;

  switch (metric) {
    case "volume":
      value = raw.volumeComplete ? selectedVolume : null;
      if (side === "total") {
        buyValue = raw.volumeComplete ? raw.buyVol : null;
        sellValue = raw.volumeComplete ? raw.sellVol : null;
      } else if (side === "buy") {
        buyValue = value;
      } else {
        sellValue = value;
      }
      break;
    case "delta":
      value = raw.volumeComplete ? raw.buyVol - raw.sellVol : null;
      break;
    case "trade-count":
      complete = complete && selectedCount !== null;
      value = complete ? selectedCount : null;
      if (side === "total") {
        buyValue = buyCount;
        sellValue = sellCount;
      } else if (side === "buy") {
        buyValue = value;
      } else {
        sellValue = value;
      }
      break;
    case "average-trade-size":
      complete = complete && selectedCount !== null && selectedCount > 0;
      value = complete ? selectedVolume / selectedCount! : null;
      if (side === "buy") buyValue = value;
      if (side === "sell") sellValue = value;
      break;
  }

  return {
    priceBin: raw.priceBin,
    buyVol: raw.buyVol,
    sellVol: raw.sellVol,
    totalVol,
    buyCount,
    sellCount,
    totalCount,
    value,
    buyValue,
    sellValue,
    magnitude: value === null ? null : metric === "delta" ? Math.abs(value) : Math.max(0, value),
    complete,
  };
}

function calculateSummary(
  metric: ProfileMetric,
  side: ProfileSide,
  buyVol: number,
  sellVol: number,
  totalCount: number | null,
  buyCount: number | null,
  sellCount: number | null,
): number | null {
  const totalVol = buyVol + sellVol;
  if (metric === "delta") return buyVol - sellVol;
  if (metric === "volume") return side === "buy" ? buyVol : side === "sell" ? sellVol : totalVol;
  const count = side === "buy" ? buyCount : side === "sell" ? sellCount : totalCount;
  if (metric === "trade-count") return count;
  if (count === null || count <= 0) return null;
  const volume = side === "buy" ? buyVol : side === "sell" ? sellVol : totalVol;
  return volume / count;
}

function calculateValueArea(
  levels: readonly OrderFlowProfileLevel[],
  valueAreaPercent: number,
): { poc: number | null; vah: number | null; val: number | null } {
  const weights = levels.map((level) => level.value ?? 0);
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (!levels.length || totalWeight <= 0) return { poc: null, vah: null, val: null };

  let pocIndex = 0;
  for (let i = 1; i < levels.length; i++) {
    if (weights[i] > weights[pocIndex]) pocIndex = i;
  }

  const target = totalWeight * valueAreaPercent;
  let low = pocIndex;
  let high = pocIndex;
  let included = weights[pocIndex];
  while (included < target && (low > 0 || high < levels.length - 1)) {
    const below = low > 0 ? weights[low - 1] : -1;
    const above = high < levels.length - 1 ? weights[high + 1] : -1;
    if (above > below) {
      high += 1;
      included += weights[high];
    } else {
      low -= 1;
      included += weights[low];
    }
  }

  return {
    poc: levels[pocIndex].priceBin,
    vah: levels[high].priceBin,
    val: levels[low].priceBin,
  };
}

function sumNullable(
  levels: readonly OrderFlowProfileLevel[],
  key: "totalCount" | "buyCount" | "sellCount",
): number | null {
  let total = 0;
  for (const level of levels) {
    const value = level[key];
    if (value === null) return null;
    total += value;
  }
  return total;
}

function normalizeMetric(metric: ProfileMetric | undefined): ProfileMetric {
  return metric === "delta" || metric === "trade-count" || metric === "average-trade-size"
    ? metric
    : "volume";
}

function normalizeSide(side: ProfileSide | undefined): ProfileSide {
  return side === "buy" || side === "sell" ? side : "total";
}

function isValidCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

function isValidVolume(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

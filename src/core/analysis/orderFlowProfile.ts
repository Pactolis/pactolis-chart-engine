import { quantizeToStep } from "../priceStep.js";
import type { FootprintBar, FootprintCell } from "../types.js";
import type { OiDeltaDisplay } from "../orderFlowProfileSettings.js";

export type ProfileMetric =
  | "volume"
  | "delta"
  | "trade-count"
  | "average-trade-size"
  | "oi-delta";

export type ProfileSide = "total" | "buy" | "sell";

export type ProfileSourceProvenance = "exact" | "estimated" | "mixed" | "none";
export type ProfileAvailability = "available" | "unavailable";
export type ProfileUnavailableReason = "exact-footprint-required";

export interface OrderFlowProfileCapabilities {
  metrics: Readonly<Record<ProfileMetric, boolean>>;
  sides: Readonly<Record<ProfileSide, boolean>>;
}

const ESTIMATED_PROFILE_CAPABILITIES: OrderFlowProfileCapabilities = Object.freeze({
  metrics: Object.freeze({
    volume: true,
    delta: false,
    "trade-count": false,
    "average-trade-size": false,
    "oi-delta": true,
  }),
  sides: Object.freeze({ total: true, buy: false, sell: false }),
});

const MAX_ESTIMATED_BINS_PER_BAR = 2_048;
const BOUNDARY_SNAP_EPSILON = 1e-10;

export interface OrderFlowProfileOptions {
  profileMetric?: ProfileMetric;
  profileSide?: ProfileSide;
  oiDeltaDisplay?: OiDeltaDisplay;
  valueAreaPercent?: number;
  developing?: boolean;
  /** Price bin step used for deterministic OHLCV distribution when `allowOhlcvEstimate` is true. */
  priceStep?: number;
  /** When true, an all-OHLCV window can fall back to OHLCV distribution (`volume`/`total` and `oi-delta`). */
  allowOhlcvEstimate?: boolean;
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
  oiOpen?: number;
  oiClose?: number;
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
  provenance: ProfileSourceProvenance;
  isEstimated: boolean;
  exactBarCount: number;
  estimatedBarCount: number;
  /** Present when source coverage is estimated and declares this selection's availability. */
  availability?: ProfileAvailability;
  /** Stable reason code for an estimated selection that needs exact footprint data. */
  unavailableReason?: ProfileUnavailableReason;
  /** Choices that the host can disable while the selected profile source is estimated. */
  capabilities?: OrderFlowProfileCapabilities;
}

interface ResolvedCounts {
  total: number | null;
  buy: number | null;
  sell: number | null;
  valid: boolean;
}

export interface AccumulatedLevel {
  priceBin: number;
  buyVol: number;
  sellVol: number;
  estimatedVol: number;
  oiOpen: number;
  oiClose: number;
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
  provenance: ProfileSourceProvenance;
  isEstimated: boolean;
  exactBarCount: number;
  estimatedBarCount: number;
  availability?: ProfileAvailability;
  unavailableReason?: ProfileUnavailableReason;
  capabilities?: OrderFlowProfileCapabilities;
}

interface ResolvedProfileOptions {
  profileMetric: ProfileMetric;
  profileSide: ProfileSide;
  oiDeltaDisplay: OiDeltaDisplay;
  valueAreaPercent: number;
  developing: boolean;
  priceStep: number | undefined;
  allowOhlcvEstimate: boolean;
}

/**
 * Running state of a profile build: the per-price histogram plus the developing series so
 * far. Cells are accumulated bar by bar in time order, so a state that holds every bar of
 * a window except its last one, cloned and fed that last bar, is bit-identical to a full
 * build over the whole window (same float additions in the same order). The indicator
 * uses this to answer a live tail tick without re-walking the window.
 */
export interface OrderFlowProfileAccumulator {
  byPrice: Map<number, AccumulatedLevel>;
  developing: DevelopingProfilePoint[];
  fromTime: number | null;
  toTime: number | null;
  exactBarCount: number;
  estimatedBarCount: number;
  hasUnsupportedEstimate: boolean;
}

function resolveProfileOptions(options: OrderFlowProfileOptions): ResolvedProfileOptions {
  const profileMetric = normalizeMetric(options.profileMetric);
  const requestedSide = normalizeSide(options.profileSide);
  const priceStep = typeof options.priceStep === "number" && Number.isFinite(options.priceStep) && options.priceStep > 0
    ? options.priceStep
    : undefined;
  return {
    profileMetric,
    profileSide: profileMetric === "delta" || profileMetric === "oi-delta" ? "total" : requestedSide,
    oiDeltaDisplay: options.oiDeltaDisplay === "split" ? "split" : "net",
    valueAreaPercent: clamp(options.valueAreaPercent ?? 0.7, 0.01, 0.99),
    developing: options.developing === true,
    priceStep,
    allowOhlcvEstimate: options.allowOhlcvEstimate === true,
  };
}

export function createOrderFlowProfileAccumulator(): OrderFlowProfileAccumulator {
  return {
    byPrice: new Map(),
    developing: [],
    fromTime: null,
    toTime: null,
    exactBarCount: 0,
    estimatedBarCount: 0,
    hasUnsupportedEstimate: false,
  };
}

export function cloneOrderFlowProfileAccumulator(acc: OrderFlowProfileAccumulator): OrderFlowProfileAccumulator {
  const byPrice = new Map<number, AccumulatedLevel>();
  for (const [price, level] of acc.byPrice) byPrice.set(price, { ...level });
  return {
    byPrice,
    developing: acc.developing.slice(),
    fromTime: acc.fromTime,
    toTime: acc.toTime,
    exactBarCount: acc.exactBarCount,
    estimatedBarCount: acc.estimatedBarCount,
    hasUnsupportedEstimate: acc.hasUnsupportedEstimate,
  };
}

/** Feeds one bar; bars must arrive in ascending startTime order to match a full build. */
export function accumulateOrderFlowProfileBar(
  acc: OrderFlowProfileAccumulator,
  bar: FootprintBar,
  options: OrderFlowProfileOptions = {},
): void {
  const resolved = resolveProfileOptions(options);
  acc.fromTime = acc.fromTime === null ? bar.startTime : Math.min(acc.fromTime, bar.startTime);
  acc.toTime = acc.toTime === null ? bar.startTime : Math.max(acc.toTime, bar.startTime);
  if (bar.cells.size > 0) {
    if (acc.exactBarCount === 0 && acc.estimatedBarCount > 0) {
      // OHLCV is a window-level fallback. Once any exact footprint bar appears,
      // preserve the historical exact behavior for the whole window: discard
      // earlier estimates and leave every cell-less bar out of the profile.
      acc.byPrice.clear();
      acc.estimatedBarCount = 0;
      acc.hasUnsupportedEstimate = false;
      if (acc.developing.length > 0) {
        const empty = buildSnapshot({
          byPrice: new Map(),
          exactBarCount: 0,
          estimatedBarCount: 0,
          hasUnsupportedEstimate: false,
        }, resolved.profileMetric, resolved.profileSide, resolved.valueAreaPercent);
        acc.developing = acc.developing.map(({ time }) => ({
          time,
          poc: empty.dataComplete ? empty.poc : null,
          vah: empty.dataComplete ? empty.vah : null,
          val: empty.dataComplete ? empty.val : null,
          valid: empty.dataComplete,
        }));
      }
    }
    acc.exactBarCount += 1;
    for (const cell of bar.cells.values()) {
      accumulateCell(acc.byPrice, cell);
    }
  } else {
    if (
      acc.exactBarCount === 0
      && resolved.allowOhlcvEstimate
      && resolved.priceStep !== undefined
      && isValidVolume(bar.volume)
      && bar.volume > 0
      && isValidPriceRange(bar.low, bar.high)
    ) {
      acc.estimatedBarCount += 1;
      if (resolved.profileMetric === "volume" && resolved.profileSide === "total") {
        accumulateEstimatedOhlcvBar(acc.byPrice, bar.low, bar.high, bar.volume, resolved.priceStep);
      } else {
        acc.hasUnsupportedEstimate = true;
      }
    }
  }
  if (resolved.developing) {
    const snapshot = buildSnapshot(acc, resolved.profileMetric, resolved.profileSide, resolved.valueAreaPercent, resolved.oiDeltaDisplay);
    acc.developing.push({
      time: bar.startTime,
      poc: snapshot.dataComplete ? snapshot.poc : null,
      vah: snapshot.dataComplete ? snapshot.vah : null,
      val: snapshot.dataComplete ? snapshot.val : null,
      valid: snapshot.dataComplete,
    });
  }
}

/**
 * Feeds one bar and its per-bar ΔOI into the profile accumulator.
 * Distributes ΔOI across footprint cells proportionally to `totalVol`, or uniformly across
 * `[low, high]` bins when the bar has no footprint cells and `allowOhlcvEstimate` is enabled.
 * Returns `true` if the bar was covered and accumulated, `false` if skipped.
 */
export function accumulateOrderFlowOiDeltaBar(
  acc: OrderFlowProfileAccumulator,
  bar: FootprintBar,
  barDeltaOi: number | null,
  options: OrderFlowProfileOptions = {},
): boolean {
  const resolved = resolveProfileOptions({ ...options, profileMetric: "oi-delta" });
  acc.fromTime = acc.fromTime === null ? bar.startTime : Math.min(acc.fromTime, bar.startTime);
  acc.toTime = acc.toTime === null ? bar.startTime : Math.max(acc.toTime, bar.startTime);
  if (barDeltaOi === null || !Number.isFinite(barDeltaOi)) {
    return false;
  }

  if (bar.cells.size > 0) {
    let totalCellVol = 0;
    for (const cell of bar.cells.values()) {
      if (isValidVolume(cell.buyVol) && isValidVolume(cell.sellVol)) {
        totalCellVol += cell.buyVol + cell.sellVol;
      }
    }
    if (totalCellVol > 0) {
      acc.exactBarCount += 1;
      for (const cell of bar.cells.values()) {
        if (!isValidVolume(cell.buyVol) || !isValidVolume(cell.sellVol)) continue;
        const cellVol = cell.buyVol + cell.sellVol;
        if (!(cellVol > 0)) continue;
        addOiDeltaToLevel(acc.byPrice, cell.priceBin, barDeltaOi * (cellVol / totalCellVol));
      }
      return true;
    }
  }

  if (
    resolved.allowOhlcvEstimate
    && resolved.priceStep !== undefined
    && isValidPriceRange(bar.low, bar.high)
  ) {
    acc.estimatedBarCount += 1;
    distributeUniformOhlcvBins(bar.low, bar.high, resolved.priceStep, (priceBin, fraction) => {
      addOiDeltaToLevel(acc.byPrice, priceBin, barDeltaOi * fraction);
    });
    return true;
  }

  return false;
}

export function finishOrderFlowProfile(
  acc: OrderFlowProfileAccumulator,
  options: OrderFlowProfileOptions = {},
): OrderFlowProfileResult {
  const resolved = resolveProfileOptions(options);
  const snapshot = buildSnapshot(acc, resolved.profileMetric, resolved.profileSide, resolved.valueAreaPercent, resolved.oiDeltaDisplay);
  return {
    profileMetric: resolved.profileMetric,
    profileSide: resolved.profileSide,
    ...snapshot,
    fromTime: acc.fromTime,
    toTime: acc.toTime,
    developing: acc.developing,
  };
}

export function calculateOrderFlowProfile(
  bars: readonly FootprintBar[],
  options: OrderFlowProfileOptions = {},
): OrderFlowProfileResult {
  const acc = createOrderFlowProfileAccumulator();
  const orderedBars = [...bars].sort((a, b) => a.startTime - b.startTime);
  for (const bar of orderedBars) accumulateOrderFlowProfileBar(acc, bar, options);
  return finishOrderFlowProfile(acc, options);
}

function getOrCreateLevel(byPrice: Map<number, AccumulatedLevel>, priceBin: number): AccumulatedLevel {
  let level = byPrice.get(priceBin);
  if (!level) {
    level = {
      priceBin,
      buyVol: 0,
      sellVol: 0,
      estimatedVol: 0,
      oiOpen: 0,
      oiClose: 0,
      totalCount: 0,
      buyCount: 0,
      sellCount: 0,
      totalCountComplete: true,
      buyCountComplete: true,
      sellCountComplete: true,
      volumeComplete: true,
    };
    byPrice.set(priceBin, level);
  }
  return level;
}

function addOiDeltaToLevel(byPrice: Map<number, AccumulatedLevel>, priceBin: number, deltaOi: number): void {
  if (!Number.isFinite(deltaOi)) return;
  const level = getOrCreateLevel(byPrice, priceBin);
  if (deltaOi >= 0) {
    level.oiOpen += deltaOi;
  } else {
    level.oiClose += deltaOi;
  }
}

function addEstimatedVolume(byPrice: Map<number, AccumulatedLevel>, priceBin: number, volume: number): void {
  if (!(volume > 0) || !Number.isFinite(volume)) return;
  const level = getOrCreateLevel(byPrice, priceBin);
  level.estimatedVol += volume;
  // OHLCV candles carry no trade counts; clear count completeness conservatively.
  level.totalCountComplete = false;
  level.buyCountComplete = false;
  level.sellCountComplete = false;
}

function distributeUniformOhlcvBins(
  low: number,
  high: number,
  step: number,
  onBin: (priceBin: number, fraction: number) => void,
): void {
  const range = high - low;
  if (!(range > 0)) {
    onBin(quantizeToStep(low, step), 1);
    return;
  }

  const uLow = low / step;
  const uHigh = high / step;
  const lowNearest = Math.round(uLow);
  const lowTick = Math.abs(uLow - lowNearest) <= BOUNDARY_SNAP_EPSILON * Math.max(1, Math.abs(uLow))
    ? lowNearest
    : Math.floor(uLow);
  const highNearest = Math.round(uHigh);
  const highOnBoundary = Math.abs(uHigh - highNearest) <= BOUNDARY_SNAP_EPSILON * Math.max(1, Math.abs(uHigh));
  const maxTick = highOnBoundary ? highNearest - 1 : Math.floor(uHigh);

  if (maxTick <= lowTick) {
    onBin(quantizeToStep(lowTick * step, step), 1);
    return;
  }

  const clampedLow = Math.max(uLow, lowTick);
  const clampedHigh = Math.min(uHigh, maxTick + 1);
  const effectiveSpan = clampedHigh - clampedLow;
  if (!(effectiveSpan > 0)) {
    onBin(quantizeToStep(lowTick * step, step), 1);
    return;
  }

  const spanTicks = maxTick - lowTick + 1;
  const stride = spanTicks > MAX_ESTIMATED_BINS_PER_BAR
    ? Math.ceil(spanTicks / MAX_ESTIMATED_BINS_PER_BAR)
    : 1;

  for (let tick = lowTick; tick <= maxTick; tick += stride) {
    const groupEnd = Math.min(maxTick + 1, tick + stride);
    const overlap = Math.min(clampedHigh, groupEnd) - Math.max(clampedLow, tick);
    if (!(overlap > 0)) continue;
    onBin(quantizeToStep(tick * step, step), overlap / effectiveSpan);
  }
}

/**
 * Distributes a bar's OHLCV volume uniformly across `priceStep` bins by [low, high] overlap.
 * Never fabricates taker buy/sell or trade-count splits; preserves total volume deterministically.
 */
function accumulateEstimatedOhlcvBar(
  byPrice: Map<number, AccumulatedLevel>,
  low: number,
  high: number,
  volume: number,
  step: number,
): void {
  distributeUniformOhlcvBins(low, high, step, (priceBin, fraction) => {
    addEstimatedVolume(byPrice, priceBin, volume * fraction);
  });
}

function accumulateCell(
  byPrice: Map<number, AccumulatedLevel>,
  cell: FootprintCell,
): void {
  const level = getOrCreateLevel(byPrice, cell.priceBin);

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

function resolveProvenance(exactBarCount: number, estimatedBarCount: number): ProfileSourceProvenance {
  if (exactBarCount > 0 && estimatedBarCount > 0) return "mixed";
  if (estimatedBarCount > 0) return "estimated";
  if (exactBarCount > 0) return "exact";
  return "none";
}

function buildSnapshot(
  acc: Pick<OrderFlowProfileAccumulator, "byPrice" | "exactBarCount" | "estimatedBarCount" | "hasUnsupportedEstimate">,
  metric: ProfileMetric,
  side: ProfileSide,
  valueAreaPercent: number,
  oiDeltaDisplay: OiDeltaDisplay = "net",
): ProfileSnapshot {
  const provenance = resolveProvenance(acc.exactBarCount, acc.estimatedBarCount);
  const isEstimated = provenance === "estimated" || provenance === "mixed";

  if (
    acc.hasUnsupportedEstimate
    || (isEstimated && metric !== "volume" && metric !== "oi-delta")
    || (isEstimated && metric === "volume" && side !== "total")
  ) {
    return {
      levels: [],
      summaryValue: null,
      totalBuyVolume: 0,
      totalSellVolume: 0,
      totalVolume: 0,
      totalBuyCount: null,
      totalSellCount: null,
      totalTradeCount: null,
      poc: null,
      vah: null,
      val: null,
      dataComplete: false,
      provenance,
      isEstimated: true,
      exactBarCount: acc.exactBarCount,
      estimatedBarCount: acc.estimatedBarCount,
      availability: "unavailable",
      unavailableReason: "exact-footprint-required",
      capabilities: ESTIMATED_PROFILE_CAPABILITIES,
    };
  }

  const levels = [...acc.byPrice.values()]
    .sort((a, b) => a.priceBin - b.priceBin)
    .map((raw) => materializeLevel(raw, metric, side, isEstimated, oiDeltaDisplay));

  const totalBuyVolume = levels.reduce((sum, level) => sum + level.buyVol, 0);
  const totalSellVolume = levels.reduce((sum, level) => sum + level.sellVol, 0);
  const totalVolume = isEstimated
    ? levels.reduce((sum, level) => sum + level.totalVol, 0)
    : totalBuyVolume + totalSellVolume;
  const totalTradeCount = isEstimated ? null : sumNullable(levels, "totalCount");
  const totalBuyCount = isEstimated ? null : sumNullable(levels, "buyCount");
  const totalSellCount = isEstimated ? null : sumNullable(levels, "sellCount");
  const dataComplete = levels.every((level) => level.complete);
  const summaryValue = metric === "oi-delta"
    ? levels.reduce((sum, level) => sum + (level.value ?? 0), 0)
    : dataComplete
      ? isEstimated
        ? totalVolume
        : calculateSummary(
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
    provenance,
    isEstimated,
    exactBarCount: acc.exactBarCount,
    estimatedBarCount: acc.estimatedBarCount,
    ...(isEstimated ? {
      availability: "available" as const,
      capabilities: ESTIMATED_PROFILE_CAPABILITIES,
    } : {}),
  };
}

function materializeLevel(
  raw: AccumulatedLevel,
  metric: ProfileMetric,
  side: ProfileSide,
  isEstimated: boolean,
  oiDeltaDisplay: OiDeltaDisplay = "net",
): OrderFlowProfileLevel {
  const totalVol = isEstimated ? raw.buyVol + raw.sellVol + raw.estimatedVol : raw.buyVol + raw.sellVol;
  if (metric === "oi-delta") {
    const net = raw.oiOpen + raw.oiClose;
    const magnitude = oiDeltaDisplay === "split"
      ? Math.max(raw.oiOpen, Math.abs(raw.oiClose))
      : Math.abs(net);
    return {
      priceBin: raw.priceBin,
      buyVol: raw.buyVol,
      sellVol: raw.sellVol,
      totalVol,
      buyCount: null,
      sellCount: null,
      totalCount: null,
      value: net,
      buyValue: raw.oiOpen,
      sellValue: raw.oiClose,
      oiOpen: raw.oiOpen,
      oiClose: raw.oiClose,
      magnitude,
      complete: true,
    };
  }
  const totalCount = !isEstimated && raw.totalCountComplete ? raw.totalCount : null;
  const buyCount = !isEstimated && raw.buyCountComplete ? raw.buyCount : null;
  const sellCount = !isEstimated && raw.sellCountComplete ? raw.sellCount : null;
  const selectedCount = side === "buy" ? buyCount : side === "sell" ? sellCount : totalCount;
  const selectedVolume = side === "buy" ? raw.buyVol : side === "sell" ? raw.sellVol : totalVol;

  let value: number | null;
  let buyValue: number | null = null;
  let sellValue: number | null = null;
  let complete = raw.volumeComplete;

  if (isEstimated) {
    // Estimated and mixed windows expose total volume without fabricated buy/sell splits.
    value = raw.volumeComplete && metric === "volume" && side === "total" ? totalVol : null;
    complete = value !== null;
    return {
      priceBin: raw.priceBin,
      buyVol: raw.buyVol,
      sellVol: raw.sellVol,
      totalVol,
      buyCount: null,
      sellCount: null,
      totalCount: null,
      value,
      buyValue: null,
      sellValue: null,
      magnitude: value === null ? null : Math.max(0, value),
      complete,
    };
  }

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
  return metric === "delta" || metric === "trade-count" || metric === "average-trade-size" || metric === "oi-delta"
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

function isValidPriceRange(low: unknown, high: unknown): boolean {
  return (
    typeof low === "number"
    && typeof high === "number"
    && Number.isFinite(low)
    && Number.isFinite(high)
    && low <= high
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

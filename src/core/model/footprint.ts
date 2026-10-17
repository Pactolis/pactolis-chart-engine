// Aggregates raw trades into footprint bars (time bucket x price bin).
import type { AggTrade, FootprintBar, FootprintCell } from "../types.js";
import { WEEK_MS, bucketEnd, bucketStart, monthSpan } from "../time.js";
import { enforceFootprintPolicy, footprintEnabledAt } from "../footprintPolicy.js";
import { tradeFingerprint, validateBar, validateTrade } from "../dataContracts.js";
import { addDeltaBySize } from "../analysis/calc/ta.js";
import { quantizeToStep } from "../priceStep.js";
import { getFootprintSupport } from "../syncAllowlist.js";

export interface FootprintConfig {
  intervalMs: number;
  priceStep: number;
  referenceMarket?: string;
  pricePrecision?: number;
}

export interface ReplaceRangeOptions {
  preserveCells?: boolean;
}

export interface ReassertOHLCOptions {
  close?: number;
  preferIncomingClose?: boolean;
  observedAt?: number;
}

interface CarriedCells {
  cells: Map<number, FootprintCell>;
  liquidationBuyVol: number;
  liquidationSellVol: number;
  deltaBySize: number[] | undefined;
}

interface RepairOwnership {
  watermark: bigint;
  seenTailIds: Set<string>;
}

interface RefTradeOrder {
  time: number;
  sequence: number | null;
  id: bigint | null;
}

interface RefTradeBounds {
  first: RefTradeOrder;
  last: RefTradeOrder;
  authoritativeOpen: boolean;
}

function carryCells(bar: FootprintBar, carried: Map<number, CarriedCells>): FootprintBar {
  if (bar.cells.size > 0) return bar;
  const previous = carried.get(bar.startTime);
  if (!previous || previous.cells.size === 0) return bar;
  return {
    ...bar,
    cells: previous.cells,
    liquidationBuyVol: previous.liquidationBuyVol,
    liquidationSellVol: previous.liquidationSellVol,
    deltaBySize: previous.deltaBySize,
  };
}

export interface AddTradesProgress {
  done: number;
  total: number;
  bars: number;
  recentTrades: number;
  elapsedMs: number;
}

export interface AddTradesOptions {
  dedupe?: boolean;
  progressEvery?: number;
  onProgress?: (progress: AddTradesProgress) => void;
}

const BASIS_ALPHA = 0.1;
const MAX_TICK_DEV = 0.003;
const OUTLIER_CONFIRM = 3;
const MAX_REPAIR_OWNED_BUCKETS = 32;
/**
 * Upper bound on bars one series retains while trades keep opening new buckets on an
 * open chart. History loads `runtimeConfig.targetBars` (default 4_000) and the view
 * shows at most MAX_VISIBLE_BARS (4_000), so this leaves an order of magnitude of
 * headroom and only ever drops the oldest bars once a chart has been left open long
 * enough to accumulate far more than it can load or display.
 */
export const MAX_SERIES_BARS = 50_000;
const DECIMAL_TRADE_ID = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
/**
 * Markets whose trade IDs are exchange aggTrade IDs that only grow (Binance spot and
 * futures). Other venues' IDs, decimal or not, carry no order a pruning floor can use.
 */
const MONOTONIC_TRADE_ID_MARKET = /^BINANCE(_FUTURES)?:/;

interface RecentTrade {
  time: number;
  /** Payload of an identified trade, compared when the same identity is delivered again. */
  payload?: string;
  /** Market and aggTrade ID of an identified normal trade on a monotonic-ID market. */
  market?: string;
  id?: bigint;
}

export function identifiedPayload(trade: AggTrade): string {
  return `${trade.time}|${trade.price}|${trade.qty}|${trade.tradeCount ?? 1}|${trade.isBuy ? 1 : 0}|${trade.liquidation ? 1 : 0}`;
}

function exactTradeId(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 20 || !DECIMAL_TRADE_ID.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_U64 ? parsed : null;
}

/** Tail IDs are tracked per component (`c:` candle, `f:` footprint). */
function markTailConsumed(seen: Set<string>, id: bigint, candle: boolean, footprint: boolean): void {
  const key = id.toString();
  if (candle) seen.add(`c:${key}`);
  if (footprint) seen.add(`f:${key}`);
}

function orderForTrade(trade: AggTrade): RefTradeOrder {
  return {
    time: trade.time,
    sequence: Number.isSafeInteger(trade.sourceSequence) ? trade.sourceSequence! : null,
    id: exactTradeId(trade.id),
  };
}

function compareTradeOrder(left: RefTradeOrder, right: RefTradeOrder): number {
  if (left.time !== right.time) return left.time < right.time ? -1 : 1;
  if (left.sequence !== null && right.sequence !== null && left.sequence !== right.sequence) {
    return left.sequence < right.sequence ? -1 : 1;
  }
  if (left.id !== null && right.id !== null && left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

export class FootprintSeries {
  private readonly bars = new Map<number, FootprintBar>();
  private order: number[] = [];

  private referenceMarket?: string;
  private refPrice: number | undefined;
  private refRejectStreak = 0;
  private readonly basis = new Map<string, number>();
  private revisionValue = 0;
  private structureRevisionValue = 0;
  private orderedSnapshotStructureRevision = -1;
  private orderedSnapshot: readonly FootprintBar[] = [];
  private pricePrecisionExplicit: boolean;
  private readonly recentTrades = new Map<string, RecentTrade>();
  private nextRecentTradesPruneAt = 0;
  /**
   * Per monotonic-ID market, the highest aggTrade ID evicted from `recentTrades`. Those
   * IDs only grow, so a normal trade at or below it was already applied and is a late
   * re-delivery; without this floor it would be counted a second time. Other markets
   * keep the bounded-window dedup only.
   */
  private readonly prunedTradeIdFloor = new Map<string, bigint>();
  private resetEpochValue = 0;
  private identityConflictCountValue = 0;
  private readonly repairOwnership = new Map<number, RepairOwnership>();
  private readonly repairFences = new Map<number, RepairOwnership>();
  private readonly repairBarriers = new Set<number>();
  private readonly refTradeBounds = new Map<number, RefTradeBounds>();

  constructor(private readonly cfg: FootprintConfig) {
    this.referenceMarket = cfg.referenceMarket;
    this.pricePrecisionExplicit = cfg.pricePrecision !== undefined;
  }

  get config(): FootprintConfig { return this.cfg; }
  get revision(): number { return this.revisionValue; }
  get structureRevision(): number { return this.structureRevisionValue; }
  /** Deliveries that reused an already-applied trade identity with a different payload. */
  get identityConflictCount(): number { return this.identityConflictCountValue; }
  /** Advances whenever the series is cleared and rebuilt (config change, full load). */
  get resetEpoch(): number { return this.resetEpochValue; }

  setReferenceMarket(market: string | undefined): void {
    this.referenceMarket = market;
    this.refPrice = undefined;
    this.refRejectStreak = 0;
    this.basis.clear();
    this.refTradeBounds.clear();
  }

  setInterval(ms: number): void {
    this.cfg.intervalMs = ms;
    this.clear();
  }

  setPricePrecision(precision: number): void {
    this.pricePrecisionExplicit = true;
    if (this.cfg.pricePrecision === precision) return;
    this.cfg.pricePrecision = precision;
    this.revisionValue++;
  }

  resetPricePrecision(): void {
    this.pricePrecisionExplicit = false;
    if (this.cfg.pricePrecision === undefined) return;
    this.cfg.pricePrecision = undefined;
    this.revisionValue++;
  }

  setPriceStep(step: number): void {
    this.cfg.priceStep = step;
    this.clear();
  }

  loadBars(bars: FootprintBar[]): void {
    this.clear();
    for (const b of bars) {
      const safeBar = enforceFootprintPolicy(b);
      validateBar(safeBar, this.cfg.intervalMs);
      if (!this.bars.has(safeBar.startTime)) this.order.push(safeBar.startTime);
      this.bars.set(safeBar.startTime, safeBar);
    }
    this.order.sort((a, b) => a - b);
    this.inferPricePrecision(bars);
    this.pruneLegacyCalendarOverlaps();
    const lastStart = this.order[this.order.length - 1];
    if (lastStart !== undefined) this.refPrice = this.bars.get(lastStart)!.close;
    this.revisionValue++;
    this.structureRevisionValue++;
  }

  private visibleOrder(): readonly number[] {
    return this.order;
  }

  get length(): number { return this.visibleOrder().length; }

  clear(): void {
    this.bars.clear();
    this.order = [];
    this.refPrice = undefined;
    this.refRejectStreak = 0;
    this.basis.clear();
    this.recentTrades.clear();
    this.prunedTradeIdFloor.clear();
    this.resetEpochValue++;
    this.repairOwnership.clear();
    this.repairFences.clear();
    this.repairBarriers.clear();
    this.refTradeBounds.clear();
    this.nextRecentTradesPruneAt = 0;
    this.revisionValue++;
    this.structureRevisionValue++;
  }

  list(): FootprintBar[] { return [...this.listReadonly()]; }

  listReadonly(): readonly FootprintBar[] {
    if (this.orderedSnapshotStructureRevision !== this.structureRevisionValue) {
      this.orderedSnapshot = this.visibleOrder().map((t) => this.bars.get(t)!);
      this.orderedSnapshotStructureRevision = this.structureRevisionValue;
    }
    return this.orderedSnapshot;
  }

  at(index: number): FootprintBar | undefined {
    const t = this.visibleOrder()[index];
    return t === undefined ? undefined : this.bars.get(t);
  }

  get(startTime: number): FootprintBar | undefined { return this.bars.get(startTime); }

  beginRepairBarrier(bucketStarts: readonly number[]): void {
    let changed = false;
    for (const start of bucketStarts) {
      if (!Number.isFinite(start) || this.repairBarriers.has(start)) continue;
      this.repairBarriers.add(start);
      changed = true;
    }
    if (changed) this.revisionValue++;
  }

  releaseRepairBarriers(bucketStarts?: readonly number[]): void {
    let changed = false;
    if (!bucketStarts) {
      changed = this.repairBarriers.size > 0;
      this.repairBarriers.clear();
    } else {
      for (const start of bucketStarts) changed = this.repairBarriers.delete(start) || changed;
    }
    if (changed) this.revisionValue++;
  }

  beginRepairFence(bucketStarts: readonly number[], watermark: bigint, blockedTail: readonly AggTrade[]): void {
    const unique = [...new Set(bucketStarts.filter(Number.isFinite))].sort((a, b) => a - b);
    for (const start of unique) {
      const seenTailIds = new Set<string>();
      for (const trade of blockedTail) {
        if (trade.liquidation === true || bucketStart(trade.time, this.cfg.intervalMs) !== start) continue;
        const id = exactTradeId(trade.id);
        if (id !== null && id > watermark) markTailConsumed(seenTailIds, id, true, true);
      }
      this.repairFences.set(start, { watermark, seenTailIds });
    }
  }

  releaseRepairFence(bucketStarts?: readonly number[]): void {
    if (!bucketStarts) {
      this.repairFences.clear();
      return;
    }
    for (const start of bucketStarts) this.repairFences.delete(start);
  }

  /**
   * Transfer only the buckets actually supplied by a frozen repair snapshot to W ownership.
   * Normal aggTrades at/below W, plus already-applied tail IDs, are rejected even when a
   * later pipeline flush uses `dedupe:false`. Liquidations intentionally bypass this fence.
   */
  commitRepairOwnership(bucketStarts: readonly number[], watermark: bigint, appliedTail: readonly AggTrade[]): void {
    const unique = [...new Set(bucketStarts.filter(Number.isFinite))].sort((a, b) => a - b);
    let barrierChanged = false;
    for (const start of unique) {
      const seenTailIds = new Set<string>();
      for (const trade of appliedTail) {
        if (trade.liquidation === true || bucketStart(trade.time, this.cfg.intervalMs) !== start) continue;
        const id = exactTradeId(trade.id);
        if (id !== null && id > watermark) markTailConsumed(seenTailIds, id, true, true);
      }
      this.repairOwnership.set(start, { watermark, seenTailIds });
      barrierChanged = this.repairBarriers.delete(start) || barrierChanged;
    }
    while (this.repairOwnership.size > MAX_REPAIR_OWNED_BUCKETS) {
      const oldest = [...this.repairOwnership.keys()].sort((a, b) => a - b)[0];
      if (oldest === undefined) break;
      this.repairOwnership.delete(oldest);
    }
    if (barrierChanged) this.revisionValue++;
  }

  indexOfTime(time: number): number {
    const order = this.visibleOrder();
    const n = order.length;
    if (n === 0) return 0;
    const first = order[0];
    if (time <= first) return (time - first) / this.cfg.intervalMs;
    const last = order[n - 1];
    if (time >= last) return n - 1 + (time - last) / this.cfg.intervalMs;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (order[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    const spanned = order[lo + 1] - order[lo];
    return spanned > 0 ? lo + (time - order[lo]) / spanned : lo;
  }

  timeOfIndex(index: number): number {
    const order = this.visibleOrder();
    const n = order.length;
    if (n === 0) return Date.now();
    if (index <= 0) return order[0] + index * this.cfg.intervalMs;
    if (index >= n - 1) return order[n - 1] + (index - (n - 1)) * this.cfg.intervalMs;
    const lo = Math.floor(index);
    const spanned = order[lo + 1] - order[lo];
    return order[lo] + (index - lo) * spanned;
  }

  /** Whether a proven trade-id repair snapshot owns this bucket; only another proven snapshot may rewrite it. */
  isRepairOwned(startTime: number): boolean {
    return this.repairOwnership.has(startTime);
  }

  reassertOHLC(startTime: number, open: number, high: number, low: number, options: ReassertOHLCOptions = {}): void {
    if (this.repairOwnership.has(startTime)) return;
    const bar = this.bars.get(startTime);
    if (!bar) return;
    const takeIncomingClose = options.preferIncomingClose === true && options.close !== undefined;
    const close = takeIncomingClose ? options.close! : bar.close;
    bar.open = open;
    bar.high = Math.max(bar.high, high, close);
    bar.low = Math.min(bar.low, low, close);
    bar.close = close;
    // Keep the live trade order: dropping it would let a delayed trade move the close back.
    // The open is the snapshot's from here on.
    const bounds = this.refTradeBounds.get(startTime);
    if (bounds) bounds.authoritativeOpen = true;
    if (takeIncomingClose && options.observedAt !== undefined) {
      bar.updatedAt = Math.max(bar.updatedAt ?? 0, options.observedAt);
    }
    bar.hasRef = true;
    this.revisionValue++;
  }

  /**
   * Insert or overwrite one bar. A bucket a proven trade-id repair snapshot owns, or one a
   * repair is fencing, only changes through `replaceRange`; an unproven bar is ignored there.
   * Returns whether the bar was written.
   */
  upsertBar(bar: FootprintBar): boolean {
    const safeBar = enforceFootprintPolicy(bar);
    validateBar(safeBar, this.cfg.intervalMs);
    if (this.repairOwnership.has(safeBar.startTime) || this.repairFences.has(safeBar.startTime)) return false;
    if (!this.bars.has(safeBar.startTime)) this.insertOrdered(safeBar.startTime);
    this.bars.set(safeBar.startTime, safeBar);
    this.refTradeBounds.delete(safeBar.startTime);
    this.inferPricePrecision([safeBar]);
    this.pruneLegacyCalendarOverlaps();
    this.pruneOldestBars();
    if (this.refPrice === undefined) this.refPrice = safeBar.close;
    this.revisionValue++;
    this.structureRevisionValue++;
    return true;
  }

  private cellSnapshot(removeFrom: number, removeTo: number): Map<number, CarriedCells> {
    const snapshot = new Map<number, CarriedCells>();
    for (let index = removeFrom; index < removeTo; index++) {
      const start = this.order[index];
      const bar = this.bars.get(start);
      if (!bar || bar.cells.size === 0) continue;
      snapshot.set(start, {
        cells: bar.cells,
        liquidationBuyVol: bar.liquidationBuyVol ?? 0,
        liquidationSellVol: bar.liquidationSellVol ?? 0,
        deltaBySize: bar.deltaBySize,
      });
    }
    return snapshot;
  }

  replaceRange(from: number, to: number, bars: readonly FootprintBar[], options?: ReplaceRangeOptions): void {
    let changed = false;
    const removeFrom = lowerBound(this.order, from);
    const removeTo = lowerBound(this.order, to);
    const removeCount = removeTo - removeFrom;
    const liveStart = bucketStart(Date.now(), this.cfg.intervalMs);
    const repairReplace = [...this.repairBarriers].some((start) => start >= from && start < to);
    const protectedLiveBar = !repairReplace && liveStart >= from && liveStart < to ? this.bars.get(liveStart) : undefined;
    const carried = options?.preserveCells ? this.cellSnapshot(removeFrom, removeTo) : null;

    // Validate and normalize every incoming bar before mutating any series-owned state.
    // This keeps Map/order/revision/repair metadata atomic when one later bar is invalid.
    const preparedBars: FootprintBar[] = [];
    for (const bar of bars) {
      if (protectedLiveBar && bar.startTime === liveStart) continue;
      const safeBar = enforceFootprintPolicy(carried ? carryCells(bar, carried) : bar);
      validateBar(safeBar, this.cfg.intervalMs);
      preparedBars.push(safeBar);
    }

    // FE-338: live trade-order bounds survive only where the exact current stored
    // bar instance is genuinely retained by this replacement -- the protected live
    // bar, or an incoming bar that already IS that stored instance after validation
    // and normalization. A new bar instance at a timestamp still resets its bounds
    // below, so the history open/close stays authoritative there.
    const retainedBounds = new Map<number, { bar: FootprintBar; bounds: RefTradeBounds }>();
    if (protectedLiveBar) {
      const bounds = this.refTradeBounds.get(liveStart);
      if (bounds) retainedBounds.set(liveStart, { bar: protectedLiveBar, bounds });
    }
    for (const safeBar of preparedBars) {
      if (safeBar !== this.bars.get(safeBar.startTime)) continue;
      const bounds = this.refTradeBounds.get(safeBar.startTime);
      if (bounds) retainedBounds.set(safeBar.startTime, { bar: safeBar, bounds });
    }

    // FE-338: committed repair ownership survives the same exact-instance
    // retention as the live trade-order bounds above, but decoupled from
    // whether refTradeBounds exist at all: an owned bucket may have had zero
    // post-snapshot live prints. Retention is decided against the FINAL
    // winning stored identity after all inserts, so a later duplicate bar
    // instance ([stored, new]) still resets ownership while [new, stored]
    // retains it.
    const retainedOwnership: { start: number; bar: FootprintBar; ownership: RepairOwnership }[] = [];
    for (const [start, ownership] of this.repairOwnership) {
      if (start < from || start >= to) continue;
      const bar = this.bars.get(start);
      if (bar !== undefined) retainedOwnership.push({ start, bar, ownership });
    }
    for (const start of [...this.repairOwnership.keys()]) {
      if (start >= from && start < to) this.repairOwnership.delete(start);
    }
    let barrierChanged = false;
    if (!repairReplace) {
      for (const start of [...this.repairBarriers]) {
        if (start >= from && start < to) barrierChanged = this.repairBarriers.delete(start) || barrierChanged;
      }
    }

    if (removeCount > 0) {
      for (let index = removeFrom; index < removeTo; index++) {
        const start = this.order[index];
        this.bars.delete(start);
        this.refTradeBounds.delete(start);
      }
      changed = true;
    }

    const incomingStarts: number[] = [];
    const incomingStartSet = new Set<number>();
    let incomingWithinRange = true;
    for (const safeBar of preparedBars) {
      this.bars.set(safeBar.startTime, safeBar);
      this.refTradeBounds.delete(safeBar.startTime);
      incomingWithinRange &&= safeBar.startTime >= from && safeBar.startTime < to;
      if (!incomingStartSet.has(safeBar.startTime)) {
        incomingStartSet.add(safeBar.startTime);
        incomingStarts.push(safeBar.startTime);
      }
      changed = true;
    }
    if (protectedLiveBar) {
      this.bars.set(liveStart, protectedLiveBar);
      if (!incomingStartSet.has(liveStart)) {
        incomingStartSet.add(liveStart);
        incomingStarts.push(liveStart);
      }
      changed = true;
    }
    for (const [start, retained] of retainedBounds) {
      if (this.bars.get(start) === retained.bar) this.refTradeBounds.set(start, retained.bounds);
    }

    if (changed) {
      incomingStarts.sort((a, b) => a - b);
      if (removeCount > 0 && incomingWithinRange) {
        this.order.splice(removeFrom, removeCount, ...incomingStarts);
      } else {
        const retainedOrder = removeCount > 0
          ? [...this.order.slice(0, removeFrom), ...this.order.slice(removeTo)]
          : this.order;
        this.order = mergeSortedStarts(retainedOrder, incomingStarts);
      }
    }
    this.inferPricePrecision(preparedBars);
    if (this.pruneLegacyCalendarOverlaps()) changed = true;
    for (const retained of retainedOwnership) {
      // Only restore ownership where the exact current stored bar instance
      // is still the FINAL winner after inserts and prunes; a removed,
      // pruned or replaced bucket keeps the existing reset semantics.
      if (this.bars.get(retained.start) === retained.bar) {
        this.repairOwnership.set(retained.start, retained.ownership);
      }
    }
    if (!changed && !barrierChanged) return;
    const lastStart = this.order[this.order.length - 1];
    if (this.refPrice === undefined && lastStart !== undefined) this.refPrice = this.bars.get(lastStart)!.close;
    this.revisionValue++;
    this.structureRevisionValue++;
  }

  addTrade(trade: AggTrade): void { this.addTradeInternal(trade, true, true, true); }

  addCandleTrades(trades: readonly AggTrade[]): void {
    for (const trade of trades) {
      if (trade.liquidation === true) continue;
      this.addTradeInternal(trade, false, true, false);
    }
  }

  addFootprintTrades(trades: readonly AggTrade[]): void {
    for (const trade of trades) this.addTradeInternal(trade, false, false, true);
  }

  private raisePrunedTradeIdFloor(market: string, id: bigint): void {
    const floor = this.prunedTradeIdFloor.get(market);
    if (floor === undefined || id > floor) this.prunedTradeIdFloor.set(market, id);
  }

  /** Record identity conflicts found outside the live dedup path (e.g. a repair tail). */
  recordIdentityConflicts(count: number): void {
    if (count > 0) this.identityConflictCountValue += count;
  }

  /**
   * Returns which components of a normal trade may still be applied to a fenced or
   * repair-owned bucket. Candle and footprint are consumed separately, so a tail trade
   * replayed as candle and footprint in two calls keeps both halves exactly once.
   */
  private repairOwnedRemainder(
    trade: AggTrade,
    start: number,
    includeCandle: boolean,
    includeFootprint: boolean,
  ): { candle: boolean; footprint: boolean } {
    const all = { candle: includeCandle, footprint: includeFootprint };
    if (trade.liquidation === true) return all;
    const ownership = this.repairFences.get(start) ?? this.repairOwnership.get(start);
    if (!ownership) return all;
    if (this.referenceMarket && trade.market !== undefined && trade.market !== this.referenceMarket) return all;
    const id = exactTradeId(trade.id);
    if (id === null || id <= ownership.watermark) return { candle: false, footprint: false };
    const key = id.toString();
    const candle = includeCandle && !ownership.seenTailIds.has(`c:${key}`);
    const footprint = includeFootprint && !ownership.seenTailIds.has(`f:${key}`);
    markTailConsumed(ownership.seenTailIds, id, candle, footprint);
    return { candle, footprint };
  }

  private addTradeInternal(trade: AggTrade, dedupe: boolean, includeCandle: boolean, includeFootprint: boolean): void {
    validateTrade(trade);
    const start = bucketStart(trade.time, this.cfg.intervalMs);
    const fingerprint = dedupe ? tradeFingerprint(trade) : "";
    const payload = dedupe && trade.id ? identifiedPayload(trade) : undefined;
    if (dedupe) {
      // First delivery wins; a repeat with a different payload is still rejected below
      // but counted so the owner can stop reporting the data as healthy.
      const seen = this.recentTrades.get(fingerprint);
      if (seen?.payload !== undefined && seen.payload !== payload) this.identityConflictCountValue++;
    }
    const remainder = this.repairOwnedRemainder(trade, start, includeCandle, includeFootprint);
    if (!remainder.candle && !remainder.footprint) return;
    includeCandle = remainder.candle;
    includeFootprint = remainder.footprint;
    if (dedupe) {
      if (this.recentTrades.has(fingerprint)) return;
      const market = trade.market ?? "";
      const id = payload !== undefined && trade.liquidation !== true && MONOTONIC_TRADE_ID_MARKET.test(market)
        ? exactTradeId(trade.id)
        : null;
      if (id !== null) {
        const floor = this.prunedTradeIdFloor.get(market);
        if (floor !== undefined && id <= floor) return;
      }
      this.recentTrades.set(fingerprint, payload === undefined
        ? { time: trade.time }
        : id === null ? { time: trade.time, payload } : { time: trade.time, payload, market, id });
      if (this.recentTrades.size > 50_000 && trade.time >= this.nextRecentTradesPruneAt) {
        const retentionMs = Math.max(this.cfg.intervalMs * 2, 60_000);
        const cutoff = trade.time - retentionMs;
        for (const [key, entry] of this.recentTrades) {
          if (entry.time >= cutoff) continue;
          this.recentTrades.delete(key);
          if (entry.market !== undefined && entry.id !== undefined) this.raisePrunedTradeIdFloor(entry.market, entry.id);
        }
        this.nextRecentTradesPruneAt = trade.time + Math.max(10_000, Math.floor(retentionMs / 4));
      }
    }

    const isLiq = trade.liquidation === true;
    const footprintSupported = !this.referenceMarket || getFootprintSupport(this.referenceMarket) !== false;
    const includeCells = includeFootprint
      && footprintSupported
      && (isLiq || !this.repairBarriers.has(start));
    const isRef = !this.referenceMarket || trade.market === undefined || trade.market === this.referenceMarket;
    let price: number;
    let skipOHLC = isLiq;
    if (isLiq) {
      price = trade.price;
    } else if (isRef && this.isRefOutlier(trade.price)) {
      price = trade.price;
      skipOHLC = true;
    } else {
      price = this.normalizePrice(trade, isRef);
      if (Number.isNaN(price)) price = trade.price;
    }

    let bar = this.bars.get(start);
    let structureChanged = false;
    if (!bar) {
      bar = {
        startTime: start,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        delta: 0,
        deltaBySize: undefined,
        count: 0,
        liquidationBuyVol: 0,
        liquidationSellVol: 0,
        cells: new Map<number, FootprintCell>(),
        hasRef: false,
        completeness: "provisional",
        sources: [trade.source ?? "live"],
        updatedAt: trade.receivedAt ?? Date.now(),
        cellRevision: 0,
      };
      this.bars.set(start, bar);
      this.insertOrdered(start);
      structureChanged = true;
      if (this.pruneLegacyCalendarOverlaps()) structureChanged = true;
      this.pruneOldestBars();
    }

    if (!includeCandle) {
      // Snapshot owns candle OHLC; footprint-only replay must not mutate it.
    } else if (skipOHLC) {
      // Volume-only print.
    } else if (isRef) {
      const tradeOrder = orderForTrade(trade);
      const bounds = this.refTradeBounds.get(start);
      if (!bar.hasRef) {
        bar.open = price;
        bar.high = price;
        bar.low = price;
        bar.close = price;
        bar.hasRef = true;
        this.refTradeBounds.set(start, { first: tradeOrder, last: tradeOrder, authoritativeOpen: false });
      } else {
        bar.high = Math.max(bar.high, price);
        bar.low = Math.min(bar.low, price);
        if (!bounds) {
          // The bar was seeded from history/snapshot data. Preserve its authoritative
          // open; use this first live reference print as the live close-order anchor.
          bar.close = price;
          this.refTradeBounds.set(start, { first: tradeOrder, last: tradeOrder, authoritativeOpen: true });
        } else {
          if (!bounds.authoritativeOpen && compareTradeOrder(tradeOrder, bounds.first) < 0) {
            bar.open = price;
            bounds.first = tradeOrder;
          }
          if (compareTradeOrder(tradeOrder, bounds.last) >= 0) {
            bar.close = price;
            bounds.last = tradeOrder;
          }
        }
      }
    } else if (!bar.hasRef) {
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
      bar.close = price;
    }

    const tradeCount = Number.isSafeInteger(trade.tradeCount) && (trade.tradeCount ?? 0) > 0 ? trade.tradeCount! : 1;
    if (!isLiq) {
      const signedQty = trade.isBuy ? trade.qty : -trade.qty;
      if (includeCandle) bar.delta += signedQty;
      if (includeCells) bar.deltaBySize = addDeltaBySize(bar.deltaBySize, price * trade.qty, signedQty);
    }
    if (includeCells && footprintEnabledAt(start)) {
      const bin = quantizeToStep(price, this.cfg.priceStep);
      let cell = bar.cells.get(bin);
      if (!cell) {
        cell = { priceBin: bin, buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 };
        bar.cells.set(bin, cell);
      }
      if (isLiq) {
        if (trade.isBuy) {
          cell.liquidationBuyVol = (cell.liquidationBuyVol ?? 0) + trade.qty;
          bar.liquidationBuyVol = (bar.liquidationBuyVol ?? 0) + trade.qty;
        } else {
          cell.liquidationSellVol = (cell.liquidationSellVol ?? 0) + trade.qty;
          bar.liquidationSellVol = (bar.liquidationSellVol ?? 0) + trade.qty;
        }
      } else {
        cell.count = (cell.count ?? 0) + tradeCount;
        if (trade.isBuy) { cell.buyCount = (cell.buyCount ?? 0) + tradeCount; cell.buyVol += trade.qty; }
        else { cell.sellCount = (cell.sellCount ?? 0) + tradeCount; cell.sellVol += trade.qty; }
      }
    }
    if (includeCandle && !isLiq) { bar.volume += trade.qty; bar.count += tradeCount; }
    const source = trade.source ?? "live";
    if (!bar.sources?.includes(source)) bar.sources = [...(bar.sources ?? []), source];
    bar.updatedAt = trade.receivedAt ?? Date.now();
    if (includeCells) bar.cellRevision = (bar.cellRevision ?? 0) + 1;
    this.revisionValue++;
    if (structureChanged) this.structureRevisionValue++;
  }

  private isRefOutlier(price: number): boolean {
    if (this.refPrice === undefined) return false;
    const dev = Math.abs(price - this.refPrice) / this.refPrice;
    if (dev <= MAX_TICK_DEV) {
      this.refRejectStreak = 0;
      return false;
    }
    if (++this.refRejectStreak >= OUTLIER_CONFIRM) {
      this.refRejectStreak = 0;
      return false;
    }
    return true;
  }

  private normalizePrice(trade: AggTrade, isRef: boolean): number {
    if (isRef) {
      this.refPrice = trade.price;
      return trade.price;
    }
    if (this.refPrice === undefined) return NaN;
    const market = trade.market!;
    const instant = this.refPrice - trade.price;
    const prev = this.basis.get(market);
    const reseed = prev === undefined || Math.abs(instant - prev) > this.refPrice * 0.002;
    const next = reseed ? instant : prev + (instant - prev) * BASIS_ALPHA;
    this.basis.set(market, next);
    return trade.price + next;
  }

  addTrades(trades: AggTrade[], options: AddTradesOptions = {}): void {
    const dedupe = options.dedupe !== false;
    const progressEvery = Math.max(0, Math.floor(options.progressEvery ?? 0));
    const startedAt = Date.now();
    for (let i = 0; i < trades.length; i++) {
      this.addTradeInternal(trades[i], dedupe, true, true);
      const done = i + 1;
      if (progressEvery > 0 && (done % progressEvery === 0 || done === trades.length)) {
        options.onProgress?.({
          done,
          total: trades.length,
          bars: this.order.length,
          recentTrades: this.recentTrades.size,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
  }

  private insertOrdered(start: number): void {
    const n = this.order.length;
    if (n === 0 || start > this.order[n - 1]) {
      this.order.push(start);
      return;
    }
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.order[mid] < start) lo = mid + 1;
      else hi = mid;
    }
    this.order.splice(lo, 0, start);
  }

  /** Drop the oldest bars once live inserts push the series past MAX_SERIES_BARS. */
  private pruneOldestBars(): void {
    const excess = this.order.length - MAX_SERIES_BARS;
    if (excess <= 0) return;
    for (const start of this.order.splice(0, excess)) {
      this.bars.delete(start);
      this.refTradeBounds.delete(start);
    }
  }

  private inferPricePrecision(bars: readonly FootprintBar[]): void {
    if (this.pricePrecisionExplicit || bars.length === 0) return;
    let inferred = this.cfg.pricePrecision ?? 0;
    for (const bar of bars) {
      inferred = Math.max(
        inferred,
        decimalPlaces(bar.open),
        decimalPlaces(bar.high),
        decimalPlaces(bar.low),
        decimalPlaces(bar.close),
      );
    }
    if (this.cfg.pricePrecision === inferred) return;
    this.cfg.pricePrecision = inferred;
    this.revisionValue++;
  }

  private pruneLegacyCalendarOverlaps(): boolean {
    const interval = this.cfg.intervalMs;
    if (monthSpan(interval) === 0 && interval !== WEEK_MS && interval !== 2 * WEEK_MS) return false;
    const calendarStarts = this.order.filter((start) => bucketStart(start, interval) === start);
    if (!calendarStarts.length) return false;
    let changed = false;
    let calendarIndex = 0;
    for (const start of this.order) {
      if (bucketStart(start, interval) === start) continue;
      while (
        calendarIndex < calendarStarts.length
        && bucketEnd(calendarStarts[calendarIndex], interval) <= start
      ) calendarIndex++;
      if (calendarIndex >= calendarStarts.length) break;
      const legacyEnd = start + interval;
      const calendarStart = calendarStarts[calendarIndex];
      if (calendarStart >= legacyEnd || start >= bucketEnd(calendarStart, interval)) continue;
      this.bars.delete(start);
      this.refTradeBounds.delete(start);
      changed = true;
    }
    if (changed) this.order = this.order.filter((start) => this.bars.has(start));
    return changed;
  }
}

function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function mergeSortedStarts(left: readonly number[], right: readonly number[]): number[] {
  const merged: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length || rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    let next: number;
    if (rightIndex >= right.length || (leftIndex < left.length && leftValue < rightValue)) {
      next = leftValue;
      leftIndex++;
    } else if (leftIndex >= left.length || rightValue < leftValue) {
      next = rightValue;
      rightIndex++;
    } else {
      next = leftValue;
      leftIndex++;
      rightIndex++;
    }
    if (merged[merged.length - 1] !== next) merged.push(next);
  }

  return merged;
}

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = Math.abs(value).toString().toLowerCase();
  const [coefficient, exponentText] = text.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const dot = coefficient.indexOf(".");
  const coefficientDecimals = dot < 0 ? 0 : coefficient.length - dot - 1;
  return Math.max(0, Math.min(12, coefficientDecimals - exponent));
}

export function cellImbalance(cell: FootprintCell): number {
  const total = cell.buyVol + cell.sellVol;
  if (total === 0) return 0;
  return (cell.buyVol - cell.sellVol) / total;
}

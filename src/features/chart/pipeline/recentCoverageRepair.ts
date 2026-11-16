/** Recent footprint-coverage repair window coordinator (buffering, snapshot reconcile, retry). */
import type { FootprintSeries } from "../../../core/model/footprint.js";
import { validateBar } from "../../../core/dataContracts.js";
import { bucketEnd, bucketStart } from "../../../core/time.js";
import type { AggTrade, FootprintBar } from "../../../core/types.js";
import type { EnvelopeMeta } from "../../../core/envelope.js";
import { incrementPerformanceCounter } from "../../../core/performanceTelemetry.js";
import { snapshotFromSeries, type ChartDataSnapshot } from "../../../core/dataUpdateEvent.js";
import type { ChartDataUpdateEvent } from "../../../core/dataUpdateEvent.js";
import type { HistoryQuery } from "../historyContracts.js";
import type { ChartDataPipelineServices, PipelineIntegrityReporter } from "../ChartDataPipelinePorts.js";
import type { LiveRepairRetryReason } from "../recentCoverageRetryPolicy.js";
import { chartDataSource } from "../chartDataSource.js";

export const RECENT_COVERAGE_REPAIR_BUFFER_CAP = 10_000;
const RECENT_COVERAGE_SOURCE = "binance-usdm-aggTrade";
const DECIMAL_TRADE_ID = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

export type RecentFootprintRepairOutcome = "complete" | "retry" | "stop";

export interface RecentCoverageRepairState {
  controller: AbortController;
  generation: number;
  trades: AggTrade[];
  journal: Set<AggTrade>;
  applied: Set<AggTrade>;
  overflow: boolean;
}

export function decimalTradeId(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 20 || !DECIMAL_TRADE_ID.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_U64 ? parsed : null;
}

export function recentCoverageHardFailure(meta: EnvelopeMeta | undefined): boolean {
  if (meta?.footprint?.available === false) return true;
  const provenanceError = meta?.provenance?.some((entry) => Boolean(entry.error)) ?? false;
  const droppedBars = meta?.footprint?.droppedBars ?? 0;
  if (meta?.degraded === true && (provenanceError || droppedBars <= 0)) return true;
  const status = meta?.footprintCoverage?.status;
  return status === "gap" || status === "degraded" || status === "error";
}

/** Adds `from`'s bar and cell liquidation volumes onto `into`, a snapshot bar that has none of its own. */
export function carryLiquidations(from: FootprintBar, into: FootprintBar): void {
  if (!from.liquidationBuyVol && !from.liquidationSellVol) return;
  into.liquidationBuyVol = (into.liquidationBuyVol ?? 0) + (from.liquidationBuyVol ?? 0);
  into.liquidationSellVol = (into.liquidationSellVol ?? 0) + (from.liquidationSellVol ?? 0);
  for (const [bin, cell] of from.cells) {
    if (!cell.liquidationBuyVol && !cell.liquidationSellVol) continue;
    let target = into.cells.get(bin);
    if (!target) {
      target = { priceBin: bin, buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 };
      into.cells.set(bin, target);
    }
    target.liquidationBuyVol = (target.liquidationBuyVol ?? 0) + (cell.liquidationBuyVol ?? 0);
    target.liquidationSellVol = (target.liquidationSellVol ?? 0) + (cell.liquidationSellVol ?? 0);
  }
}

export interface RecentCoverageRepairHost {
  readonly series: FootprintSeries;
  readonly services: Pick<ChartDataPipelineServices, "fetchHistory">;
  readonly integrityReporter?: PipelineIntegrityReporter;
  notifyDataDegraded(degraded: boolean, detail: string): void;
  isDisposed(): boolean;
  isPaused(): boolean;
  getGeneration(): number;
  getMarket(): string;
  getIntervalMs(): number;
  isBlockingMaintenance(): boolean;
  hasPatchDayInFlight(): boolean;
  hasFillCellsInFlight(): boolean;
  getPendingTradesCount(): number;
  filterPendingTrades(predicate: (trade: AggTrade) => boolean): void;
  scheduleFlush(): void;
  cancelFlush(): void;
  handleMeta(meta: EnvelopeMeta | undefined, reportDegraded?: boolean): void;
  beforeUpdateKeepsPlan(kind: ChartDataUpdateEvent["kind"], generation: number, owned?: () => boolean): boolean;
  emitHistoryPatched(previous: ChartDataSnapshot): void;
  recordLastAppliedTradeTime(time: number): void;
  hasUnsyncedBars(from: number, to: number): boolean;
  markHistoryFootprintReceived(): void;
  markRecentCoverageCompleted(from: number): void;
}

export class RecentCoverageRepairCoordinator {
  state: RecentCoverageRepairState | null = null;
  retryScheduler: ((attempt: number, retry: () => boolean, reason: LiveRepairRetryReason) => void) | null = null;

  constructor(private readonly host: RecentCoverageRepairHost) {}

  setRetryScheduler(scheduler: ((attempt: number, retry: () => boolean, reason: LiveRepairRetryReason) => void) | null): void {
    this.retryScheduler = scheduler;
  }

  scheduleRetry(attempt: number, retry: () => boolean, reason: LiveRepairRetryReason): boolean {
    if (!this.retryScheduler) return false;
    this.retryScheduler(attempt, retry, reason);
    return true;
  }

  recordIncomingTrade(trade: AggTrade): boolean {
    const recent = this.state;
    if (!recent) return false;
    if (!recent.overflow) {
      if (recent.trades.length >= RECENT_COVERAGE_REPAIR_BUFFER_CAP) {
        recent.overflow = true;
        recent.controller.abort();
      } else {
        recent.trades.push(trade);
        recent.journal.add(trade);
      }
    }
    return true;
  }

  markAppliedTrade(trade: AggTrade): void {
    if (this.state?.journal.has(trade)) this.state.applied.add(trade);
  }

  cancel(): void {
    const state = this.state;
    if (!state) return;
    state.controller.abort();
    this._releaseRecentCoverageRepair(state);
  }

  dispose(): void {
    this.cancel();
    this.retryScheduler = null;
  }

  _releaseRecentCoverageRepair(state: RecentCoverageRepairState): void {
    if (this.state !== state) return;
    this.state = null;
    if (!this.host.isDisposed() && state.generation === this.host.getGeneration() && this.host.getPendingTradesCount() > 0) {
      this.host.scheduleFlush();
    }
  }

  async repair(from: number, to: number): Promise<RecentFootprintRepairOutcome> {
    if (this.host.isDisposed() || this.host.isPaused() || !(to >= from)) return "stop";
    if (
      this.state
      || this.host.isBlockingMaintenance()
      || this.host.hasPatchDayInFlight()
      || this.host.hasFillCellsInFlight()
    ) return "retry";
    if (this.host.getPendingTradesCount() > 0) {
      this.host.scheduleFlush();
      return "retry";
    }
    const controller = new AbortController();
    const generation = this.host.getGeneration();
    const market = this.host.getMarket();
    const intervalMs = this.host.getIntervalMs();
    const state: RecentCoverageRepairState = {
      controller,
      generation,
      trades: [],
      journal: new Set(),
      applied: new Set(),
      overflow: false,
    };
    this.state = state;
    let latestMeta: EnvelopeMeta | undefined;
    let bars: FootprintBar[];
    try {
      const fetcher = this.host.services.fetchHistory ?? ((query: HistoryQuery) => chartDataSource().collectHistory(query));
      bars = await fetcher({
        markets: [market], from, to, interval: intervalMs,
        priceStep: this.host.series.config.priceStep, reference: market,
        signal: controller.signal, consumeBatchRecords: 8,
        onMeta: (meta) => {
          latestMeta = meta;
          const soft = meta?.degraded === true && !recentCoverageHardFailure(meta);
          this.host.handleMeta(meta, !soft);
        },
      });
    } catch {
      if (this.state !== state) return "stop";
      const retry = state.overflow || (!this.host.isDisposed() && generation === this.host.getGeneration() && !controller.signal.aborted);
      this._releaseRecentCoverageRepair(state);
      return retry ? "retry" : "stop";
    }
    if (this.state !== state) return "stop";
    if (state.overflow || this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) {
      this._releaseRecentCoverageRepair(state);
      return state.overflow ? "retry" : "stop";
    }
    if (recentCoverageHardFailure(latestMeta)) {
      this._releaseRecentCoverageRepair(state);
      return "stop";
    }
    const coverage = latestMeta?.footprintCoverage;
    const usable = coverage !== undefined
      && coverage.schemaVersion === 1
      && coverage.source === RECENT_COVERAGE_SOURCE
      && coverage.instrument === market
      && (coverage.authority === "provisional" || coverage.authority === "mixed")
      && (coverage.status === "pending" || coverage.status === "complete" || coverage.status === "verified")
      && coverage.requestedFrom === from
      && coverage.requestedTo === to
      && coverage.reasonCode === null
      && typeof coverage.authorityToken === "string"
      && coverage.authorityToken.trim().length > 0;
    const watermark = decimalTradeId(coverage?.projectionThroughId);
    const safeToExclusive = bucketStart(to, intervalMs);
    const safeBars = bars.filter((bar) => bar.startTime >= from && bar.startTime < safeToExclusive);
    const hasRepairCells = safeBars.some((bar) => bar.cells.size > 0);
    if (!usable || watermark === null || safeToExclusive <= from || !hasRepairCells) {
      this._releaseRecentCoverageRepair(state);
      return "retry";
    }
    const coverageCoversClosedRange = safeToExclusive > from
      && typeof coverage?.coveredFrom === "number"
      && typeof coverage?.coveredThrough === "number"
      && coverage.coveredFrom <= from
      && coverage.coveredThrough >= safeToExclusive - 1;
    const authoritativeClosedSnapshot = coverageCoversClosedRange
      && (coverage?.status === "complete" || coverage?.status === "verified");
    // Plan every change before touching the series or the queue: a trade without an exact ID in
    // a snapshot bucket means retry, and a retry must leave both exactly as they were.
    const plannedBars: FootprintBar[] = [];
    for (const bar of safeBars) {
      if (bar.cells.size === 0) continue;
      const existing = this.host.series.get(bar.startTime);
      if (existing?.cells.size && !authoritativeClosedSnapshot) continue;
      // `upsertBar` ignores repair ownership, so an unproven snapshot must not reach an owned bucket.
      if (!authoritativeClosedSnapshot && this.host.series.isRepairOwned(bar.startTime)) continue;
      plannedBars.push(bar);
    }
    const snapshotBuckets = new Set(plannedBars.map((bar) => bar.startTime));
    const replay: AggTrade[] = [];
    for (const trade of state.trades) {
      const tradeBucket = bucketStart(trade.time, intervalMs);
      if (snapshotBuckets.has(tradeBucket)) {
        if (trade.liquidation === true) {
          // An applied liquidation is already in the volumes carried over from the replaced bar.
          if (!state.applied.has(trade)) replay.push(trade);
          continue;
        }
        const id = decimalTradeId(trade.id);
        if (id === null) {
          this._releaseRecentCoverageRepair(state);
          return "retry";
        }
        if (id > watermark) replay.push(trade);
      } else if (!state.applied.has(trade)) {
        replay.push(trade);
      }
    }
    const appliedCells = plannedBars.length > 0;
    try {
      for (const bar of plannedBars) validateBar(bar, intervalMs);
    } catch {
      // Applying a prefix of the snapshot would leave the series half-repaired; try again later.
      incrementPerformanceCounter("pipeline.recent_coverage.invalid_snapshot");
      this._releaseRecentCoverageRepair(state);
      return "retry";
    }
    const previous = snapshotFromSeries(this.host.series);
    const plannedTrades = state.trades.length;
    const plannedApplied = state.applied.size;
    // A trade delivered (or flushed) from inside the callback is not in this plan, so it voids the plan too.
    if (appliedCells && !this.host.beforeUpdateKeepsPlan("history-patched", generation, () => this.state === state
      && !controller.signal.aborted && !state.overflow && state.trades.length === plannedTrades
      && state.applied.size === plannedApplied)) {
      const stillCurrent = this.state === state && !this.host.isDisposed() && generation === this.host.getGeneration() && !controller.signal.aborted;
      this._releaseRecentCoverageRepair(state);
      return stillCurrent ? "retry" : "stop";
    }
    this.host.cancelFlush();
    if (state.journal.size > 0) this.host.filterPendingTrades((trade) => !state.journal.has(trade));
    for (const bar of plannedBars) {
      const existing = this.host.series.get(bar.startTime);
      // The recent snapshot carries no liquidations; keep the ones the bar already holds.
      if (existing) carryLiquidations(existing, bar);
      if (authoritativeClosedSnapshot) this.host.series.replaceRange(bar.startTime, bucketEnd(bar.startTime, intervalMs), [bar]);
      else this.host.series.upsertBar(bar);
    }
    if (replay.length) this.host.series.addTrades(replay, { dedupe: false });
    for (const trade of state.trades) this.host.recordLastAppliedTradeTime(trade.time);
    this.state = null;
    if (this.host.getPendingTradesCount() > 0) this.host.scheduleFlush();
    if (appliedCells) this.host.markHistoryFootprintReceived();
    if (appliedCells || replay.length) this.host.emitHistoryPatched(previous);
    const complete = authoritativeClosedSnapshot && !this.host.hasUnsyncedBars(from, safeToExclusive);
    if (complete) {
      this.host.markRecentCoverageCompleted(from);
      this.host.integrityReporter?.report("healthy");
      this.host.notifyDataDegraded(false, "");
    }
    return complete ? "complete" : "retry";
  }
}

import type { AggTrade, FootprintBar, FootprintCell } from "../../core/types.js";
import type { ChartDataSnapshot } from "../../core/dataUpdateEvent.js";
import { identifiedPayload, type FootprintSeries } from "../../core/model/footprint.js";
import type { EnvelopeMeta, TradeIdRepairSnapshot } from "../../core/envelope.js";
import { bucketEnd, bucketStart } from "../../core/time.js";
import { validateBar, validateTrade } from "../../core/dataContracts.js";
import type { HistoryQuery } from "./historyContracts.js";
import type { TradeStreamSession } from "./historyContracts.js";
import type { ChartDataPipelineServices, PipelineIntegrityReporter, TradeMarketReadiness } from "./ChartDataPipelinePorts.js";
import { requestRecentCoverageRetry } from "./recentCoverageRetryBridge.js";
import {
  LIVE_REPAIR_EVIDENCE_WAIT_MS,
  LIVE_REPAIR_UNRESOLVED_AFTER_MS,
  type LiveRepairRetryReason,
} from "./recentCoverageRetryPolicy.js";
import { LIVE_REPAIR_UNRESOLVED_DETAIL } from "./chartDataState.js";
import { chartDataSource } from "./chartDataSource.js";

const RECONCILE_BUFFER_CAP = 10_000;
const REPAIR_OVERFLOW_RESYNC_LIMIT = 4;
const REPAIR_SOURCE = "binance-usdm-aggTrade";
const DECIMAL_ID = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
type HistoryMeta = EnvelopeMeta | undefined;
type RepairRejection = { state: "pending" | "error"; detail: string; retryReason?: LiveRepairRetryReason };
type ExplicitHistoryRange = { from: number; toExclusive: number };

function rangesOverlap(a: ExplicitHistoryRange, b: ExplicitHistoryRange): boolean {
  return a.from < b.toExclusive && b.from < a.toExclusive;
}

const LIVE_EVIDENCE_PENDING_DETAIL = "Trade stream liveness evidence unavailable after subscription boundary";

/** A trade that proves the stream is delivering this market after the subscribe boundary. */
function isLiveEvidence(trade: AggTrade, market: string, boundaryAt: number): boolean {
  return trade.liquidation !== true
    && (trade.market === undefined || trade.market === market)
    && Number.isFinite(trade.time)
    && trade.time >= boundaryAt;
}

function repairRetryReason(rejection: RepairRejection | null): LiveRepairRetryReason {
  if (!rejection) return "transport";
  if (rejection.retryReason) return rejection.retryReason;
  return /join|gap|continu|trade ID/i.test(rejection.detail) ? "continuity" : "snapshot_pending";
}

function decimalId(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 20 || !DECIMAL_ID.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_U64 ? parsed : null;
}

function cloneRepairBar(bar: FootprintBar): FootprintBar {
  return {
    ...bar,
    cells: new Map([...bar.cells].map(([price, cell]) => [price, { ...cell }])),
    deltaBySize: bar.deltaBySize ? [...bar.deltaBySize] : undefined,
    sources: bar.sources ? [...bar.sources] : undefined,
  };
}

export function repairSnapshotReason(
  meta: HistoryMeta,
  market: string,
  from: number,
  to: number,
  intervalMs: number,
  priceStep: number,
  lastWatermark: bigint | null,
): RepairRejection | null {
  const snapshot = meta?.repairSnapshot;
  if (!snapshot || (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2 && snapshot.schemaVersion !== 3) ||
      snapshot.mode !== "trade-id-v1" || snapshot.source !== REPAIR_SOURCE) {
    return { state: "pending", detail: "Trade-id repair snapshot contract unavailable" };
  }
  if (snapshot.instrument !== market || snapshot.interval !== intervalMs ||
      !Number.isFinite(snapshot.priceStep) || Math.abs(snapshot.priceStep - priceStep) > Math.max(1e-12, priceStep * 1e-9)) {
    return { state: "pending", detail: "Trade-id repair snapshot identity mismatch" };
  }
  if ((snapshot.authority !== "provisional" && snapshot.authority !== "mixed") ||
      typeof snapshot.authorityToken !== "string" || !snapshot.authorityToken.trim()) {
    return { state: "pending", detail: "Trade-id repair snapshot authority unavailable" };
  }
  if (snapshot.requestedFrom !== from || snapshot.requestedTo !== to ||
      snapshot.bucketFrom !== bucketStart(from, intervalMs) || snapshot.bucketThrough !== bucketStart(to, intervalMs)) {
    return { state: "pending", detail: "Trade-id repair snapshot bucket selection mismatch" };
  }
  if (!Number.isFinite(snapshot.coveredFrom) || !Number.isFinite(snapshot.coveredThrough) ||
      snapshot.coveredFrom > snapshot.coveredThrough || snapshot.coveredFrom < 0 || snapshot.coveredThrough > to) {
    return { state: "pending", detail: "Trade-id repair snapshot coverage malformed" };
  }
  const watermark = decimalId(snapshot.watermark);
  if (watermark === null) return { state: "pending", detail: "Trade-id repair snapshot watermark unavailable" };

  if (snapshot.schemaVersion === 1) {
    const proof = snapshot.coverageProof;
    const coverageComplete = snapshot.coveredFrom <= from && snapshot.coveredThrough >= to;
    const explicitProof = proof?.kind === "resolver-contiguous-v1" &&
      proof.authority === snapshot.authority && proof.requestedFrom === from && proof.requestedTo === to &&
      proof.coveredFrom === snapshot.coveredFrom && proof.coveredThrough === snapshot.coveredThrough &&
      proof.complete === coverageComplete;
    if (!coverageComplete || !explicitProof) {
      return { state: "pending", detail: "Trade-id repair snapshot does not prove the complete requested range" };
    }
  } else if (snapshot.schemaVersion === 2) {
    const proof = snapshot.coverageProof;
    const prefixProven = snapshot.coveredFrom <= from && snapshot.coveredThrough >= from;
    const explicitProof = proof.kind === "resolver-watermark-contiguous-v2" &&
      proof.authority === snapshot.authority && proof.authorityToken === snapshot.authorityToken &&
      proof.projectionThroughId === snapshot.watermark && proof.requestedFrom === from && proof.requestedTo === to &&
      proof.coveredFrom === snapshot.coveredFrom && proof.coveredThrough === snapshot.coveredThrough &&
      proof.watermarkComplete === true;
    if (!prefixProven || !explicitProof) {
      return { state: "pending", detail: "Trade-id repair snapshot does not prove the requested prefix through its watermark" };
    }
  } else {
    const proof = snapshot.coverageProof;
    const commonProof = proof.kind === "resolver-watermark-prefix-v3" &&
      proof.authority === snapshot.authority && proof.authorityToken === snapshot.authorityToken &&
      proof.projectionThroughId === snapshot.watermark && proof.requestedFrom === from && proof.requestedTo === to &&
      proof.coveredFrom === snapshot.coveredFrom && proof.coveredThrough === snapshot.coveredThrough &&
      proof.watermarkComplete === true && proof.prefixProof.requestedFrom === from;
    let prefixProven = false;
    if (commonProof && proof.prefixProof.kind === "event-time-prefix-v1") {
      prefixProven = snapshot.coveredFrom <= from && snapshot.coveredThrough >= from &&
        proof.prefixProof.firstEventTime === snapshot.coveredFrom;
    } else if (commonProof && proof.prefixProof.kind === "adjacent-agg-id-prefix-v1") {
      const previous = decimalId(proof.prefixProof.previousProjectionId);
      const first = decimalId(proof.prefixProof.firstAggregateId);
      prefixProven = snapshot.coveredFrom > from && proof.prefixProof.firstEventTime === snapshot.coveredFrom &&
        previous !== null && first !== null && previous < first;
    } else if (commonProof && proof.prefixProof.kind === "rest-discovery-prefix-v1") {
      const first = decimalId(proof.prefixProof.firstAggregateId);
      const visionCoverageEnd = proof.prefixProof.visionCoverageEnd;
      prefixProven = snapshot.coveredFrom > from && proof.prefixProof.firstEventTime === snapshot.coveredFrom &&
        first !== null && first <= watermark &&
        proof.prefixProof.discoveryFrom === from &&
        Number.isSafeInteger(proof.prefixProof.discoveryAt) &&
        proof.prefixProof.discoveryFrom >= 0 &&
        proof.prefixProof.discoveryFrom <= proof.prefixProof.firstEventTime &&
        proof.prefixProof.firstEventTime <= proof.prefixProof.discoveryAt &&
        (visionCoverageEnd === null ||
          (Number.isSafeInteger(visionCoverageEnd) && visionCoverageEnd >= 0 &&
            visionCoverageEnd <= proof.prefixProof.discoveryFrom));
    }
    if (!prefixProven) {
      return { state: "pending", detail: "Trade-id repair snapshot does not prove the requested prefix" };
    }
  }

  if (lastWatermark !== null && watermark < lastWatermark) {
    return { state: "error", detail: "Trade-id repair snapshot watermark regressed" };
  }
  return null;
}

export function joinedTail(
  trades: readonly AggTrade[],
  market: string,
  watermark: bigint,
): { tail: AggTrade[]; rejection: RepairRejection | null; conflicts: number } {
  const byId = new Map<bigint, AggTrade>();
  let conflicts = 0;
  for (const trade of trades) {
    if (trade.liquidation === true) continue;
    if (trade.market !== undefined && trade.market !== market) continue;
    const id = decimalId(trade.id);
    if (id === null) {
      return { tail: [], rejection: { state: "pending", detail: "Trade stream repair buffer contains an invalid trade ID" }, conflicts };
    }
    if (id <= watermark) continue;
    // First delivery wins, as on the live dedup path; a different payload is a conflict.
    const first = byId.get(id);
    if (!first) byId.set(id, trade);
    else if (identifiedPayload(first) !== identifiedPayload(trade)) conflicts++;
  }
  if (byId.size === 0) return { tail: [], rejection: null, conflicts };
  const ids = [...byId.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (ids[0] <= watermark) {
    return { tail: [], rejection: { state: "pending", detail: "Trade stream repair buffer does not advance the snapshot watermark" }, conflicts };
  }
  for (let i = 1; i < ids.length; i++) {
    if (ids[i - 1] >= ids[i]) {
      return { tail: [], rejection: { state: "pending", detail: "Trade stream repair tail contains a non-monotonic ID" }, conflicts };
    }
  }
  return { tail: ids.map((id) => byId.get(id)!), rejection: null, conflicts };
}

function hasLiquidations(bar: FootprintBar | undefined): bar is FootprintBar {
  return Boolean(bar && ((bar.liquidationBuyVol ?? 0) !== 0 || (bar.liquidationSellVol ?? 0) !== 0 ||
    [...bar.cells.values()].some((cell) => (cell.liquidationBuyVol ?? 0) !== 0 || (cell.liquidationSellVol ?? 0) !== 0)));
}

function preserveLiquidations(incoming: FootprintBar, existing: FootprintBar | undefined): FootprintBar {
  if (!hasLiquidations(existing)) return incoming;
  const cells = new Map<number, FootprintCell>();
  for (const [price, cell] of incoming.cells) cells.set(price, { ...cell });
  for (const [price, previous] of existing.cells) {
    const buy = previous.liquidationBuyVol ?? 0;
    const sell = previous.liquidationSellVol ?? 0;
    if (buy === 0 && sell === 0) continue;
    const next = cells.get(price) ?? {
      priceBin: price, buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0,
      liquidationBuyVol: 0, liquidationSellVol: 0,
    };
    next.liquidationBuyVol = buy;
    next.liquidationSellVol = sell;
    cells.set(price, next);
  }
  return {
    ...incoming,
    cells,
    liquidationBuyVol: existing.liquidationBuyVol ?? 0,
    liquidationSellVol: existing.liquidationSellVol ?? 0,
  };
}

function liquidationOnlyBar(existing: FootprintBar): FootprintBar {
  const cells = new Map<number, FootprintCell>();
  for (const [price, previous] of existing.cells) {
    const buy = previous.liquidationBuyVol ?? 0;
    const sell = previous.liquidationSellVol ?? 0;
    if (buy === 0 && sell === 0) continue;
    cells.set(price, {
      priceBin: price,
      buyVol: 0,
      sellVol: 0,
      count: 0,
      buyCount: 0,
      sellCount: 0,
      liquidationBuyVol: buy,
      liquidationSellVol: sell,
    });
  }
  return {
    ...cloneRepairBar(existing),
    volume: 0,
    delta: 0,
    deltaBySize: undefined,
    count: 0,
    cells,
    liquidationBuyVol: existing.liquidationBuyVol ?? 0,
    liquidationSellVol: existing.liquidationSellVol ?? 0,
    hasRef: false,
  };
}

function bucketStarts(from: number, toExclusive: number, intervalMs: number): number[] {
  const starts: number[] = [];
  let start = bucketStart(from, intervalMs);
  while (start < toExclusive && starts.length < RECONCILE_BUFFER_CAP) {
    starts.push(start);
    const next = bucketEnd(start, intervalMs);
    if (!(next > start)) break;
    start = next;
  }
  return starts;
}

function prevalidateRepairInput(
  bars: readonly FootprintBar[],
  tail: readonly AggTrade[],
  from: number,
  snapshotToExclusive: number,
  intervalMs: number,
  watermark: bigint,
): number {
  const starts = new Set<number>();
  let through = snapshotToExclusive;
  for (const bar of bars) {
    validateBar(bar, intervalMs);
    if (bar.startTime < from || bar.startTime >= snapshotToExclusive || starts.has(bar.startTime)) {
      throw { state: "error", detail: "Trade-id repair snapshot contains an invalid bucket set" } satisfies RepairRejection;
    }
    starts.add(bar.startTime);
  }
  for (const trade of tail) {
    validateTrade(trade);
    const id = decimalId(trade.id);
    if (trade.liquidation === true || id === null || id <= watermark) {
      throw { state: "error", detail: "Trade-id repair tail violates watermark ownership" } satisfies RepairRejection;
    }
    const bucket = bucketStart(trade.time, intervalMs);
    if (bucket < from) {
      throw { state: "error", detail: "Trade-id repair tail precedes the repair bucket set" } satisfies RepairRejection;
    }
    through = Math.max(through, bucketEnd(bucket, intervalMs));
  }
  return through;
}

export interface RepairSnapshotInput {
  from: number;
  to: number;
  bars: readonly FootprintBar[];
  trades: readonly AggTrade[];
  watermark: bigint;
  generation: number;
}

export interface LiveTradeRepairHost {
  readonly services: ChartDataPipelineServices;
  readonly series: FootprintSeries;
  readonly integrityReporter?: PipelineIntegrityReporter;
  isDisposed(): boolean;
  getGeneration(): number;
  getMarket(): string;
  getIntervalMs(): number;
  getLastAppliedTradeTime(): number;
  onBeforeHistoryPatch(): void;
  emitHistoryPatch(previous: ChartDataSnapshot): void;
  reconcileHistorySnapshot(input: RepairSnapshotInput): ChartDataSnapshot | null;
  handleMeta(meta: HistoryMeta): void;
  setDataDegraded(degraded: boolean, detail: string): void;
  reportIdentityConflicts?(count: number): void;
  onReconciled?(): void;
  trace?(stage: string, fields?: Record<string, unknown>): void;
}

export class LiveTradeRepairController {
  private pendingSession: TradeStreamSession | null = null;
  private pendingRepairFrom: number | null = null;
  private highestSessionGeneration: number | null = null;
  private lastAcceptedWatermark: bigint | null = null;
  private repairController: AbortController | null = null;
  private activeRepairSession: TradeStreamSession | null = null;
  private activeRepairFrom: number | null = null;
  private activeRepairToExclusive: number | null = null;
  private repairOwnership = 0;
  private repairActive = false;
  private reconciled = false;
  private localDataLossPending = false;
  private repairRetryCount = 0;
  /** When the current repair first failed; reset with the retry count. */
  private repairFailingSince: number | null = null;
  private repairDeferred = false;
  private explicitHistoryRange: ExplicitHistoryRange | null = null;
  private explicitHistoryToken = 0;
  private reconcileBuffer: AggTrade[] = [];
  private reconcileOverflow = false;
  private overflowResyncCount = 0;
  private lastTransportSession: TradeStreamSession | null = null;
  /** Last applied trade time when a new transport session began: the start of what the outage may have missed. */
  private outageCursor: number | null = null;
  private configSignature = "";
  /** At most one repair is ever in flight, so one waiter slot covers every case. */
  private liveEvidenceWaiter: { session: TradeStreamSession; settle: (value: boolean) => void } | null = null;

  constructor(private readonly host: LiveTradeRepairHost) {
    this.configSignature = this.currentConfigSignature();
  }

  get isReconciled(): boolean { return this.reconciled; }

  isBlockingMaintenance(): boolean {
    return this.explicitHistoryRange !== null || this.repairActive || this.pendingSession !== null || this.repairController !== null;
  }

  isBlockingCandleMaintenance(): boolean {
    if (!this.explicitHistoryRange) return false;
    const start = bucketStart(Date.now(), this.host.getIntervalMs());
    return rangesOverlap(this.explicitHistoryRange, { from: start, toExclusive: bucketEnd(start, this.host.getIntervalMs()) });
  }

  beginExplicitHistory(range: ExplicitHistoryRange): number {
    const normalized = { from: range.from, toExclusive: Math.max(range.from, range.toExclusive) };
    if (!this.host.isDisposed() && (this.repairController || this.repairActive)
      && this.activeRepairFrom !== null && this.activeRepairToExclusive !== null
      && rangesOverlap(normalized, { from: this.activeRepairFrom, toExclusive: this.activeRepairToExclusive })) {
      this.preempt(true);
    }
    const token = ++this.explicitHistoryToken;
    this.explicitHistoryRange = normalized;
    return token;
  }

  finishExplicitHistory(token: number): boolean {
    if (token !== this.explicitHistoryToken) return false;
    this.explicitHistoryRange = null;
    if (!this.pendingSession && !this.repairController) {
      this.repairActive = false;
      this.clearReconcileBuffer();
      this.host.series.releaseRepairBarriers();
    }
    if (!this.repairDeferred) this.startPendingRepair();
    return true;
  }

  onSession(session: TradeStreamSession, bootstrap = true): void {
    if (this.host.isDisposed()) return;
    const previousHighest = this.highestSessionGeneration;
    if (previousHighest !== null && session.generation < previousHighest) return;
    const duplicateBootstrap = bootstrap && previousHighest !== null && session.generation === previousHighest
      && this.configSignature === this.currentConfigSignature();
    if (previousHighest !== null && session.generation > previousHighest) {
      const cursor = this.host.getLastAppliedTradeTime();
      if (Number.isFinite(cursor)) this.outageCursor = Math.min(this.outageCursor ?? cursor, cursor);
    }
    this.highestSessionGeneration = Math.max(previousHighest ?? session.generation, session.generation);
    this.lastTransportSession = session;
    this.configSignature = this.currentConfigSignature();
    if (bootstrap && !duplicateBootstrap) this.queueRepair(session, null, "Trade stream reconnect repair pending");
  }

  onMarketReady(readiness: TradeMarketReadiness): void {
    if (this.host.isDisposed() || readiness.market !== this.host.getMarket()) return;
    if (this.highestSessionGeneration !== null && readiness.generation < this.highestSessionGeneration) return;
    this.highestSessionGeneration = Math.max(this.highestSessionGeneration ?? readiness.generation, readiness.generation);
    this.lastTransportSession = readiness;
    this.configSignature = this.currentConfigSignature();
    // After a reconnect the stream only guarantees trades from its new boundary on; everything after
    // the last trade this chart applied (the outage, possibly several buckets) has to be repaired too.
    const appliedCursor = this.outageCursor ?? this.host.getLastAppliedTradeTime();
    this.outageCursor = null;
    const resumeFrom = Number.isFinite(appliedCursor) && appliedCursor < readiness.boundaryAt
      ? appliedCursor - 1
      : readiness.boundaryAt - 1;
    const repairFrom = Math.min(readiness.repairFrom ?? resumeFrom, resumeFrom);
    this.queueRepair(readiness, bucketStart(repairFrom, this.host.getIntervalMs()), readiness.repairFrom === undefined ? "Market subscription bootstrap pending" : "Venue recovery repair pending");
  }

  handleTrade(trade: AggTrade): boolean {
    if (this.host.isDisposed()) return false;
    const signature = this.currentConfigSignature();
    if (signature !== this.configSignature && this.lastTransportSession) {
      this.configSignature = signature;
      const boundaryAt = Number.isFinite(trade.time) ? trade.time : Date.now();
      this.queueRepair({ ...this.lastTransportSession, boundaryAt }, bucketStart(boundaryAt - 1, this.host.getIntervalMs()), "Chart configuration repair pending");
    }
    if (!this.repairActive) return false;
    if (trade.market !== undefined && trade.market !== this.host.getMarket()) return false;
    if (this.reconcileBuffer.length >= RECONCILE_BUFFER_CAP) {
      const detail = "Trade stream repair buffer overflow";
      if (!this.restartAfterOverflow(trade, detail)) {
        this.reconcileOverflow = true;
        this.pendingSession = null;
        this.pendingRepairFrom = null;
        this.host.integrityReporter?.report("error", detail);
        this.host.setDataDegraded(true, detail);
        return false;
      }
    }
    this.reconcileBuffer.push(trade);
    if (trade.liquidation !== true && Number.isFinite(trade.time)) {
      this.host.series.beginRepairBarrier([bucketStart(trade.time, this.host.getIntervalMs())]);
    }
    this.notifyLiveEvidence();
    return true;
  }

  recoverDataLoss(trades: readonly AggTrade[]): boolean {
    if (this.host.isDisposed() || !this.lastTransportSession || trades.length === 0) return false;
    const intervalMs = this.host.getIntervalMs();
    const market = this.host.getMarket();
    const lost = trades.filter((trade) => Number.isFinite(trade.time)
      && (trade.market === undefined || trade.market === market));
    if (!lost.length) return false;
    const from = Math.min(...lost.map((trade) => bucketStart(trade.time, intervalMs)));
    const boundaryAt = Math.max(this.lastTransportSession.boundaryAt, ...lost.map((trade) => trade.time));
    this.localDataLossPending = true;
    if (!this.repairActive && !this.reconciled) return false;

    const repairFrom = this.activeRepairFrom ?? this.pendingRepairFrom;
    const alreadyJournaled = lost.length === 1 && this.reconcileBuffer.at(-1) === lost[0];
    if (!this.repairActive || repairFrom === null || from < repairFrom) {
      const overflowResyncCount = this.overflowResyncCount;
      const repairRetryCount = this.repairRetryCount;
      const repairFailingSince = this.repairFailingSince;
      const activeBoundary = this.activeRepairSession?.boundaryAt ?? this.pendingSession?.boundaryAt ?? boundaryAt;
      this.queueRepair(
        { ...this.lastTransportSession, boundaryAt: Math.max(boundaryAt, activeBoundary) },
        Math.min(from, repairFrom ?? from),
        "Trade stream local data loss repair pending",
      );
      this.overflowResyncCount = overflowResyncCount;
      this.repairRetryCount = repairRetryCount;
      this.repairFailingSince = repairFailingSince;
    }
    if (!alreadyJournaled) {
      const journaled = new Set(this.reconcileBuffer);
      for (const trade of lost) {
        if (journaled.has(trade)) continue;
        this.handleTrade(trade);
        journaled.add(trade);
      }
    }
    return true;
  }

  cancel(): void {
    this.preempt(false);
    this.localDataLossPending = false;
    this.pendingSession = null;
    this.pendingRepairFrom = null;
    this.lastAcceptedWatermark = null;
    this.outageCursor = null;
    this.repairRetryCount = 0;
    this.repairFailingSince = null;
    this.repairDeferred = false;
    this.reconcileOverflow = false;
    this.overflowResyncCount = 0;
    this.reconciled = false;
    this.explicitHistoryRange = null;
    this.explicitHistoryToken++;
    this.configSignature = this.currentConfigSignature();
  }

  dispose(): void { this.cancel(); }

  private currentConfigSignature(): string {
    return `${this.host.getMarket()}|${this.host.getIntervalMs()}|${this.host.series.config.priceStep}`;
  }

  private queueRepair(session: TradeStreamSession, from: number | null, detail: string): void {
    this.pendingSession = session;
    this.pendingRepairFrom = from;
    this.repairRetryCount = 0;
    this.repairFailingSince = null;
    this.repairDeferred = false;
    this.reconcileOverflow = false;
    this.overflowResyncCount = 0;
    this.reconciled = false;
    this.repairActive = true;
    this.host.integrityReporter?.report("pending", detail);
    if (this.repairController) this.preempt(true);
    this.startPendingRepair();
  }

  private restartAfterOverflow(trade: AggTrade, detail: string): boolean {
    const session = this.activeRepairSession ?? this.pendingSession ?? this.lastTransportSession;
    if (!session || this.overflowResyncCount >= REPAIR_OVERFLOW_RESYNC_LIMIT) {
      this.preempt(false);
      return false;
    }

    const intervalMs = this.host.getIntervalMs();
    const boundaryAt = Number.isFinite(trade.time) ? trade.time : Date.now();
    const cursor = Number.isFinite(this.host.getLastAppliedTradeTime())
      ? this.host.getLastAppliedTradeTime()
      : session.boundaryAt;
    const from = this.activeRepairFrom ?? this.pendingRepairFrom ??
      bucketStart(Math.min(cursor, session.boundaryAt) - 1, intervalMs);

    this.preempt(false);
    this.overflowResyncCount++;
    this.reconcileOverflow = false;
    this.pendingSession = { ...session, boundaryAt };
    this.pendingRepairFrom = from;
    this.repairRetryCount = 0;
    this.repairFailingSince = null;
    this.repairDeferred = false;
    this.repairActive = true;
    this.host.integrityReporter?.report(
      "pending",
      `${detail}; resynchronizing (${this.overflowResyncCount}/${REPAIR_OVERFLOW_RESYNC_LIMIT})`,
    );
    this.startPendingRepair();
    return true;
  }

  private preempt(preserveBuffer: boolean): void {
    this.repairOwnership++;
    this.repairController?.abort();
    this.repairController = null;
    if (preserveBuffer && this.activeRepairSession && !this.pendingSession) {
      this.pendingSession = this.activeRepairSession;
      this.pendingRepairFrom = this.activeRepairFrom;
    }
    this.activeRepairSession = null;
    this.activeRepairFrom = null;
    this.activeRepairToExclusive = null;
    this.repairActive = preserveBuffer;
    if (!preserveBuffer) {
      this.repairDeferred = false;
      this.clearReconcileBuffer();
      this.host.series.releaseRepairFence();
      this.host.series.releaseRepairBarriers();
    }
  }

  private clearReconcileBuffer(): void { this.reconcileBuffer = []; }

  /** The current repair has kept failing for longer than its fast retry ladder. */
  private repairUnresolved(): boolean {
    return this.repairFailingSince !== null && Date.now() - this.repairFailingSince >= LIVE_REPAIR_UNRESOLVED_AFTER_MS;
  }

  /**
   * Retries continue either way (the ladder caps their pace at one a minute), but past the fast
   * ladder the chart reads as failed rather than "repairing" until a repair succeeds (#315).
   */
  private reportRetrying(detail: string): void {
    if (!this.repairUnresolved()) {
      this.host.integrityReporter?.report("pending", detail);
      return;
    }
    const unresolved = `${LIVE_REPAIR_UNRESOLVED_DETAIL}: ${detail}`.slice(0, 160);
    this.host.integrityReporter?.report("error", unresolved);
    this.host.setDataDegraded(true, unresolved);
  }

  private hasLiveEvidence(session: TradeStreamSession): boolean {
    if (this.host.getLastAppliedTradeTime() >= session.boundaryAt) return true;
    const market = this.host.getMarket();
    return this.reconcileBuffer.some((trade) => isLiveEvidence(trade, market, session.boundaryAt));
  }

  private notifyLiveEvidence(): void {
    const waiter = this.liveEvidenceWaiter;
    if (!waiter || !this.hasLiveEvidence(waiter.session)) return;
    waiter.settle(true);
  }

  private waitForLiveEvidence(session: TradeStreamSession, signal: AbortSignal): Promise<boolean> {
    if (this.hasLiveEvidence(session)) return Promise.resolve(true);
    if (signal.aborted || this.host.isDisposed()) return Promise.resolve(false);
    this.liveEvidenceWaiter?.settle(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        signal.removeEventListener("abort", onAbort);
        if (this.liveEvidenceWaiter?.settle === settle) this.liveEvidenceWaiter = null;
        resolve(value);
      };
      const onAbort = (): void => settle(false);
      timer = setTimeout(() => settle(false), LIVE_REPAIR_EVIDENCE_WAIT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      this.liveEvidenceWaiter = { session, settle };
      // A repair already reported as failed stays failed while a retry waits; only success clears it.
      if (!this.repairUnresolved()) this.host.integrityReporter?.report("pending", LIVE_EVIDENCE_PENDING_DETAIL);
      this.host.trace?.("repair.evidence.waiting", { boundaryAt: session.boundaryAt, bufferedTrades: this.reconcileBuffer.length });
    });
  }

  private startPendingRepair(): void {
    if (this.host.isDisposed() || !this.pendingSession || this.repairController || this.repairDeferred) return;
    const session = this.pendingSession;
    const generation = this.host.getGeneration();
    const cutoff = session.boundaryAt;
    const cursor = Number.isFinite(this.host.getLastAppliedTradeTime()) ? this.host.getLastAppliedTradeTime() : cutoff;
    const intervalMs = this.host.getIntervalMs();
    const market = this.host.getMarket();
    const from = this.pendingRepairFrom ?? bucketStart(Math.min(cursor, cutoff) - 1, intervalMs);
    const toExclusive = bucketEnd(cutoff, intervalMs);
    if (this.explicitHistoryRange && rangesOverlap(this.explicitHistoryRange, { from, toExclusive })) return;
    this.pendingSession = null;
    this.pendingRepairFrom = null;
    this.activeRepairSession = session;
    this.activeRepairFrom = from;
    this.activeRepairToExclusive = toExclusive;
    const controller = new AbortController();
    const ownership = ++this.repairOwnership;
    this.repairController = controller;
    this.repairActive = true;
    this.reconciled = false;
    const repairTo = toExclusive - 1;
    this.host.trace?.("repair.request.started", { from, to: repairTo, bufferedTrades: this.reconcileBuffer.length });
    this.host.series.beginRepairBarrier(bucketStarts(from, toExclusive, intervalMs));
    let latestMeta: HistoryMeta;
    let stickyDegraded = false;
    let sourceUnavailable = false;
    let unsupportedFootprint = false;
    const onMeta = (meta: HistoryMeta): void => {
      if (ownership !== this.repairOwnership || this.repairController !== controller ||
          this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
      latestMeta = meta;
      unsupportedFootprint ||= meta?.footprint?.allowed === false && meta?.footprintCoverage?.reasonCode === "market_not_allowed";
      this.host.handleMeta(meta);
      if (meta?.degraded === true && !unsupportedFootprint) {
        stickyDegraded = true;
        sourceUnavailable ||= meta.footprint?.available === false;
      }
    };

    // A direct-candle market has no trade-id snapshot on the server to repair from; it
    // settles exactly like a market the server reports as not allowlisted.
    if (chartDataSource().isDirectCandleMarket(market)) unsupportedFootprint = true;
    const fetchPromise = unsupportedFootprint
      ? Promise.resolve<FootprintBar[]>([])
      : this.host.services.fetchHistory
      ? this.host.services.fetchHistory({
          markets: [market], from, to: repairTo, interval: intervalMs,
          priceStep: this.host.series.config.priceStep, reference: market,
          signal: controller.signal, consumeBatchRecords: 8, onMeta,
        } satisfies HistoryQuery)
      : chartDataSource().fetchRepairHistory({
          market, from, to: repairTo, interval: intervalMs,
          priceStep: this.host.series.config.priceStep, signal: controller.signal, onMeta,
        });

    let retryScheduled = false;
    void fetchPromise.then(async (bars) => {
      if (ownership !== this.repairOwnership || this.repairController !== controller) return;
      if (this.reconcileOverflow) throw { state: "error", detail: "Trade stream repair buffer overflow" } satisfies RepairRejection;
      if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
      if (unsupportedFootprint) {
        if (this.localDataLossPending) {
          throw { state: "error", detail: "Trade stream local data loss cannot be repaired for this market" } satisfies RepairRejection;
        }
        this.pendingSession = null;
        this.pendingRepairFrom = null;
        this.clearReconcileBuffer();
        this.repairRetryCount = 0;
        this.repairFailingSince = null;
        this.repairDeferred = false;
        this.overflowResyncCount = 0;
        this.repairActive = false;
        this.host.series.releaseRepairFence();
        this.host.series.releaseRepairBarriers();
        this.host.integrityReporter?.report("healthy");
        this.host.setDataDegraded(false, "");
        return;
      }
      if (stickyDegraded) {
        if (sourceUnavailable) {
          throw {
            state: "pending",
            detail: "Trade-id repair snapshot source unavailable",
            retryReason: "transport",
          } satisfies RepairRejection;
        }
        throw { state: "error", detail: "Trade-id repair snapshot degraded" } satisfies RepairRejection;
      }
      const reason = repairSnapshotReason(
        latestMeta, market, from, repairTo, intervalMs, this.host.series.config.priceStep, this.lastAcceptedWatermark,
      );
      if (reason) throw reason;
      const snapshot = latestMeta!.repairSnapshot as TradeIdRepairSnapshot;
      const watermark = decimalId(snapshot.watermark)!;
      if (!(await this.waitForLiveEvidence(session, controller.signal))) {
        throw { state: "pending", detail: LIVE_EVIDENCE_PENDING_DETAIL } satisfies RepairRejection;
      }
      if (ownership !== this.repairOwnership || this.repairController !== controller) return;
      if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
      if (this.reconcileOverflow) throw { state: "error", detail: "Trade stream repair buffer overflow" } satisfies RepairRejection;
      const buffered = this.reconcileBuffer.slice();
      this.host.trace?.("repair.snapshot.accepted", { watermark: snapshot.watermark, bufferedTrades: buffered.length });
      const joined = joinedTail(buffered, market, watermark);
      if (joined.conflicts > 0) this.host.reportIdentityConflicts?.(joined.conflicts);
      if (joined.rejection) throw joined.rejection;
      const commitTo = prevalidateRepairInput(bars, joined.tail, from, toExclusive, intervalMs, watermark);
      const commitBars = bars.map((bar) => preserveLiquidations(cloneRepairBar(bar), this.host.series.get(bar.startTime)));
      const commitBarStarts = new Set(commitBars.map((bar) => bar.startTime));
      for (const start of bucketStarts(from, commitTo, intervalMs)) {
        if (commitBarStarts.has(start)) continue;
        const existing = this.host.series.get(start);
        if (hasLiquidations(existing)) {
          commitBars.push(liquidationOnlyBar(existing));
          commitBarStarts.add(start);
        }
      }
      commitBars.sort((a, b) => a.startTime - b.startTime);
      const repairBuckets = bucketStarts(from, commitTo, intervalMs);

      if (ownership !== this.repairOwnership || this.repairController !== controller ||
          this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
      this.host.series.beginRepairFence(repairBuckets, watermark, joined.tail);
      let previous: ChartDataSnapshot | null = null;
      try {
        this.host.onBeforeHistoryPatch();
        if (ownership !== this.repairOwnership || this.repairController !== controller ||
            this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
        previous = this.host.reconcileHistorySnapshot({
          from, to: commitTo, bars: commitBars, trades: [], watermark, generation,
        });
        if (!previous) throw { state: "pending", detail: "Trade stream repair snapshot became stale" } satisfies RepairRejection;
        this.host.series.commitRepairOwnership(repairBuckets, watermark, []);
      } finally {
        this.host.series.releaseRepairFence(repairBuckets);
      }
      if (joined.tail.length) this.host.series.addTrades([...joined.tail], { dedupe: false });

      this.clearReconcileBuffer();
      this.lastAcceptedWatermark = watermark;
      this.repairRetryCount = 0;
      this.repairFailingSince = null;
      this.repairDeferred = false;
      this.overflowResyncCount = 0;
      this.reconciled = true;
      this.localDataLossPending = false;
      // Each step below reaches code outside this controller (reporter, degraded callback,
      // update listeners), which may cancel this repair, reset the series or start a new one.
      const stillOwned = (): boolean => ownership === this.repairOwnership && this.repairController === controller
        && !this.host.isDisposed() && generation === this.host.getGeneration() && !controller.signal.aborted;
      this.host.onReconciled?.();
      this.host.trace?.("repair.reconciled", { watermark: snapshot.watermark, bufferedTrades: buffered.length, tailTrades: joined.tail.length });
      if (!stillOwned()) return;
      this.host.integrityReporter?.report("healthy");
      if (!stillOwned()) return;
      this.host.setDataDegraded(false, "");
      if (!stillOwned()) return;
      this.host.emitHistoryPatch(previous);
    }).catch((error) => {
      if (ownership !== this.repairOwnership || this.repairController !== controller) return;
      if (this.host.isDisposed() || generation !== this.host.getGeneration()) return;
      const rejection = error && typeof error === "object" && "state" in error &&
        (error.state === "pending" || error.state === "error") && typeof error.detail === "string"
        ? error as RepairRejection : null;
      const state = rejection?.state ?? "error";
      const detail = rejection?.detail ?? (error instanceof Error ? error.message : "Trade stream history repair failed");
      this.host.trace?.("repair.snapshot.rejected", { state, detail, bufferedTrades: this.reconcileBuffer.length });
      const retryable = !this.reconcileOverflow && (rejection?.state === "pending" || rejection === null);
      if (retryable) {
        this.repairRetryCount++;
        this.repairFailingSince ??= Date.now();
        if (!this.pendingSession) {
          this.pendingSession = session;
          this.pendingRepairFrom = from;
        }
        this.repairActive = true;
        const scheduled = requestRecentCoverageRetry(
          this.host.series,
          this.repairRetryCount - 1,
          () => {
            if (this.host.isDisposed() || generation !== this.host.getGeneration() || this.pendingSession !== session) return false;
            this.startPendingRepair();
            return true;
          },
          repairRetryReason(rejection),
        );
        if (scheduled) {
          retryScheduled = true;
          this.reportRetrying(`${detail.slice(0, 140)}; retrying`);
          return;
        }
        this.repairDeferred = true;
        this.reportRetrying(detail.slice(0, 160));
        return;
      }
      this.repairDeferred = false;
      this.clearReconcileBuffer();
      this.host.series.releaseRepairFence();
      this.host.series.releaseRepairBarriers();
      const finalState = rejection?.state === "pending" ? "pending" : state;
      this.host.integrityReporter?.report(finalState, detail.slice(0, 160));
      if (finalState === "error") this.host.setDataDegraded(true, detail.slice(0, 160));
    }).finally(() => {
      this.host.series.releaseRepairFence();
      if (this.repairController === controller) {
        this.repairController = null;
        if (this.activeRepairSession === session) this.activeRepairSession = null;
        if (this.activeRepairFrom === from) this.activeRepairFrom = null;
        if (this.activeRepairToExclusive === toExclusive) this.activeRepairToExclusive = null;
        this.repairActive = Boolean(this.pendingSession) || this.repairDeferred;
      }
      if (!this.host.isDisposed()) {
        if (!this.repairActive && this.reconcileBuffer.length) this.clearReconcileBuffer();
        if (!this.repairActive) this.host.series.releaseRepairBarriers();
        if (!retryScheduled && !this.repairDeferred) this.startPendingRepair();
      }
    });
  }
}

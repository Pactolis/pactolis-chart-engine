/**
 * Truthful per-chart data state (#314, T04-A).
 *
 * Three questions are answered separately, because a yes to one says nothing about
 * the others:
 * - OHLC: are the candles the chart shows the venue's candles?
 * - Footprint: is the trade-level data under them (cells, volume, delta, count) complete?
 * - Freshness: how old is the newest trade the chart has applied?
 *
 * `healthy` is true only when all three are proven. Missing evidence (no coverage
 * answer, no trade yet, support not known) is reported as `unknown`, never as fine,
 * and an unsupported market's footprint is `unsupported` (not applicable), not
 * complete. A fresh chart whose live trades were dropped is not healthy just because
 * a resync will repair it: the loss stays visible until the repair finishes.
 */

export type OhlcState = "loading" | "ok" | "repairing" | "gap" | "error";
export type FootprintState = "unknown" | "complete" | "pending" | "partial" | "missing" | "degraded" | "unsupported";
export type FreshnessState = "unknown" | "live" | "delayed" | "stale" | "offline";
/** How live trades are reaching the chart: normally, draining a backlog, or resynchronizing after a gap. */
export type FreshnessPhase = "normal" | "catching-up" | "resyncing";

export type OhlcReason =
  | "HISTORY_LOADING"
  | "HISTORY_FAILED"
  | "CANDLE_SOURCE_GAP"
  | "LIVE_TRADES_DROPPED"
  | "LIVE_REPAIR_PENDING"
  | "LIVE_REPAIR_FAILED"
  | "INTEGRITY_ERROR"
  | null;

/**
 * Integrity detail prefix of a live repair that has kept failing past its fast retry ladder.
 * The gate is then "error", but the reason is the failed repair, not contradictory data.
 */
export const LIVE_REPAIR_UNRESOLVED_DETAIL = "LIVE_REPAIR_UNRESOLVED";

export type FootprintReason =
  | "HISTORY_LOADING"
  | "HISTORY_FAILED"
  | "SUPPORT_UNKNOWN"
  | "MARKET_UNSUPPORTED"
  | "NOT_COLLECTED"
  | "LIVE_TRADES_DROPPED"
  | "RECENT_REPAIR_PENDING"
  | "HISTORY_DEGRADED"
  | "COVERAGE_UNREPORTED"
  | "COVERAGE_INCOMPLETE"
  | null;

export type FreshnessReason = "NO_TRADE_YET" | "TRANSPORT_OFFLINE" | "TRADE_AGE" | null;

export interface ChartDataStateInputs {
  historyStatus: "idle" | "loading" | "settled" | "failed";
  /** A candle range whose kline source failed and is being asked for again. */
  candleSourceGap: boolean;
  /** Live repair / integrity gate of this chart's pipeline. */
  integrity: "pending" | "healthy" | "error";
  integrityDetail: string;
  /** Live trades were dropped by the pipeline's queue and a resync is required. */
  liveTradesDropped: boolean;
  /** The pipeline's live queue is full and is being drained. */
  liveBacklogOverloaded: boolean;
  /** `true`/`false` from the server or the bootstrap allowlist; `undefined` when neither has answered. */
  footprintSupported: boolean | undefined;
  footprintReceived: boolean;
  /** At least one history window answered with a footprint coverage report. */
  footprintCoverageReported: boolean;
  /** Every coverage report covered its request and no window was degraded. */
  footprintCoverageComplete: boolean;
  /** A history window came back degraded (e.g. the footprint store dropped bars). */
  footprintHistoryDegraded: boolean;
  recentFootprintRepairActive: boolean;
  /** Event time of the newest trade applied to the series, or null before the first one. */
  lastTradeTime: number | null;
  transportOffline: boolean;
}

export interface ChartDataStateThresholds {
  /** Soft freshness target. */
  liveMs: number;
  staleMs: number;
  offlineMs: number;
}

/**
 * Freshness thresholds and where they come from:
 * - 1 s live: the soft data-freshness target the user set in #308. On CI the 10x burst
 *   delivered every trade within p95 32 ms (worst 76 ms), so a healthy pipeline sits
 *   far under it and 1 s is a real symptom rather than noise.
 * - 15 s stale / 60 s offline: the app-wide `staleAfterMs` / `offlineAfterMs` defaults
 *   (src/core/config.ts) the connection status already uses, so a chart and the status
 *   bar never disagree about when data is stale.
 * Catch-up and resync are not timed: they come from the pipeline's own queue and repair
 * state. #312 measured the oldest pending trade under an all-market spike at < 106 ms,
 * so a full queue (10k trades) is never the normal path.
 */
export const DEFAULT_CHART_DATA_THRESHOLDS: ChartDataStateThresholds = Object.freeze({
  liveMs: 1_000,
  staleMs: 15_000,
  offlineMs: 60_000,
});

export interface ChartDataState {
  ohlc: { state: OhlcState; reason: OhlcReason; detail: string };
  footprint: { state: FootprintState; reason: FootprintReason };
  freshness: { state: FreshnessState; phase: FreshnessPhase; reason: FreshnessReason; ageMs: number | null };
  healthy: boolean;
}

function evaluateOhlc(input: ChartDataStateInputs): ChartDataState["ohlc"] {
  if (input.historyStatus === "idle" || input.historyStatus === "loading") return { state: "loading", reason: "HISTORY_LOADING", detail: "" };
  if (input.historyStatus === "failed") return { state: "error", reason: "HISTORY_FAILED", detail: "" };
  if (input.integrity === "error") {
    const reason = input.integrityDetail.startsWith(LIVE_REPAIR_UNRESOLVED_DETAIL) ? "LIVE_REPAIR_FAILED" : "INTEGRITY_ERROR";
    return { state: "error", reason, detail: input.integrityDetail };
  }
  if (input.candleSourceGap) return { state: "gap", reason: "CANDLE_SOURCE_GAP", detail: "" };
  if (input.liveTradesDropped) return { state: "repairing", reason: "LIVE_TRADES_DROPPED", detail: input.integrityDetail };
  if (input.integrity === "pending") return { state: "repairing", reason: "LIVE_REPAIR_PENDING", detail: input.integrityDetail };
  return { state: "ok", reason: null, detail: "" };
}

function evaluateFootprint(input: ChartDataStateInputs): ChartDataState["footprint"] {
  if (input.footprintSupported === false) return { state: "unsupported", reason: "MARKET_UNSUPPORTED" };
  if (input.historyStatus === "idle" || input.historyStatus === "loading") return { state: "unknown", reason: "HISTORY_LOADING" };
  if (input.footprintSupported === undefined) return { state: "unknown", reason: "SUPPORT_UNKNOWN" };
  if (input.historyStatus === "failed") return { state: "unknown", reason: "HISTORY_FAILED" };
  if (!input.footprintReceived) return { state: "missing", reason: "NOT_COLLECTED" };
  if (input.liveTradesDropped) return { state: "degraded", reason: "LIVE_TRADES_DROPPED" };
  if (input.recentFootprintRepairActive) return { state: "pending", reason: "RECENT_REPAIR_PENDING" };
  if (input.footprintHistoryDegraded) return { state: "degraded", reason: "HISTORY_DEGRADED" };
  if (!input.footprintCoverageReported) return { state: "unknown", reason: "COVERAGE_UNREPORTED" };
  if (!input.footprintCoverageComplete) return { state: "partial", reason: "COVERAGE_INCOMPLETE" };
  return { state: "complete", reason: null };
}

function evaluateFreshness(
  input: ChartDataStateInputs,
  now: number,
  thresholds: ChartDataStateThresholds,
): ChartDataState["freshness"] {
  const phase: FreshnessPhase = input.liveTradesDropped || input.integrity === "pending"
    ? "resyncing"
    : input.liveBacklogOverloaded ? "catching-up" : "normal";
  const ageMs = input.lastTradeTime === null || !Number.isFinite(input.lastTradeTime)
    ? null
    // Venue event time against the local clock: a clock running behind reads as age 0, not negative.
    : Math.max(0, now - input.lastTradeTime);
  if (input.transportOffline) return { state: "offline", phase, reason: "TRANSPORT_OFFLINE", ageMs };
  if (ageMs === null) return { state: "unknown", phase, reason: "NO_TRADE_YET", ageMs };
  const state: FreshnessState = ageMs >= thresholds.offlineMs ? "offline"
    : ageMs >= thresholds.staleMs ? "stale"
      : ageMs > thresholds.liveMs ? "delayed"
        : "live";
  return { state, phase, reason: state === "live" ? null : "TRADE_AGE", ageMs };
}

export function evaluateChartDataState(
  input: ChartDataStateInputs,
  now: number,
  thresholds: ChartDataStateThresholds = DEFAULT_CHART_DATA_THRESHOLDS,
): ChartDataState {
  const ohlc = evaluateOhlc(input);
  const footprint = evaluateFootprint(input);
  const freshness = evaluateFreshness(input, now, thresholds);
  const healthy = ohlc.state === "ok"
    && footprint.state === "complete"
    && freshness.state === "live"
    && freshness.phase === "normal";
  return { ohlc, footprint, freshness, healthy };
}

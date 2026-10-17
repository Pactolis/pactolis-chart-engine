import type { AnalysisRevisionSnapshot } from "../../core/analysisRevision.js";

export type HistoryReadinessStatus = "idle" | "loading" | "settled" | "failed";

export interface HistoryReadinessSnapshot {
  status: HistoryReadinessStatus;
  generation: number;
  market: string;
  timeframe: string;
  footprintReceived: boolean;
}

export type ChartCaptureReadinessReason =
  | "READY"
  | "DISPOSED"
  | "HISTORY_PENDING"
  | "HISTORY_FAILED"
  | "ANALYSIS_PENDING"
  | "ANALYSIS_FAILED"
  | "RENDER_PENDING";

export interface ChartCaptureReadinessInput {
  disposed: boolean;
  market: string;
  timeframe: string;
  /** Monotonic market/timeframe selection identity; internal history/analysis reloads do not advance it. */
  selectionGeneration: number;
  priceStep: number;
  history: HistoryReadinessSnapshot;
  analysis: AnalysisRevisionSnapshot;
  renderedAnalysisRevision: number;
  renderedAnalysisMarket: string;
}

export interface ChartCaptureReadiness extends ChartCaptureReadinessInput {
  ready: boolean;
  reason: ChartCaptureReadinessReason;
}

function result(input: ChartCaptureReadinessInput, reason: ChartCaptureReadinessReason): ChartCaptureReadiness {
  return { ...input, ready: reason === "READY", reason };
}

/**
 * Pure readiness gate used by the future native screenshot control path.
 *
 * Important invariants:
 * - zero footprint cells are a valid settled history state;
 * - progressive/partial Object Tree levels never count as full canonical readiness;
 * - the exact canonical data revision must have completed an annotation render pass;
 * - readiness is bound to the chart's current market/timeframe/selection generation/priceStep, not stale work.
 */
export function evaluateChartCaptureReadiness(input: ChartCaptureReadinessInput): ChartCaptureReadiness {
  if (input.disposed) return result(input, "DISPOSED");

  const history = input.history;
  if (history.status === "failed" && history.market === input.market && history.timeframe === input.timeframe) {
    return result(input, "HISTORY_FAILED");
  }
  if (history.status !== "settled" || history.market !== input.market || history.timeframe !== input.timeframe) {
    return result(input, "HISTORY_PENDING");
  }

  const expectedRunKey = `${input.market}|${input.priceStep}`;
  const canonical = input.analysis.canonical;
  const canonicalMatches = canonical.market === input.market && canonical.runKey === expectedRunKey;
  if (!canonicalMatches || canonical.status === "idle" || canonical.status === "running") {
    return result(input, "ANALYSIS_PENDING");
  }
  if (canonical.status === "partial" || canonical.status === "failed" || canonical.revision == null) {
    return result(input, "ANALYSIS_FAILED");
  }

  if (
    input.analysis.market !== input.market ||
    input.renderedAnalysisMarket !== input.market ||
    input.renderedAnalysisRevision < canonical.revision
  ) {
    return result(input, "RENDER_PENDING");
  }

  return result(input, "READY");
}

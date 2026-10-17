export type CanonicalAnalysisStatus = "idle" | "running" | "complete" | "partial" | "failed";

export interface CanonicalAnalysisReadinessSnapshot {
  status: CanonicalAnalysisStatus;
  market: string;
  runKey: string | null;
  generation: number;
  revision: number | null;
  failedPeriods: readonly string[];
}

export interface AnalysisRevisionSnapshot {
  /** Latest automatic-analysis data revision visible through AnalysisService. */
  revision: number;
  market: string;
  /** Full six-period canonical readiness; progressive data is never `complete`. */
  canonical: CanonicalAnalysisReadinessSnapshot;
}

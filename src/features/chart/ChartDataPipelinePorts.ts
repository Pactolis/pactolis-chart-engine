import type { AggTrade, FootprintBar } from "../../core/types.js";
import type { HistoryQuery } from "./historyContracts.js";
import type { TradeStreamSession } from "./historyContracts.js";

export interface TradeMarketReadiness extends TradeStreamSession {
  readonly market: string;
  readonly acknowledgedAt: number;
  readonly transportGeneration: number;
  /** Set when the market's venue recovered from an outage: repair from here (the gap start), not just the boundary. */
  readonly repairFrom?: number;
}

export interface PipelineIntegrityReporter {
  report(state: "pending" | "healthy" | "error", detail?: string): void;
  dispose(): void;
}

/** Consumer-owned service surface required by one ChartDataPipeline. */
export interface ChartDataPipelineServices {
  subscribeToTrades(market: string, cb: (trade: AggTrade) => void): () => void;
  subscribeToTradeSessions?(cb: (session: TradeStreamSession) => void): () => void;
  subscribeToTradeMarketReadiness?(cb: (readiness: TradeMarketReadiness) => void): () => void;
  acquirePipelineIntegrityReporter?(): PipelineIntegrityReporter;
  fetchHistory?(query: HistoryQuery): Promise<FootprintBar[]>;
  fetchPriceStep(market: string): Promise<number>;
  fetchPriceStepResult?(market: string): Promise<{ step: number; resolved: boolean }>;
  fetchPricePrecision(market: string): Promise<number | undefined>;
}

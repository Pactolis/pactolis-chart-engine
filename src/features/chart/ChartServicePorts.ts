import type { NpocResponse } from "./historyContracts.js";
import type { OrderbookHeatmapFetch } from "../orderbook/heatmapOverlay.js";
import type { AnalysisRevisionSnapshot } from "../../core/analysisRevision.js";
import type { AutomaticLevelsAsOf } from "../../core/analysisContext.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type { FootprintBar } from "../../core/types.js";
import type { ChartDataPipelineServices } from "./ChartDataPipelinePorts.js";
import type { ChartCommandServices } from "./chartCommands.js";

export interface ChartAnalysisChange {
  readonly kind: "automatic-data" | "user-state" | "user-preview";
  readonly market?: string;
  readonly dataRevision: number;
  readonly visibilityRevision: number;
}

export interface ChartAnalysisServices {
  getAnalysisRevisionSnapshot(market?: string): AnalysisRevisionSnapshot;
  /**
   * The market's automatic levels as of `asOf`, for a chart in replay; null until the market has
   * analysis source bars. Hosts without it leave replaying charts without automatic levels.
   */
  getAutomaticLevelsAsOf?(market: string, asOf: number): AutomaticLevelsAsOf | null;
  subscribeAnalysis(listener: (change: ChartAnalysisChange) => void): () => void;
  subscribeAnalysisRevision(listener: () => void): () => void;
}

export interface ChartCaptureServices {
  getAnalysisRevisionSnapshot(market?: string): AnalysisRevisionSnapshot;
}

export interface ChartReplayServices {
  updateAnalysisFromSeries(market: string, series: FootprintSeries, priceStep?: number): void;
}

export interface ChartHistoryServices extends ChartReplayServices {
  fetchNpocSnapshot(market: string, signal?: AbortSignal): Promise<NpocResponse>;
  notifyActiveMarket(market: string, priceStep?: number): void;
  notifyInteractiveCandlesReady(market: string, priceStep?: number): void;
  notifyInteractiveHistorySettled(market: string, priceStep?: number, footprintReceived?: boolean): void;
  /**
   * Ask the backend to fill this market's recent footprint gap. Fire-and-forget and
   * idempotent — it enqueues nothing when the backend is already up to date.
   */
  triggerAutoSync(market: string, priceStep?: number, days?: number): void;
  isFootprintSyncBusy?(): boolean;
}

/** Full service surface needed by the ChartRuntime composition root. */
export interface ChartRuntimeServices
  extends ChartDataPipelineServices,
    ChartCommandServices,
    ChartAnalysisServices,
    ChartCaptureServices,
    ChartHistoryServices {
  notifyBarClose(market: string, bar: FootprintBar, priceStep: number): void;
  /** Stored orderbook heatmap for the BTCUSDT perp chart overlay; absent in hosts without it. */
  fetchOrderbookHeatmap?: OrderbookHeatmapFetch;
}

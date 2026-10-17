import { chartHost } from "./chartHost.js";
import type { ChartCaptureServices } from "./ChartServicePorts.js";
import type { ChartDataPipeline } from "./ChartDataPipeline.js";
import type { ChartSession } from "./ChartSession.js";
import { evaluateChartCaptureReadiness, type ChartCaptureReadiness, type HistoryReadinessSnapshot, type HistoryReadinessStatus } from "./captureReadiness.js";
import {
  ChartCaptureError,
  captureStateMatches,
  createCaptureStateToken,
  type NativeChartCapture,
} from "./nativeCapture.js";

let nextHistoryDegradedKey = 0;

export interface ChartCaptureCoordinatorHost {
  readonly pipeline: ChartDataPipeline;
  readonly session: ChartSession;
  readonly svc: ChartCaptureServices;
  isDisposed(): boolean;
  getMarket(): string;
  getTimeframe(): string;
}

/** Owns capture selection generation, history readiness and painted-analysis barriers. */
export class ChartCaptureCoordinator {
  private selectionGeneration = 0;
  private historyGeneration = 0;
  private history: HistoryReadinessSnapshot;
  private renderedAnalysisRevision = 0;
  private renderedAnalysisMarket = "";
  private readonly listeners = new Set<(snapshot: ChartCaptureReadiness) => void>();
  private readonly historyDegradedKey = `history-load-${++nextHistoryDegradedKey}`;

  constructor(private readonly host: ChartCaptureCoordinatorHost, initialMarket: string, initialTimeframe: string) {
    this.history = {
      status: "idle",
      generation: 0,
      market: initialMarket,
      timeframe: initialTimeframe,
      footprintReceived: false,
    };
    const analysis = host.svc.getAnalysisRevisionSnapshot(initialMarket);
    this.renderedAnalysisRevision = analysis.revision;
    this.renderedAnalysisMarket = analysis.market;
  }

  /**
   * Advance user-visible selection ownership. Only a market switch changes the
   * analysis namespace; timeframe-only switches retain the already-painted market
   * revision exactly as the pre-extraction runtime did.
   */
  noteSelectionChange(): void {
    this.selectionGeneration++;
    const market = this.host.getMarket();
    if (this.renderedAnalysisMarket !== market) {
      const analysis = this.host.svc.getAnalysisRevisionSnapshot(market);
      this.renderedAnalysisRevision = analysis.revision;
      this.renderedAnalysisMarket = analysis.market;
    }
    this.emit();
  }

  notify(): void {
    this.emit();
  }

  beginHistoryLoad(market: string, timeframe: string): number {
    const generation = ++this.historyGeneration;
    this.history = { status: "loading", generation, market, timeframe, footprintReceived: false };
    this.emit();
    return generation;
  }

  settleHistoryLoad(generation: number, market: string, timeframe: string, footprintReceived: boolean): boolean {
    if (!this.ownsHistory(generation, market, timeframe)) return false;
    this.history = { status: "settled", generation, market, timeframe, footprintReceived };
    chartHost().setDataDegraded(this.historyDegradedKey, false);
    this.emit();
    return true;
  }

  failHistoryLoad(generation: number, market: string, timeframe: string): boolean {
    if (!this.ownsHistory(generation, market, timeframe)) return false;
    this.history = { status: "failed", generation, market, timeframe, footprintReceived: false };
    chartHost().setDataDegraded(this.historyDegradedKey, true, "History load incomplete: some requested data could not be loaded");
    this.emit();
    return true;
  }

  /** Status of the history load for the chart's current market and timeframe; another selection's load reads as loading. */
  getHistoryStatus(): HistoryReadinessStatus {
    const { status, market, timeframe } = this.history;
    return market === this.host.getMarket() && timeframe === this.host.getTimeframe() ? status : "loading";
  }

  noteAnalysisPaint(market: string, revision: number): void {
    if (market !== this.host.getMarket()) return;
    this.renderedAnalysisMarket = market;
    this.renderedAnalysisRevision = Math.max(this.renderedAnalysisRevision, revision);
    this.emit();
  }

  getReadiness(): ChartCaptureReadiness {
    const market = this.host.getMarket();
    return evaluateChartCaptureReadiness({
      disposed: this.host.isDisposed(),
      market,
      timeframe: this.host.getTimeframe(),
      selectionGeneration: this.selectionGeneration,
      priceStep: this.host.pipeline.series.config.priceStep,
      history: { ...this.history },
      analysis: this.host.svc.getAnalysisRevisionSnapshot(market),
      renderedAnalysisRevision: this.renderedAnalysisRevision,
      renderedAnalysisMarket: this.renderedAnalysisMarket,
    });
  }

  subscribe(cb: (snapshot: ChartCaptureReadiness) => void): () => void {
    this.listeners.add(cb);
    cb(this.getReadiness());
    return () => this.listeners.delete(cb);
  }

  async captureNativePng(): Promise<NativeChartCapture> {
    const token = createCaptureStateToken(this.getReadiness());
    const frame = await this.host.session.captureCompositePng();
    const post = this.getReadiness();
    if (!captureStateMatches(token, post)) {
      throw new ChartCaptureError("STATE_SUPERSEDED", "chart state changed while native capture was encoding");
    }
    return { ...frame, ...token };
  }

  dispose(): void {
    chartHost().setDataDegraded(this.historyDegradedKey, false);
    this.emit();
    this.listeners.clear();
  }

  private ownsHistory(generation: number, market: string, timeframe: string): boolean {
    return generation === this.historyGeneration
      && market === this.host.getMarket()
      && timeframe === this.host.getTimeframe();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.getReadiness();
    for (const listener of this.listeners) listener(snapshot);
  }
}

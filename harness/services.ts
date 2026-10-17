// Default chart services for harness pages that mount a chart on load. Analysis is
// empty, the price step resolves at once, and live trades arrive only when a spec
// calls `pushTrade`.
import type { AnalysisContext } from "../src/core/analysisContext.js";
import { normalizeMondayRangeSettings } from "../src/core/analysis/mondayRange.js";
import { normalizePreviousWeekStrategySettings } from "../src/core/analysis/previousWeekStrategy.js";
import { DEFAULT_VOLUME_PROFILE_SETTINGS } from "../src/core/analysis/volumeProfile.js";
import type { AggTrade } from "../src/core/types.js";
import type { ChartAnalysisChange, ChartRuntimeServices } from "../src/features/chart/ChartServicePorts.js";
import { DrawingManager } from "../src/features/drawings/drawingManager.js";
import type { OrderbookHeatmapRequest, OrderbookHeatmapResponse } from "../src/features/orderbook/heatmapContracts.js";

/** Stored orderbook heatmap over a plain JSON `/api/orderbook/heatmap` endpoint. */
export async function fetchOrderbookHeatmap(request: OrderbookHeatmapRequest, signal?: AbortSignal): Promise<OrderbookHeatmapResponse> {
  const params = new URLSearchParams({
    base: "BTC",
    source: request.source,
    resolution: request.resolution,
    from: String(request.from),
    to: String(request.to),
    bucketStep: String(request.bucketStep),
  });
  if (request.minUsd !== undefined) params.set("minUsd", String(request.minUsd));
  if (request.minBtc !== undefined) params.set("minBtc", String(request.minBtc));
  if (request.priceFrom !== undefined) params.set("priceFrom", String(request.priceFrom));
  if (request.priceTo !== undefined) params.set("priceTo", String(request.priceTo));
  const response = await fetch(`/api/orderbook/heatmap?${params.toString()}`, { signal });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: OrderbookHeatmapResponse; error?: { message?: string } } | null;
  if (!response.ok || !body?.ok || !body.data) throw new Error(body?.error?.message ?? `orderbook heatmap HTTP ${response.status}`);
  return body.data;
}

export interface HarnessServicesOptions {
  priceStep?: number;
  /** False reports the step as a guess, so the chart adopts the step a history answer names. */
  priceStepResolved?: boolean;
  pricePrecision?: number;
}

export interface HarnessServices extends ChartRuntimeServices {
  /** Deliver a live trade to every chart subscribed to `market`. */
  pushTrade(market: string, trade: AggTrade): void;
  readonly drawings: DrawingManager;
}

export function createHarnessServices(opts: HarnessServicesOptions = {}): HarnessServices {
  const priceStep = opts.priceStep ?? 10;
  const pricePrecision = opts.pricePrecision ?? 1;
  const drawings = new DrawingManager(() => {});
  const tradeListeners = new Map<string, Set<(trade: AggTrade) => void>>();
  const analysisContext = (market = ""): AnalysisContext => ({
    market,
    profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
    previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
    previousWeekStrategyLevels: [],
    mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
    mondayRangeLevels: [],
    nakedPocs: [],
    referenceLevels: [],
    drawings,
  });

  // Analysis is empty but must name the price step the chart runs on: capture
  // readiness waits for a canonical run keyed `${market}|${priceStep}`.
  const analysisSteps = new Map<string, number>();
  const revisionListeners = new Set<() => void>();
  const changeListeners = new Set<(change: ChartAnalysisChange) => void>();
  let revision = 1;
  const noteStep = (market: string, step?: number) => {
    if (!(step && step > 0) || analysisSteps.get(market) === step) return;
    analysisSteps.set(market, step);
    revision++;
    for (const listener of [...revisionListeners]) listener();
    const change: ChartAnalysisChange = { kind: "automatic-data", market, dataRevision: revision, visibilityRevision: revision };
    for (const listener of [...changeListeners]) listener(change);
  };

  return {
    drawings,
    pushTrade(market, trade) {
      for (const listener of tradeListeners.get(market) ?? []) listener(trade);
    },
    subscribeToTrades(market, cb) {
      let listeners = tradeListeners.get(market);
      if (!listeners) tradeListeners.set(market, listeners = new Set());
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    fetchPriceStep: async () => priceStep,
    fetchPriceStepResult: async () => ({ step: priceStep, resolved: opts.priceStepResolved ?? true }),
    fetchPricePrecision: async () => pricePrecision,
    getAnalysisContext: (market) => analysisContext(market),
    notify() {},
    getAnalysisRevisionSnapshot: (market = "") => ({
      market,
      revision,
      canonical: {
        status: "complete", market, runKey: `${market}|${analysisSteps.get(market) ?? priceStep}`,
        generation: revision, revision, failedPeriods: [],
      },
    }) as ReturnType<ChartRuntimeServices["getAnalysisRevisionSnapshot"]>,
    subscribeAnalysis(listener) {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },
    subscribeAnalysisRevision(listener) {
      revisionListeners.add(listener);
      return () => { revisionListeners.delete(listener); };
    },
    updateAnalysisFromSeries(market, _series, step) { noteStep(market, step); },
    fetchNpocSnapshot: () => new Promise(() => {}),
    notifyActiveMarket(market, step) { noteStep(market, step); },
    notifyInteractiveCandlesReady() {},
    notifyInteractiveHistorySettled() {},
    triggerAutoSync() {},
    isFootprintSyncBusy: () => false,
    notifyBarClose() {},
    fetchOrderbookHeatmap,
  };
}

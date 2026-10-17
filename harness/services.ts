// Default chart services for harness pages that mount a chart on load. Analysis is
// empty, the price step resolves at once, and live trades arrive only when a spec
// calls `pushTrade`.
import type { AnalysisContext } from "../src/core/analysisContext.js";
import { normalizeMondayRangeSettings } from "../src/core/analysis/mondayRange.js";
import { normalizePreviousWeekStrategySettings } from "../src/core/analysis/previousWeekStrategy.js";
import { DEFAULT_VOLUME_PROFILE_SETTINGS } from "../src/core/analysis/volumeProfile.js";
import type { AggTrade } from "../src/core/types.js";
import type { ChartRuntimeServices } from "../src/features/chart/ChartServicePorts.js";
import { DrawingManager } from "../src/features/drawings/drawingManager.js";

export interface HarnessServicesOptions {
  priceStep?: number;
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
    fetchPriceStepResult: async () => ({ step: priceStep, resolved: true }),
    fetchPricePrecision: async () => pricePrecision,
    getAnalysisContext: (market) => analysisContext(market),
    notify() {},
    getAnalysisRevisionSnapshot: (market = "") => ({
      market,
      revision: 1,
      canonical: { status: "complete", market, runKey: "harness", generation: 1, revision: 1, failedPeriods: [] },
    }) as ReturnType<ChartRuntimeServices["getAnalysisRevisionSnapshot"]>,
    subscribeAnalysis: () => () => {},
    subscribeAnalysisRevision: () => () => {},
    updateAnalysisFromSeries() {},
    fetchNpocSnapshot: () => new Promise(() => {}),
    notifyActiveMarket() {},
    notifyInteractiveCandlesReady() {},
    notifyInteractiveHistorySettled() {},
    triggerAutoSync() {},
    isFootprintSyncBusy: () => false,
    notifyBarClose() {},
  };
}

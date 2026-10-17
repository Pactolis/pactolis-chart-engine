// Browser test harness: wires the chart engine's ports the way a host application
// would, but with nothing behind them except a JSON `/history` endpoint the tests
// answer with Playwright routes. Specs import this module from the page and mount
// charts with `mountChart`.
import { configureChartLocale } from "../src/core/chartLocale.js";
import { configureFootprintBootstrapMarkets } from "../src/core/syncAllowlist.js";
import {
  DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
  type OrderbookHeatmapMode,
  type OrderbookHeatmapSettings,
} from "../src/core/orderbookHeatmap/settings.js";
import type { ChartPanelState, ChartType } from "../src/core/chartPanelState.js";
import { configureChartDataSource } from "../src/features/chart/chartDataSource.js";
import { configureChartHost } from "../src/features/chart/chartHost.js";
import { mountChartRuntime, type ChartMountHandle, type ChartRuntime } from "../src/features/chart/ChartRuntime.js";
import type { ChartRuntimeServices } from "../src/features/chart/ChartServicePorts.js";
import type { ChartSurfaceModel } from "../src/features/chart/chartSurfaceModel.js";
import { configureIndicatorDataSource } from "../src/features/indicators/indicatorDataSource.js";
import { createIndicatorPaneHeadersModel } from "../src/features/indicators/indicatorPaneHeaders.js";
import { configureOrderbookHeatmapSettingsSource } from "../src/features/orderbook/heatmapSettingsSource.js";
import { httpHistorySource } from "./historySource.js";
import { messages } from "./messages.js";
import { createHarnessServices, type HarnessServices } from "./services.js";

// --- Runtime registry ---------------------------------------------------------

const runtimes = new Map<string, ChartRuntime>();
const pairChartTypes = new Map<string, ChartType>();
const degraded = new Map<string, string | undefined>();

export function getChartRuntime(panelId: string | undefined): ChartRuntime | undefined {
  return panelId ? runtimes.get(panelId) : undefined;
}

export function listChartRuntimes(): ChartRuntime[] {
  return [...runtimes.values()];
}

export function listChartRuntimeEntries(): Array<readonly [panelId: string, runtime: ChartRuntime]> {
  return [...runtimes.entries()];
}

/** Data-degraded flags the engine raised, by key. */
export function dataDegradedFlags(): Record<string, string | undefined> {
  return Object.fromEntries(degraded);
}

// --- Orderbook heatmap settings ------------------------------------------------

let heatmapSettings: OrderbookHeatmapSettings = DEFAULT_ORDERBOOK_HEATMAP_SETTINGS;
const heatmapModeByMarket = new Map<string, OrderbookHeatmapMode>();
const heatmapListeners = new Set<() => void>();

function notifyHeatmapSettings(): void {
  for (const listener of heatmapListeners) listener();
}

export function getOrderbookHeatmapSettings(): OrderbookHeatmapSettings {
  return heatmapSettings;
}

export function updateOrderbookHeatmapSettings(patch: Partial<OrderbookHeatmapSettings>): void {
  heatmapSettings = { ...heatmapSettings, ...patch };
  notifyHeatmapSettings();
}

export function setOrderbookHeatmapModeFor(market: string, mode: OrderbookHeatmapMode): void {
  heatmapModeByMarket.set(market.toLowerCase(), mode);
  notifyHeatmapSettings();
}

export function orderbookHeatmapSettingsFor(market: string): OrderbookHeatmapSettings {
  const mode = heatmapModeByMarket.get(market.toLowerCase()) ?? heatmapSettings.mode;
  return mode === heatmapSettings.mode ? heatmapSettings : { ...heatmapSettings, mode };
}

// --- Ports -------------------------------------------------------------------

configureChartDataSource(httpHistorySource);

configureChartHost({
  registerRuntime: (panelId, runtime) => { runtimes.set(panelId, runtime); },
  unregisterRuntime: (panelId, runtime) => { if (runtimes.get(panelId) === runtime) runtimes.delete(panelId); },
  indicatorsChanged: () => {},
  setDataDegraded: (key, isDegraded, detail) => {
    if (isDegraded) degraded.set(key, detail);
    else degraded.delete(key);
  },
  isFootprintAutoFillEnabled: () => true,
  getPairChartType: (market) => pairChartTypes.get(market),
  setPairChartType: (market, type) => { pairChartTypes.set(market, type); },
  exposeDebugGlobals: () => true,
});

configureChartLocale({
  locale: () => "en-US",
  timeZone: () => "UTC",
  translate: (key, params) => {
    const text = messages[key] ?? key;
    return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;
  },
  onLocaleChange: () => () => {},
});

configureIndicatorDataSource({
  requestLiquidationSeries: () => ({ status: "idle" }),
  requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
  requestFuturesPositioningSeries: () => ({ status: "idle" }),
  fetchOptionsGexSurface: () => Promise.reject(new Error("options GEX is not served by the harness")),
});

configureOrderbookHeatmapSettingsSource({
  settingsFor: orderbookHeatmapSettingsFor,
  onChange: (listener) => {
    heatmapListeners.add(listener);
    return () => { heatmapListeners.delete(listener); };
  },
});

configureFootprintBootstrapMarkets([
  "BINANCE_FUTURES:btcusdt",
  "BINANCE_FUTURES:ethusdt",
  "BINANCE_FUTURES:solusdt",
  "BINANCE_FUTURES:avaxusdt",
  "BINANCE_FUTURES:xauusdt",
  "BINANCE_FUTURES:xagusdt",
  "BINANCE_FUTURES:clusdt",
]);

// --- Mounting ------------------------------------------------------------------

export type { ChartMountHandle };

export function createChartSurfaceModel(): ChartSurfaceModel {
  return {
    status: "loading",
    historyOverlay: false,
    historyBackground: false,
    indicatorHeaders: createIndicatorPaneHeadersModel(),
  };
}

export function mountChart(
  root: HTMLElement,
  state: ChartPanelState,
  services: ChartRuntimeServices,
  panelId: string,
  surface: ChartSurfaceModel = createChartSurfaceModel(),
  onStateChange?: (next: ChartPanelState) => void,
): ChartMountHandle {
  return mountChartRuntime(root, state, services, panelId, surface, onStateChange);
}

// `/harness/?chart=<market>&timeframe=<tf>&type=<chartType>` mounts one chart that fills
// the window, with the default harness services, as panel "harness-chart".
export let harnessChart: { panelId: string; root: HTMLElement; handle: ChartMountHandle; services: HarnessServices } | undefined;

const params = new URLSearchParams(location.search);
const market = params.get("chart");
if (market) {
  const root = document.createElement("div");
  root.className = "harness-chart";
  root.style.cssText = "position:fixed;inset:0;overflow:hidden;";
  document.body.appendChild(root);
  const services = createHarnessServices();
  const panelId = "harness-chart";
  const handle = mountChart(root, {
    type: "chart",
    market,
    timeframe: params.get("timeframe") ?? "15m",
    scaleMode: "linear",
    chartType: (params.get("type") ?? "footprint") as ChartType,
    candles: true,
  } as ChartPanelState, services, panelId);
  harnessChart = { panelId, root, handle, services };
}

(window as Window & { __chartHarnessReady?: boolean }).__chartHarnessReady = true;

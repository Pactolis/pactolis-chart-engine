/**
 * Strictly DOM-free chart worker runtime (`ChartWorkerPanelRuntime`) and
 * multi-panel pool (`ChartWorkerHostPool`).
 *
 * Runs inside a DedicatedWorker (or headless Node test) over `WorkerChartEndpoint`
 * with zero main-thread tick/history relay.
 */

import { ChartChange, ChartSurfaceDirty, surfaceDirtyForChanges } from "../../../core/render/scene/chartScene.js";
import { resolveBuiltInLayerPreset, type BuiltInChartType } from "../../../core/render/scene/chartLayerPreset.js";
import { View } from "../../../core/engine/view.js";
import type { Canvas2dContext, CanvasTarget } from "../../../core/gpu/canvasTarget.js";
import type { GpuBackendKind, GpuSurface } from "../../../core/gpu/gpuBackend.js";
import { getGpuDiagnostics, type GpuDiagnosticsSnapshot } from "../../../core/gpu/gpuDiagnostics.js";
import { readGpuSettings, type GpuBackendPreference } from "../../../core/gpu/gpuSettings.js";
import { createGpuSurfaceAsync } from "../../../core/gpu/selectBackend.js";
import { FootprintSeries } from "../../../core/model/footprint.js";
import {
  DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
  isOrderbookHeatmapMarket,
  type OrderbookHeatmapMode,
  type OrderbookHeatmapSettings,
} from "../../../core/orderbookHeatmap/settings.js";
import {
  configurePerformanceTelemetry,
  incrementPerformanceCounter,
  isPerformanceTelemetryEnabled,
  recordPerformanceDuration,
  snapshotPerformanceTelemetry,
} from "../../../core/performanceTelemetry.js";
import { FootprintRenderer } from "../../../core/render/footprintRenderer.js";
import { Overlay, type Crosshair } from "../../../core/render/overlay.js";
import { settings, type ChartViewConfig } from "../../../core/settings.js";
import type { FootprintBar, FootprintCell } from "../../../core/types.js";
import { ChartHeatmapGpuCoordinator } from "../ChartHeatmapGpuCoordinator.js";
import type { HeatmapGpuCellFrame } from "../heatmap/gpu/heatmapGpuRenderer.js";
import { IndicatorManager, drawIndicatorPaneBackground } from "../../indicators/IndicatorManager.js";
import type {
  OrderbookHeatmapRequest,
  OrderbookHeatmapResponse,
} from "../../orderbook/heatmapContracts.js";
import type { OrderbookHeatmapOverlay } from "../../orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
  type OrderbookHeatmapSettingsSource,
} from "../../orderbook/heatmapSettingsSource.js";
import {
  decodeHeatmapBarsFromBuffer,
  INGRESS_TICKS_STRIDE,
  type HeatmapProtocolBar,
  type WorkerChartStatePatch,
  type WorkerHistoryBar,
  type WorkerInputEvent,
  type WorkerSurfaceDescriptor,
  type WorkerSurfaceRole,
} from "./workerProtocol.js";
import {
  WorkerChartEndpoint,
  type MessagePortLike,
  type WorkerEndpointStats,
} from "./workerRuntimeAdapter.js";

const PACKED_BAR_STRIDE = 6; // [time, open, high, low, close, volume]
const DEFAULT_TIME_AXIS_HEIGHT = 24;

const workerHeatmapPanelModes = new Map<string, OrderbookHeatmapMode>();
const workerHeatmapPanelSettings = new Map<string, OrderbookHeatmapSettings>();
const workerHeatmapListeners = new Set<() => void>();
let installedFallbackSource: OrderbookHeatmapSettingsSource | null = null;

const workerHeatmapSettingsSource: OrderbookHeatmapSettingsSource = {
  settingsFor: (market, panelId) => {
    const key = `${panelId ?? ""}:${market}`;
    const stored = workerHeatmapPanelSettings.get(key);
    const mode = workerHeatmapPanelModes.get(key);
    if (stored !== undefined || mode !== undefined) {
      return {
        ...DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
        ...stored,
        mode: mode ?? stored?.mode ?? "off",
      };
    }
    return installedFallbackSource?.settingsFor(market, panelId) ?? {
      ...DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
      mode: "off",
    };
  },
  onChange: (listener) => {
    workerHeatmapListeners.add(listener);
    const unsubFallback = installedFallbackSource?.onChange(listener);
    return () => {
      workerHeatmapListeners.delete(listener);
      unsubFallback?.();
    };
  },
};

function ensureWorkerHeatmapSettingsSource(): void {
  let current: OrderbookHeatmapSettingsSource | null = null;
  try {
    current = orderbookHeatmapSettingsSource();
  } catch {
    current = null;
  }
  if (current === workerHeatmapSettingsSource) return;
  installedFallbackSource = current;
  configureOrderbookHeatmapSettingsSource(workerHeatmapSettingsSource);
}

export interface ChartWorkerPanelOptions {
  panelId: string;
  marketId: string;
  timeframe?: string;
  intervalMs?: number;
  priceStep?: number;
  pricePrecision?: number;
  backendPreference?: GpuBackendPreference;
  initialGeneration?: number;
  createScratchCanvas?: () => CanvasTarget;
  getWebGl2Context?: (canvas: CanvasTarget) => WebGL2RenderingContext | null;
  fetchOrderbookHeatmap?: (req: OrderbookHeatmapRequest, signal?: AbortSignal) => Promise<OrderbookHeatmapResponse>;
}

export interface ChartWorkerDiagnostics {
  readonly renderMode: "worker";
  readonly panelId: string;
  readonly marketId: string;
  readonly requestedBackend: GpuBackendPreference;
  readonly activeBackend: GpuBackendKind | null;
  readonly chartType: BuiltInChartType;
  readonly scaleMode: "linear" | "log";
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly intervalMs: number;
  readonly priceStep: number;
  readonly pricePrecision: number;
  readonly barCount: number;
  readonly cellCount: number;
  readonly oldestBarTime: number | null;
  readonly visibleRange: [number, number];
  readonly indicatorCount: number;
  readonly frameCount: number;
  readonly paused: boolean;
  readonly disposed: boolean;
  readonly endpointStats: WorkerEndpointStats;
  readonly gpuDiagnostics: GpuDiagnosticsSnapshot;
  readonly heatmap: ReturnType<ChartHeatmapGpuCoordinator["getDiagnostics"]> | null;
  readonly heatmapRaster: ReturnType<OrderbookHeatmapOverlay["getRasterDiagnostics"]> | null;
  readonly telemetry?: ReturnType<typeof snapshotPerformanceTelemetry>;
}

function toFootprintBar(bar: WorkerHistoryBar, intervalMs: number): FootprintBar {
  const safeInterval = intervalMs > 0 ? intervalMs : 60_000;
  const cells = new Map<number, FootprintCell>();
  let computedDelta = 0;
  if (bar.cells) {
    for (const [priceBin, buyVol, sellVol] of bar.cells) {
      cells.set(priceBin, { priceBin, buyVol, sellVol });
      computedDelta += buyVol - sellVol;
    }
  }
  return {
    startTime: Math.floor(bar.time / safeInterval) * safeInterval,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    delta: bar.delta ?? computedDelta,
    count: bar.count ?? (cells.size > 0 ? cells.size : 1),
    cells,
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
  };
}

function packedBufferToFootprintBars(buffer: ArrayBuffer, intervalMs: number): FootprintBar[] {
  const safeInterval = intervalMs > 0 ? intervalMs : 60_000;
  const view = new Float64Array(buffer);
  const count = Math.floor(view.length / PACKED_BAR_STRIDE);
  const bars: FootprintBar[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * PACKED_BAR_STRIDE;
    bars[i] = {
      startTime: Math.floor(view[base]! / safeInterval) * safeInterval,
      open: view[base + 1]!,
      high: view[base + 2]!,
      low: view[base + 3]!,
      close: view[base + 4]!,
      volume: view[base + 5]!,
      delta: 0,
      count: 1,
      cells: new Map<number, FootprintCell>(),
      hasRef: true,
      completeness: "complete",
      sources: ["history"],
    };
  }
  return bars;
}

function scheduleWorkerFrame(callback: () => void): { cancel: () => void } {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame;
  if (typeof raf === "function") {
    const id = raf(callback);
    return {
      cancel: () => {
        caf?.(id);
      },
    };
  }
  const timerId = setTimeout(callback, 16);
  return {
    cancel: () => {
      clearTimeout(timerId);
    },
  };
}

export class ChartWorkerPanelRuntime {
  readonly panelId: string;
  readonly marketId: string;
  readonly endpoint: WorkerChartEndpoint;
  readonly view: View;
  readonly series: FootprintSeries;

  private requestedBackend: GpuBackendPreference;
  private timeframe: string;
  private readonly createScratchCanvas?: () => CanvasTarget;
  private readonly getWebGl2Context?: (canvas: CanvasTarget) => WebGL2RenderingContext | null;

  private annotationCanvas: CanvasTarget | null = null;
  private interactionCanvas: CanvasTarget | null = null;
  private gpuSurface: GpuSurface | null = null;
  private renderer: FootprintRenderer | null = null;
  private overlay: Overlay | null = null;
  private indicatorManager: IndicatorManager | null = null;
  private orderbookHeatmap: OrderbookHeatmapOverlay | null = null;
  private orderbookHeatmapPromise: Promise<OrderbookHeatmapOverlay | null> | null = null;
  private readonly pendingHeatmapChunks: Array<{
    resolution?: "1m" | "5m" | "15m" | "1h";
    bucketStep?: number;
    from?: number;
    to?: number;
    bars: Array<{ t: number; cells: Array<[number, number, number]> }>;
  }> = [];
  private readonly pendingHeatmapTails: Array<{
    market?: string;
    timestamp?: number;
    bars?: Array<{ t: number; cells: Array<[number, number, number]> }>;
  }> = [];
  private readonly fetchOrderbookHeatmapOption: ChartWorkerPanelOptions["fetchOrderbookHeatmap"];
  private heatmapGpuCoordinator: ChartHeatmapGpuCoordinator | null = null;
  private offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>;
  private surfaceSetupId = 0;
  private cachedGpuLayersChartType: BuiltInChartType | null = null;
  private cachedGpuLayers: Set<ReturnType<typeof resolveBuiltInLayerPreset>["gpu"][number]> | null = null;

  private chartType: BuiltInChartType = "footprint";
  private cellData: ChartViewConfig["clusterCellData"] = settings.clusterCellData;
  private tpoMode: ChartViewConfig["tpoMode"] = settings.tpoMode;
  private scaleMode: "linear" | "log" = "linear";
  private orderbookHeatmapMode: OrderbookHeatmapMode = "off";
  private residentHeatmapEnabled: boolean = readGpuSettings().residentHeatmap;
  private candlesVisible: boolean = settings.candles;
  private heatVisible: boolean = settings.heat;
  private cellNumbersVisible: boolean = settings.cellNumbers;
  private pocVisible: boolean = settings.poc;
  private stackedImbalanceVisible: boolean = settings.stackedImbalance;

  private width = 640;
  private height = 360;
  private dpr = 1;
  private frameCount = 0;
  private paused = false;
  private disposed = false;
  private pendingChanges: number = ChartChange.None;
  private scheduledFrame: { cancel: () => void } | null = null;
  private initPromise: Promise<void> = Promise.resolve();
  private hasInitialFit = false;
  private expectedNextTickSeq: number | null = null;
  private dragging = false;
  private lastPointerX = 0;
  private readonly crosshair: Crosshair = { x: 0, y: 0, visible: false };

  constructor(options: ChartWorkerPanelOptions) {
    this.panelId = options.panelId;
    this.marketId = options.marketId;
    this.timeframe = options.timeframe ?? "1m";
    this.requestedBackend = options.backendPreference ?? "auto";
    this.createScratchCanvas = options.createScratchCanvas;
    this.getWebGl2Context = options.getWebGl2Context;

    ensureWorkerHeatmapSettingsSource();

    this.view = new View();
    this.series = new FootprintSeries({
      intervalMs: options.intervalMs ?? 60_000,
      priceStep: options.priceStep ?? 1,
      pricePrecision: options.pricePrecision ?? 2,
      referenceMarket: options.marketId,
    });

    this.indicatorManager = new IndicatorManager({
      initial: [],
      onChange: () => {
        // Authoritative indicator state is pushed from main thread via main:state-update.
      },
      onLayoutChange: () => {
        if (this.disposed) return;
        this.updateViewLayout();
        this.invalidate(ChartChange.Layout | ChartChange.Viewport);
      },
      onInvalidate: (changes) => {
        if (!this.disposed) this.invalidate(changes ?? ChartChange.All);
      },
      getChartContext: () => ({
        market: this.marketId,
        timeframe: this.timeframe,
        intervalMs: this.series.config.intervalMs,
      }),
      queuePriceLabel: (price, text, color, priority) => {
        this.overlay?.queuePriceAxisLabel(price, text, color, priority);
      },
    });

    this.fetchOrderbookHeatmapOption = options.fetchOrderbookHeatmap;

    const self = this;
    this.heatmapGpuCoordinator = new ChartHeatmapGpuCoordinator({
      get backendKind() { return self.gpuSurface?.kind ?? "canvas2d"; },
      get orderbookHeatmap() { return self.orderbookHeatmap; },
      get renderCoordinator() {
        return {
          getAnnotationLayerOrder: () => resolveBuiltInLayerPreset(self.chartType).annotation,
        };
      },
      get renderer() { return self.renderer!; },
      invalidateSession: () => {
        if (!this.disposed) this.invalidate(ChartChange.All);
      },
    });
    this.heatmapGpuCoordinator.setResidentHeatmapEnabled(this.residentHeatmapEnabled, false);

    this.endpoint = new WorkerChartEndpoint({
      panelId: options.panelId,
      marketId: options.marketId,
      initialGeneration: options.initialGeneration,
      handlers: {
        onInit: (payload) => {
          this.initPromise = this.handleInit(payload);
        },
        onResize: (payload) => {
          this.handleResize(payload.width, payload.height, payload.dpr);
        },
        onInput: (event) => {
          this.handleInputEvent(event);
        },
        onStateUpdate: (payload) => {
          void this.handleStateUpdate(payload);
        },
        onTick: (payload) => {
          this.handleTick(payload);
        },
        onTicks: (payload) => {
          this.handleTicks(payload);
        },
        onBar: (payload) => {
          this.handleBar(payload);
        },
        onHeatmapTail: (payload) => {
          this.handleHeatmapTail(payload);
        },
        onHistoryChunk: (payload) => {
          this.handleHistoryChunk(payload);
        },
        onHeatmapChunk: (payload) => {
          this.handleHeatmapChunk(payload);
        },
        onHitTest: (payload) => this.handleHitTest(payload.x, payload.y),
        onTooltip: (payload) => this.handleTooltip(payload.x, payload.y),
        onCapture: (payload) => this.handleCapture(payload),
        onLifecycle: (payload) => {
          this.handleLifecycle(payload);
        },
      },
    });
  }

  attachPorts(ports: {
    mainPort: MessagePortLike;
    ingressPort?: MessagePortLike;
    historyPort?: MessagePortLike;
  }): void {
    this.endpoint.attachPorts(ports);
  }

  async waitUntilReady(): Promise<void> {
    await this.initPromise;
  }

  renderNow(): boolean {
    if (this.disposed || this.paused || !this.gpuSurface || !this.renderer) {
      return false;
    }

    const frameStartedAt = performance.now();
    this.endpoint.flushInputs();

    const changes = this.pendingChanges === ChartChange.None ? ChartChange.All : this.pendingChanges;
    this.pendingChanges = ChartChange.None;

    const preset = resolveBuiltInLayerPreset(this.chartType);
    let dirty = surfaceDirtyForChanges(changes, {
      annotation: true,
      interaction: this.overlay?.hasTailDependentInteractionContent(
        this.view,
        this.series,
        this.crosshair,
        this.renderer.visibleRange(this.view, this.series.length),
        preset.interaction,
      ) ?? false,
    });
    if (
      (changes & ChartChange.Interaction)
      && (
        (this.indicatorManager?.getPaneRenders().some((pane) => !pane.collapsed && pane.requiresInteractionRedraw === true) ?? false)
        || (this.overlay?.hasInteractionDependentHudContent(this.crosshair) ?? false)
      )
    ) {
      dirty |= ChartSurfaceDirty.Annotation;
    }

    if (dirty & ChartSurfaceDirty.GpuScene) {
      this.heatmapGpuCoordinator?.beginFrameAttempt();
      let heatmapFrame: HeatmapGpuCellFrame | null = null;
      const gpuStartedAt = performance.now();
      try {
        heatmapFrame = this.heatmapGpuCoordinator?.prepareHeatmapGpuCells(this.view, this.series) ?? null;
        const isOrderbookHeatmapActive =
          this.orderbookHeatmap !== null
          && isOrderbookHeatmapMarket(this.marketId)
          && this.orderbookHeatmapMode !== "off";
        this.renderer.setAllowNativeFootprintText(!isOrderbookHeatmapActive);
        if (this.cachedGpuLayersChartType !== this.chartType || !this.cachedGpuLayers) {
          this.cachedGpuLayersChartType = this.chartType;
          this.cachedGpuLayers = new Set(preset.gpu);
        }
        this.gpuSurface.beginNativeComposite?.();
        try {
          this.renderer.renderLayers(this.view, this.series, this.cachedGpuLayers);
          this.heatmapGpuCoordinator?.renderHeatmapGpuCells(heatmapFrame, this.view, this.series);
        } finally {
          this.gpuSurface.flushNativeComposite?.();
        }
      } catch (error) {
        heatmapFrame?.preparedLease?.release();
        heatmapFrame = null;
        throw error;
      }
      recordPerformanceDuration("chart.surface.gpu.draw.ms", performance.now() - gpuStartedAt);
    }

    if (this.overlay && (dirty & (ChartSurfaceDirty.Annotation | ChartSurfaceDirty.Interaction))) {
      const range = this.renderer.visibleRange(this.view, this.series.length);
      if (dirty & ChartSurfaceDirty.Annotation) {
        const annotationStartedAt = performance.now();
        this.overlay.renderAnnotations(
          this.view,
          this.series,
          this.crosshair,
          range,
          preset.annotation,
          changes as ChartChange,
        );
        recordPerformanceDuration("chart.surface.annotation.draw.ms", performance.now() - annotationStartedAt);
      }
      if (dirty & ChartSurfaceDirty.Interaction) {
        const interactionStartedAt = performance.now();
        this.overlay.renderInteraction(
          this.view,
          this.series,
          this.crosshair,
          range,
          preset.interaction,
        );
        recordPerformanceDuration("chart.surface.interaction.draw.ms", performance.now() - interactionStartedAt);
      }
    }

    const renderMs = performance.now() - frameStartedAt;
    recordPerformanceDuration("chart.frame.render.ms", renderMs);
    incrementPerformanceCounter("chart.raf.frames");
    if (dirty & ChartSurfaceDirty.GpuScene) {
      this.heatmapGpuCoordinator?.observeRenderedFrame({
        renderMs,
        rafLatencyMs: null,
        visible: true,
      });
    }

    this.frameCount++;
    return true;
  }

  getDiagnostics(): ChartWorkerDiagnostics {
    let cellCount = 0;
    for (let i = 0; i < this.series.length; i++) {
      cellCount += this.series.at(i)?.cells.size ?? 0;
    }
    const visibleRange: [number, number] = this.renderer
      ? this.renderer.visibleRange(this.view, this.series.length)
      : [0, 0];
    const indicatorCount = this.indicatorManager?.peekInstances().length ?? 0;
    const telemetry = isPerformanceTelemetryEnabled() ? snapshotPerformanceTelemetry() : undefined;
    return {
      renderMode: "worker",
      panelId: this.panelId,
      marketId: this.marketId,
      requestedBackend: this.requestedBackend,
      activeBackend: this.gpuSurface?.kind ?? null,
      chartType: this.chartType,
      scaleMode: this.scaleMode,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      intervalMs: this.series.config.intervalMs,
      priceStep: this.series.config.priceStep,
      pricePrecision: this.series.config.pricePrecision ?? 2,
      barCount: this.series.length,
      cellCount,
      oldestBarTime: this.series.length > 0 ? this.series.at(0)?.startTime ?? null : null,
      visibleRange,
      indicatorCount,
      frameCount: this.frameCount,
      paused: this.paused,
      disposed: this.disposed,
      endpointStats: this.endpoint.getStats(),
      gpuDiagnostics: getGpuDiagnostics(),
      heatmap: this.heatmapGpuCoordinator?.getDiagnostics() ?? null,
      heatmapRaster: this.orderbookHeatmap?.getRasterDiagnostics() ?? null,
      ...(telemetry !== undefined ? { telemetry } : {}),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduledFrame?.cancel();
    this.scheduledFrame = null;
    const heatmapKey = `${this.panelId}:${this.marketId}`;
    workerHeatmapPanelModes.delete(heatmapKey);
    workerHeatmapPanelSettings.delete(heatmapKey);
    this.indicatorManager?.dispose();
    this.indicatorManager = null;
    this.heatmapGpuCoordinator?.dispose();
    this.heatmapGpuCoordinator = null;
    this.pendingHeatmapChunks.length = 0;
    this.pendingHeatmapTails.length = 0;
    this.orderbookHeatmap?.dispose();
    this.orderbookHeatmap = null;
    this.overlay?.dispose();
    this.overlay = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.gpuSurface?.dispose();
    this.gpuSurface = null;
    this.annotationCanvas = null;
    this.interactionCanvas = null;
    this.offscreenCanvases = undefined;
    this.endpoint.dispose();
  }

  private chartViewConfig(): ChartViewConfig {
    return {
      chartType: this.chartType,
      tpoMode: this.tpoMode,
      tpoProfilePeriod: settings.tpoProfilePeriod,
      tpoBracketSize: settings.tpoBracketSize,
      clusterCellData: this.cellData,
      profileCellData: this.cellData,
      candles: this.candlesVisible,
      heat: this.heatVisible,
      cellNumbers: this.cellNumbersVisible,
      poc: this.pocVisible,
      stackedImbalance: this.stackedImbalanceVisible,
    };
  }

  private applyChartConfig(): void {
    const cfg = this.chartViewConfig();
    this.renderer?.setChartConfig(cfg);
    this.overlay?.setChartConfig(cfg);
  }

  private async handleInit(payload: {
    surfaces: ReadonlyArray<WorkerSurfaceDescriptor>;
    viewport: { width: number; height: number; dpr: number };
    backendPreference?: GpuBackendPreference;
    offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>;
  }): Promise<void> {
    if (this.disposed) return;
    if (payload.backendPreference) {
      this.requestedBackend = payload.backendPreference;
    }
    this.offscreenCanvases = payload.offscreenCanvases;

    await this.setupSurfaces(
      payload.viewport.width,
      payload.viewport.height,
      payload.viewport.dpr,
      payload.offscreenCanvases,
    );

    if (this.series.length > 0 && !this.hasInitialFit) {
      this.fitViewToSeries();
    }
    this.invalidate(ChartChange.All);
  }

  private async setupSurfaces(
    width: number,
    height: number,
    dpr: number,
    offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>,
  ): Promise<void> {
    const safeW = Math.max(1, Math.floor(width) || 1);
    const safeH = Math.max(1, Math.floor(height) || 1);
    const safeDpr = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
    const bitmapW = Math.max(1, Math.round(safeW * safeDpr));
    const bitmapH = Math.max(1, Math.round(safeH * safeDpr));

    this.width = safeW;
    this.height = safeH;
    this.dpr = safeDpr;
    this.updateViewLayout();

    const makeCanvas = (role: WorkerSurfaceRole): CanvasTarget => {
      const provided = offscreenCanvases?.[role];
      if (provided) {
        provided.width = bitmapW;
        provided.height = bitmapH;
        return provided;
      }
      if (typeof OffscreenCanvas === "function") {
        return new OffscreenCanvas(bitmapW, bitmapH);
      }
      if (this.createScratchCanvas) {
        const created = this.createScratchCanvas();
        created.width = bitmapW;
        created.height = bitmapH;
        return created;
      }
      throw new Error(`ChartWorkerPanelRuntime: no canvas available for role "${role}"`);
    };

    const setupId = ++this.surfaceSetupId;
    const nextGpuCanvas = makeCanvas("gpu-scene");
    const nextAnnotationCanvas = makeCanvas("annotation");
    const nextInteractionCanvas = makeCanvas("interaction");

    const nextSurface = await createGpuSurfaceAsync(
      nextGpuCanvas,
      this.requestedBackend,
      undefined,
      this.getWebGl2Context,
      { createCanvas: this.createScratchCanvas },
    );

    if (this.disposed || setupId !== this.surfaceSetupId) {
      nextSurface.dispose();
      return;
    }

    nextSurface.resize(bitmapW, bitmapH, safeDpr);

    this.gpuSurface?.dispose();
    this.annotationCanvas = nextAnnotationCanvas;
    this.interactionCanvas = nextInteractionCanvas;
    this.gpuSurface = nextSurface;

    if (!this.renderer) {
      this.renderer = new FootprintRenderer(nextSurface);
    } else {
      this.renderer.setSurface(nextSurface);
    }

    const resolvedGl = nextSurface.kind === "webgl2"
      ? (
        this.getWebGl2Context?.(nextGpuCanvas)
        ?? (nextSurface as { getGlContext?: () => WebGL2RenderingContext | null }).getGlContext?.()
        ?? null
      )
      : null;
    this.heatmapGpuCoordinator?.setGl(resolvedGl);
    this.heatmapGpuCoordinator?.setSurface(nextSurface);

    const annotationCtx = nextAnnotationCanvas.getContext?.("2d") as Canvas2dContext | null;
    const interactionCtx = nextInteractionCanvas.getContext?.("2d") as Canvas2dContext | null;

    if (annotationCtx) {
      annotationCtx.setTransform?.(safeDpr, 0, 0, safeDpr, 0, 0);
      interactionCtx?.setTransform?.(safeDpr, 0, 0, safeDpr, 0, 0);
      if (!this.overlay) {
        this.overlay = new Overlay(
          annotationCtx,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () => this.indicatorManager?.getPaneRenders() ?? [],
          () => this.indicatorManager?.getPriceOverlayRenders() ?? [],
          undefined,
          undefined,
          drawIndicatorPaneBackground,
          () => this.indicatorManager?.isIndicatorPaneMaximized() ?? false,
          interactionCtx ?? undefined,
          undefined,
          (ctx, activeView, activeSeries, range) => {
            if (this.heatmapGpuCoordinator?.heatmapGpuSuppressedAnnotation(activeView, activeSeries, range)) {
              incrementPerformanceCounter("chart.gpu.heatmap.annotation.suppressed");
              this.orderbookHeatmap?.releaseRasterCache();
              return false;
            }
            if (!this.orderbookHeatmap) return false;
            incrementPerformanceCounter("chart.cpu.heatmap.annotation.fallback");
            this.orderbookHeatmap.draw(ctx, activeView, activeSeries, range);
            return this.chartType !== "tpo" || (
              isOrderbookHeatmapMarket(this.marketId)
              && this.orderbookHeatmapMode !== "off"
            );
          },
          (ctx, activeView, activeSeries, activeCrosshair) => {
            this.orderbookHeatmap?.drawHover(ctx, activeView, activeSeries, activeCrosshair);
          },
        );
      } else {
        this.overlay.updateContext(annotationCtx);
        if (interactionCtx) {
          this.overlay.updateInteractionContext(interactionCtx);
        }
      }
    }

    this.applyChartConfig();
  }

  private async handleStateUpdate(patch: WorkerChartStatePatch): Promise<void> {
    if (this.disposed) return;
    if (patch.chartType !== undefined) {
      this.chartType = patch.chartType;
    }
    if (patch.cellData !== undefined) {
      this.cellData = patch.cellData;
    }
    if (patch.tpoMode !== undefined) {
      this.tpoMode = patch.tpoMode;
    }
    if (patch.scaleMode !== undefined) {
      this.scaleMode = patch.scaleMode;
      this.view.setScaleMode(patch.scaleMode);
    }
    if (patch.candles !== undefined) {
      this.candlesVisible = patch.candles;
    }
    if (patch.heat !== undefined) {
      this.heatVisible = patch.heat;
    }
    if (patch.cellNumbers !== undefined) {
      this.cellNumbersVisible = patch.cellNumbers;
    }
    if (patch.poc !== undefined) {
      this.pocVisible = patch.poc;
    }
    if (patch.stackedImbalance !== undefined) {
      this.stackedImbalanceVisible = patch.stackedImbalance;
    }
    if (patch.orderbookHeatmapSettings !== undefined) {
      const heatmapKey = `${this.panelId}:${this.marketId}`;
      const prevSettings = workerHeatmapPanelSettings.get(heatmapKey) ?? {
        ...DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
        mode: this.orderbookHeatmapMode,
      };
      const nextMode = patch.orderbookHeatmapMode ?? patch.orderbookHeatmapSettings.mode ?? prevSettings.mode ?? this.orderbookHeatmapMode;
      const mergedSettings: OrderbookHeatmapSettings = {
        ...DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
        ...prevSettings,
        ...patch.orderbookHeatmapSettings,
        mode: nextMode,
      };
      workerHeatmapPanelSettings.set(heatmapKey, mergedSettings);
      if (patch.orderbookHeatmapMode === undefined && patch.orderbookHeatmapSettings.mode !== undefined) {
        this.orderbookHeatmapMode = patch.orderbookHeatmapSettings.mode;
        workerHeatmapPanelModes.set(heatmapKey, patch.orderbookHeatmapSettings.mode);
      }
      for (const listener of workerHeatmapListeners) {
        listener();
      }
    }
    if (patch.orderbookHeatmapMode !== undefined) {
      const heatmapKey = `${this.panelId}:${this.marketId}`;
      this.orderbookHeatmapMode = patch.orderbookHeatmapMode;
      workerHeatmapPanelModes.set(heatmapKey, patch.orderbookHeatmapMode);
      const existingSettings = workerHeatmapPanelSettings.get(heatmapKey);
      if (existingSettings) {
        workerHeatmapPanelSettings.set(heatmapKey, {
          ...existingSettings,
          mode: patch.orderbookHeatmapMode,
        });
      }
      for (const listener of workerHeatmapListeners) {
        listener();
      }
    }
    if (patch.residentHeatmap !== undefined) {
      this.residentHeatmapEnabled = patch.residentHeatmap;
      this.heatmapGpuCoordinator?.setResidentHeatmapEnabled(
        patch.residentHeatmap,
        patch.residentHeatmapExplicit === true,
      );
    }
    if (patch.priceStep !== undefined && Number.isFinite(patch.priceStep) && patch.priceStep > 0) {
      if (this.series.config.priceStep !== patch.priceStep) {
        this.series.setPriceStep(patch.priceStep);
      }
    }
    if (patch.pricePrecision !== undefined && Number.isFinite(patch.pricePrecision)) {
      this.series.setPricePrecision(patch.pricePrecision);
    }
    if (patch.indicators !== undefined && this.indicatorManager) {
      this.indicatorManager.restore([...patch.indicators]);
      this.updateViewLayout();
    }
    if (patch.telemetryEnabled !== undefined) {
      configurePerformanceTelemetry({ enabled: patch.telemetryEnabled });
    }

    this.applyChartConfig();

    if (this.orderbookHeatmapMode !== "off") {
      await this.ensureOrderbookHeatmap();
    }

    if (patch.backendPreference !== undefined && patch.backendPreference !== this.requestedBackend) {
      this.requestedBackend = patch.backendPreference;
      await this.setupSurfaces(this.width, this.height, this.dpr, this.offscreenCanvases);
    }

    if (!this.disposed) {
      this.invalidate(ChartChange.Style | ChartChange.All);
    }
  }

  private async ensureOrderbookHeatmap(): Promise<OrderbookHeatmapOverlay | null> {
    if (this.disposed || this.orderbookHeatmapMode === "off") return null;
    if (this.orderbookHeatmap) return this.orderbookHeatmap;
    if (this.orderbookHeatmapPromise) return this.orderbookHeatmapPromise;

    const promise = import("../../orderbook/heatmapOverlay.js").then((mod) => {
      if (this.orderbookHeatmapPromise === promise) {
        this.orderbookHeatmapPromise = null;
      }
      if (this.disposed || this.orderbookHeatmapMode === "off") return null;
      if (!this.orderbookHeatmap) {
        this.orderbookHeatmap = new mod.OrderbookHeatmapOverlay({
          fetch: this.fetchOrderbookHeatmapOption ?? (async (req) => ({
            schemaVersion: 1,
            generatedAt: Date.now(),
            base: "BTC",
            source: req.source,
            resolution: req.resolution,
            bucketStep: req.bucketStep,
            from: req.from,
            to: req.to,
            bars: [],
          })),
          invalidate: () => {
            if (!this.disposed) {
              this.invalidate(this.heatmapGpuCoordinator?.getFrame() !== null ? ChartChange.GpuContext : ChartChange.Data);
            }
          },
          getMarket: () => this.marketId,
          getPanelId: () => this.panelId,
          isReplayActive: () => false,
        });
        for (const chunk of this.pendingHeatmapChunks.splice(0)) {
          this.orderbookHeatmap.ingestWorkerHeatmapChunk(chunk);
        }
        for (const tail of this.pendingHeatmapTails.splice(0)) {
          this.orderbookHeatmap.ingestWorkerHeatmapTail(tail);
        }
      }
      return this.orderbookHeatmap;
    }).catch(() => {
      if (this.orderbookHeatmapPromise === promise) {
        this.orderbookHeatmapPromise = null;
      }
      return null;
    });
    this.orderbookHeatmapPromise = promise;
    return promise;
  }

  private handleHeatmapChunk(payload: {
    resolution?: "1m" | "5m" | "15m" | "1h";
    bucketStep?: number;
    from?: number;
    to?: number;
    bars: ReadonlyArray<HeatmapProtocolBar> | ArrayBuffer;
  }): void {
    const rawBars = payload.bars;
    try {
      if (this.disposed) return;
      if (!this.orderbookHeatmap && this.orderbookHeatmapMode === "off") return;
      const decodedBars = rawBars instanceof ArrayBuffer
        ? decodeHeatmapBarsFromBuffer(rawBars)
        : rawBars.map((bar) => ({
            t: bar.t,
            cells: bar.cells.map(([p, b, a]): [number, number, number] => [p, b, a]),
          }));
      const normalized = {
        resolution: payload.resolution,
        bucketStep: payload.bucketStep,
        from: payload.from,
        to: payload.to,
        bars: decodedBars,
      };
      if (!this.orderbookHeatmap) {
        if (this.pendingHeatmapChunks.length > 32) this.pendingHeatmapChunks.shift();
        this.pendingHeatmapChunks.push(normalized);
        void this.ensureOrderbookHeatmap();
        return;
      }
      this.orderbookHeatmap.ingestWorkerHeatmapChunk(normalized);
    } finally {
      if (rawBars instanceof ArrayBuffer) {
        this.endpoint.recycleBuffer(rawBars);
      }
    }
  }

  private handleHeatmapTail(payload: {
    market?: string;
    timestamp?: number;
    bars?: ReadonlyArray<HeatmapProtocolBar> | ArrayBuffer;
  }): void {
    const rawBars = payload.bars;
    try {
      if (this.disposed) return;
      if (!this.orderbookHeatmap && this.orderbookHeatmapMode === "off") return;
      const decodedBars = rawBars instanceof ArrayBuffer
        ? decodeHeatmapBarsFromBuffer(rawBars)
        : rawBars?.map((bar) => ({
            t: bar.t,
            cells: bar.cells.map(([p, b, a]): [number, number, number] => [p, b, a]),
          }));
      const normalized = {
        market: payload.market,
        timestamp: payload.timestamp,
        bars: decodedBars,
      };
      if (!this.orderbookHeatmap) {
        if (this.pendingHeatmapTails.length > 32) this.pendingHeatmapTails.shift();
        this.pendingHeatmapTails.push(normalized);
        void this.ensureOrderbookHeatmap();
        return;
      }
      this.orderbookHeatmap.ingestWorkerHeatmapTail(normalized);
    } finally {
      if (rawBars instanceof ArrayBuffer) {
        this.endpoint.recycleBuffer(rawBars);
      }
    }
  }

  private handleResize(width: number, height: number, dpr: number): void {
    if (this.disposed) return;
    const safeW = Math.max(1, Math.floor(width) || 1);
    const safeH = Math.max(1, Math.floor(height) || 1);
    const safeDpr = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
    const bitmapW = Math.max(1, Math.round(safeW * safeDpr));
    const bitmapH = Math.max(1, Math.round(safeH * safeDpr));

    this.width = safeW;
    this.height = safeH;
    this.dpr = safeDpr;
    this.updateViewLayout();

    this.gpuSurface?.resize(bitmapW, bitmapH, safeDpr);
    for (const c of [this.annotationCanvas, this.interactionCanvas]) {
      if (!c) continue;
      if (c.width !== bitmapW) c.width = bitmapW;
      if (c.height !== bitmapH) c.height = bitmapH;
      const ctx2d = c.getContext?.("2d") as Canvas2dContext | null;
      ctx2d?.setTransform?.(safeDpr, 0, 0, safeDpr, 0, 0);
    }

    if (this.series.length > 0 && this.view.isPriceAutoScale()) {
      this.autoFitVisiblePrices();
    }
    this.invalidate(ChartChange.Viewport);
  }

  private updateViewLayout(): void {
    const layoutOptions = this.view.chartLayoutOptions;
    const timeAxisHeight = layoutOptions?.timeAxisHeight ?? DEFAULT_TIME_AXIS_HEIGHT;
    const priceAxisWidth = layoutOptions?.priceAxisWidth ?? this.view.priceAxisW;
    const availableHeight = Math.max(1, this.height - timeAxisHeight - 1);
    const paneH = this.indicatorManager?.totalPaneHeight(availableHeight) ?? 0;
    this.view.subPanesH = paneH;
    this.view.priceAxisW = priceAxisWidth;
    const plotW = Math.max(1, this.width - priceAxisWidth);
    const plotH = Math.max(1, this.height - timeAxisHeight - paneH);
    this.view.area = { left: 0, top: 0, width: plotW, height: plotH };
    this.view.pixelRatio = this.dpr;
    this.indicatorManager?.layout(this.view);
  }

  private applyTickTrade(
    price: number,
    size: number,
    timestamp: number,
    isBuy: boolean,
    tradeId?: string,
  ): void {
    this.series.addTrade({
      time: timestamp,
      price,
      qty: size,
      isBuy,
      id: tradeId,
      market: this.marketId,
      source: "live",
    });
  }

  private finishTickUpdate(): void {
    if (!this.hasInitialFit) {
      this.fitViewToSeries();
    } else if (this.view.isPriceAutoScale()) {
      this.autoFitVisiblePrices();
    }
    this.invalidate(ChartChange.DataTail);
  }

  private handleTick(payload: {
    price: number;
    size: number;
    timestamp: number;
    side?: "buy" | "sell";
    tradeId?: string;
  }): void {
    if (this.disposed) return;
    this.applyTickTrade(
      payload.price,
      payload.size,
      payload.timestamp,
      payload.side !== "sell",
      payload.tradeId,
    );
    this.finishTickUpdate();
  }

  /**
   * Applies a packed `ingress:ticks` batch sequentially using `applyTickTrade`,
   * performing a single viewport-fit and a single `ChartChange.DataTail`
   * invalidation at the end of the batch, then emits `ingress:credit`
   * (`{ granted: appliedCount }`) on the ingress port so the producer can
   * maintain its in-flight tick budget.
   */
  private handleTicks(payload: {
    buffer: ArrayBuffer;
    count: number;
    firstSeq: number;
    schema: 1;
  }): void {
    try {
      if (this.disposed || payload.schema !== 1 || payload.count <= 0) {
        return;
      }
      const view = new Float64Array(payload.buffer);
      const maxRecords = Math.floor(view.length / INGRESS_TICKS_STRIDE);
      const appliedCount = Math.min(payload.count, maxRecords);
      if (appliedCount <= 0) {
        return;
      }

      if (this.expectedNextTickSeq !== null && payload.firstSeq > this.expectedNextTickSeq) {
        this.endpoint.emitDiagnostic({
          type: "ingress-gap",
          expectedSeq: this.expectedNextTickSeq,
          receivedSeq: payload.firstSeq,
          gap: payload.firstSeq - this.expectedNextTickSeq,
        });
      }
      const batchEndSeq = payload.firstSeq + appliedCount;
      this.expectedNextTickSeq =
        this.expectedNextTickSeq === null
          ? batchEndSeq
          : Math.max(this.expectedNextTickSeq, batchEndSeq);

      for (let i = 0; i < appliedCount; i++) {
        const base = i * INGRESS_TICKS_STRIDE;
        const timestamp = view[base]!;
        const price = view[base + 1]!;
        const size = view[base + 2]!;
        const sideFlag = view[base + 3]!;
        this.applyTickTrade(price, size, timestamp, sideFlag !== -1);
      }

      this.finishTickUpdate();
      this.endpoint.grantIngressCredits(appliedCount);
    } finally {
      this.endpoint.recycleBuffer(payload.buffer);
    }
  }

  private handleBar(payload: WorkerHistoryBar): void {
    if (this.disposed) return;
    this.series.upsertBar(toFootprintBar(payload, this.series.config.intervalMs));
    if (!this.hasInitialFit) {
      this.fitViewToSeries();
    } else if (this.view.isPriceAutoScale()) {
      this.autoFitVisiblePrices();
    }
    this.invalidate(ChartChange.Data | ChartChange.DataTail);
  }

  private handleHistoryChunk(payload: {
    timeframe: string;
    bars: ReadonlyArray<WorkerHistoryBar> | ArrayBuffer;
    hasMore: boolean;
    chunkIndex: number;
  }): void {
    if (this.disposed) {
      if (payload.bars instanceof ArrayBuffer) {
        this.endpoint.recycleBuffer(payload.bars);
      }
      return;
    }
    const intervalMs = this.series.config.intervalMs;
    const batch = payload.bars instanceof ArrayBuffer
      ? packedBufferToFootprintBars(payload.bars, intervalMs)
      : payload.bars.map((bar) => toFootprintBar(bar, intervalMs));

    if (batch.length > 0) {
      if (this.series.length === 0) {
        this.series.loadBars(batch);
      } else {
        this.series.upsertBars(batch);
      }
    }

    if (payload.bars instanceof ArrayBuffer) {
      this.endpoint.recycleBuffer(payload.bars);
    }

    if (this.series.length > 0) {
      if (!this.hasInitialFit) {
        this.fitViewToSeries();
      } else if (this.view.isPriceAutoScale()) {
        this.autoFitVisiblePrices();
      }
    }
    this.invalidate(ChartChange.Data);
  }

  private fitViewToSeries(): void {
    if (this.series.length === 0) return;
    this.hasInitialFit = true;
    const total = this.series.length;
    const rightEdge = this.view.area.left + this.view.area.width;
    this.view.offsetX = rightEdge - total * this.view.colWidth - this.view.colWidth * 2;
    this.autoFitVisiblePrices();
  }

  private autoFitVisiblePrices(): void {
    if (this.series.length === 0) return;
    const from = Math.max(0, Math.floor(this.view.indexOfX(this.view.area.left)));
    const to = Math.min(this.series.length, Math.ceil(this.view.indexOfX(this.view.area.left + this.view.area.width)));
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const start = from < to ? from : Math.max(0, this.series.length - 50);
    const end = from < to ? to : this.series.length;
    for (let i = start; i < end; i++) {
      const bar = this.series.at(i);
      if (!bar) continue;
      if (bar.low < min) min = bar.low;
      if (bar.high > max) max = bar.high;
    }
    if (Number.isFinite(min) && Number.isFinite(max)) {
      if (min === max) {
        const pad = Math.max(this.series.config.priceStep, Math.abs(min) * 0.005);
        this.view.fitPriceRange(min - pad, max + pad);
      } else {
        this.view.fitPriceRange(min, max);
      }
    }
  }

  private handleInputEvent(event: WorkerInputEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case "pointerdown": {
        this.dragging = true;
        this.lastPointerX = event.x;
        this.crosshair.x = event.x;
        this.crosshair.y = event.y;
        this.crosshair.visible = true;
        this.invalidate(ChartChange.Interaction);
        break;
      }
      case "pointermove": {
        this.crosshair.x = event.x;
        this.crosshair.y = event.y;
        this.crosshair.visible = true;
        if (this.dragging) {
          const dx = event.x - this.lastPointerX;
          this.lastPointerX = event.x;
          if (dx !== 0) {
            this.view.panX(dx);
            if (this.view.isPriceAutoScale()) {
              this.autoFitVisiblePrices();
            }
            this.invalidate(ChartChange.Viewport | ChartChange.Interaction);
            break;
          }
        }
        this.invalidate(ChartChange.Interaction);
        break;
      }
      case "pointerup": {
        this.dragging = false;
        this.invalidate(ChartChange.Interaction);
        break;
      }
      case "wheel": {
        const factor = event.deltaY < 0 ? 1.12 : 0.89;
        this.view.zoomX(factor, event.x);
        if (this.view.isPriceAutoScale()) {
          this.autoFitVisiblePrices();
        }
        this.invalidate(ChartChange.Viewport);
        break;
      }
      case "blur": {
        this.dragging = false;
        this.crosshair.visible = false;
        this.invalidate(ChartChange.Interaction);
        break;
      }
      case "keydown": {
        break;
      }
    }
  }

  private handleHitTest(x: number, y: number): {
    hit: boolean;
    targetKind?: string;
    targetId?: string;
    price?: number;
    time?: number;
  } {
    const barIdx = Math.floor(this.view.indexOfX(x));
    const price = this.view.priceOfY(y);
    if (barIdx >= 0 && barIdx < this.series.length) {
      return {
        hit: true,
        targetKind: "bar",
        targetId: String(barIdx),
        price,
        time: this.series.timeOfIndex(barIdx),
      };
    }
    return {
      hit: false,
      targetKind: "plot",
      price,
    };
  }

  private handleTooltip(x: number, y: number): {
    visible: boolean;
    title?: string;
    lines?: ReadonlyArray<string>;
    x: number;
    y: number;
  } {
    const barIdx = Math.floor(this.view.indexOfX(x));
    const bar = barIdx >= 0 && barIdx < this.series.length ? this.series.at(barIdx) : undefined;
    if (!bar) {
      return { visible: false, x, y };
    }
    return {
      visible: true,
      title: this.marketId,
      lines: [
        `O: ${bar.open}`,
        `H: ${bar.high}`,
        `L: ${bar.low}`,
        `C: ${bar.close}`,
        `V: ${bar.volume}`,
      ],
      x,
      y,
    };
  }

  private async handleCapture(payload: { format: "png" | "bitmap"; includeOverlays?: boolean }): Promise<{
    ok: boolean;
    width?: number;
    height?: number;
    buffer?: ArrayBuffer;
    error?: string;
  }> {
    await this.initPromise;
    if (this.disposed || !this.gpuSurface) {
      return { ok: false, error: "ChartWorkerPanelRuntime is not initialized or disposed" };
    }

    if (!this.paused) {
      this.renderNow();
    }

    if (payload.format === "bitmap") {
      try {
        const frame = await this.gpuSurface.requestCapture();
        const copy = new Uint8ClampedArray(frame.data);
        return {
          ok: true,
          width: frame.width,
          height: frame.height,
          buffer: copy.buffer,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // PNG / OffscreenCanvas blob fallback
    const target = this.gpuSurface.canvas;
    if (target && "convertToBlob" in target && typeof target.convertToBlob === "function") {
      try {
        const blob = await target.convertToBlob({ type: "image/png" });
        const buffer = await blob.arrayBuffer();
        return {
          ok: true,
          width: target.width,
          height: target.height,
          buffer,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    try {
      const frame = await this.gpuSurface.requestCapture();
      const copy = new Uint8ClampedArray(frame.data);
      return {
        ok: true,
        width: frame.width,
        height: frame.height,
        buffer: copy.buffer,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private handleLifecycle(payload: {
    action: "pause" | "resume" | "rehome" | "dispose" | "epoch-bump" | "abort";
    reason?: string;
    surfaces?: ReadonlyArray<WorkerSurfaceDescriptor>;
    offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>;
  }): void {
    switch (payload.action) {
      case "pause":
        this.paused = true;
        this.scheduledFrame?.cancel();
        this.scheduledFrame = null;
        break;
      case "resume":
        this.paused = false;
        this.invalidate(ChartChange.All);
        break;
      case "rehome":
        if (payload.offscreenCanvases) {
          this.offscreenCanvases = payload.offscreenCanvases;
          const primary = payload.surfaces?.[0];
          const nextW = primary?.width ?? this.width;
          const nextH = primary?.height ?? this.height;
          const nextDpr = primary?.dpr ?? this.dpr;
          this.initPromise = this.setupSurfaces(nextW, nextH, nextDpr, payload.offscreenCanvases).then(() => {
            this.invalidate(ChartChange.All);
          });
        }
        break;
      case "dispose":
        this.dispose();
        break;
      case "epoch-bump":
        this.expectedNextTickSeq = null;
        this.dragging = false;
        this.crosshair.visible = false;
        break;
      case "abort":
        this.dragging = false;
        this.crosshair.visible = false;
        break;
    }
  }

  private invalidate(changes: number): void {
    if (this.disposed) return;
    this.pendingChanges |= changes;
    if (this.paused || this.scheduledFrame) return;
    this.scheduledFrame = scheduleWorkerFrame(() => {
      this.scheduledFrame = null;
      this.renderNow();
    });
  }
}

export class ChartWorkerHostPool {
  private readonly panels = new Map<string, ChartWorkerPanelRuntime>();

  createPanel(options: ChartWorkerPanelOptions): ChartWorkerPanelRuntime {
    const existing = this.panels.get(options.panelId);
    if (existing) {
      existing.dispose();
    }
    const runtime = new ChartWorkerPanelRuntime(options);
    this.panels.set(options.panelId, runtime);
    return runtime;
  }

  getPanel(panelId: string): ChartWorkerPanelRuntime | undefined {
    return this.panels.get(panelId);
  }

  removePanel(panelId: string): boolean {
    const existing = this.panels.get(panelId);
    if (!existing) return false;
    existing.dispose();
    this.panels.delete(panelId);
    return true;
  }

  listPanelIds(): string[] {
    return [...this.panels.keys()];
  }

  disposeAll(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }
}

/**
 * Strictly DOM-free chart worker runtime (`ChartWorkerPanelRuntime`) and
 * multi-panel pool (`ChartWorkerHostPool`).
 *
 * Runs inside a DedicatedWorker (or headless Node test) over `WorkerChartEndpoint`
 * with zero main-thread tick/history relay.
 */

import { ChartChange } from "../../../core/render/scene/chartScene.js";
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
} from "../../../core/orderbookHeatmap/settings.js";
import { FootprintRenderer } from "../../../core/render/footprintRenderer.js";
import { Overlay, type Crosshair } from "../../../core/render/overlay.js";
import { settings, type ChartViewConfig } from "../../../core/settings.js";
import type { FootprintBar, FootprintCell } from "../../../core/types.js";
import { ChartHeatmapGpuCoordinator } from "../ChartHeatmapGpuCoordinator.js";
import type { HeatmapGpuCellFrame } from "../heatmap/gpu/heatmapGpuRenderer.js";
import { OrderbookHeatmapOverlay } from "../../orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../../orderbook/heatmapSettingsSource.js";
import {
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
const workerHeatmapListeners = new Set<() => void>();
let workerHeatmapSourceInstalled = false;

function ensureWorkerHeatmapSettingsSource(): void {
  try {
    orderbookHeatmapSettingsSource();
    return;
  } catch {
    if (workerHeatmapSourceInstalled) return;
    workerHeatmapSourceInstalled = true;
    configureOrderbookHeatmapSettingsSource({
      settingsFor: (market, panelId) => {
        const mode = workerHeatmapPanelModes.get(`${panelId ?? ""}:${market}`) ?? "off";
        return {
          ...DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
          mode,
        };
      },
      onChange: (listener) => {
        workerHeatmapListeners.add(listener);
        return () => {
          workerHeatmapListeners.delete(listener);
        };
      },
    });
  }
}

export interface ChartWorkerPanelOptions {
  panelId: string;
  marketId: string;
  intervalMs?: number;
  priceStep?: number;
  pricePrecision?: number;
  backendPreference?: GpuBackendPreference;
  initialGeneration?: number;
  createScratchCanvas?: () => CanvasTarget;
  getWebGl2Context?: (canvas: CanvasTarget) => WebGL2RenderingContext | null;
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
  readonly barCount: number;
  readonly cellCount: number;
  readonly frameCount: number;
  readonly paused: boolean;
  readonly disposed: boolean;
  readonly endpointStats: WorkerEndpointStats;
  readonly gpuDiagnostics: GpuDiagnosticsSnapshot;
  readonly heatmap: ReturnType<ChartHeatmapGpuCoordinator["getDiagnostics"]> | null;
  readonly heatmapRaster: ReturnType<OrderbookHeatmapOverlay["getRasterDiagnostics"]> | null;
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

function unpackHistoryBuffer(buffer: ArrayBuffer): WorkerHistoryBar[] {
  const view = new Float64Array(buffer);
  const count = Math.floor(view.length / PACKED_BAR_STRIDE);
  const bars: WorkerHistoryBar[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * PACKED_BAR_STRIDE;
    bars[i] = {
      time: view[base]!,
      open: view[base + 1]!,
      high: view[base + 2]!,
      low: view[base + 3]!,
      close: view[base + 4]!,
      volume: view[base + 5]!,
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
  private readonly createScratchCanvas?: () => CanvasTarget;
  private readonly getWebGl2Context?: (canvas: CanvasTarget) => WebGL2RenderingContext | null;

  private annotationCanvas: CanvasTarget | null = null;
  private interactionCanvas: CanvasTarget | null = null;
  private gpuSurface: GpuSurface | null = null;
  private renderer: FootprintRenderer | null = null;
  private overlay: Overlay | null = null;
  private orderbookHeatmap: OrderbookHeatmapOverlay | null = null;
  private heatmapGpuCoordinator: ChartHeatmapGpuCoordinator | null = null;
  private offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>;

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
  private dragging = false;
  private lastPointerX = 0;
  private readonly crosshair: Crosshair = { x: 0, y: 0, visible: false };

  constructor(options: ChartWorkerPanelOptions) {
    this.panelId = options.panelId;
    this.marketId = options.marketId;
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

    this.orderbookHeatmap = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: Date.now(),
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: [],
      }),
      invalidate: () => {
        if (!this.disposed) this.invalidate(ChartChange.Data);
      },
      getMarket: () => this.marketId,
      getPanelId: () => this.panelId,
      isReplayActive: () => false,
    });

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
    this.heatmapGpuCoordinator.setResidentHeatmapEnabled(this.residentHeatmapEnabled);

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

    this.endpoint.flushInputs();

    const changes = this.pendingChanges === ChartChange.None ? ChartChange.All : this.pendingChanges;
    this.pendingChanges = ChartChange.None;

    this.heatmapGpuCoordinator?.beginFrameAttempt();
    let heatmapFrame: HeatmapGpuCellFrame | null = null;
    try {
      heatmapFrame = this.heatmapGpuCoordinator?.prepareHeatmapGpuCells(this.view, this.series) ?? null;
      const isOrderbookHeatmapActive =
        this.orderbookHeatmap !== null
        && isOrderbookHeatmapMarket(this.marketId)
        && orderbookHeatmapSettingsSource().settingsFor(this.marketId, this.panelId).mode !== "off";
      this.renderer.setAllowNativeFootprintText(!isOrderbookHeatmapActive);
      const gpuLayers = new Set(resolveBuiltInLayerPreset(this.chartType).gpu);
      this.renderer.renderLayers(this.view, this.series, gpuLayers);
      this.heatmapGpuCoordinator?.renderHeatmapGpuCells(heatmapFrame, this.view, this.series);
    } catch (error) {
      heatmapFrame?.preparedLease?.release();
      heatmapFrame = null;
      throw error;
    }

    if (this.overlay) {
      const range = this.renderer.visibleRange(this.view, this.series.length);
      const preset = resolveBuiltInLayerPreset(this.chartType);
      this.overlay.renderAnnotations(
        this.view,
        this.series,
        this.crosshair,
        range,
        preset.annotation,
        changes as ChartChange,
      );
      this.overlay.renderInteraction(
        this.view,
        this.series,
        this.crosshair,
        range,
        preset.interaction,
      );
    }

    this.frameCount++;
    return true;
  }

  getDiagnostics(): ChartWorkerDiagnostics {
    let cellCount = 0;
    for (let i = 0; i < this.series.length; i++) {
      cellCount += this.series.at(i)?.cells.size ?? 0;
    }
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
      barCount: this.series.length,
      cellCount,
      frameCount: this.frameCount,
      paused: this.paused,
      disposed: this.disposed,
      endpointStats: this.endpoint.getStats(),
      gpuDiagnostics: getGpuDiagnostics(),
      heatmap: this.heatmapGpuCoordinator?.getDiagnostics() ?? null,
      heatmapRaster: this.orderbookHeatmap?.getRasterDiagnostics() ?? null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduledFrame?.cancel();
    this.scheduledFrame = null;
    this.heatmapGpuCoordinator?.dispose();
    this.heatmapGpuCoordinator = null;
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

    if (this.disposed) {
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

    const resolvedGl = nextSurface.kind === "webgl2" && this.getWebGl2Context
      ? this.getWebGl2Context(nextGpuCanvas)
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
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          interactionCtx ?? undefined,
          undefined,
          (ctx, activeView, activeSeries, range) => {
            if (this.heatmapGpuCoordinator?.heatmapGpuSuppressedAnnotation(activeView, activeSeries, range)) {
              this.orderbookHeatmap?.releaseRasterCache();
              return false;
            }
            if (!this.orderbookHeatmap) return false;
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
    if (patch.orderbookHeatmapMode !== undefined) {
      this.orderbookHeatmapMode = patch.orderbookHeatmapMode;
      workerHeatmapPanelModes.set(`${this.panelId}:${this.marketId}`, patch.orderbookHeatmapMode);
      for (const listener of workerHeatmapListeners) {
        listener();
      }
    }
    if (patch.residentHeatmap !== undefined) {
      this.residentHeatmapEnabled = patch.residentHeatmap;
      this.heatmapGpuCoordinator?.setResidentHeatmapEnabled(patch.residentHeatmap);
    }

    this.applyChartConfig();

    if (patch.backendPreference !== undefined && patch.backendPreference !== this.requestedBackend) {
      this.requestedBackend = patch.backendPreference;
      await this.setupSurfaces(this.width, this.height, this.dpr, this.offscreenCanvases);
    }

    if (!this.disposed) {
      this.invalidate(ChartChange.Style | ChartChange.All);
    }
  }

  private handleHeatmapChunk(payload: {
    resolution?: "1m" | "5m" | "15m" | "1h";
    bucketStep?: number;
    from?: number;
    to?: number;
    bars: ReadonlyArray<{ t: number; cells: ReadonlyArray<readonly [number, number, number]> }>;
  }): void {
    if (this.disposed || !this.orderbookHeatmap) return;
    this.orderbookHeatmap.ingestWorkerHeatmapChunk({
      resolution: payload.resolution,
      bucketStep: payload.bucketStep,
      from: payload.from,
      to: payload.to,
      bars: payload.bars.map((bar) => ({
        t: bar.t,
        cells: bar.cells.map(([p, b, a]) => [p, b, a]),
      })),
    });
  }

  private handleHeatmapTail(payload: {
    market?: string;
    timestamp?: number;
    bars?: ReadonlyArray<{ t: number; cells: ReadonlyArray<readonly [number, number, number]> }>;
  }): void {
    if (this.disposed || !this.orderbookHeatmap) return;
    this.orderbookHeatmap.ingestWorkerHeatmapTail({
      market: payload.market,
      timestamp: payload.timestamp,
      bars: payload.bars?.map((bar) => ({
        t: bar.t,
        cells: bar.cells.map(([p, b, a]) => [p, b, a]),
      })),
    });
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
    const plotW = Math.max(1, this.width - this.view.priceAxisW);
    const plotH = Math.max(1, this.height - DEFAULT_TIME_AXIS_HEIGHT);
    this.view.area = { left: 0, top: 0, width: plotW, height: plotH };
    this.view.pixelRatio = this.dpr;
  }

  private handleTick(payload: {
    price: number;
    size: number;
    timestamp: number;
    side?: "buy" | "sell";
    tradeId?: string;
  }): void {
    if (this.disposed) return;
    this.series.addTrade({
      time: payload.timestamp,
      price: payload.price,
      qty: payload.size,
      isBuy: payload.side !== "sell",
      id: payload.tradeId,
      market: this.marketId,
      source: "live",
    });
    if (!this.hasInitialFit) {
      this.fitViewToSeries();
    } else if (this.view.isPriceAutoScale()) {
      this.autoFitVisiblePrices();
    }
    this.invalidate(ChartChange.DataTail);
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
    if (this.disposed) return;
    const bars = payload.bars instanceof ArrayBuffer
      ? unpackHistoryBuffer(payload.bars)
      : payload.bars;

    for (const bar of bars) {
      this.series.upsertBar(toFootprintBar(bar, this.series.config.intervalMs));
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

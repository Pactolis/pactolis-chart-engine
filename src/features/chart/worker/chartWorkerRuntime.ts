/**
 * Strictly DOM-free chart worker runtime (`ChartWorkerPanelRuntime`) and
 * multi-panel pool (`ChartWorkerHostPool`).
 *
 * Runs inside a DedicatedWorker (or headless Node test) over `WorkerChartEndpoint`
 * with zero main-thread tick/history relay.
 */

import { ChartChange } from "../../../core/render/scene/chartScene.js";
import { View } from "../../../core/engine/view.js";
import type { Canvas2dContext, CanvasTarget } from "../../../core/gpu/canvasTarget.js";
import type { GpuBackendKind, GpuSurface } from "../../../core/gpu/gpuBackend.js";
import { getGpuDiagnosticsSnapshot, type GpuDiagnosticsSnapshot } from "../../../core/gpu/gpuDiagnostics.js";
import type { GpuBackendPreference } from "../../../core/gpu/gpuSettings.js";
import { createGpuSurfaceAsync } from "../../../core/gpu/selectBackend.js";
import { FootprintSeries } from "../../../core/model/footprint.js";
import { FootprintRenderer } from "../../../core/render/footprintRenderer.js";
import { Overlay, type Crosshair } from "../../../core/render/overlay.js";
import type { FootprintBar } from "../../../core/types.js";
import {
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
  readonly panelId: string;
  readonly marketId: string;
  readonly requestedBackend: GpuBackendPreference;
  readonly activeBackend: GpuBackendKind | null;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly barCount: number;
  readonly frameCount: number;
  readonly paused: boolean;
  readonly disposed: boolean;
  readonly endpointStats: WorkerEndpointStats;
  readonly gpuDiagnostics: GpuDiagnosticsSnapshot;
}

function toFootprintBar(bar: WorkerHistoryBar): FootprintBar {
  return {
    startTime: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    delta: 0,
    count: 1,
    cells: new Map(),
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

  private gpuCanvas: CanvasTarget | null = null;
  private annotationCanvas: CanvasTarget | null = null;
  private interactionCanvas: CanvasTarget | null = null;
  private gpuSurface: GpuSurface | null = null;
  private renderer: FootprintRenderer | null = null;
  private overlay: Overlay | null = null;

  private width = 640;
  private height = 360;
  private dpr = 1;
  private frameCount = 0;
  private paused = false;
  private disposed = false;
  private dirty = false;
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

    this.view = new View();
    this.series = new FootprintSeries({
      intervalMs: options.intervalMs ?? 60_000,
      priceStep: options.priceStep ?? 1,
      pricePrecision: options.pricePrecision ?? 2,
      referenceMarket: options.marketId,
    });

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
        onTick: (payload) => {
          this.handleTick(payload);
        },
        onBar: (payload) => {
          this.handleBar(payload);
        },
        onHistoryChunk: (payload) => {
          this.handleHistoryChunk(payload);
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
    this.dirty = false;
    this.pendingChanges = ChartChange.None;

    this.renderer.render(this.view, this.series);

    if (this.overlay) {
      const range = this.renderer.visibleRange(this.view, this.series.length);
      this.overlay.renderAnnotations(
        this.view,
        this.series,
        this.crosshair,
        range,
        undefined,
        changes as ChartChange,
      );
      this.overlay.renderInteraction(this.view, this.series, this.crosshair);
    }

    this.frameCount++;
    return true;
  }

  getDiagnostics(): ChartWorkerDiagnostics {
    return {
      panelId: this.panelId,
      marketId: this.marketId,
      requestedBackend: this.requestedBackend,
      activeBackend: this.gpuSurface?.kind ?? null,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      barCount: this.series.length,
      frameCount: this.frameCount,
      paused: this.paused,
      disposed: this.disposed,
      endpointStats: this.endpoint.getStats(),
      gpuDiagnostics: getGpuDiagnosticsSnapshot(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduledFrame?.cancel();
    this.scheduledFrame = null;
    this.overlay?.dispose();
    this.overlay = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.gpuSurface?.dispose();
    this.gpuSurface = null;
    this.gpuCanvas = null;
    this.annotationCanvas = null;
    this.interactionCanvas = null;
    this.endpoint.dispose();
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
    this.gpuCanvas = nextSurface.canvas;
    this.annotationCanvas = nextAnnotationCanvas;
    this.interactionCanvas = nextInteractionCanvas;
    this.gpuSurface = nextSurface;

    if (!this.renderer) {
      this.renderer = new FootprintRenderer(nextSurface);
    } else {
      this.renderer.setSurface(nextSurface);
    }

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
        );
      } else {
        this.overlay.updateContext(annotationCtx);
        if (interactionCtx) {
          this.overlay.updateInteractionContext(interactionCtx);
        }
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
    this.series.upsertBar(toFootprintBar(payload));
    if (!this.hasInitialFit) {
      this.fitViewToSeries();
    } else if (this.view.isPriceAutoScale()) {
      this.autoFitVisiblePrices();
    }
    this.invalidate(ChartChange.DataStructure | ChartChange.DataTail);
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
      this.series.upsertBar(toFootprintBar(bar));
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
    this.invalidate(ChartChange.DataStructure);
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

    if (this.dirty || this.frameCount === 0) {
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
    this.dirty = true;
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

/**
 * ChartSession — owns the three physical render surfaces (GPU scene, annotation, interaction),
 * the RAF loop, ResizeObserver, and the WebGL context-lost/restored lifecycle.
 *
 * Architectural contract (from the migration plan):
 *  - Svelte owns the panel lifecycle (mount/destroy); this class owns everything
 *    below it: GPU resources, RAF, resize, DPR.
 *  - chart/viewport/frame state never enters Svelte stores — needsRender stays here.
 *  - resize source is the panel container, NOT window.innerWidth/innerHeight.
 *  - DPR is read from ownerDocument.defaultView on every resize/activate/restore, and held
 *    down to the host's `maxDevicePixelRatio` when it set one.
 *  - 0×0 measurements are never applied to canvases; last valid size is kept.
 *  - webglcontextlost → RAF cancelled, GPU invalidated, CPU state preserved.
 *  - webglcontextrestored → GPU rebuilt from scratch, one new RAF started.
 *  - Canvas relocation (popout) may lose context; that goes through the same path.
 */

import type { View } from "../../core/engine/view.js";
import { effectivePixelRatio } from "../../core/model/chartDisplayOptions.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type { Crosshair } from "../../core/render/overlay.js";
import {
  ChartChange,
  ChartSurfaceDirty,
  surfaceDirtyForChanges,
  type ChartInvalidationScope,
} from "../../core/render/scene/chartScene.js";
import {
  incrementPerformanceCounter,
  isPerformanceTelemetryEnabled,
  measurePerformance,
  recordPerformanceDuration,
} from "../../core/performanceTelemetry.js";
import { LifecycleController } from "../controllers/lifecycleController.js";
import {
  ChartCaptureError,
  getChartWebGl2Context,
  encodeGpuAndAnnotationPng,
  flipRgbaRows,
  validateCaptureDimensions,
  type NativeCaptureFrame,
} from "./nativeCapture.js";
import type { GpuSurface } from "../../core/gpu/gpuBackend.js";
import { Canvas2dSurface } from "../../core/gpu/canvas2d/canvas2dSurface.js";
import { WebGl2Surface } from "../../core/gpu/webgl2/webgl2Surface.js";
import { recordGpuFallback, recordGpuFrame } from "../../core/gpu/gpuDiagnostics.js";
import { readGpuSettings } from "../../core/gpu/gpuSettings.js";

const CONTEXT_RESTORE_TIMEOUT_MS = 5000;

export interface ChartSessionRenderer {
  render(view: View, series: FootprintSeries): void;
  visibleRange(view: View, total: number): [number, number];
  setSurface?(surface: GpuSurface): void;
}

export interface ChartSessionAnnotation {
  render(view: View, series: FootprintSeries, crosshair: Crosshair, range: [number, number]): void;
  /** Some legacy indicator readouts still depend on crosshair until their own interaction pass lands. */
  requiresInteractionRedraw?(): boolean;
}

export interface ChartSessionInteraction {
  render(view: View, series: FootprintSeries, crosshair: Crosshair, range: [number, number]): void;
}

export interface ChartSessionOptions {
  /** Outer container element whose measured size drives canvas dimensions. */
  container: HTMLElement;
  /** Three fixed physical surfaces: GPU scene < annotation < interaction. */
  gpuCanvas: HTMLCanvasElement;
  annotationCanvas: HTMLCanvasElement;
  interactionCanvas: HTMLCanvasElement;
  /** document that owns the canvases — used for DPR, events, popout support. */
  ownerDocument: Document;
  /** Current production GPU context. Optional when gpuSurface is provided. */
  gl?: WebGL2RenderingContext | null;
  /** GPU surface abstraction (WebGL2, Canvas2D, or WebGPU). */
  gpuSurface?: GpuSurface;
  annotationCtx2d: CanvasRenderingContext2D;
  interactionCtx2d: CanvasRenderingContext2D;
  renderer: ChartSessionRenderer;
  annotation: ChartSessionAnnotation;
  interaction: ChartSessionInteraction;
  view: View;
  series: FootprintSeries;
  crosshair: Crosshair;
  /** Called when the GPU needs to be fully rebuilt (context restored or first setup). */
  onRestoreContext: (gl: WebGL2RenderingContext) => void;
  /** Called when the GPU context is lost, after the session already cancelled RAF, marked GPU invalid, cleared dirty state and rejected any pending capture; symmetric to onRestoreContext. */
  onLostContext?: () => void;
  /** Called after each resize so the caller can recompute view.area. */
  onResize?: (width: number, height: number, dpr: number) => void;
  /**
   * Exact physical surfaces that completed a draw pass in this render turn, and the semantic
   * changes coalesced into it (`None` when only an explicit surface request or capture drew).
   */
  onRendered?: (surfaces: ChartSurfaceDirty, changes: ChartChange) => void;
  /** Called after every `invalidate()` with the semantic changes it carried. */
  onInvalidate?: (changes: ChartChange) => void;
  /** Highest pixel ratio the canvases render at; null (default) follows the window's devicePixelRatio. */
  maxDevicePixelRatio?: number | null;
}

export class ChartSession {
  private readonly lifecycle = new LifecycleController();
  private rafId: number | null = null;
  private gpuValid = true;
  private active = true;

  // Mutable reference — replaced on context restore.
  private gl: WebGL2RenderingContext;
  private gpuSurface: GpuSurface;
  private ro: ResizeObserver | null = null;

  private container: HTMLElement;
  private gpuCanvas: HTMLCanvasElement;
  private restoreTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private cleanupContextListeners: (() => void) | null = null;
  private lastRenderTimestamp: number | null = null;
  private readonly annotationCanvas: HTMLCanvasElement;
  private readonly interactionCanvas: HTMLCanvasElement;
  private ownerDocument: Document;
  private readonly annotationCtx2d: CanvasRenderingContext2D;
  private readonly interactionCtx2d: CanvasRenderingContext2D;
  private readonly renderer: ChartSessionRenderer;
  private readonly annotationRenderer: ChartSessionAnnotation;
  private readonly interactionRenderer: ChartSessionInteraction;
  private readonly view: View;
  private readonly series: FootprintSeries;
  private readonly crosshair: Crosshair;
  private readonly onRestoreContextCb: (gl: WebGL2RenderingContext) => void;
  private readonly onLostContextCb?: () => void;
  private readonly onResizeCb?: (w: number, h: number, dpr: number) => void;
  private readonly onRenderedCb?: (surfaces: ChartSurfaceDirty, changes: ChartChange) => void;
  private readonly onInvalidateCb?: (changes: ChartChange) => void;
  private disposeDprWatcher: (() => void) | null = null;
  private maxDevicePixelRatio: number | null;

  private dirtySurfaces = ChartSurfaceDirty.All;
  /** Semantic changes waiting for the next frame; travels with `dirtySurfaces`, never narrows it. */
  private pendingChanges: ChartChange = ChartChange.All;
  /**
   * A resize notification (RO / DPR change / container adoption) asked for a commit. The actual
   * bitmap/CSS/transform mutation happens inside the next owner-window RAF — never synchronously
   * in the notification — so previously painted bitmaps are retained until the same frame repaints.
   */
  private pendingContainerResize = false;
  /**
   * A resize commit physically cleared the surfaces but died before its DPR transforms,
   * onResize adaptation and repaint debt were restored. The latest committed bounds stay
   * here until the next healthy owner frame completes the transaction; there is no
   * automatic retry and the original exception is never swallowed.
   */
  private unfinishedResize: { w: number; h: number; dpr: number } | null = null;
  /** Whether at least one draw pass has completed; only a never-painted session may size eagerly. */
  private hasRenderedFrame = false;
  /** Earliest telemetry-enabled live update waiting for the next drawable frame. */
  private pendingLiveUpdateStartedAt: number | null = null;
  private pendingCapture: {
    resolve: (frame: NativeCaptureFrame) => void;
    reject: (error: unknown) => void;
  } | null = null;
  /**
   * True only inside an owner-window frame before its dirty snapshot is taken. An
   * invalidation arriving in that window is consumed by the same frame's snapshot, so
   * it must not schedule a successor frame; `finally` resets it so a throwing commit
   * never strands the guard and future invalidations schedule normally again.
   */
  private inPreSnapshotFrame = false;

  get needsRender(): boolean {
    return this.dirtySurfaces !== ChartSurfaceDirty.None;
  }

  /** What the next frame will redraw and why. */
  get pendingInvalidation(): ChartInvalidationScope {
    return { changes: this.pendingChanges, surfaces: this.dirtySurfaces };
  }

  constructor(opts: ChartSessionOptions) {
    this.container = opts.container;
    this.gpuCanvas = opts.gpuCanvas;
    this.annotationCanvas = opts.annotationCanvas;
    this.interactionCanvas = opts.interactionCanvas;
    this.ownerDocument = opts.ownerDocument;
    if (opts.gpuSurface) {
      this.gpuSurface = opts.gpuSurface;
      this.gl = (opts.gl ?? (opts.gpuSurface.kind === "webgl2" ? opts.gpuSurface.getGlContext?.() : null)) as WebGL2RenderingContext;
    } else {
      this.gpuSurface = new WebGl2Surface(opts.gpuCanvas, opts.gl as WebGL2RenderingContext);
      this.gl = opts.gl as WebGL2RenderingContext;
    }
    this.annotationCtx2d = opts.annotationCtx2d;
    this.interactionCtx2d = opts.interactionCtx2d;
    this.renderer = opts.renderer;
    this.annotationRenderer = opts.annotation;
    this.interactionRenderer = opts.interaction;
    this.view = opts.view;
    this.series = opts.series;
    this.crosshair = opts.crosshair;
    this.onRestoreContextCb = opts.onRestoreContext;
    this.onLostContextCb = opts.onLostContext;
    this.onResizeCb = opts.onResize;
    this.onRenderedCb = opts.onRendered;
    this.onInvalidateCb = opts.onInvalidate;
    this.maxDevicePixelRatio = opts.maxDevicePixelRatio ?? null;

    this.lifecycle.start();
    this.setupContextLossHandling();
    this.setupResizeObserver();
    this.setupDprWatcher();
    void this.gl;
  }

  activate(): void {
    this.active = true;
    if (this.hasRenderedFrame) {
      // Reactivation of a painted session must not expose cleared bitmaps pre-frame.
      this.requestContainerResize();
    } else {
      // Fresh, never-painted initialization applies a valid CSS/bitmap size immediately.
      this.applyContainerSize();
    }
    this.startRaf();
  }

  deactivate(): void {
    this.active = false;
    this.pendingLiveUpdateStartedAt = null;
    this.cancelRaf();
    this.rejectPendingCapture("chart session was deactivated during capture");
  }

  /** Correlate a live pipeline update with the next frame without changing scheduling. */
  markLiveUpdate(startedAt: number): void {
    if (!this.active || !this.gpuValid || !isPerformanceTelemetryEnabled() || !Number.isFinite(startedAt)) return;
    if (this.pendingLiveUpdateStartedAt !== null) {
      incrementPerformanceCounter("chart.liveUpdate.coalesced");
      this.pendingLiveUpdateStartedAt = Math.min(this.pendingLiveUpdateStartedAt, startedAt);
      return;
    }
    this.pendingLiveUpdateStartedAt = startedAt;
  }

  invalidate(changes: ChartChange = ChartChange.All): void {
    let dirty = surfaceDirtyForChanges(changes);
    if ((changes & ChartChange.Interaction) && this.annotationRenderer.requiresInteractionRedraw?.()) {
      dirty |= ChartSurfaceDirty.Annotation;
    }
    this.dirtySurfaces |= dirty;
    this.pendingChanges |= changes;
    // Pre-snapshot invalidation coalesces into the running owner frame; scheduling here
    // would queue an idle successor after that frame repays the debt in its snapshot.
    if (!this.inPreSnapshotFrame) this.startRaf();
    this.onInvalidateCb?.(changes);
  }

  getSurface(): GpuSurface {
    return this.gpuSurface;
  }

  replaceSurface(
    nextSurface: GpuSurface,
    onCanvasReplaced?: (nextCanvas: HTMLCanvasElement, prevCanvas: HTMLCanvasElement) => void,
  ): void {
    const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
    this.cancelRaf();
    if (this.restoreTimeoutId) {
      clearTimeout(this.restoreTimeoutId);
      this.restoreTimeoutId = null;
    }

    const prevCanvas = this.gpuCanvas;
    const nextCanvas = nextSurface.canvas;

    nextCanvas.dataset.chartSurface = "gpu-scene";
    if (prevCanvas.style && prevCanvas.style.cssText) {
      nextCanvas.style.cssText = prevCanvas.style.cssText;
    }

    if (onCanvasReplaced) {
      onCanvasReplaced(nextCanvas, prevCanvas);
    } else if (prevCanvas.parentNode) {
      prevCanvas.replaceWith(nextCanvas);
    }

    this.gpuSurface.dispose();
    this.gpuSurface = nextSurface;
    this.gpuCanvas = nextCanvas;
    if (nextSurface.kind === "webgl2") {
      const gl = nextSurface.getGlContext?.();
      if (gl) {
        this.gl = gl;
      }
    }
    this.gpuValid = true;

    if (typeof (this.renderer as any).setSurface === "function") {
      (this.renderer as any).setSurface(nextSurface);
    }

    const target = this.measureContainerSize();
    if (target) {
      nextCanvas.style.width = target.cssWidth;
      nextCanvas.style.height = target.cssHeight;
      nextCanvas.width = target.bitmapWidth;
      nextCanvas.height = target.bitmapHeight;
      nextSurface.resize(target.bitmapWidth, target.bitmapHeight, target.dpr);
      this.unfinishedResize = { w: target.w, h: target.h, dpr: target.dpr };
      this.finishPendingResize();
    } else {
      this.applyContainerSize();
    }
    this.dirtySurfaces = ChartSurfaceDirty.All;
    this.pendingChanges = ChartChange.All;

    this.setupContextLossHandling();

    if (startedAt !== null) {
      recordPerformanceDuration("gpu.surface.swap.ms", performance.now() - startedAt);
    }

    if (this.active) this.startRaf();
  }

  invalidateSurface(surfaces: ChartSurfaceDirty): void {
    this.dirtySurfaces |= surfaces;
    this.startRaf();
  }

  captureCompositePng(): Promise<NativeCaptureFrame> {
    if (!this.active || !this.gpuValid) {
      return Promise.reject(new ChartCaptureError("CAPTURE_FAILED", "chart session is not renderable"));
    }
    if (this.pendingCapture) {
      return Promise.reject(new ChartCaptureError("CAPTURE_FAILED", "a native chart capture is already pending"));
    }
    try {
      validateCaptureDimensions(
        this.gpuCanvas.width,
        this.gpuCanvas.height,
        this.annotationCanvas.width,
        this.annotationCanvas.height,
      );
    } catch (error) {
      return Promise.reject(error);
    }
    this.dirtySurfaces |= ChartSurfaceDirty.GpuScene | ChartSurfaceDirty.Annotation;
    this.startRaf();
    return new Promise<NativeCaptureFrame>((resolve, reject) => {
      this.pendingCapture = { resolve, reject };
    });
  }

  destroy(): void {
    this.active = false;
    this.pendingLiveUpdateStartedAt = null;
    this.cancelRaf();
    this.rejectPendingCapture("chart session was destroyed during capture");
    this.lifecycle.dispose();
    this.disposeDprWatcher?.();
    this.disposeDprWatcher = null;
    this.gpuSurface.dispose();
    this.gpuValid = false;
  }

  /** A capture waits on a frame that will not come once the session stops rendering. */
  private rejectPendingCapture(message: string): void {
    const pending = this.pendingCapture;
    this.pendingCapture = null;
    pending?.reject(new ChartCaptureError("CAPTURE_FAILED", message));
  }

  private startRaf(): void {
    if (this.rafId !== null) {
      incrementPerformanceCounter("chart.raf.coalesced");
      return;
    }
    const win = this.ownerDocument.defaultView;
    if (!win) return;
    incrementPerformanceCounter("chart.raf.scheduled");
    this.rafId = win.requestAnimationFrame(() => {
      // Release the slot before any commit/render work: a reentrant notification inside a
      // commit, or a throwing commit, must never leave a finished RAF id behind that
      // coalesces away a future frame.
      this.rafId = null;
      this.inPreSnapshotFrame = true;
      try {
        if (this.pendingContainerResize) {
          // Coalesced commit: collapse every pending measurement into one latest-bounds commit
          // BEFORE the dirty snapshot, in the same owner-window frame that repaints the surfaces.
          this.pendingContainerResize = false;
          if (this.active && this.gpuValid) this.applyContainerSize();
        }
        if (!this.active || !this.gpuValid) return;
        this.finishPendingResize();
      } finally {
        this.inPreSnapshotFrame = false;
      }
      incrementPerformanceCounter("chart.raf.frames");
      this.renderDirtySurfaces();
      if (this.dirtySurfaces !== ChartSurfaceDirty.None) this.startRaf();
    });
  }

  private renderDirtySurfaces(): void {
    if (!this.active || !this.gpuValid || this.dirtySurfaces === ChartSurfaceDirty.None) return;
    const telemetryEnabled = isPerformanceTelemetryEnabled();
    const frameStartedAt = telemetryEnabled ? performance.now() : null;
    const liveUpdateStartedAt = telemetryEnabled ? this.pendingLiveUpdateStartedAt : null;
    this.pendingLiveUpdateStartedAt = null;
    if (frameStartedAt !== null && liveUpdateStartedAt !== null) {
      recordPerformanceDuration("chart.liveUpdate.toRenderStart.ms", frameStartedAt - liveUpdateStartedAt);
    }
    const dirty = this.dirtySurfaces;
    const changes = this.pendingChanges;
    this.dirtySurfaces = ChartSurfaceDirty.None;
    this.pendingChanges = ChartChange.None;
    let capturePixels: Uint8ClampedArray | null = null;
    let captureSize: { width: number; height: number } | null = null;
    const useAsyncCapture = this.pendingCapture !== null && Boolean(readGpuSettings(this.ownerDocument.defaultView).asyncCapture || this.gpuSurface.kind === "webgpu");
    if (dirty & ChartSurfaceDirty.GpuScene) {
      incrementPerformanceCounter("chart.surface.gpu.draw");
      if (telemetryEnabled) {
        measurePerformance("chart.surface.gpu.draw.ms", () => this.renderer.render(this.view, this.series));
      } else {
        this.renderer.render(this.view, this.series);
      }
      if (this.pendingCapture && !useAsyncCapture) {
        try {
          captureSize = validateCaptureDimensions(
            this.gpuCanvas.width,
            this.gpuCanvas.height,
            this.annotationCanvas.width,
            this.annotationCanvas.height,
          );
          if (this.gpuSurface.kind === "canvas2d") {
            const ctx2d = this.gpuCanvas.getContext("2d");
            if (!ctx2d) throw new ChartCaptureError("CAPTURE_FAILED", "Canvas2D context unavailable for capture");
            const imgData = ctx2d.getImageData(0, 0, captureSize.width, captureSize.height);
            capturePixels = imgData.data;
          } else if (this.gl && typeof this.gl.readPixels === "function") {
            const raw = new Uint8Array(captureSize.width * captureSize.height * 4);
            this.gl.readPixels(0, 0, captureSize.width, captureSize.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, raw);
            capturePixels = flipRgbaRows(raw, captureSize.width, captureSize.height);
          } else {
            throw new ChartCaptureError("CAPTURE_FAILED", `Synchronous capture unsupported for ${this.gpuSurface.kind} surface`);
          }
        } catch (error) {
          const pending = this.pendingCapture;
          this.pendingCapture = null;
          pending?.reject(error);
        }
      }
    }
    const range = this.renderer.visibleRange(this.view, this.series.length);
    if (dirty & ChartSurfaceDirty.Annotation) {
      incrementPerformanceCounter("chart.surface.annotation.draw");
      if (telemetryEnabled) {
        measurePerformance("chart.surface.annotation.draw.ms", () => {
          this.annotationRenderer.render(this.view, this.series, this.crosshair, range);
        });
      } else {
        this.annotationRenderer.render(this.view, this.series, this.crosshair, range);
      }
    }
    if (dirty & ChartSurfaceDirty.Interaction) {
      incrementPerformanceCounter("chart.surface.interaction.draw");
      if (telemetryEnabled) {
        measurePerformance("chart.surface.interaction.draw.ms", () => {
          this.interactionRenderer.render(this.view, this.series, this.crosshair, range);
        });
      } else {
        this.interactionRenderer.render(this.view, this.series, this.crosshair, range);
      }
    }
    this.hasRenderedFrame = true;
    this.onRenderedCb?.(dirty, changes);
    const frameEndedAt = performance.now();
    const renderMs = frameStartedAt !== null ? frameEndedAt - frameStartedAt : undefined;
    if (frameStartedAt !== null) {
      recordPerformanceDuration("chart.frame.render.ms", frameEndedAt - frameStartedAt);
      if (liveUpdateStartedAt !== null) {
        recordPerformanceDuration("chart.liveUpdate.toRenderEnd.ms", frameEndedAt - liveUpdateStartedAt);
      }
    }
    const intervalMs = this.lastRenderTimestamp !== null && frameEndedAt - this.lastRenderTimestamp < 100
      ? frameEndedAt - this.lastRenderTimestamp
      : undefined;
    this.lastRenderTimestamp = frameEndedAt;
    recordGpuFrame(this.gpuSurface.kind, renderMs, intervalMs);

    if (this.pendingCapture && (dirty & ChartSurfaceDirty.Annotation)) {
      const pending = this.pendingCapture;
      this.pendingCapture = null;
      if (useAsyncCapture) {
        (async () => {
          try {
            validateCaptureDimensions(
              this.gpuCanvas.width,
              this.gpuCanvas.height,
              this.annotationCanvas.width,
              this.annotationCanvas.height,
            );
            const frame = await this.gpuSurface.requestCapture();
            const captureFrame = await encodeGpuAndAnnotationPng(
              this.ownerDocument,
              frame.data,
              frame.width,
              frame.height,
              this.annotationCanvas,
            );
            pending.resolve(captureFrame);
          } catch (err) {
            pending.reject(err);
          }
        })();
      } else if (capturePixels && captureSize) {
        void encodeGpuAndAnnotationPng(
          this.ownerDocument,
          capturePixels,
          captureSize.width,
          captureSize.height,
          this.annotationCanvas,
        ).then(pending.resolve, pending.reject);
      }
    }
  }

  private cancelRaf(): void {
    if (this.rafId !== null) {
      this.ownerDocument.defaultView?.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private dpr(): number {
    return effectivePixelRatio(this.ownerDocument.defaultView?.devicePixelRatio ?? 1, this.maxDevicePixelRatio);
  }

  /** Change the pixel-ratio cap on a live session; the canvases resize on the next frame if it moves them. */
  setMaxDevicePixelRatio(max: number | null): void {
    if (max === this.maxDevicePixelRatio) return;
    this.maxDevicePixelRatio = max;
    this.requestContainerResize();
  }

  /** Latest valid measured container target; `null` for non-positive bounds (never applied). */
  private measureContainerSize(): {
    w: number;
    h: number;
    dpr: number;
    cssWidth: string;
    cssHeight: string;
    bitmapWidth: number;
    bitmapHeight: number;
  } | null {
    const rect = this.container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return null;
    const dpr = this.dpr();
    return {
      w,
      h,
      dpr,
      cssWidth: w + "px",
      cssHeight: h + "px",
      bitmapWidth: Math.round(w * dpr),
      bitmapHeight: Math.round(h * dpr),
    };
  }

  private containerSizeWouldChange(target: {
    cssWidth: string;
    cssHeight: string;
    bitmapWidth: number;
    bitmapHeight: number;
  }): boolean {
    return this.gpuCanvas.style.width !== target.cssWidth ||
      this.gpuCanvas.style.height !== target.cssHeight ||
      this.gpuCanvas.width !== target.bitmapWidth ||
      this.gpuCanvas.height !== target.bitmapHeight;
  }

  /** Apply a measured canvas size. Returns true only when a commit actually ran. */
  private applyContainerSize(): boolean {
    const target = this.measureContainerSize();
    if (!target) return false;
    if (this.containerSizeWouldChange(target)) {
      // Mark the transaction unfinished BEFORE the destructive bitmap/CSS mutation: if a
      // transform or onResize throws mid-commit, the physically cleared surfaces keep
      // their repayment intent instead of silently skipping restoration on an unchanged retry.
      this.unfinishedResize = { w: target.w, h: target.h, dpr: target.dpr };
      const { cssWidth, cssHeight, bitmapWidth, bitmapHeight } = target;
      for (const c of [this.gpuCanvas, this.annotationCanvas, this.interactionCanvas]) {
        if (c.style.width !== cssWidth) c.style.width = cssWidth;
        if (c.style.height !== cssHeight) c.style.height = cssHeight;
        if (c.width !== bitmapWidth) c.width = bitmapWidth;
        if (c.height !== bitmapHeight) c.height = bitmapHeight;
      }
      this.gpuSurface.resize(bitmapWidth, bitmapHeight, target.dpr);
    } else if (this.unfinishedResize === null) {
      return false;
    }
    this.finishPendingResize();
    return true;
  }

  /**
   * Complete the resize transaction: DPR transforms, healthy onResize adaptation and the
   * full repaint debt owed by every physically cleared surface. No-op unless a commit left
   * `unfinishedResize` behind; only the next healthy owner frame runs this — the original
   * exception is neither swallowed nor retried here.
   */
  private finishPendingResize(): void {
    const pending = this.unfinishedResize;
    if (pending === null) return;
    this.annotationCtx2d.setTransform(pending.dpr, 0, 0, pending.dpr, 0, 0);
    this.interactionCtx2d.setTransform(pending.dpr, 0, 0, pending.dpr, 0, 0);
    this.onResizeCb?.(pending.w, pending.h, pending.dpr);
    this.dirtySurfaces = ChartSurfaceDirty.All;
    this.pendingChanges |= ChartChange.Layout;
    this.unfinishedResize = null;
  }

  /**
   * Resize notification path (RO / DPR / adoption): measure only, then coalesce a single
   * request. Unchanged measurements queue zero frames; the commit itself happens inside the
   * next owner-window RAF via `pendingContainerResize`, painted bitmaps stay retained until
   * that same frame repaints all dirty surfaces.
   */
  private requestContainerResize(): void {
    if (!this.active || !this.gpuValid) return;
    const target = this.measureContainerSize();
    if (!target || !this.containerSizeWouldChange(target)) return;
    this.pendingContainerResize = true;
    this.startRaf();
  }

  private setupResizeObserver(): void {
    const ResizeObserverCtor = this.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver;
    this.ro = new ResizeObserverCtor(() => {
      if (!this.active) return;
      this.requestContainerResize();
    });
    this.ro.observe(this.container);
    this.lifecycle.add(() => this.ro?.disconnect());
  }

  updateContainer(container: HTMLElement): void {
    this.ro?.disconnect();
    // Whether this owner actually owed a frame (pending paint/capture/resize intent). The
    // swap re-homes that intent on the new owner as exactly one callback; an idle or
    // inactive session must not invent paint debt on adoption.
    const transferPendingWork = this.rafId !== null && this.active && this.gpuValid;
    if (container.ownerDocument !== this.ownerDocument) {
      // Cancel a pending frame on its actual old scheduling window before the owner swap;
      // raf ids are realm-local, so a post-swap cancel could hit an unrelated new frame.
      this.cancelRaf();
    }
    this.container = container;
    this.ownerDocument = container.ownerDocument;
    this.disposeDprWatcher?.();
    this.disposeDprWatcher = null;
    const ResizeObserverCtor = this.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver;
    this.ro = new ResizeObserverCtor(() => {
      if (!this.active) return;
      this.requestContainerResize();
    });
    this.ro.observe(this.container);
    this.setupDprWatcher();
    if (transferPendingWork) {
      // Re-home the interrupted frame on the new owner window: exactly one callback
      // carrying the same pending paint/capture/resize intent.
      this.startRaf();
    }
    this.requestContainerResize();
  }

  private setupDprWatcher(): void {
    const win = this.ownerDocument.defaultView;
    if (!win) return;

    let mql: MediaQueryList | null = null;
    const update = (): void => {
      mql?.removeEventListener("change", update);
      mql = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
      mql.addEventListener("change", update);
      if (this.active) this.requestContainerResize();
    };
    update();
    const dispose = () => mql?.removeEventListener("change", update);
    this.disposeDprWatcher = dispose;
    this.lifecycle.add(dispose);
  }

  private setupContextLossHandling(): void {
    if (this.cleanupContextListeners) {
      this.cleanupContextListeners();
      this.cleanupContextListeners = null;
    }

    if (this.gpuSurface.kind === "webgpu") {
      const unbind = this.gpuSurface.onLost((reason) => {
        incrementPerformanceCounter("chart.gpu.contextLost");
        this.cancelRaf();
        this.pendingLiveUpdateStartedAt = null;
        this.gpuValid = false;
        this.dirtySurfaces = ChartSurfaceDirty.None;
        this.pendingChanges = ChartChange.None;
        this.rejectPendingCapture("WebGPU device was lost during capture");
        this.onLostContextCb?.();

        recordGpuFallback("webgpu", "webgl2", reason);
        try {
          const fallbackCanvas = this.ownerDocument.createElement("canvas");
          const fallbackGl = getChartWebGl2Context(fallbackCanvas);
          if (fallbackGl) {
            this.replaceSurface(new WebGl2Surface(fallbackCanvas, fallbackGl));
          } else {
            recordGpuFallback("webgl2", "canvas2d", "fallback_context_unavailable");
            this.replaceSurface(new Canvas2dSurface(fallbackCanvas));
          }
        } catch (err) {
          console.error("[ChartSession] WebGPU fallback failed", err);
        }
      });

      this.cleanupContextListeners = unbind;
      this.lifecycle.add(unbind);
      return;
    }

    const canvas = this.gpuCanvas;
    if (!canvas.addEventListener) return;

    const onLost = (e: Event): void => {
      e.preventDefault();
      incrementPerformanceCounter("chart.gpu.contextLost");
      this.cancelRaf();
      this.pendingLiveUpdateStartedAt = null;
      this.gpuValid = false;
      this.dirtySurfaces = ChartSurfaceDirty.None;
      this.pendingChanges = ChartChange.None;
      this.rejectPendingCapture("WebGL context was lost during capture");
      this.onLostContextCb?.();

      if (this.restoreTimeoutId) clearTimeout(this.restoreTimeoutId);
      this.restoreTimeoutId = setTimeout(() => {
        this.restoreTimeoutId = null;
        recordGpuFallback("webgl2", "canvas2d", "restore_timeout");
        const fallbackCanvas = this.ownerDocument.createElement("canvas");
        const fallbackSurface = new Canvas2dSurface(fallbackCanvas);
        this.replaceSurface(fallbackSurface);
      }, CONTEXT_RESTORE_TIMEOUT_MS);
    };

    const onRestored = (): void => {
      if (this.restoreTimeoutId) {
        clearTimeout(this.restoreTimeoutId);
        this.restoreTimeoutId = null;
      }
      const freshGl = getChartWebGl2Context(this.gpuCanvas);
      if (!freshGl) {
        incrementPerformanceCounter("chart.gpu.contextCreateFailed");
        return;
      }
      incrementPerformanceCounter("chart.gpu.contextRestored");
      this.gl = freshGl;
      if (typeof (this.gpuSurface as any).updateGl === "function") {
        (this.gpuSurface as any).updateGl(freshGl);
      }
      this.onRestoreContextCb(freshGl);
      this.gpuValid = true;
      this.applyContainerSize();
      this.dirtySurfaces = ChartSurfaceDirty.All;
      this.pendingChanges = ChartChange.All;
      if (this.active) this.startRaf();
    };

    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    const cleanup = () => {
      if (this.restoreTimeoutId) {
        clearTimeout(this.restoreTimeoutId);
        this.restoreTimeoutId = null;
      }
      canvas.removeEventListener?.("webglcontextlost", onLost);
      canvas.removeEventListener?.("webglcontextrestored", onRestored);
    };
    this.cleanupContextListeners = cleanup;
    this.lifecycle.add(cleanup);
  }
}


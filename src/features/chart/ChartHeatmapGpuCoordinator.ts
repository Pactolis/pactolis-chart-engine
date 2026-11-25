import type { View } from "../../core/engine/view.js";
import type { GpuNativeHeatmapResidentFrame, GpuSurface } from "../../core/gpu/gpuBackend.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type { HeatmapGpuRenderer, HeatmapGpuCellFrame } from "./heatmap/gpu/heatmapGpuRenderer.js";
import type { OrderbookHeatmapOverlay } from "../orderbook/heatmapOverlay.js";
import { recordGpuFeatureFallback, setGpuFeaturePath } from "../../core/gpu/gpuDiagnostics.js";
import { isSoftwareRendererName } from "../../core/gpu/selectBackend.js";
import { incrementPerformanceCounter } from "../../core/performanceTelemetry.js";

const HEATMAP_GPU_FEATURE = "orderbook-heatmap";

export const HEATMAP_GPU_SLOW_FRAME_THRESHOLD_MS = 50;
export const HEATMAP_GPU_SLOW_FRAME_CONSECUTIVE_LIMIT = 5;

let cachedCaveatProbeResult: boolean | null = null;

export function resetSoftwareRendererProbeCacheForTest(): void {
  cachedCaveatProbeResult = null;
}

function probeMajorPerformanceCaveat(): boolean {
  if (cachedCaveatProbeResult !== null) {
    return cachedCaveatProbeResult;
  }
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  try {
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      canvas = document.createElement("canvas");
    } else if (typeof OffscreenCanvas === "function") {
      canvas = new OffscreenCanvas(1, 1);
    }
  } catch {
    canvas = null;
  }
  if (!canvas) {
    return false;
  }
  try {
    canvas.width = 1;
    canvas.height = 1;
    const strictGl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) as WebGL2RenderingContext | null;
    if (strictGl) {
      try {
        (strictGl.getExtension?.("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
      } catch {
        // ignore
      }
      cachedCaveatProbeResult = false;
      return false;
    }
    const plainGl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    if (plainGl) {
      try {
        (plainGl.getExtension?.("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
      } catch {
        // ignore
      }
      cachedCaveatProbeResult = true;
      return true;
    }
    cachedCaveatProbeResult = false;
    return false;
  } catch {
    cachedCaveatProbeResult = false;
    return false;
  } finally {
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      // ignore
    }
  }
}

function detectWebGl2SoftwareRenderer(
  gl: WebGL2RenderingContext | null,
): { isSoftware: boolean; renderer: string | null } {
  if (!gl) {
    return { isSoftware: false, renderer: null };
  }
  let renderer: string | null = null;
  let unmaskedFound = false;
  try {
    const debugInfo = gl.getExtension?.("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL?: number } | null;
    if (debugInfo && typeof debugInfo.UNMASKED_RENDERER_WEBGL === "number") {
      const unmasked = gl.getParameter?.(debugInfo.UNMASKED_RENDERER_WEBGL);
      if (typeof unmasked === "string" && unmasked.trim().length > 0) {
        renderer = unmasked.trim();
        unmaskedFound = true;
      }
    }
    if (!renderer) {
      const masked = gl.getParameter?.(0x1f01);
      if (typeof masked === "string" && masked.trim().length > 0) {
        renderer = masked.trim();
      }
    }
  } catch {
    // ignore WebGL parameter probe errors on mock/lost contexts
  }

  if (renderer && isSoftwareRendererName(renderer)) {
    return { isSoftware: true, renderer };
  }

  const isMaskedOrEmpty = !unmaskedFound && (!renderer || /^(webkit webgl|mozilla|webgl|angle)$/i.test(renderer));
  if (isMaskedOrEmpty && probeMajorPerformanceCaveat()) {
    return { isSoftware: true, renderer };
  }

  return { isSoftware: false, renderer };
}

export interface HeatmapGpuRenderFrame {
  dataKey: string;
  threshold: number;
  floor?: number;
  ceiling: number;
  opacity?: number;
  colWidth: number;
  offsetX: number;
  areaLeft: number;
  areaTop: number;
  areaWidth: number;
  areaHeight: number;
  priceTop: number;
  pricePerPx: number;
  priceScaleMode: string;
  seriesRef: FootprintSeries;
  seriesStructureRevision: number;
  seriesLength: number;
  rangeFrom: number;
  rangeTo: number;
}

export interface ChartHeatmapGpuCoordinatorHost {
  readonly backendKind?: string;
  readonly orderbookHeatmap: OrderbookHeatmapOverlay | null;
  readonly renderCoordinator?: { getAnnotationLayerOrder(): readonly string[] };
  readonly renderer: { visibleRange(view: View, seriesLength: number): [number, number] };
  invalidateSession(): void;
}

/**
 * Coordinates GPU-accelerated orderbook heatmap texture lifecycle, preparation, rendering,
 * budget latching, and annotation suppression.
 */
export class ChartHeatmapGpuCoordinator {
  private _heatmapTexturePrototypeEnabled = false;
  private explicitOverride = false;
  private heatmapTexturePrototypeLastEnabled: boolean | null = null;
  private heatmapGpuRenderer: HeatmapGpuRenderer | null = null;
  private heatmapGpuRendererPromise: Promise<typeof import("./heatmap/gpu/heatmapGpuRenderer.js")> | null = null;
  private heatmapGpuRendererGl: WebGL2RenderingContext | null = null;
  private cachedGlRendererName: string | null = null;
  private cachedGlIsSoftware = false;
  private surface: GpuSurface | null = null;
  private heatmapGpuFailureLatched = false;
  private heatmapGpuUnsupportedEpisode = false;
  private heatmapGpuSoftwareEpisode = false;
  private renderedGpuHeatmapThisFrame = false;
  private consecutiveSlowGpuFrames = 0;
  private lastFallbackReason: string | null = null;
  private lastHeatmapPath = "cpu";
  private heatmapGpuFrame: HeatmapGpuRenderFrame | null = null;
  private heatmapGpuLease: { release(): void } | null = null;
  private pendingResidentFrame: GpuNativeHeatmapResidentFrame | null = null;
  private cachedPrepareKey: string | null = null;
  private cachedPrepareFrame: HeatmapGpuCellFrame | null = null;
  private cachedPrepareLease: { release(): void } | null = null;
  private cachedPrepareHandle: { release(): void } | undefined = undefined;
  private cachedPrepareEpoch = 0;

  constructor(private readonly host: ChartHeatmapGpuCoordinatorHost) {}

  get heatmapTexturePrototypeEnabled(): boolean {
    return this._heatmapTexturePrototypeEnabled;
  }

  set heatmapTexturePrototypeEnabled(enabled: boolean) {
    this.setResidentHeatmapEnabled(enabled, enabled);
  }

  isHeatmapTexturePrototypeEnabled(): boolean {
    return this._heatmapTexturePrototypeEnabled;
  }

  setHeatmapTexturePrototypeEnabled(enabled: boolean): void {
    this.heatmapTexturePrototypeEnabled = enabled;
  }

  public isHeatmapGpuSupported(): boolean {
    return !this.heatmapGpuFailureLatched && this.supportsHeatmapGpu();
  }

  private supportsHeatmapGpu(): boolean {
    if (!this.heatmapTexturePrototypeEnabled) {
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
      setGpuFeaturePath("heatmap", "off");
      return false;
    }
    const backend = this.host.backendKind ?? "webgl2";
    if (backend === "webgpu") {
      if (!this.surface?.supportsNativeHeatmap?.()) {
        setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
        setGpuFeaturePath("heatmap", "cpu");
        if (!this.heatmapGpuUnsupportedEpisode) {
          recordGpuFeatureFallback(HEATMAP_GPU_FEATURE, "backend_unsupported");
          this.heatmapGpuUnsupportedEpisode = true;
        }
        return false;
      }
      this.heatmapGpuUnsupportedEpisode = false;
      if (!this.heatmapGpuFrame) {
        setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
        setGpuFeaturePath("heatmap", "cpu");
      }
      return true;
    }
    if (backend !== "webgl2") {
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
      setGpuFeaturePath("heatmap", "cpu");
      this.lastHeatmapPath = "cpu";
      this.lastFallbackReason = "backend_unsupported";
      if (!this.heatmapGpuUnsupportedEpisode) {
        recordGpuFeatureFallback(HEATMAP_GPU_FEATURE, "backend_unsupported");
        this.heatmapGpuUnsupportedEpisode = true;
      }
      return false;
    }
    this.heatmapGpuUnsupportedEpisode = false;
    if (!this.explicitOverride && this.cachedGlIsSoftware) {
      this.lastHeatmapPath = "cpu-raster";
      this.lastFallbackReason = "software_renderer";
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu-raster");
      setGpuFeaturePath("heatmap", "cpu-raster");
      if (!this.heatmapGpuSoftwareEpisode) {
        recordGpuFeatureFallback(HEATMAP_GPU_FEATURE, "software_renderer");
        this.heatmapGpuSoftwareEpisode = true;
      }
      return false;
    }
    if (!this.heatmapGpuFrame) {
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
      setGpuFeaturePath("heatmap", "cpu");
    }
    return true;
  }

  setResidentHeatmapEnabled(enabled: boolean, explicitOverride = false): void {
    this.explicitOverride = enabled && explicitOverride;
    this._heatmapTexturePrototypeEnabled = enabled;
    if (enabled) {
      if ((this.host.backendKind ?? "webgl2") !== "webgpu" && this.supportsHeatmapGpu() && !this.heatmapGpuFailureLatched) {
        void this.loadHeatmapGpuRenderer();
      }
    } else {
      this.heatmapGpuFrame = null;
      this.pendingResidentFrame = null;
      this.releaseHeatmapGpuLease();
      this.clearPreparedCache();
      this.surface?.disposeNativeHeatmap?.();
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
      setGpuFeaturePath("heatmap", "off");
    }
    this.host.invalidateSession();
  }

  setGl(gl: WebGL2RenderingContext | null): void {
    const glChanged = this.heatmapGpuRendererGl !== gl;
    if (glChanged) {
      this.heatmapGpuFrame = null;
      this.pendingResidentFrame = null;
      this.releaseHeatmapGpuLease();
      this.clearPreparedCache();
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
      setGpuFeaturePath("heatmap", undefined);
      this.heatmapGpuSoftwareEpisode = false;
    }
    this.heatmapGpuRendererGl = gl;
    if (!gl) {
      this.cachedGlIsSoftware = false;
      this.cachedGlRendererName = null;
    } else if (glChanged || (this.cachedGlRendererName === null && !this.cachedGlIsSoftware)) {
      const detection = detectWebGl2SoftwareRenderer(gl);
      this.cachedGlIsSoftware = detection.isSoftware;
      this.cachedGlRendererName = detection.renderer;
    }
    if (this._heatmapTexturePrototypeEnabled) {
      this.supportsHeatmapGpu();
    }
  }

  setSurface(surface: GpuSurface | null): void {
    if (this.surface !== surface) {
      this.heatmapGpuFrame = null;
      this.pendingResidentFrame = null;
      this.releaseHeatmapGpuLease();
      this.clearPreparedCache();
      this.surface?.disposeNativeHeatmap?.();
      this.heatmapGpuFailureLatched = false;
      this.lastFallbackReason = null;
      this.heatmapGpuUnsupportedEpisode = false;
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
      setGpuFeaturePath("heatmap", undefined);
    }
    this.surface = surface;
  }

  resetFailureLatch(): void {
    this.heatmapGpuFailureLatched = false;
    this.lastFallbackReason = null;
  }

  getDiagnostics(): {
    enabled: boolean;
    backend: string;
    heatmapPath: string;
    failureLatched: boolean;
    fallbackReason: string | null;
    renderer: string | null;
  } {
    return {
      enabled: this._heatmapTexturePrototypeEnabled,
      backend: this.host.backendKind ?? "webgl2",
      heatmapPath: this.lastHeatmapPath,
      failureLatched: this.heatmapGpuFailureLatched,
      fallbackReason: this.lastFallbackReason,
      renderer: this.cachedGlRendererName,
    };
  }

  getFrame(): HeatmapGpuRenderFrame | null {
    return this.heatmapGpuFrame;
  }

  getLease(): { release(): void } | null {
    return this.heatmapGpuLease ?? this.cachedPrepareLease;
  }

  whenHeatmapGpuRendererReady(): Promise<void> {
    if ((this.host.backendKind ?? "webgl2") === "webgpu") {
      return Promise.resolve();
    }
    return this.loadHeatmapGpuRenderer().then(() => undefined);
  }

  private loadHeatmapGpuRenderer(): Promise<typeof import("./heatmap/gpu/heatmapGpuRenderer.js")> {
    if (!this.heatmapGpuRendererPromise) {
      this.heatmapGpuRendererPromise = import("./heatmap/gpu/heatmapGpuRenderer.js").then((module) => {
        if (this.heatmapTexturePrototypeEnabled) {
          this.heatmapGpuRenderer ??= new module.HeatmapGpuRenderer();
          this.host.invalidateSession();
        }
        return module;
      }).finally(() => {
        this.heatmapGpuRendererPromise = null;
      });
    }
    return this.heatmapGpuRendererPromise;
  }

  beginFrameAttempt(): void {
    this.renderedGpuHeatmapThisFrame = false;
    this.heatmapGpuFrame = null;
    this.pendingResidentFrame = null;
    this.releaseHeatmapGpuLease();
    this.trackHeatmapPrototypeOptIn();
  }

  trackHeatmapPrototypeOptIn(): void {
    if (this.heatmapTexturePrototypeLastEnabled !== this.heatmapTexturePrototypeEnabled) {
      this.heatmapTexturePrototypeLastEnabled = this.heatmapTexturePrototypeEnabled;
      this.heatmapGpuFailureLatched = false;
    }
  }

  prepareHeatmapGpuCells(v: View, s: FootprintSeries): HeatmapGpuCellFrame | null {
    const backend = this.host.backendKind ?? "webgl2";
    const isWebGpu = backend === "webgpu";
    this.pendingResidentFrame = null;
    if (!this.supportsHeatmapGpu() || this.heatmapGpuFailureLatched) {
      this.clearPreparedCache();
      return null;
    }
    if (!isWebGpu && !this.heatmapGpuRenderer) {
      this.clearPreparedCache();
      return null;
    }
    if (isWebGpu && typeof this.surface?.reserveNativeHeatmapPayload !== "function") {
      this.clearPreparedCache();
      return null;
    }
    if (!this.host.orderbookHeatmap) {
      this.clearPreparedCache();
      return null;
    }
    if (!(this.host.renderCoordinator?.getAnnotationLayerOrder() ?? []).includes("orderbook-heatmap")) {
      this.clearPreparedCache();
      return null;
    }
    if (v.area.width <= 1 || v.area.height <= 1 || s.length === 0) {
      this.clearPreparedCache();
      return null;
    }

    const overlay = this.host.orderbookHeatmap;
    const range = this.host.renderer.visibleRange(v, s.length);
    const isLogScale = typeof (v as { isLogScale?: () => boolean }).isLogScale === "function"
      && (v as { isLogScale: () => boolean }).isLogScale();
    if (
      isWebGpu
      && !isLogScale
      && typeof this.surface?.renderNativeResidentHeatmap === "function"
      && typeof (overlay as { prepareResidentGpuScene?: unknown }).prepareResidentGpuScene === "function"
    ) {
      this.clearPreparedCache();
      this.pendingResidentFrame = overlay.prepareResidentGpuScene(v, s, range);
      return null;
    }
    const hasCacheKeyFn = typeof overlay.getPrepareCacheKey === "function";
    const rawCacheKey = hasCacheKeyFn ? overlay.getPrepareCacheKey(v, s, range) : null;
    if (hasCacheKeyFn && rawCacheKey === null) {
      this.clearPreparedCache();
      return null;
    }
    const cacheKey = rawCacheKey === null
      ? null
      : (isWebGpu ? `${rawCacheKey}|offsetX:${v.offsetX}` : rawCacheKey);

    if (cacheKey !== null && cacheKey === this.cachedPrepareKey && this.cachedPrepareFrame) {
      const panOffsetX = !isWebGpu && this.cachedPrepareFrame.anchorOffsetX !== undefined
        ? v.offsetX - this.cachedPrepareFrame.anchorOffsetX
        : 0;
      return {
        ...this.cachedPrepareFrame,
        panOffsetX,
        ...(typeof (overlay as { getActivePalette?: () => unknown }).getActivePalette === "function"
          ? { palette: (overlay as { getActivePalette: () => HeatmapGpuCellFrame["palette"] }).getActivePalette() }
          : {}),
        ...(typeof (overlay as { getActiveOpacity?: () => unknown }).getActiveOpacity === "function"
          ? { opacity: (overlay as { getActiveOpacity: () => number }).getActiveOpacity() }
          : {}),
        preparedLease: this.cachedPrepareHandle,
      };
    }

    this.clearPreparedCache();
    const reserve = isWebGpu
      ? (logicalBytes: number) => this.surface!.reserveNativeHeatmapPayload!(logicalBytes)
      : (logicalBytes: number) => this.heatmapGpuRenderer!.reservePreparedPayload(logicalBytes);
    const prepared = overlay.prepareGpuCells(
      v,
      s,
      range,
      reserve,
    );
    if (!prepared || cacheKey === null) return prepared;

    const realLease = prepared.preparedLease ?? null;
    let handle: { release(): void } | undefined;
    if (realLease) {
      const epoch = ++this.cachedPrepareEpoch;
      handle = {
        release: () => {
          if (this.cachedPrepareEpoch === epoch) {
            this.clearPreparedCache();
          }
        },
      };
    }
    this.cachedPrepareKey = cacheKey;
    this.cachedPrepareFrame = prepared;
    this.cachedPrepareLease = realLease;
    this.cachedPrepareHandle = handle;
    return {
      ...prepared,
      preparedLease: handle,
    };
  }

  renderHeatmapGpuCells(frame: HeatmapGpuCellFrame | null, v: View, s: FootprintSeries): void {
    const residentFrame = this.pendingResidentFrame;
    this.pendingResidentFrame = null;
    if (!this.supportsHeatmapGpu()) {
      frame?.preparedLease?.release();
      return;
    }
    if (!residentFrame && !frame) return;
    const backend = this.host.backendKind ?? "webgl2";
    const isWebGpu = backend === "webgpu";
    const plot = {
      left: v.area.left,
      top: v.area.top,
      width: v.area.width,
      height: v.area.height,
      ...(v.pixelRatio !== null && v.pixelRatio > 0 ? { pixelRatio: v.pixelRatio } : {}),
    };

    if (isWebGpu && residentFrame) {
      frame?.preparedLease?.release();
      const surface = this.surface;
      if (!surface || typeof surface.renderNativeResidentHeatmap !== "function") {
        this.disposeHeatmapGpuRenderer();
        this.heatmapGpuFailureLatched = true;
        setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
        setGpuFeaturePath("heatmap", "cpu");
        return;
      }
      let ok = false;
      try {
        ok = surface.renderNativeResidentHeatmap(residentFrame, plot);
      } catch (error) {
        if (error instanceof Error && error.message === "Heatmap GPU prototype budget exceeded") {
          setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
          setGpuFeaturePath("heatmap", "cpu");
          return;
        }
        throw error;
      }
      if (!ok) {
        if (surface.wasLastHeatmapFailureRecoverable?.() === true) {
          this.lastFallbackReason = "recoverable-frame-skip";
          incrementPerformanceCounter("chart.gpu.heatmap.fallback.recoverable");
        } else {
          this.disposeHeatmapGpuRenderer();
          this.heatmapGpuFailureLatched = true;
          this.lastFallbackReason = "webgpu-resident-permanent";
          incrementPerformanceCounter("chart.gpu.heatmap.fallback.permanent");
        }
        this.lastHeatmapPath = "cpu";
        setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
        setGpuFeaturePath("heatmap", "cpu");
        return;
      }

      this.recordHeatmapGpuClaim(v, s, {
        dataKey: residentFrame.dataKey,
        threshold: residentFrame.threshold,
        floor: residentFrame.floor,
        ceiling: residentFrame.ceiling,
        opacity: residentFrame.opacity,
      }, null);
      this.renderedGpuHeatmapThisFrame = true;
      this.lastFallbackReason = null;
      this.lastHeatmapPath = "webgpu-native";
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, "webgpu");
      setGpuFeaturePath("heatmap", "webgpu-native");
      return;
    }

    if (!frame) return;

    let ok: boolean;
    if (isWebGpu) {
      const surface = this.surface;
      if (!surface || typeof surface.renderNativeHeatmap !== "function") {
        frame.preparedLease?.release();
        this.disposeHeatmapGpuRenderer();
        this.heatmapGpuFailureLatched = true;
        this.lastFallbackReason = "webgpu-surface-missing";
        this.lastHeatmapPath = "cpu";
        setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
        setGpuFeaturePath("heatmap", "cpu");
        return;
      }
      try {
        ok = surface.renderNativeHeatmap(frame, plot);
      } catch (error) {
        if (error instanceof Error && error.message === "Heatmap GPU prototype budget exceeded") {
          frame.preparedLease?.release();
          this.lastFallbackReason = "budget-exceeded";
          this.lastHeatmapPath = "cpu";
          setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
          setGpuFeaturePath("heatmap", "cpu");
          return;
        }
        throw error;
      }
      if (!ok) {
        frame.preparedLease?.release();
        if (surface.wasLastHeatmapFailureRecoverable?.() === true) {
          this.lastFallbackReason = "recoverable-frame-skip";
          incrementPerformanceCounter("chart.gpu.heatmap.fallback.recoverable");
        } else {
          this.disposeHeatmapGpuRenderer();
          this.heatmapGpuFailureLatched = true;
          this.lastFallbackReason = "webgpu-immediate-permanent";
          incrementPerformanceCounter("chart.gpu.heatmap.fallback.permanent");
        }
        this.lastHeatmapPath = "cpu";
        setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
        setGpuFeaturePath("heatmap", "cpu");
        return;
      }
    } else {
      const gl = this.heatmapGpuRendererGl;
      if (!gl) {
        frame.preparedLease?.release();
        this.disposeHeatmapGpuRenderer();
        this.heatmapGpuFailureLatched = true;
        this.lastFallbackReason = "webgl2-context-missing";
        this.lastHeatmapPath = "cpu";
        setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
        setGpuFeaturePath("heatmap", "cpu");
        return;
      }
      if (!this.heatmapGpuRenderer) {
        frame.preparedLease?.release();
        return;
      }
      try {
        ok = this.heatmapGpuRenderer.renderFrame(gl, frame, plot);
      } catch (error) {
        if (error instanceof Error && error.message === "Heatmap GPU prototype budget exceeded") {
          frame.preparedLease?.release();
          this.lastFallbackReason = "budget-exceeded";
          return;
        }
        throw error;
      }
      if (!ok) {
        frame.preparedLease?.release();
        const permanent = typeof (this.heatmapGpuRenderer as { isDisposed?: () => boolean }).isDisposed === "function"
          ? this.heatmapGpuRenderer.isDisposed()
          : true;
        if (permanent) {
          this.disposeHeatmapGpuRenderer();
          this.heatmapGpuRendererGl = gl;
          this.heatmapGpuFailureLatched = true;
          this.lastFallbackReason = "webgl2-permanent";
          incrementPerformanceCounter("chart.gpu.heatmap.fallback.permanent");
        } else {
          this.lastFallbackReason = "recoverable-frame-skip";
          incrementPerformanceCounter("chart.gpu.heatmap.fallback.recoverable");
        }
        this.lastHeatmapPath = "cpu";
        setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
        setGpuFeaturePath("heatmap", "cpu");
        return;
      }
    }

    this.recordHeatmapGpuClaim(
      v,
      s,
      {
        dataKey: frame.dataKey,
        threshold: frame.threshold,
        floor: frame.floor,
        ceiling: frame.ceiling,
        opacity: frame.opacity,
      },
      frame.preparedLease && frame.preparedLease === this.cachedPrepareHandle
        ? null
        : (frame.preparedLease ?? null),
    );
    this.renderedGpuHeatmapThisFrame = true;
    this.lastFallbackReason = null;
    this.lastHeatmapPath = isWebGpu ? "webgpu-immediate" : "webgl2";
    setGpuFeaturePath(HEATMAP_GPU_FEATURE, isWebGpu ? "webgpu" : "webgl2");
    setGpuFeaturePath("heatmap", isWebGpu ? "webgpu-immediate" : "webgl2");
  }

  observeRenderedFrame(sample: {
    renderMs: number;
    rafLatencyMs?: number | null;
    visible?: boolean;
  }): boolean {
    if (
      !this.renderedGpuHeatmapThisFrame
      || this.explicitOverride
      || this.heatmapGpuFailureLatched
      || !this._heatmapTexturePrototypeEnabled
    ) {
      return false;
    }
    if (sample.visible === false) {
      this.consecutiveSlowGpuFrames = 0;
      return false;
    }
    const effectiveMs = Math.max(sample.renderMs, sample.rafLatencyMs ?? 0);
    if (effectiveMs > HEATMAP_GPU_SLOW_FRAME_THRESHOLD_MS) {
      this.consecutiveSlowGpuFrames++;
    } else {
      this.consecutiveSlowGpuFrames = 0;
      return false;
    }
    if (this.consecutiveSlowGpuFrames < HEATMAP_GPU_SLOW_FRAME_CONSECUTIVE_LIMIT) {
      return false;
    }
    const gl = this.heatmapGpuRendererGl;
    const isSw = this.cachedGlIsSoftware;
    const rName = this.cachedGlRendererName;
    this.disposeHeatmapGpuRenderer();
    this.heatmapGpuRendererGl = gl;
    this.cachedGlIsSoftware = isSw;
    this.cachedGlRendererName = rName;
    this.heatmapGpuFailureLatched = true;
    this.lastHeatmapPath = "cpu-raster";
    this.lastFallbackReason = "slow_frame_budget";
    setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu-raster");
    setGpuFeaturePath("heatmap", "cpu-raster");
    recordGpuFeatureFallback(HEATMAP_GPU_FEATURE, "slow_frame_budget");
    incrementPerformanceCounter("chart.gpu.heatmap.fallback.permanent");
    this.host.invalidateSession();
    return true;
  }

  private recordHeatmapGpuClaim(
    v: View,
    s: FootprintSeries,
    frame: { dataKey: string; threshold: number; floor?: number; ceiling: number; opacity?: number },
    lease: { release(): void } | null,
  ): void {
    const range = this.host.renderer.visibleRange(v, s.length);
    this.heatmapGpuFrame = {
      dataKey: frame.dataKey,
      threshold: frame.threshold,
      floor: frame.floor,
      ceiling: frame.ceiling,
      opacity: frame.opacity,
      colWidth: v.colWidth,
      offsetX: v.offsetX,
      areaLeft: v.area.left,
      areaTop: v.area.top,
      areaWidth: v.area.width,
      areaHeight: v.area.height,
      priceTop: v.priceTop,
      pricePerPx: v.pricePerPx,
      priceScaleMode: v.priceScaleMode,
      seriesRef: s,
      seriesStructureRevision: (s as { structureRevision?: number }).structureRevision ?? 0,
      seriesLength: s.length,
      rangeFrom: range[0],
      rangeTo: range[1],
    };
    this.heatmapGpuLease = lease;
  }

  heatmapGpuSuppressedAnnotation(v: View, s: FootprintSeries, range: [number, number]): boolean {
    const claim = this.heatmapGpuFrame;
    if (!claim) return false;
    return claim.dataKey === this.host.orderbookHeatmap?.currentDataKey()
      && claim.seriesRef === s
      && claim.seriesStructureRevision === ((s as { structureRevision?: number }).structureRevision ?? 0)
      && claim.colWidth === v.colWidth
      && claim.offsetX === v.offsetX
      && claim.areaLeft === v.area.left
      && claim.areaTop === v.area.top
      && claim.areaWidth === v.area.width
      && claim.areaHeight === v.area.height
      && claim.priceTop === v.priceTop
      && claim.pricePerPx === v.pricePerPx
      && claim.priceScaleMode === v.priceScaleMode
      && claim.seriesLength === s.length
      && claim.rangeFrom === range[0]
      && claim.rangeTo === range[1];
  }

  private clearPreparedCache(): void {
    const lease = this.cachedPrepareLease;
    this.cachedPrepareKey = null;
    this.cachedPrepareFrame = null;
    this.cachedPrepareLease = null;
    this.cachedPrepareHandle = undefined;
    this.cachedPrepareEpoch++;
    lease?.release();
  }

  releaseHeatmapGpuLease(): void {
    const lease = this.heatmapGpuLease;
    this.heatmapGpuLease = null;
    lease?.release();
  }

  disposeHeatmapGpuRenderer(): void {
    this.heatmapGpuFrame = null;
    this.pendingResidentFrame = null;
    setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
    setGpuFeaturePath("heatmap", undefined);
    this.releaseHeatmapGpuLease();
    this.clearPreparedCache();
    this.heatmapGpuRenderer?.dispose();
    this.heatmapGpuRenderer = null;
    this.heatmapGpuRendererGl = null;
    this.surface?.disposeNativeHeatmap?.();
  }

  dispose(): void {
    this.disposeHeatmapGpuRenderer();
    this.surface = null;
  }

  onRestoreContext(restoredGl: WebGL2RenderingContext | null): void {
    this.disposeHeatmapGpuRenderer();
    this.heatmapGpuFailureLatched = false;
    this.consecutiveSlowGpuFrames = 0;
    this.setGl(restoredGl);
    if (this.heatmapTexturePrototypeEnabled && this.supportsHeatmapGpu()) {
      void this.loadHeatmapGpuRenderer();
    }
  }

  onLostContext(): void {
    this.disposeHeatmapGpuRenderer();
    this.heatmapGpuFailureLatched = false;
    this.consecutiveSlowGpuFrames = 0;
  }
}

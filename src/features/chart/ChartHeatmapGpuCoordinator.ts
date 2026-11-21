import type { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type { HeatmapGpuRenderer, HeatmapGpuCellFrame } from "./heatmap/gpu/heatmapGpuRenderer.js";
import type { OrderbookHeatmapOverlay } from "../orderbook/heatmapOverlay.js";
import { recordGpuFeatureFallback, setGpuFeaturePath } from "../../core/gpu/gpuDiagnostics.js";

const HEATMAP_GPU_FEATURE = "orderbook-heatmap";

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
  private heatmapTexturePrototypeLastEnabled: boolean | null = null;
  private heatmapGpuRenderer: HeatmapGpuRenderer | null = null;
  private heatmapGpuRendererPromise: Promise<typeof import("./heatmap/gpu/heatmapGpuRenderer.js")> | null = null;
  private heatmapGpuRendererGl: WebGL2RenderingContext | null = null;
  private heatmapGpuFailureLatched = false;
  private heatmapGpuUnsupportedEpisode = false;
  private heatmapGpuFrame: HeatmapGpuRenderFrame | null = null;
  private heatmapGpuLease: { release(): void } | null = null;
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
    this._heatmapTexturePrototypeEnabled = enabled;
    if (enabled) {
      void this.loadHeatmapGpuRenderer();
    } else {
      this.heatmapGpuFrame = null;
      this.releaseHeatmapGpuLease();
      this.clearPreparedCache();
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
    }
    this.host.invalidateSession();
  }

  isHeatmapTexturePrototypeEnabled(): boolean {
    return this._heatmapTexturePrototypeEnabled;
  }

  setHeatmapTexturePrototypeEnabled(enabled: boolean): void {
    this.heatmapTexturePrototypeEnabled = enabled;
  }

  private supportsHeatmapGpu(): boolean {
    if (!this.heatmapTexturePrototypeEnabled) {
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
      return false;
    }
    if ((this.host.backendKind ?? "webgl2") !== "webgl2") {
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
      if (!this.heatmapGpuUnsupportedEpisode) {
        recordGpuFeatureFallback(HEATMAP_GPU_FEATURE, "backend_unsupported");
        this.heatmapGpuUnsupportedEpisode = true;
      }
      return false;
    }
    this.heatmapGpuUnsupportedEpisode = false;
    if (!this.heatmapGpuFrame) setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
    return true;
  }

  setResidentHeatmapEnabled(enabled: boolean): void {
    this.setHeatmapTexturePrototypeEnabled(enabled);
  }

  setGl(gl: WebGL2RenderingContext | null): void {
    if (this.heatmapGpuRendererGl !== gl) {
      this.heatmapGpuFrame = null;
      this.releaseHeatmapGpuLease();
      this.clearPreparedCache();
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
    }
    this.heatmapGpuRendererGl = gl;
  }

  resetFailureLatch(): void {
    this.heatmapGpuFailureLatched = false;
  }

  getFrame(): HeatmapGpuRenderFrame | null {
    return this.heatmapGpuFrame;
  }

  getLease(): { release(): void } | null {
    return this.heatmapGpuLease ?? this.cachedPrepareLease;
  }

  whenHeatmapGpuRendererReady(): Promise<void> {
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
    this.heatmapGpuFrame = null;
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
    if (!this.supportsHeatmapGpu() || this.heatmapGpuFailureLatched || !this.heatmapGpuRenderer) {
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
    const hasCacheKeyFn = typeof overlay.getPrepareCacheKey === "function";
    const cacheKey = hasCacheKeyFn ? overlay.getPrepareCacheKey(v, s, range) : null;
    if (hasCacheKeyFn && cacheKey === null) {
      this.clearPreparedCache();
      return null;
    }

    if (cacheKey !== null && cacheKey === this.cachedPrepareKey && this.cachedPrepareFrame) {
      return {
        ...this.cachedPrepareFrame,
        preparedLease: this.cachedPrepareHandle,
      };
    }

    this.clearPreparedCache();
    const gpuRenderer = this.heatmapGpuRenderer;
    const prepared = overlay.prepareGpuCells(
      v,
      s,
      range,
      (logicalBytes: number) => gpuRenderer.reservePreparedPayload(logicalBytes),
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
    if (!this.supportsHeatmapGpu()) {
      frame?.preparedLease?.release();
      return;
    }
    if (!frame) return;
    const gl = this.heatmapGpuRendererGl;
    if (!gl) {
      frame.preparedLease?.release();
      this.disposeHeatmapGpuRenderer();
      this.heatmapGpuFailureLatched = true;
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
      return;
    }
    if (!this.heatmapGpuRenderer) {
      frame.preparedLease?.release();
      return;
    }
    const range = this.host.renderer.visibleRange(v, s.length);
    let ok: boolean;
    try {
      ok = this.heatmapGpuRenderer.renderFrame(gl, frame, {
        left: v.area.left,
        top: v.area.top,
        width: v.area.width,
        height: v.area.height,
        ...(v.pixelRatio !== null && v.pixelRatio > 0 ? { pixelRatio: v.pixelRatio } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Heatmap GPU prototype budget exceeded") {
        frame.preparedLease?.release();
        return;
      }
      throw error;
    }
    if (!ok) {
      frame.preparedLease?.release();
      this.disposeHeatmapGpuRenderer();
      this.heatmapGpuRendererGl = gl;
      this.heatmapGpuFailureLatched = true;
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, "cpu");
      return;
    }
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
      seriesLength: s.length,
      rangeFrom: range[0],
      rangeTo: range[1],
    };
    this.heatmapGpuLease = frame.preparedLease && frame.preparedLease === this.cachedPrepareHandle
      ? null
      : (frame.preparedLease ?? null);
    setGpuFeaturePath(HEATMAP_GPU_FEATURE, "webgl2");
  }

  heatmapGpuSuppressedAnnotation(v: View, s: FootprintSeries, range: [number, number]): boolean {
    const claim = this.heatmapGpuFrame;
    if (!claim) return false;
    return claim.dataKey === this.host.orderbookHeatmap?.currentDataKey()
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
    setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
    this.releaseHeatmapGpuLease();
    this.clearPreparedCache();
    this.heatmapGpuRenderer?.dispose();
    this.heatmapGpuRenderer = null;
    this.heatmapGpuRendererGl = null;
  }

  dispose(): void {
    this.disposeHeatmapGpuRenderer();
  }

  onRestoreContext(restoredGl: WebGL2RenderingContext | null): void {
    this.disposeHeatmapGpuRenderer();
    this.heatmapGpuRendererGl = restoredGl;
    this.heatmapGpuFailureLatched = false;
    if (this.heatmapTexturePrototypeEnabled) void this.loadHeatmapGpuRenderer();
  }

  onLostContext(): void {
    this.disposeHeatmapGpuRenderer();
    this.heatmapGpuFailureLatched = false;
  }
}

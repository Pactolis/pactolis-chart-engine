import type { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type { HeatmapGpuRenderer, HeatmapGpuCellFrame } from "./heatmap/gpu/heatmapGpuRenderer.js";
import type { OrderbookHeatmapOverlay } from "../orderbook/heatmapOverlay.js";
import { recordGpuFeatureFallback, setGpuFeaturePath } from "../../core/gpu/gpuDiagnostics.js";

const HEATMAP_GPU_FEATURE = "orderbook-heatmap";

export interface HeatmapGpuRenderFrame {
  dataKey: string;
  threshold: number;
  ceiling: number;
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

  constructor(private readonly host: ChartHeatmapGpuCoordinatorHost) {}

  get heatmapTexturePrototypeEnabled(): boolean {
    return this._heatmapTexturePrototypeEnabled;
  }

  set heatmapTexturePrototypeEnabled(enabled: boolean) {
    this._heatmapTexturePrototypeEnabled = enabled;
    if (enabled) void this.loadHeatmapGpuRenderer();
    this.host.invalidateSession();
  }

  isHeatmapTexturePrototypeEnabled(): boolean {
    return this._heatmapTexturePrototypeEnabled;
  }

  setHeatmapTexturePrototypeEnabled(enabled: boolean): void {
    this.heatmapTexturePrototypeEnabled = enabled;
    if (!enabled) setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
  }

  private supportsHeatmapGpu(): boolean {
    if (!this.heatmapTexturePrototypeEnabled) {
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
      return false;
    }
    if ((this.host.backendKind ?? "webgl2") !== "webgl2") {
      setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
      if (!this.heatmapGpuUnsupportedEpisode) {
        recordGpuFeatureFallback(HEATMAP_GPU_FEATURE, "backend_unsupported");
        this.heatmapGpuUnsupportedEpisode = true;
      }
      return false;
    }
    this.heatmapGpuUnsupportedEpisode = false;
    return true;
  }

  setResidentHeatmapEnabled(enabled: boolean): void {
    this.setHeatmapTexturePrototypeEnabled(enabled);
  }

  setGl(gl: WebGL2RenderingContext | null): void {
    if (this.heatmapGpuRendererGl !== gl) {
      this.heatmapGpuFrame = null;
      this.releaseHeatmapGpuLease();
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
    return this.heatmapGpuLease;
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
    if (!this.supportsHeatmapGpu() || this.heatmapGpuFailureLatched || !this.heatmapGpuRenderer) return null;
    if (!this.host.orderbookHeatmap) return null;
    if (!(this.host.renderCoordinator?.getAnnotationLayerOrder() ?? []).includes("orderbook-heatmap")) return null;
    if (v.area.width <= 1 || v.area.height <= 1 || s.length === 0) return null;

    const gpuRenderer = this.heatmapGpuRenderer;
    return this.host.orderbookHeatmap.prepareGpuCells(
      v,
      s,
      this.host.renderer.visibleRange(v, s.length),
      (logicalBytes: number) => gpuRenderer.reservePreparedPayload(logicalBytes),
    );
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
      ceiling: frame.ceiling,
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
    this.heatmapGpuLease = frame.preparedLease ?? null;
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

  releaseHeatmapGpuLease(): void {
    const lease = this.heatmapGpuLease;
    this.heatmapGpuLease = null;
    lease?.release();
  }

  disposeHeatmapGpuRenderer(): void {
    this.heatmapGpuFrame = null;
    setGpuFeaturePath(HEATMAP_GPU_FEATURE, undefined);
    this.releaseHeatmapGpuLease();
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

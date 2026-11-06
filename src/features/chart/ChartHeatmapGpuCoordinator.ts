import type { View } from "../../core/engine/view.js";
import { recordGpuFeatureFallback, setGpuFeaturePath } from "../../core/gpu/gpuDiagnostics.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type { HeatmapGpuRenderer, HeatmapGpuCellFrame } from "./heatmap/gpu/heatmapGpuRenderer.js";
import type { OrderbookHeatmapOverlay } from "../orderbook/heatmapOverlay.js";

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
  readonly orderbookHeatmap: OrderbookHeatmapOverlay | null;
  readonly renderCoordinator?: { getAnnotationLayerOrder(): readonly string[] };
  readonly renderer: { visibleRange(view: View, seriesLength: number): [number, number] };
  invalidateSession(): void;
}

const RESIDENT_HEATMAP_FEATURE = "resident-heatmap";

/**
 * Coordinates GPU-accelerated orderbook heatmap texture lifecycle, preparation, rendering,
 * budget latching, and annotation suppression.
 *
 * The resident heatmap renderer only exists for WebGL2. On any other backend the heatmap stays on the
 * Canvas2D annotation path, and that is reported once through GPU diagnostics instead of preparing
 * cells that can never be drawn.
 */
export class ChartHeatmapGpuCoordinator {
  private _heatmapTexturePrototypeEnabled = false;
  private backendKind = "webgl2";
  private backendUnsupportedReported = false;
  private heatmapTexturePrototypeLastEnabled: boolean | null = null;
  private heatmapGpuRenderer: HeatmapGpuRenderer | null = null;
  private heatmapGpuRendererReady = false;
  private HeatmapGpuRendererClass: typeof HeatmapGpuRenderer | null = null;
  private heatmapGpuRendererLoading: Promise<void> | null = null;
  private heatmapGpuRendererGl: WebGL2RenderingContext | null = null;
  private heatmapGpuFailureLatched = false;
  private heatmapGpuFrame: HeatmapGpuRenderFrame | null = null;
  private heatmapGpuLease: { release(): void } | null = null;

  constructor(private readonly host: ChartHeatmapGpuCoordinatorHost) {}

  get heatmapTexturePrototypeEnabled(): boolean {
    return this._heatmapTexturePrototypeEnabled;
  }

  set heatmapTexturePrototypeEnabled(enabled: boolean) {
    this._heatmapTexturePrototypeEnabled = enabled;
    if (enabled) this.loadHeatmapGpuRenderer();
    else setGpuFeaturePath(RESIDENT_HEATMAP_FEATURE, null);
    this.backendUnsupportedReported = false;
    this.host.invalidateSession();
  }

  private loadHeatmapGpuRenderer(): void {
    if (this.backendKind !== "webgl2") return;
    if (this.heatmapGpuRendererReady || this.heatmapGpuRendererLoading) return;
    this.heatmapGpuRendererLoading = import("./heatmap/gpu/heatmapGpuRenderer.js").then(({ HeatmapGpuRenderer }) => {
      this.HeatmapGpuRendererClass = HeatmapGpuRenderer;
      this.heatmapGpuRendererReady = true;
      this.heatmapGpuRendererLoading = null;
      if (this._heatmapTexturePrototypeEnabled) this.host.invalidateSession();
    }).catch(() => {
      this.heatmapGpuRendererLoading = null;
      this.heatmapGpuFailureLatched = true;
    });
  }

  /**
   * Resolves once the lazily imported heatmap GPU renderer is available (after the session was invalidated
   * for it) or the load failed. Resolves immediately when the heatmap is disabled or already loaded.
   */
  whenHeatmapGpuRendererReady(): Promise<void> {
    if (!this._heatmapTexturePrototypeEnabled || this.heatmapGpuRendererReady) return Promise.resolve();
    this.loadHeatmapGpuRenderer();
    return this.heatmapGpuRendererLoading ?? Promise.resolve();
  }

  isHeatmapTexturePrototypeEnabled(): boolean {
    return this._heatmapTexturePrototypeEnabled;
  }

  setHeatmapTexturePrototypeEnabled(enabled: boolean): void {
    this.heatmapTexturePrototypeEnabled = enabled;
  }

  setResidentHeatmapEnabled(enabled: boolean): void {
    this.setHeatmapTexturePrototypeEnabled(enabled);
  }

  setGl(gl: WebGL2RenderingContext | null): void {
    this.heatmapGpuRendererGl = gl;
  }

  /** Tells the coordinator which backend draws the chart; only `webgl2` can host the resident heatmap. */
  setBackendKind(kind: string): void {
    if (this.backendKind === kind) return;
    this.backendKind = kind;
    this.backendUnsupportedReported = false;
    if (kind !== "webgl2") this.disposeHeatmapGpuRenderer();
    else if (this._heatmapTexturePrototypeEnabled) this.loadHeatmapGpuRenderer();
  }

  private reportBackendUnsupported(): void {
    if (this.backendUnsupportedReported) return;
    this.backendUnsupportedReported = true;
    recordGpuFeatureFallback(RESIDENT_HEATMAP_FEATURE, "canvas2d", "backend_unsupported");
    setGpuFeaturePath(RESIDENT_HEATMAP_FEATURE, "cpu");
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
    if (!this.heatmapTexturePrototypeEnabled) return null;
    if (this.backendKind !== "webgl2") {
      this.reportBackendUnsupported();
      return null;
    }
    if (this.heatmapGpuFailureLatched || !this.heatmapGpuRendererReady) return null;
    if (!this.host.orderbookHeatmap) return null;
    if (!(this.host.renderCoordinator?.getAnnotationLayerOrder() ?? []).includes("orderbook-heatmap")) return null;
    if (v.area.width <= 1 || v.area.height <= 1 || s.length === 0) return null;

    if (!this.heatmapGpuRenderer && this.HeatmapGpuRendererClass) this.heatmapGpuRenderer = new this.HeatmapGpuRendererClass();
    const gpuRenderer = this.heatmapGpuRenderer;
    if (!gpuRenderer) return null;
    return this.host.orderbookHeatmap.prepareGpuCells(
      v,
      s,
      this.host.renderer.visibleRange(v, s.length),
      (logicalBytes: number) => gpuRenderer.reservePreparedPayload(logicalBytes),
    );
  }

  renderHeatmapGpuCells(frame: HeatmapGpuCellFrame | null, v: View, s: FootprintSeries): void {
    if (!frame) return;
    const gl = this.heatmapGpuRendererGl;
    if (!gl) {
      frame.preparedLease?.release();
      this.disposeHeatmapGpuRenderer();
      this.heatmapGpuFailureLatched = true;
      setGpuFeaturePath(RESIDENT_HEATMAP_FEATURE, "cpu");
      return;
    }
    if (!this.heatmapGpuRenderer && this.HeatmapGpuRendererClass) this.heatmapGpuRenderer = new this.HeatmapGpuRendererClass();
    const gpuRenderer = this.heatmapGpuRenderer;
    if (!gpuRenderer) {
      frame.preparedLease?.release();
      return;
    }
    const range = this.host.renderer.visibleRange(v, s.length);
    let ok: boolean;
    try {
      ok = gpuRenderer.renderFrame(gl, frame, {
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
      setGpuFeaturePath(RESIDENT_HEATMAP_FEATURE, "cpu");
      return;
    }
    setGpuFeaturePath(RESIDENT_HEATMAP_FEATURE, "gpu");
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
  }

  onLostContext(): void {
    this.disposeHeatmapGpuRenderer();
    this.heatmapGpuFailureLatched = false;
  }
}

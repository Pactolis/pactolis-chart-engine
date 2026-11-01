import type { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import { HeatmapGpuRenderer, type HeatmapGpuCellFrame } from "./heatmap/gpu/heatmapGpuRenderer.js";
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

/**
 * Coordinates GPU-accelerated orderbook heatmap texture lifecycle, preparation, rendering,
 * budget latching, and annotation suppression.
 */
export class ChartHeatmapGpuCoordinator {
  private heatmapTexturePrototypeEnabled = false;
  private heatmapTexturePrototypeLastEnabled: boolean | null = null;
  private heatmapGpuRenderer: HeatmapGpuRenderer | null = null;
  private heatmapGpuRendererGl: WebGL2RenderingContext | null = null;
  private heatmapGpuFailureLatched = false;
  private heatmapGpuFrame: HeatmapGpuRenderFrame | null = null;
  private heatmapGpuLease: { release(): void } | null = null;

  constructor(private readonly host: ChartHeatmapGpuCoordinatorHost) {}

  isHeatmapTexturePrototypeEnabled(): boolean {
    return this.heatmapTexturePrototypeEnabled;
  }

  setHeatmapTexturePrototypeEnabled(enabled: boolean): void {
    this.heatmapTexturePrototypeEnabled = enabled;
    this.host.invalidateSession();
  }

  setResidentHeatmapEnabled(enabled: boolean): void {
    this.setHeatmapTexturePrototypeEnabled(enabled);
  }

  setGl(gl: WebGL2RenderingContext | null): void {
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
    if (!this.heatmapTexturePrototypeEnabled || this.heatmapGpuFailureLatched) return null;
    if (!this.host.orderbookHeatmap) return null;
    if (!(this.host.renderCoordinator?.getAnnotationLayerOrder() ?? []).includes("orderbook-heatmap")) return null;
    if (v.area.width <= 1 || v.area.height <= 1 || s.length === 0) return null;

    if (!this.heatmapGpuRenderer) this.heatmapGpuRenderer = new HeatmapGpuRenderer();
    const gpuRenderer = this.heatmapGpuRenderer;
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
      return;
    }
    if (!this.heatmapGpuRenderer) this.heatmapGpuRenderer = new HeatmapGpuRenderer();
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

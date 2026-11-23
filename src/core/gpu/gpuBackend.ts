import type { RGBA } from "../engine/gl.js";
import type { ChartArea } from "../engine/view.js";
import type { FootprintSeries } from "../model/footprint.js";

export type { RGBA };

export type GpuBackendKind = "webgpu" | "webgl2" | "canvas2d";

export type GpuNativeCandleStyle = "none" | "strip" | "full";
export type GpuNativeSceneLodMode = "standard" | "pixel-bucket" | "merged-cells";

export interface GpuNativeSceneView {
  readonly area: ChartArea;
  readonly offsetX: number;
  readonly colWidth: number;
  readonly priceTop: number;
  readonly pricePerPx: number;
  readonly candleWidth: number;
}

export interface NativeGlyphSink {
  addText(
    text: string,
    anchorX: number,
    yMid: number,
    fontSize: number,
    align: "left" | "center" | "right",
    colorPacked: number,
    clipArea: ChartArea,
  ): boolean;
}

export interface GpuNativeSceneInput {
  readonly series: FootprintSeries;
  readonly view: GpuNativeSceneView;
  readonly candleStyle: GpuNativeCandleStyle;
  readonly lodMode?: GpuNativeSceneLodMode;
  readonly drawGrid: boolean;
  readonly drawCandles: boolean;
  readonly drawFootprint: boolean;
  readonly drawHeat: boolean;
  readonly drawPoc: boolean;
  readonly drawGridQuads?: (quads: QuadSink) => void;
  readonly drawForegroundOverlay?: (quads: QuadSink) => void;
  readonly drawFootprintText?: (sink: NativeGlyphSink) => boolean;
}

export interface GpuNativeHeatmapRect {
  readonly x: number;
  readonly yTop: number;
  readonly width: number;
  readonly height: number;
  readonly value: number;
  readonly sourceMainIndex?: number;
}

export interface GpuNativeHeatmapFrame {
  readonly main: readonly GpuNativeHeatmapRect[];
  readonly extension: readonly GpuNativeHeatmapRect[];
  readonly ceiling: number;
  readonly threshold: number;
  readonly floor?: number;
  readonly opacity?: number;
  readonly dataKey: string;
  readonly preparedLease?: { release(): void };
}

export interface GpuNativeHeatmapPlot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio?: number;
}

export interface QuadSink {
  rect(x: number, y: number, w: number, h: number, c: RGBA): void;
}

export interface GpuFrame {
  readonly quads: QuadSink;
  flushQuads(logicalWidth?: number, logicalHeight?: number): void;
  end(): void;
}

export interface RgbaFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export type GpuLossReason =
  | "context-lost"
  | "context-restore-timeout"
  | "device-lost"
  | "create-failed"
  | "validation-failed"
  | "out-of-memory"
  | "internal-error";

export interface GpuSurface {
  readonly kind: GpuBackendKind;
  readonly canvas: HTMLCanvasElement;
  getGlContext?(): WebGL2RenderingContext | null;
  resize(bitmapWidth: number, bitmapHeight: number, dpr?: number): void;
  beginFrame(clear: RGBA): GpuFrame;
  supportsNativeScene?(): boolean;
  renderNativeScene?(clear: RGBA, logicalWidth: number, logicalHeight: number, scene: GpuNativeSceneInput): boolean;
  didLastNativeSceneRenderText?(): boolean;
  supportsNativeHeatmap?(): boolean;
  reserveNativeHeatmapPayload?(logicalBytes: number): { release(): void } | null;
  renderNativeHeatmap?(frame: GpuNativeHeatmapFrame, plot: GpuNativeHeatmapPlot): boolean;
  disposeNativeHeatmap?(): void;
  requestCapture(): Promise<RgbaFrame>;
  onLost(listener: (reason: GpuLossReason) => void): () => void;
  dispose(): void;
}

export interface GpuProbe {
  readonly supported: boolean;
  readonly reason?: string;
}

export interface GpuSurfaceInit {
  readonly canvas: HTMLCanvasElement;
  readonly options?: unknown;
}

export interface GpuBackend {
  readonly kind: GpuBackendKind;
  probe(win?: Window | null): GpuProbe | Promise<GpuProbe>;
  createSurface(init: GpuSurfaceInit): GpuSurface | Promise<GpuSurface>;
}

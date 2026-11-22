import type { RGBA } from "../engine/gl.js";
import type { ChartArea } from "../engine/view.js";
import type { FootprintSeries } from "../model/footprint.js";

export type { RGBA };

export type GpuBackendKind = "webgpu" | "webgl2" | "canvas2d";

export type GpuNativeCandleStyle = "none" | "strip" | "full";

export interface GpuNativeSceneView {
  readonly area: ChartArea;
  readonly offsetX: number;
  readonly colWidth: number;
  readonly priceTop: number;
  readonly pricePerPx: number;
  readonly candleWidth: number;
}

export interface GpuNativeSceneInput {
  readonly series: FootprintSeries;
  readonly view: GpuNativeSceneView;
  readonly candleStyle: GpuNativeCandleStyle;
  readonly drawGrid: boolean;
  readonly drawCandles: boolean;
  readonly drawFootprint: boolean;
  readonly drawHeat: boolean;
  readonly drawPoc: boolean;
  readonly drawGridQuads?: (quads: QuadSink) => void;
  readonly drawForegroundOverlay?: (quads: QuadSink) => void;
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

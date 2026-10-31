import type { RGBA } from "../engine/gl.js";

export type { RGBA };

export type GpuBackendKind = "webgpu" | "webgl2" | "canvas2d";

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
  | "validation-failed";

export interface HeatmapRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface HeatmapLayer {
  readonly kind: GpuBackendKind;
  upload(width: number, height: number, data: Uint8Array | Float32Array): void;
  draw(rect: { x: number; y: number; w: number; h: number }, opacity?: number): void;
  dispose(): void;
}

export interface GpuSurface {
  readonly kind: GpuBackendKind;
  readonly canvas: HTMLCanvasElement;
  readonly heatmap: HeatmapLayer | null;
  getGlContext?(): WebGL2RenderingContext | null;
  resize(bitmapWidth: number, bitmapHeight: number, dpr?: number): void;
  beginFrame(clear: RGBA): GpuFrame;
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

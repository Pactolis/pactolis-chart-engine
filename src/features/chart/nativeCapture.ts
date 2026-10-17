import type { ChartCaptureReadiness } from "./captureReadiness.js";

export const MAX_CAPTURE_WIDTH = 4096;
export const MAX_CAPTURE_HEIGHT = 4096;
export const MAX_CAPTURE_PIXELS = 16_777_216;
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/**
 * Production WebGL2 context attributes. Capture relies on reading the current
 * default framebuffer in the same render turn, so framebuffer persistence must
 * stay explicitly disabled rather than depending on the browser default.
 */
export const CHART_WEBGL_CONTEXT_ATTRIBUTES: WebGLContextAttributes = Object.freeze({
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: false,
});

export function getChartWebGl2Context(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  return canvas.getContext("webgl2", CHART_WEBGL_CONTEXT_ATTRIBUTES);
}

export type ChartCaptureErrorCode =
  | "CAPTURE_NOT_READY"
  | "CAPTURE_FAILED"
  | "IMAGE_TOO_LARGE"
  | "STATE_SUPERSEDED";

export class ChartCaptureError extends Error {
  readonly code: ChartCaptureErrorCode;

  constructor(code: ChartCaptureErrorCode, message: string) {
    super(message);
    this.name = "ChartCaptureError";
    this.code = code;
  }
}

export interface ChartCaptureStateToken {
  market: string;
  timeframe: string;
  selectionGeneration: number;
  priceStep: number;
  historyGeneration: number;
  canonicalRunKey: string;
  canonicalGeneration: number;
  canonicalRevision: number;
}

export interface NativeCaptureFrame {
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
}

export interface NativeChartCapture extends NativeCaptureFrame, ChartCaptureStateToken {}

export function createCaptureStateToken(readiness: ChartCaptureReadiness): ChartCaptureStateToken {
  const canonical = readiness.analysis.canonical;
  if (!readiness.ready || readiness.reason !== "READY" || canonical.status !== "complete" || canonical.revision == null || canonical.runKey == null) {
    throw new ChartCaptureError("CAPTURE_NOT_READY", `chart capture is not ready (${readiness.reason})`);
  }
  return {
    market: readiness.market,
    timeframe: readiness.timeframe,
    selectionGeneration: readiness.selectionGeneration,
    priceStep: readiness.priceStep,
    historyGeneration: readiness.history.generation,
    canonicalRunKey: canonical.runKey,
    canonicalGeneration: canonical.generation,
    canonicalRevision: canonical.revision,
  };
}

export function captureStateMatches(token: ChartCaptureStateToken, readiness: ChartCaptureReadiness): boolean {
  if (!readiness.ready || readiness.reason !== "READY") return false;
  const canonical = readiness.analysis.canonical;
  return canonical.status === "complete"
    && canonical.revision != null
    && readiness.market === token.market
    && readiness.timeframe === token.timeframe
    && readiness.selectionGeneration === token.selectionGeneration
    && readiness.priceStep === token.priceStep
    && readiness.history.generation === token.historyGeneration
    && canonical.runKey === token.canonicalRunKey
    && canonical.generation === token.canonicalGeneration
    && canonical.revision === token.canonicalRevision
    && readiness.renderedAnalysisMarket === token.market
    && readiness.renderedAnalysisRevision >= token.canonicalRevision;
}

export function validateCaptureDimensions(
  gpuWidth: number,
  gpuHeight: number,
  annotationWidth: number,
  annotationHeight: number,
): { width: number; height: number } {
  for (const value of [gpuWidth, gpuHeight, annotationWidth, annotationHeight]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ChartCaptureError("CAPTURE_FAILED", "capture surfaces must have positive integer bitmap dimensions");
    }
  }
  if (gpuWidth !== annotationWidth || gpuHeight !== annotationHeight) {
    throw new ChartCaptureError("CAPTURE_FAILED", "gpu and annotation bitmap dimensions do not match");
  }
  if (
    gpuWidth > MAX_CAPTURE_WIDTH
    || gpuHeight > MAX_CAPTURE_HEIGHT
    || gpuWidth * gpuHeight > MAX_CAPTURE_PIXELS
  ) {
    throw new ChartCaptureError("IMAGE_TOO_LARGE", "capture bitmap exceeds the bounded image dimensions");
  }
  return { width: gpuWidth, height: gpuHeight };
}

export function validateEncodedPngSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new ChartCaptureError("CAPTURE_FAILED", "encoded PNG size is invalid");
  }
  if (bytes > MAX_CAPTURE_BYTES) {
    throw new ChartCaptureError("IMAGE_TOO_LARGE", "encoded PNG exceeds the 8 MiB capture limit");
  }
}

export function flipRgbaRows(source: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const rowBytes = width * 4;
  const expected = rowBytes * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || source.byteLength !== expected) {
    throw new ChartCaptureError("CAPTURE_FAILED", "invalid WebGL RGBA capture buffer");
  }
  const output = new Uint8ClampedArray(expected);
  for (let sourceRow = 0; sourceRow < height; sourceRow++) {
    const targetRow = height - 1 - sourceRow;
    output.set(source.subarray(sourceRow * rowBytes, (sourceRow + 1) * rowBytes), targetRow * rowBytes);
  }
  return output;
}

export async function encodeGpuAndAnnotationPng(
  ownerDocument: Document,
  rgbaTopLeft: Uint8ClampedArray,
  width: number,
  height: number,
  annotationCanvas: HTMLCanvasElement,
): Promise<NativeCaptureFrame> {
  const scratch = ownerDocument.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext("2d");
  if (!ctx) throw new ChartCaptureError("CAPTURE_FAILED", "scratch Canvas2D context is unavailable");

  const image = ctx.createImageData(width, height);
  image.data.set(rgbaTopLeft);
  ctx.putImageData(image, 0, 0);
  // Deliberately compose annotation only. Interaction/crosshair/temp UI is excluded.
  ctx.drawImage(annotationCanvas, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    scratch.toBlob((value) => {
      if (value) resolve(value);
      else reject(new ChartCaptureError("CAPTURE_FAILED", "PNG encoder returned no data"));
    }, "image/png");
  });
  validateEncodedPngSize(blob.size);
  return { blob, width, height, bytes: blob.size };
}

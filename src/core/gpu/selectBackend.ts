import type { ChartWebGlOptions } from "../model/chartDisplayOptions.js";
import { Canvas2dSurface } from "./canvas2d/canvas2dSurface.js";
import { recordGpuBackendSelection, recordGpuContextEvent, recordGpuFallback } from "./gpuDiagnostics.js";
import type { GpuBackendPreference } from "./gpuSettings.js";
import type { GpuSurface } from "./gpuBackend.js";
import { WebGl2Surface } from "./webgl2/webgl2Surface.js";

export const DEFAULT_WEBGL2_ATTRIBUTES: WebGLContextAttributes = Object.freeze({
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: false,
});

export function resolveWebGlAttributes(options?: ChartWebGlOptions): WebGLContextAttributes {
  if (!options) return DEFAULT_WEBGL2_ATTRIBUTES;
  return Object.freeze({
    ...DEFAULT_WEBGL2_ATTRIBUTES,
    antialias: options.antialias,
    powerPreference: options.powerPreference,
  });
}

export function createGpuSurface(
  canvas: HTMLCanvasElement,
  preference: GpuBackendPreference = "webgl2",
  options?: ChartWebGlOptions,
): GpuSurface {
  if (preference === "canvas2d") {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("selectBackend: failed to acquire 2D rendering context");
    }
    recordGpuBackendSelection("canvas2d", "canvas2d");
    return new Canvas2dSurface(canvas, ctx);
  }

  // "auto", "webgl2", or experimental "webgpu" (Stage 1 falls back to WebGL2 first)
  const glAttrs = resolveWebGlAttributes(options);
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", glAttrs) as WebGL2RenderingContext | null;
  } catch (err) {
    console.warn("[selectBackend] WebGL2 context acquisition threw", err);
    gl = null;
  }

  if (gl) {
    recordGpuBackendSelection(preference, "webgl2");
    return new WebGl2Surface(canvas, gl);
  }

  // WebGL2 unavailable -> fallback to Canvas2D
  recordGpuFallback("webgl2", "canvas2d", "context_unavailable");
  recordGpuContextEvent("createFailed");

  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) {
    throw new Error("selectBackend: failed to acquire both WebGL2 and Canvas2D contexts");
  }

  recordGpuBackendSelection(preference, "canvas2d");
  return new Canvas2dSurface(canvas, ctx2d);
}

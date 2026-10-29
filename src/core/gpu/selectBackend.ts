import { Canvas2dSurface } from "./canvas2d/canvas2dSurface.js";
import { recordGpuBackendSelection, recordGpuContextEvent, recordGpuFallback } from "./gpuDiagnostics.js";
import type { GpuBackendPreference } from "./gpuSettings.js";
import type { GpuSurface } from "./gpuBackend.js";
import { WebGl2Surface } from "./webgl2/webgl2Surface.js";

export function createGpuSurface(
  canvas: HTMLCanvasElement,
  preference: GpuBackendPreference = "webgl2",
  providedGl?: WebGL2RenderingContext | null,
): GpuSurface {
  if (preference === "canvas2d") {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("selectBackend: failed to acquire 2D rendering context");
    }
    recordGpuBackendSelection("canvas2d", "canvas2d");
    return new Canvas2dSurface(canvas, ctx);
  }

  // "auto", "webgl2", or experimental "webgpu" (Stage 1 uses WebGL2 first)
  let gl = providedGl;
  if (gl === undefined) {
    try {
      gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    } catch {
      gl = null;
    }
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

import { Canvas2dSurface } from "./canvas2d/canvas2dSurface.js";
import {
  recordGpuBackendSelection,
  recordGpuContextEvent,
  recordGpuFallback,
  setGpuLimits,
} from "./gpuDiagnostics.js";
import type { GpuBackendPreference } from "./gpuSettings.js";
import type { GpuSurface } from "./gpuBackend.js";
import { WebGl2Surface } from "./webgl2/webgl2Surface.js";
import type { WebGpuDeviceHandle } from "./webgpu/webgpuDevice.js";
import type { ChartPowerPreference } from "../model/chartDisplayOptions.js";

export function createGpuSurface(
  canvas: HTMLCanvasElement,
  preference: GpuBackendPreference = "webgl2",
  providedGl?: WebGL2RenderingContext | null,
  webgpuHandle?: WebGpuDeviceHandle | null,
): GpuSurface {
  if (preference === "canvas2d") {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("selectBackend: failed to acquire 2D rendering context");
    }
    recordGpuBackendSelection("canvas2d", "canvas2d");
    return new Canvas2dSurface(canvas, ctx);
  }

  if (preference === "webgpu" && webgpuHandle && !webgpuHandle.isLost()) {
    let hasWebgpuContext = false;
    try {
      hasWebgpuContext = Boolean(canvas.getContext && canvas.getContext("webgpu"));
    } catch {
      hasWebgpuContext = false;
    }

    if (hasWebgpuContext) {
      if (webgpuHandle.limits) {
        setGpuLimits({
          maxBufferSize: webgpuHandle.limits.maxBufferSize,
          maxTextureDimension2D: webgpuHandle.limits.maxTextureDimension2D,
        });
      }
      const WebGpuSurfaceClass = (globalThis as any).__PactolisWebGpuSurface;
      if (WebGpuSurfaceClass) {
        recordGpuBackendSelection(preference, "webgpu");
        return new WebGpuSurfaceClass(canvas, webgpuHandle);
      }
    }
  }

  if (preference === "webgpu") {
    recordGpuFallback("webgpu", "webgl2", "device_unavailable");
  }

  // "auto", "webgl2", or fallback from webgpu
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
    throw new Error("selectBackend: failed to acquire WebGPU, WebGL2 and Canvas2D contexts");
  }

  recordGpuBackendSelection(preference, "canvas2d");
  return new Canvas2dSurface(canvas, ctx2d);
}

export async function createGpuSurfaceAsync(
  canvas: HTMLCanvasElement,
  preference: GpuBackendPreference = "webgl2",
  providedGl?: WebGL2RenderingContext | null,
  getWebGl2Context?: (canvas: HTMLCanvasElement) => WebGL2RenderingContext | null,
  options?: { powerPreference?: ChartPowerPreference },
): Promise<GpuSurface> {
  if (preference === "canvas2d") {
    return createGpuSurface(canvas, "canvas2d");
  }

  if (preference === "webgpu" || preference === "auto") {
    try {
      const [{ requestWebGpuDevice }, { WebGpuSurface }] = await Promise.all([
        import("./webgpu/webgpuDevice.js"),
        import("./webgpu/webgpuSurface.js"),
      ]);
      if (typeof globalThis !== "undefined") {
        (globalThis as any).__PactolisWebGpuSurface = WebGpuSurface;
      }
      const handle = await requestWebGpuDevice(
        options?.powerPreference ? { powerPreference: options.powerPreference } : undefined,
      );
      if (handle && !handle.isLost()) {
        const hasWebGpuContext = Boolean(canvas.getContext && canvas.getContext("webgpu"));
        if (hasWebGpuContext) {
          if (handle.limits) {
            setGpuLimits({
              maxBufferSize: handle.limits.maxBufferSize,
              maxTextureDimension2D: handle.limits.maxTextureDimension2D,
            });
          }
          recordGpuBackendSelection(preference, "webgpu");
          return new WebGpuSurface(canvas, handle);
        }
      }
    } catch {
      // ignore and proceed to WebGL2 fallback
    }
    if (preference === "webgpu") {
      recordGpuFallback("webgpu", "webgl2", "device_unavailable");
    }
  }

  let gl = providedGl;
  if (gl === undefined) {
    if (getWebGl2Context) {
      try {
        gl = getWebGl2Context(canvas);
      } catch {
        gl = null;
      }
    } else {
      try {
        gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
      } catch {
        gl = null;
      }
    }
  }

  if (gl) {
    recordGpuBackendSelection(preference, "webgl2");
    return new WebGl2Surface(canvas, gl);
  }

  recordGpuFallback("webgl2", "canvas2d", "context_unavailable");
  recordGpuContextEvent("createFailed");

  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) {
    throw new Error("selectBackend: failed to acquire WebGPU, WebGL2 and Canvas2D contexts");
  }

  recordGpuBackendSelection(preference, "canvas2d");
  return new Canvas2dSurface(canvas, ctx2d);
}

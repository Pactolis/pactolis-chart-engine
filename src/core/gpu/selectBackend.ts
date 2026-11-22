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

type PendingFallback = { from: string; to: string; reason: string };

function cleanupCanvas(canvas: HTMLCanvasElement, webgpuCtx?: any, removeFromDom = false): void {
  try {
    webgpuCtx?.unconfigure?.();
  } catch {
    // ignore mock or unconfigured WebGPU context
  }
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // ignore
  }
  if (removeFromDom) {
    try {
      canvas.remove?.();
    } catch {
      // ignore
    }
  }
}

function allocateReplacementCanvas(
  baseCanvas: HTMLCanvasElement,
  createCanvas?: () => HTMLCanvasElement,
): HTMLCanvasElement | null {
  try {
    if (createCanvas) {
      return createCanvas() ?? null;
    }
    return baseCanvas.ownerDocument?.createElement?.("canvas") ?? null;
  } catch {
    return null;
  }
}

function commitSelectionDiagnostics(
  preference: GpuBackendPreference,
  actualKind: "webgpu" | "webgl2" | "canvas2d",
  pendingFallbacks: readonly PendingFallback[],
  contextCreateFailed: boolean,
  pendingLimits?: { maxBufferSize: number; maxTextureDimension2D: number },
): void {
  for (const fb of pendingFallbacks) {
    recordGpuFallback(fb.from, fb.to, fb.reason);
  }
  if (contextCreateFailed) {
    recordGpuContextEvent("createFailed");
  }
  if (pendingLimits) {
    setGpuLimits(pendingLimits);
  }
  recordGpuBackendSelection(preference, actualKind);
}

export function createGpuSurface(
  canvas: HTMLCanvasElement,
  preference: GpuBackendPreference = "webgl2",
  providedGl?: WebGL2RenderingContext | null,
  webgpuHandle?: WebGpuDeviceHandle | null,
  options?: { createCanvas?: () => HTMLCanvasElement },
): GpuSurface {
  if (preference === "canvas2d") {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("selectBackend: failed to acquire 2D rendering context");
    }
    const surface = new Canvas2dSurface(canvas, ctx);
    recordGpuBackendSelection("canvas2d", "canvas2d");
    return surface;
  }

  let canvasLocked = false;
  const pendingFallbacks: PendingFallback[] = [];
  let contextCreateFailed = false;

  if (preference === "webgpu") {
    let webgpuAttemptedInit = false;
    if (webgpuHandle && !webgpuHandle.isLost()) {
      let webgpuCtx: any = null;
      try {
        webgpuCtx = canvas.getContext ? canvas.getContext("webgpu") : null;
      } catch {
        webgpuCtx = null;
      }

      if (webgpuCtx) {
        canvasLocked = true;
        const WebGpuSurfaceClass = (globalThis as any).__PactolisWebGpuSurface;
        if (WebGpuSurfaceClass) {
          webgpuAttemptedInit = true;
          try {
            const surface = new WebGpuSurfaceClass(canvas, webgpuHandle);
            const limits = webgpuHandle.limits
              ? {
                  maxBufferSize: webgpuHandle.limits.maxBufferSize,
                  maxTextureDimension2D: webgpuHandle.limits.maxTextureDimension2D,
                }
              : undefined;
            commitSelectionDiagnostics(preference, "webgpu", pendingFallbacks, false, limits);
            return surface;
          } catch {
            cleanupCanvas(canvas, webgpuCtx, false);
            pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: "surface_init_failed" });
          }
        }
      }
    }
    if (!webgpuAttemptedInit) {
      pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: "device_unavailable" });
    }
  }

  // Acquire WebGL2 on a fresh canvas if the original canvas was locked by WebGPU
  let webglCanvas: HTMLCanvasElement | null = canvas;
  if (canvasLocked) {
    webglCanvas = allocateReplacementCanvas(canvas, options?.createCanvas);
    canvasLocked = false;
  }

  if (webglCanvas) {
    let gl = webglCanvas === canvas ? providedGl : undefined;
    if (gl === undefined) {
      try {
        gl = webglCanvas.getContext("webgl2") as WebGL2RenderingContext | null;
      } catch {
        gl = null;
      }
    }

    if (gl) {
      canvasLocked = true;
      try {
        const surface = new WebGl2Surface(webglCanvas, gl);
        commitSelectionDiagnostics(preference, "webgl2", pendingFallbacks, false);
        return surface;
      } catch {
        cleanupCanvas(webglCanvas, undefined, webglCanvas !== canvas);
        pendingFallbacks.push({ from: "webgl2", to: "canvas2d", reason: "surface_init_failed" });
        contextCreateFailed = true;
      }
    } else {
      if (webglCanvas !== canvas) cleanupCanvas(webglCanvas, undefined, true);
      pendingFallbacks.push({ from: "webgl2", to: "canvas2d", reason: "context_unavailable" });
      contextCreateFailed = true;
    }
  } else {
    pendingFallbacks.push({ from: "webgl2", to: "canvas2d", reason: "context_unavailable" });
    contextCreateFailed = true;
  }

  // Fallback to Canvas2D on a fresh canvas if the current canvas was locked by WebGL2
  let c2dCanvas: HTMLCanvasElement | null = canvasLocked
    ? allocateReplacementCanvas(canvas, options?.createCanvas)
    : (webglCanvas === canvas ? canvas : allocateReplacementCanvas(canvas, options?.createCanvas));

  if (c2dCanvas) {
    let ctx2d: CanvasRenderingContext2D | null = null;
    try {
      ctx2d = c2dCanvas.getContext("2d") as CanvasRenderingContext2D | null;
    } catch {
      ctx2d = null;
    }
    if (!ctx2d && !canvasLocked && c2dCanvas === canvas) {
      const replacement = allocateReplacementCanvas(canvas, options?.createCanvas);
      if (replacement) {
        c2dCanvas = replacement;
        try {
          ctx2d = c2dCanvas.getContext("2d") as CanvasRenderingContext2D | null;
        } catch {
          ctx2d = null;
        }
      }
    }
    if (ctx2d) {
      try {
        const surface = new Canvas2dSurface(c2dCanvas, ctx2d);
        commitSelectionDiagnostics(preference, "canvas2d", pendingFallbacks, contextCreateFailed);
        return surface;
      } catch {
        if (c2dCanvas !== canvas) cleanupCanvas(c2dCanvas, undefined, true);
      }
    } else if (c2dCanvas !== canvas) {
      cleanupCanvas(c2dCanvas, undefined, true);
    }
  }

  throw new Error("selectBackend: failed to acquire WebGPU, WebGL2 and Canvas2D contexts");
}

export async function createGpuSurfaceAsync(
  canvas: HTMLCanvasElement,
  preference: GpuBackendPreference = "webgl2",
  providedGl?: WebGL2RenderingContext | null,
  getWebGl2Context?: (canvas: HTMLCanvasElement) => WebGL2RenderingContext | null,
  options?: { powerPreference?: ChartPowerPreference; createCanvas?: () => HTMLCanvasElement },
): Promise<GpuSurface> {
  if (preference === "canvas2d") {
    return createGpuSurface(canvas, "canvas2d", undefined, undefined, options);
  }

  let canvasLocked = false;
  const pendingFallbacks: PendingFallback[] = [];
  let contextCreateFailed = false;

  if (preference === "webgpu" || preference === "auto") {
    let deviceFallbackReason: string | null = null;
    let webgpuSurfaceInitFailed = false;
    let webgpuCtx: any = null;
    let createdSurface: GpuSurface | null = null;

    try {
      const [{ requestWebGpuDevice }, { WebGpuSurface }] = await Promise.all([
        import("./webgpu/webgpuDevice.js"),
        import("./webgpu/webgpuSurface.js"),
      ]);
      if (typeof globalThis !== "undefined") {
        (globalThis as any).__PactolisWebGpuSurface = WebGpuSurface;
      }
      const handle = await requestWebGpuDevice({
        ...(options?.powerPreference ? { powerPreference: options.powerPreference } : {}),
        onFallback: (reason) => {
          deviceFallbackReason = reason;
        },
      });
      if (handle && !handle.isLost()) {
        try {
          webgpuCtx = canvas.getContext ? canvas.getContext("webgpu") : null;
        } catch {
          webgpuCtx = null;
        }
        if (webgpuCtx) {
          canvasLocked = true;
          createdSurface = new WebGpuSurface(canvas, handle);
          await (createdSurface as { verifyInit?: () => Promise<void> }).verifyInit?.();
          const limits = handle.limits
            ? {
                maxBufferSize: handle.limits.maxBufferSize,
                maxTextureDimension2D: handle.limits.maxTextureDimension2D,
              }
            : undefined;
          commitSelectionDiagnostics(preference, "webgpu", pendingFallbacks, false, limits);
          return createdSurface;
        }
      }
    } catch {
      if (createdSurface) {
        try { createdSurface.dispose(); } catch {}
        createdSurface = null;
      }
      if (canvasLocked) {
        webgpuSurfaceInitFailed = true;
        cleanupCanvas(canvas, webgpuCtx, false);
      }
    }

    if (webgpuSurfaceInitFailed) {
      pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: "surface_init_failed" });
    } else if (deviceFallbackReason) {
      pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: deviceFallbackReason });
    } else if (preference === "webgpu") {
      pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: "device_unavailable" });
    }
  }

  let webglCanvas: HTMLCanvasElement | null = canvas;
  if (canvasLocked) {
    webglCanvas = allocateReplacementCanvas(canvas, options?.createCanvas);
    canvasLocked = false;
  }

  if (webglCanvas) {
    let gl = webglCanvas === canvas ? providedGl : undefined;
    if (gl === undefined) {
      if (getWebGl2Context) {
        try {
          gl = getWebGl2Context(webglCanvas);
        } catch {
          gl = null;
        }
      } else {
        try {
          gl = webglCanvas.getContext("webgl2") as WebGL2RenderingContext | null;
        } catch {
          gl = null;
        }
      }
    }

    if (gl) {
      canvasLocked = true;
      try {
        const surface = new WebGl2Surface(webglCanvas, gl);
        commitSelectionDiagnostics(preference, "webgl2", pendingFallbacks, false);
        return surface;
      } catch {
        cleanupCanvas(webglCanvas, undefined, webglCanvas !== canvas);
        pendingFallbacks.push({ from: "webgl2", to: "canvas2d", reason: "surface_init_failed" });
        contextCreateFailed = true;
      }
    } else {
      if (webglCanvas !== canvas) cleanupCanvas(webglCanvas, undefined, true);
      pendingFallbacks.push({ from: "webgl2", to: "canvas2d", reason: "context_unavailable" });
      contextCreateFailed = true;
    }
  } else {
    pendingFallbacks.push({ from: "webgl2", to: "canvas2d", reason: "context_unavailable" });
    contextCreateFailed = true;
  }

  let c2dCanvas: HTMLCanvasElement | null = canvasLocked
    ? allocateReplacementCanvas(canvas, options?.createCanvas)
    : (webglCanvas === canvas ? canvas : allocateReplacementCanvas(canvas, options?.createCanvas));

  if (c2dCanvas) {
    let ctx2d: CanvasRenderingContext2D | null = null;
    try {
      ctx2d = c2dCanvas.getContext("2d") as CanvasRenderingContext2D | null;
    } catch {
      ctx2d = null;
    }
    if (!ctx2d && !canvasLocked && c2dCanvas === canvas) {
      const replacement = allocateReplacementCanvas(canvas, options?.createCanvas);
      if (replacement) {
        c2dCanvas = replacement;
        try {
          ctx2d = c2dCanvas.getContext("2d") as CanvasRenderingContext2D | null;
        } catch {
          ctx2d = null;
        }
      }
    }
    if (ctx2d) {
      try {
        const surface = new Canvas2dSurface(c2dCanvas, ctx2d);
        commitSelectionDiagnostics(preference, "canvas2d", pendingFallbacks, contextCreateFailed);
        return surface;
      } catch {
        if (c2dCanvas !== canvas) cleanupCanvas(c2dCanvas, undefined, true);
      }
    } else if (c2dCanvas !== canvas) {
      cleanupCanvas(c2dCanvas, undefined, true);
    }
  }

  throw new Error("selectBackend: failed to acquire WebGPU, WebGL2 and Canvas2D contexts");
}

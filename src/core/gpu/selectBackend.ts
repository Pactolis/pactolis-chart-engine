import { Canvas2dSurface } from "./canvas2d/canvas2dSurface.js";
import {
  getCanvasOwnerDocument,
  isOffscreenCanvas,
  type Canvas2dContext,
  type CanvasTarget,
} from "./canvasTarget.js";
import {
  recordGpuBackendSelection,
  recordGpuContextEvent,
  recordGpuFallback,
  setGpuAdapterInfo,
  setGpuLimits,
  setGpuSelectionDecision,
  type GpuAdapterInfo,
} from "./gpuDiagnostics.js";
import {
  readGpuSettings,
  type GpuBackendPreference,
  type WebGpuRolloutMode,
} from "./gpuSettings.js";
import type { GpuSurface } from "./gpuBackend.js";
import { WebGl2Surface } from "./webgl2/webgl2Surface.js";
import type { WebGpuDeviceHandle, WebGpuLimits } from "./webgpu/webgpuDevice.js";
import type { ChartPowerPreference } from "../model/chartDisplayOptions.js";

type PendingFallback = { from: string; to: string; reason: string };

export const MIN_WEBGPU_MAX_BUFFER_SIZE = 64 * 1024 * 1024;
export const MIN_WEBGPU_MAX_TEXTURE_DIMENSION_2D = 4096;

export const SOFTWARE_ADAPTER_PATTERNS = [
  "swiftshader",
  "microsoft basic render",
  "llvmpipe",
  "lavapipe",
] as const;

export function isSoftwareRendererName(renderer: string | null | undefined): boolean {
  if (!renderer) return false;
  const lower = renderer.toLowerCase();
  return SOFTWARE_ADAPTER_PATTERNS.some((pattern) => lower.includes(pattern));
}

export interface WebGpuQualificationOptions {
  readonly preference?: GpuBackendPreference;
  readonly webgpuRollout?: WebGpuRolloutMode;
  readonly webgpuKillSwitch?: boolean;
}

export interface WebGpuQualificationResult {
  readonly qualified: boolean;
  readonly selectionReason: string;
  readonly fallbackReason?: string;
}

type SessionWebGpuDecision =
  | { kind: "qualified"; selectionReason: string }
  | { kind: "fallback"; reason: string };

let sessionWebGpuDecision: SessionWebGpuDecision | null = null;
let clearWebGpuFatalReasonFn: (() => void) | null = null;

function isSoftwareOrFallbackAdapter(adapterInfo?: GpuAdapterInfo): boolean {
  if (!adapterInfo) return false;
  if (adapterInfo.isFallbackAdapter === true) return true;
  const text = [
    adapterInfo.vendor,
    adapterInfo.architecture,
    adapterInfo.description,
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
  if (!text) return false;
  return isSoftwareRendererName(text);
}

function hasSufficientLimits(
  limits?: Partial<WebGpuLimits> | Record<string, number>,
): boolean {
  if (!limits) return false;
  const maxBufferSize = limits.maxBufferSize;
  const maxTextureDimension2D = limits.maxTextureDimension2D;
  return (
    typeof maxBufferSize === "number" &&
    Number.isFinite(maxBufferSize) &&
    maxBufferSize >= MIN_WEBGPU_MAX_BUFFER_SIZE &&
    typeof maxTextureDimension2D === "number" &&
    Number.isFinite(maxTextureDimension2D) &&
    maxTextureDimension2D >= MIN_WEBGPU_MAX_TEXTURE_DIMENSION_2D
  );
}

/**
 * Conservatively evaluates whether WebGPU should be used for the current
 * preference, rollout/kill-switch policy, adapter info, and device limits.
 */
export function evaluateWebGpuQualification(
  adapterInfo: GpuAdapterInfo | undefined,
  limits: Partial<WebGpuLimits> | Record<string, number> | undefined,
  options?: WebGpuQualificationOptions,
): WebGpuQualificationResult {
  const preference = options?.preference ?? "auto";
  if (preference === "webgl2") {
    return { qualified: false, selectionReason: "user_forced_webgl2" };
  }
  if (preference === "canvas2d") {
    return { qualified: false, selectionReason: "user_forced_canvas2d" };
  }
  if (
    options?.webgpuKillSwitch === true ||
    (preference === "auto" && options?.webgpuRollout === "off")
  ) {
    return {
      qualified: false,
      selectionReason: "kill_switch",
      fallbackReason: "kill_switch",
    };
  }
  if (preference === "webgpu") {
    return { qualified: true, selectionReason: "user_forced_webgpu" };
  }
  if (isSoftwareOrFallbackAdapter(adapterInfo)) {
    return {
      qualified: false,
      selectionReason: "fallback_adapter_rejected",
      fallbackReason: "fallback_adapter_rejected",
    };
  }
  if (!hasSufficientLimits(limits)) {
    return {
      qualified: false,
      selectionReason: "insufficient_limits",
      fallbackReason: "insufficient_limits",
    };
  }
  return { qualified: true, selectionReason: "qualified_hardware" };
}

/**
 * Pins the current session to WebGL2/Canvas2D fallback after qualification
 * rejection or fatal runtime device-loss/OOM so subsequent panels do not
 * repeatedly probe or recreate WebGPU canvases.
 */
export function latchWebGpuSessionFallback(reason: string): void {
  const normalized = reason && reason.trim().length > 0 ? reason : "device_lost";
  sessionWebGpuDecision = { kind: "fallback", reason: normalized };
  setGpuSelectionDecision({
    selectionReason: normalized,
    nativeWebGpuActive: false,
    nativeWebGpuDisabledReason: normalized,
  });
}

export function resetWebGpuSessionDecisionForTest(): void {
  sessionWebGpuDecision = null;
  clearWebGpuFatalReasonFn?.();
}

function cleanupCanvas(canvas: CanvasTarget, webgpuCtx?: any, removeFromDom = false): void {
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
  if (!isOffscreenCanvas(canvas) && removeFromDom) {
    try {
      canvas.remove?.();
    } catch {
      // ignore
    }
  }
}

function allocateReplacementCanvas(
  baseCanvas: CanvasTarget,
  createCanvas?: () => CanvasTarget,
): CanvasTarget | null {
  try {
    if (createCanvas) {
      return createCanvas() ?? null;
    }
    const ownerDoc = getCanvasOwnerDocument(baseCanvas);
    if (ownerDoc && typeof ownerDoc.createElement === "function") {
      return ownerDoc.createElement("canvas");
    }
    if (isOffscreenCanvas(baseCanvas) && typeof OffscreenCanvas === "function") {
      return new OffscreenCanvas(Math.max(1, baseCanvas.width || 1), Math.max(1, baseCanvas.height || 1));
    }
    return null;
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
  selectionReason?: string,
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
  if (selectionReason !== undefined) {
    setGpuSelectionDecision({
      selectionReason,
      nativeWebGpuActive: actualKind === "webgpu",
      nativeWebGpuDisabledReason: actualKind === "webgpu" ? undefined : selectionReason,
    });
  }
}

export function createGpuSurface(
  canvas: CanvasTarget,
  preference: GpuBackendPreference = "webgl2",
  providedGl?: WebGL2RenderingContext | null,
  webgpuHandle?: WebGpuDeviceHandle | null,
  options?: { createCanvas?: () => CanvasTarget },
): GpuSurface {
  if (preference === "canvas2d") {
    const ctx = canvas.getContext("2d") as Canvas2dContext | null;
    if (!ctx) {
      throw new Error("selectBackend: failed to acquire 2D rendering context");
    }
    const surface = new Canvas2dSurface(canvas, ctx);
    recordGpuBackendSelection("canvas2d", "canvas2d");
    setGpuSelectionDecision({
      selectionReason: "user_forced_canvas2d",
      nativeWebGpuActive: false,
      nativeWebGpuDisabledReason: "user_forced_canvas2d",
    });
    return surface;
  }

  let canvasLocked = false;
  const pendingFallbacks: PendingFallback[] = [];
  let contextCreateFailed = false;
  let resolvedSelectionReason =
    preference === "webgl2"
      ? "user_forced_webgl2"
      : preference === "auto"
        ? (sessionWebGpuDecision?.kind === "fallback" ? sessionWebGpuDecision.reason : "webgpu_unsupported")
        : "device_unavailable";

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
            if (webgpuHandle.adapterInfo) {
              setGpuAdapterInfo(webgpuHandle.adapterInfo);
            }
            commitSelectionDiagnostics(preference, "webgpu", pendingFallbacks, false, limits, "user_forced_webgpu");
            return surface;
          } catch {
            cleanupCanvas(canvas, webgpuCtx, false);
            pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: "surface_init_failed" });
            resolvedSelectionReason = "surface_init_failed";
          }
        }
      }
    }
    if (!webgpuAttemptedInit) {
      pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: "device_unavailable" });
      resolvedSelectionReason = "device_unavailable";
    }
  }

  // Acquire WebGL2 on a fresh canvas if the original canvas was locked by WebGPU
  let webglCanvas: CanvasTarget | null = canvas;
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
        commitSelectionDiagnostics(preference, "webgl2", pendingFallbacks, false, undefined, resolvedSelectionReason);
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
  let c2dCanvas: CanvasTarget | null = canvasLocked
    ? allocateReplacementCanvas(canvas, options?.createCanvas)
    : (webglCanvas === canvas ? canvas : allocateReplacementCanvas(canvas, options?.createCanvas));

  if (c2dCanvas) {
    let ctx2d: Canvas2dContext | null = null;
    try {
      ctx2d = c2dCanvas.getContext("2d") as Canvas2dContext | null;
    } catch {
      ctx2d = null;
    }
    if (!ctx2d && !canvasLocked && c2dCanvas === canvas) {
      const replacement = allocateReplacementCanvas(canvas, options?.createCanvas);
      if (replacement) {
        c2dCanvas = replacement;
        try {
          ctx2d = c2dCanvas.getContext("2d") as Canvas2dContext | null;
        } catch {
          ctx2d = null;
        }
      }
    }
    if (ctx2d) {
      try {
        const surface = new Canvas2dSurface(c2dCanvas, ctx2d);
        commitSelectionDiagnostics(preference, "canvas2d", pendingFallbacks, contextCreateFailed, undefined, resolvedSelectionReason);
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
  canvas: CanvasTarget,
  preference: GpuBackendPreference = "webgl2",
  providedGl?: WebGL2RenderingContext | null,
  getWebGl2Context?: (canvas: CanvasTarget) => WebGL2RenderingContext | null,
  options?: {
    powerPreference?: ChartPowerPreference;
    createCanvas?: () => CanvasTarget;
    webgpuRollout?: WebGpuRolloutMode;
    webgpuKillSwitch?: boolean;
  },
): Promise<GpuSurface> {
  if (preference === "canvas2d") {
    return createGpuSurface(canvas, "canvas2d", undefined, undefined, options);
  }

  let canvasLocked = false;
  const pendingFallbacks: PendingFallback[] = [];
  let contextCreateFailed = false;
  let resolvedSelectionReason =
    preference === "webgl2" ? "user_forced_webgl2" : "device_unavailable";

  if (preference === "webgpu" || preference === "auto") {
    const currentSettings = readGpuSettings();
    const effectiveRollout = options?.webgpuRollout ?? currentSettings.webgpuRollout;
    const effectiveKillSwitch = options?.webgpuKillSwitch ?? currentSettings.webgpuKillSwitch;

    if (
      effectiveKillSwitch === true ||
      (preference === "auto" && effectiveRollout === "off")
    ) {
      pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: "kill_switch" });
      resolvedSelectionReason = "kill_switch";
    } else if (preference === "auto" && sessionWebGpuDecision?.kind === "fallback") {
      pendingFallbacks.push({
        from: "webgpu",
        to: "webgl2",
        reason: sessionWebGpuDecision.reason,
      });
      resolvedSelectionReason = sessionWebGpuDecision.reason;
    } else {
      let deviceFallbackReason: string | null = null;
      let webgpuSurfaceInitFailed = false;
      let qualificationRejected = false;
      let webgpuCtx: any = null;
      let createdSurface: GpuSurface | null = null;

      try {
        const [deviceMod, { WebGpuSurface }] = await Promise.all([
          import("./webgpu/webgpuDevice.js"),
          import("./webgpu/webgpuSurface.js"),
        ]);
        clearWebGpuFatalReasonFn = deviceMod.clearWebGpuFatalReasonForTest;
        deviceMod.registerWebGpuSessionHandlers({
          onFatal: latchWebGpuSessionFallback,
          onReset: () => {
            sessionWebGpuDecision = null;
          },
        });

        const fatalReason = deviceMod.getWebGpuFatalReason();
        if (preference === "auto" && fatalReason !== null) {
          latchWebGpuSessionFallback(fatalReason);
          pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: fatalReason });
          resolvedSelectionReason = fatalReason;
          qualificationRejected = true;
        } else {
          if (typeof globalThis !== "undefined") {
            (globalThis as any).__PactolisWebGpuSurface = WebGpuSurface;
          }
          const handle = await deviceMod.requestWebGpuDevice({
            ...(options?.powerPreference ? { powerPreference: options.powerPreference } : {}),
            onFallback: (reason) => {
              deviceFallbackReason = reason;
            },
          });

          if (handle && !handle.isLost()) {
            const limits = handle.limits
              ? {
                  maxBufferSize: handle.limits.maxBufferSize,
                  maxTextureDimension2D: handle.limits.maxTextureDimension2D,
                }
              : undefined;
            if (handle.adapterInfo) {
              setGpuAdapterInfo(handle.adapterInfo);
            }
            if (limits) {
              setGpuLimits(limits);
            }

            let allowWebGpu = true;
            if (preference === "auto") {
              if (sessionWebGpuDecision?.kind === "qualified") {
                resolvedSelectionReason = sessionWebGpuDecision.selectionReason;
              } else {
                const qual = evaluateWebGpuQualification(handle.adapterInfo, handle.limits, {
                  preference,
                  webgpuRollout: effectiveRollout,
                  webgpuKillSwitch: effectiveKillSwitch,
                });
                if (!qual.qualified) {
                  const fbReason = qual.fallbackReason ?? qual.selectionReason;
                  latchWebGpuSessionFallback(fbReason);
                  pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: fbReason });
                  resolvedSelectionReason = qual.selectionReason;
                  qualificationRejected = true;
                  allowWebGpu = false;
                } else {
                  sessionWebGpuDecision = {
                    kind: "qualified",
                    selectionReason: qual.selectionReason,
                  };
                  resolvedSelectionReason = qual.selectionReason;
                }
              }
            } else {
              resolvedSelectionReason = "user_forced_webgpu";
            }

            if (allowWebGpu) {
              try {
                webgpuCtx = canvas.getContext ? canvas.getContext("webgpu") : null;
              } catch {
                webgpuCtx = null;
              }
              if (webgpuCtx) {
                canvasLocked = true;
                createdSurface = new WebGpuSurface(canvas, handle);
                await (createdSurface as { verifyInit?: () => Promise<void> }).verifyInit?.();
                commitSelectionDiagnostics(
                  preference,
                  "webgpu",
                  pendingFallbacks,
                  false,
                  limits,
                  resolvedSelectionReason,
                );
                return createdSurface;
              }
            }
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

      if (!qualificationRejected) {
        if (webgpuSurfaceInitFailed) {
          if (preference === "auto") {
            latchWebGpuSessionFallback("surface_init_failed");
          }
          pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: "surface_init_failed" });
          resolvedSelectionReason = "surface_init_failed";
        } else if (deviceFallbackReason) {
          pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: deviceFallbackReason });
          resolvedSelectionReason = deviceFallbackReason;
        } else {
          pendingFallbacks.push({ from: "webgpu", to: "webgl2", reason: "device_unavailable" });
          resolvedSelectionReason = "device_unavailable";
        }
      }
    }
  }

  let webglCanvas: CanvasTarget | null = canvas;
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
        commitSelectionDiagnostics(
          preference,
          "webgl2",
          pendingFallbacks,
          false,
          undefined,
          resolvedSelectionReason,
        );
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

  let c2dCanvas: CanvasTarget | null = canvasLocked
    ? allocateReplacementCanvas(canvas, options?.createCanvas)
    : (webglCanvas === canvas ? canvas : allocateReplacementCanvas(canvas, options?.createCanvas));

  if (c2dCanvas) {
    let ctx2d: Canvas2dContext | null = null;
    try {
      ctx2d = c2dCanvas.getContext("2d") as Canvas2dContext | null;
    } catch {
      ctx2d = null;
    }
    if (!ctx2d && !canvasLocked && c2dCanvas === canvas) {
      const replacement = allocateReplacementCanvas(canvas, options?.createCanvas);
      if (replacement) {
        c2dCanvas = replacement;
        try {
          ctx2d = c2dCanvas.getContext("2d") as Canvas2dContext | null;
        } catch {
          ctx2d = null;
        }
      }
    }
    if (ctx2d) {
      try {
        const surface = new Canvas2dSurface(c2dCanvas, ctx2d);
        commitSelectionDiagnostics(
          preference,
          "canvas2d",
          pendingFallbacks,
          contextCreateFailed,
          undefined,
          resolvedSelectionReason,
        );
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

/**
 * OffscreenCanvas capability probing and single-transfer ownership manager
 * for the 3-surface chart rendering stack (gpu-scene, annotation, interaction).
 */

import type { WorkerSurfaceDescriptor, WorkerSurfaceRole } from "./workerProtocol.js";

export interface TransferableCanvasLike {
  width: number;
  height: number;
  style?: {
    zIndex?: string;
    [key: string]: unknown;
  };
  transferControlToOffscreen?: () => OffscreenCanvas;
}

export interface OffscreenCanvasCapabilities {
  hasOffscreenCanvas: boolean;
  hasTransferControlToOffscreen: boolean;
  hasWebGPU: boolean;
  hasWebGL2: boolean;
  has2D: boolean;
  supported: boolean;
  recommendedMode: "worker-offscreen" | "main-thread";
  preferredGpuBackend: "webgpu" | "webgl2" | "2d" | "none";
  fallbackReason?: string;
}

export interface SurfaceDimensions {
  width: number;
  height: number;
  dpr: number;
}

export interface ManagedSurfaceEntry {
  role: WorkerSurfaceRole;
  zIndex: number;
  canvas: TransferableCanvasLike;
  offscreen: OffscreenCanvas | null;
  width: number;
  height: number;
  dpr: number;
  generation: number;
}

export interface SurfaceCompositingMetadata extends WorkerSurfaceDescriptor {
  transferred: boolean;
  generation: number;
}

export const SURFACE_LAYER_Z_ORDER: Readonly<Record<WorkerSurfaceRole, number>> = {
  "gpu-scene": 0,
  annotation: 1,
  interaction: 2,
};

export const ORDERED_SURFACE_ROLES: readonly WorkerSurfaceRole[] = [
  "gpu-scene",
  "annotation",
  "interaction",
];

/**
 * Probes runtime support for OffscreenCanvas, transferControlToOffscreen,
 * and rendering contexts (WebGPU / WebGL2 / 2D), returning a deterministic
 * fallback recommendation when worker offscreen rendering is unavailable.
 */
export function probeOffscreenCanvasCapabilities(
  sampleCanvas?: TransferableCanvasLike | null,
): OffscreenCanvasCapabilities {
  const hasOffscreenCanvas = typeof OffscreenCanvas === "function";

  let hasTransferControlToOffscreen = false;
  if (sampleCanvas) {
    hasTransferControlToOffscreen = typeof sampleCanvas.transferControlToOffscreen === "function";
  } else if (typeof HTMLCanvasElement !== "undefined") {
    hasTransferControlToOffscreen =
      typeof HTMLCanvasElement.prototype?.transferControlToOffscreen === "function";
  }

  const nav = typeof navigator !== "undefined" ? (navigator as { gpu?: unknown }) : undefined;
  const hasWebGPU = Boolean(nav && typeof nav.gpu !== "undefined" && nav.gpu !== null);

  let hasWebGL2 = false;
  let has2D = false;
  if (hasOffscreenCanvas) {
    try {
      const probe = new OffscreenCanvas(1, 1);
      hasWebGL2 = probe.getContext("webgl2") !== null;
    } catch {
      hasWebGL2 = false;
    }
    try {
      const probe = new OffscreenCanvas(1, 1);
      has2D = probe.getContext("2d") !== null;
    } catch {
      has2D = false;
    }
  }

  const hasAnyContext = hasWebGPU || hasWebGL2 || has2D;
  const supported = hasOffscreenCanvas && hasTransferControlToOffscreen && hasAnyContext;

  const preferredGpuBackend: OffscreenCanvasCapabilities["preferredGpuBackend"] = hasWebGPU
    ? "webgpu"
    : hasWebGL2
      ? "webgl2"
      : has2D
        ? "2d"
        : "none";

  let fallbackReason: string | undefined;
  if (!hasOffscreenCanvas) {
    fallbackReason = "OffscreenCanvas constructor is unavailable in this environment";
  } else if (!hasTransferControlToOffscreen) {
    fallbackReason = "transferControlToOffscreen is unavailable on canvas elements";
  } else if (!hasAnyContext) {
    fallbackReason = "No supported rendering context (WebGPU, WebGL2, or 2D) on OffscreenCanvas";
  }

  return {
    hasOffscreenCanvas,
    hasTransferControlToOffscreen,
    hasWebGPU,
    hasWebGL2,
    has2D,
    supported,
    recommendedMode: supported ? "worker-offscreen" : "main-thread",
    preferredGpuBackend,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

export type CanvasNodeFactory = (role: WorkerSurfaceRole, zIndex: number) => TransferableCanvasLike;

/**
 * Enforces the browser single-transfer rule (`transferControlToOffscreen()` can
 * only be called once per DOM `<canvas>`) using a `WeakSet<object>` and manages
 * 3-surface Z-order compositing metadata plus canvas-node recreation during
 * worker recovery, context loss, or popout re-homing.
 */
export class OffscreenCanvasOwnershipManager {
  private readonly transferredCanvases = new WeakSet<object>();
  private readonly surfaces = new Map<WorkerSurfaceRole, ManagedSurfaceEntry>();
  private generation = 0;
  private disposed = false;

  get currentGeneration(): number {
    return this.generation;
  }

  hasTransferred(canvas: object): boolean {
    return this.transferredCanvases.has(canvas);
  }

  registerMainThreadSurface(
    role: WorkerSurfaceRole,
    canvas: TransferableCanvasLike,
    dimensions: SurfaceDimensions,
  ): ManagedSurfaceEntry {
    this.assertNotDisposed();
    const zIndex = SURFACE_LAYER_Z_ORDER[role];
    this.applyZOrderMetadata(canvas, zIndex);
    const entry: ManagedSurfaceEntry = {
      role,
      zIndex,
      canvas,
      offscreen: null,
      width: dimensions.width,
      height: dimensions.height,
      dpr: dimensions.dpr,
      generation: this.generation,
    };
    this.surfaces.set(role, entry);
    return entry;
  }

  transferSurface(
    role: WorkerSurfaceRole,
    canvas: TransferableCanvasLike,
    dimensions: SurfaceDimensions,
  ): OffscreenCanvas {
    this.assertNotDisposed();
    if (this.transferredCanvases.has(canvas)) {
      throw new Error(
        `Canvas for surface "${role}" has already been transferred to an OffscreenCanvas; recreate the canvas node first.`,
      );
    }
    if (typeof canvas.transferControlToOffscreen !== "function") {
      throw new Error(
        `Canvas for surface "${role}" does not support transferControlToOffscreen(); fall back to main-thread rendering.`,
      );
    }

    const zIndex = SURFACE_LAYER_Z_ORDER[role];
    this.applyZOrderMetadata(canvas, zIndex);
    const offscreen = canvas.transferControlToOffscreen();
    this.transferredCanvases.add(canvas);

    this.surfaces.set(role, {
      role,
      zIndex,
      canvas,
      offscreen,
      width: dimensions.width,
      height: dimensions.height,
      dpr: dimensions.dpr,
      generation: this.generation,
    });
    return offscreen;
  }

  /**
   * Recreates the DOM `<canvas>` node for a surface role on worker restart,
   * context loss, or popout re-homing. The previously transferred canvas stays
   * recorded in the WeakSet so it can never be transferred a second time.
   */
  recreateCanvas(
    role: WorkerSurfaceRole,
    factory: CanvasNodeFactory,
    dimensions?: SurfaceDimensions,
  ): ManagedSurfaceEntry {
    this.assertNotDisposed();
    this.generation++;
    const previous = this.surfaces.get(role);
    const zIndex = SURFACE_LAYER_Z_ORDER[role];
    const nextCanvas = factory(role, zIndex);
    this.applyZOrderMetadata(nextCanvas, zIndex);

    const entry: ManagedSurfaceEntry = {
      role,
      zIndex,
      canvas: nextCanvas,
      offscreen: null,
      width: dimensions?.width ?? previous?.width ?? 0,
      height: dimensions?.height ?? previous?.height ?? 0,
      dpr: dimensions?.dpr ?? previous?.dpr ?? 1,
      generation: this.generation,
    };
    this.surfaces.set(role, entry);
    return entry;
  }

  recreateAndTransfer(
    role: WorkerSurfaceRole,
    factory: CanvasNodeFactory,
    dimensions?: SurfaceDimensions,
  ): { entry: ManagedSurfaceEntry; offscreen: OffscreenCanvas } {
    const recreated = this.recreateCanvas(role, factory, dimensions);
    const offscreen = this.transferSurface(role, recreated.canvas, {
      width: recreated.width,
      height: recreated.height,
      dpr: recreated.dpr,
    });
    const entry = this.surfaces.get(role)!;
    return { entry, offscreen };
  }

  getSurface(role: WorkerSurfaceRole): ManagedSurfaceEntry | undefined {
    return this.surfaces.get(role);
  }

  /**
   * Returns 3-surface compositing metadata ordered deterministically by Z-index.
   */
  getSurfaceSnapshot(): SurfaceCompositingMetadata[] {
    const result: SurfaceCompositingMetadata[] = [];
    for (const role of ORDERED_SURFACE_ROLES) {
      const entry = this.surfaces.get(role);
      if (entry) {
        result.push({
          role: entry.role,
          zIndex: entry.zIndex,
          width: entry.width,
          height: entry.height,
          dpr: entry.dpr,
          transferred: entry.offscreen !== null,
          generation: entry.generation,
        });
      }
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.surfaces.clear();
  }

  private applyZOrderMetadata(canvas: TransferableCanvasLike, zIndex: number): void {
    if (canvas.style) {
      canvas.style.zIndex = String(zIndex);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("OffscreenCanvasOwnershipManager has been disposed.");
    }
  }
}

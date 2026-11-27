import { incrementPerformanceCounter } from "../../performanceTelemetry.js";
import {
  recordGpuDeviceDestroyed,
  recordGpuDeviceLoss,
  recordGpuError,
  recordGpuFallback,
  setGpuAdapterInfo,
  type GpuAdapterInfo,
  type GpuErrorKind,
} from "../gpuDiagnostics.js";
import type { ChartPowerPreference } from "../../model/chartDisplayOptions.js";
import { isWebGpuSupported } from "../gpuSettings.js";
export { isWebGpuSupported } from "../gpuSettings.js";

export interface WebGpuLimits {
  readonly maxBufferSize: number;
  readonly maxTextureDimension2D: number;
}

export interface WebGpuDeviceHandle {
  readonly adapter: any;
  readonly device: any;
  readonly format: string;
  readonly limits: WebGpuLimits;
  readonly adapterInfo?: GpuAdapterInfo;
  readonly supportsTimestampQuery?: boolean;
  isLost(): boolean;
  onLost(callback: (reason: string) => void): () => void;
  dispose(): void;
}

interface SharedWebGpuSlot {
  handle: WebGpuDeviceHandle | null;
  promise: Promise<WebGpuDeviceHandle | null> | null;
}

const sharedSlots = new Map<ChartPowerPreference, SharedWebGpuSlot>();
let sharedSlotEpoch = 0;
let fatalDeviceReason: string | null = null;
let fatalErrorHandler: ((reason: string) => void) | null = null;
let sessionResetHandler: (() => void) | null = null;

function getOrCreateSharedSlot(preference: ChartPowerPreference): SharedWebGpuSlot {
  let slot = sharedSlots.get(preference);
  if (!slot) {
    slot = { handle: null, promise: null };
    sharedSlots.set(preference, slot);
  }
  return slot;
}

export function registerWebGpuSessionHandlers(handlers: {
  onFatal: (reason: string) => void;
  onReset: () => void;
}): void {
  fatalErrorHandler = handlers.onFatal;
  sessionResetHandler = handlers.onReset;
  if (fatalDeviceReason !== null) {
    fatalErrorHandler(fatalDeviceReason);
  }
}

export function getWebGpuFatalReason(): string | null {
  return fatalDeviceReason;
}

export function clearWebGpuFatalReasonForTest(): void {
  fatalDeviceReason = null;
}

function triggerFatalSessionFallback(reason: string): void {
  fatalDeviceReason = reason;
  try {
    fatalErrorHandler?.(reason);
  } catch (err) {
    console.error("[WebGPU] fatal session fallback handler error", err);
  }
}

function classifyWebGpuError(error: unknown): GpuErrorKind {
  if (!error || typeof error !== "object") return "unknown";
  const g = globalThis as Record<string, any>;
  if (typeof g.GPUOutOfMemoryError === "function" && error instanceof g.GPUOutOfMemoryError) {
    return "out-of-memory";
  }
  if (typeof g.GPUInternalError === "function" && error instanceof g.GPUInternalError) {
    return "internal";
  }
  if (typeof g.GPUValidationError === "function" && error instanceof g.GPUValidationError) {
    return "validation";
  }
  const errObj = error as { name?: unknown; constructor?: { name?: unknown } };
  const errName = errObj.name;
  const ctorName = errObj.constructor?.name;
  if (errName === "GPUOutOfMemoryError" || ctorName === "GPUOutOfMemoryError") return "out-of-memory";
  if (errName === "GPUInternalError" || ctorName === "GPUInternalError") return "internal";
  if (errName === "GPUValidationError" || ctorName === "GPUValidationError") return "validation";
  return "unknown";
}

async function readAdapterInfoSafely(adapter: any): Promise<GpuAdapterInfo | undefined> {
  let info: any = undefined;
  try {
    info = adapter?.info;
  } catch {
    info = undefined;
  }

  if (!info && typeof adapter?.requestAdapterInfo === "function") {
    try {
      info = await adapter.requestAdapterInfo();
    } catch {
      info = undefined;
    }
  }

  let vendor: string | undefined;
  let architecture: string | undefined;
  let description: string | undefined;
  let infoFallback: unknown = undefined;
  let adapterFallback: unknown = undefined;

  try {
    vendor = typeof info?.vendor === "string" ? info.vendor : undefined;
    architecture = typeof info?.architecture === "string" ? info.architecture : undefined;
    description = typeof info?.description === "string" ? info.description : undefined;
    infoFallback = info?.isFallbackAdapter;
  } catch {
    // Metadata access error must never break requestDevice()
  }

  try {
    adapterFallback = adapter?.isFallbackAdapter;
  } catch {
    adapterFallback = undefined;
  }

  const isFallbackAdapter =
    typeof infoFallback === "boolean"
      ? infoFallback
      : typeof adapterFallback === "boolean"
        ? adapterFallback
        : undefined;

  const hasText =
    (typeof vendor === "string" && vendor.trim().length > 0) ||
    (typeof architecture === "string" && architecture.trim().length > 0) ||
    (typeof description === "string" && description.trim().length > 0);

  if (!hasText && typeof isFallbackAdapter !== "boolean") {
    return undefined;
  }

  return {
    ...(vendor !== undefined ? { vendor } : {}),
    ...(architecture !== undefined ? { architecture } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(isFallbackAdapter !== undefined ? { isFallbackAdapter } : {}),
  };
}

export async function requestWebGpuDevice(options?: {
  powerPreference?: ChartPowerPreference;
  forceNew?: boolean;
  onFallback?: (reason: string) => void;
}): Promise<WebGpuDeviceHandle | null> {
  if (!isWebGpuSupported()) {
    setGpuAdapterInfo(undefined);
    return null;
  }

  const requestedPref: ChartPowerPreference = options?.powerPreference ?? "default";
  const slot = !options?.forceNew ? getOrCreateSharedSlot(requestedPref) : null;
  const slotEpoch = sharedSlotEpoch;

  if (slot?.handle && !slot.handle.isLost()) {
    return slot.handle;
  }

  if (slot?.promise) {
    return slot.promise;
  }

  const emitFallback = (reason: string): void => {
    if (options?.onFallback) {
      options.onFallback(reason);
    } else {
      recordGpuFallback("webgpu", "webgl2", reason);
    }
  };

  const acquirePromise = (async (): Promise<WebGpuDeviceHandle | null> => {
    try {
      const gpu = (navigator as any).gpu;
      const adapter = await (requestedPref === "low-power" || requestedPref === "high-performance"
        ? gpu.requestAdapter({ powerPreference: requestedPref })
        : gpu.requestAdapter());

      if (!adapter) {
        setGpuAdapterInfo(undefined);
        emitFallback("adapter_request_failed");
        return null;
      }

      const wantsTimestampQuery = Boolean(adapter.features?.has?.("timestamp-query"));
      let device: any = null;
      if (wantsTimestampQuery) {
        try {
          device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
        } catch {
          device = null;
        }
      }
      if (!device) {
        device = await adapter.requestDevice();
      }
      if (!device) {
        setGpuAdapterInfo(undefined);
        emitFallback("device_request_failed");
        return null;
      }
      const supportsTimestampQuery = Boolean(device.features?.has?.("timestamp-query"));

      const resolvedAdapterInfo = await readAdapterInfoSafely(adapter);
      setGpuAdapterInfo(resolvedAdapterInfo);

      const format = typeof gpu.getPreferredCanvasFormat === "function"
        ? gpu.getPreferredCanvasFormat()
        : "rgba8unorm";

      let terminalState: "alive" | "lost" | "destroyed" = "alive";
      const lostListeners = new Set<(reason: string) => void>();

      const clearSharedIfOwned = (): void => {
        if (!slot) return;
        if (slot.handle === handle) {
          slot.handle = null;
        }
        if (slot.promise === acquirePromise) {
          slot.promise = null;
        }
      };

      const notifyLostListeners = (reason: string): void => {
        for (const listener of [...lostListeners]) {
          try {
            listener(reason);
          } catch (err) {
            console.error("[WebGPU] device lost listener error", err);
          }
        }
      };

      const onUncapturedError = (event: any): void => {
        if (terminalState !== "alive") return;
        const kind = classifyWebGpuError(event?.error);
        recordGpuError("webgpu", kind);
        if (kind === "validation" || kind === "unknown") {
          console.error("[WebGPU] uncaptured error", event?.error);
          return;
        }
        const fatalReason = kind === "out-of-memory" ? "out-of-memory" : "internal-error";
        terminalState = "lost";
        try {
          device.removeEventListener?.("uncapturederror", onUncapturedError);
        } catch {
          // mock safety
        }
        clearSharedIfOwned();
        triggerFatalSessionFallback(fatalReason);
        notifyLostListeners(fatalReason);
        try {
          device.destroy?.();
        } catch {
          // device might already be destroyed or mock
        }
      };

      const handleDeviceLost = (): void => {
        if (terminalState !== "alive") return;
        terminalState = "lost";
        try {
          device.removeEventListener?.("uncapturederror", onUncapturedError);
        } catch {
          // mock safety
        }
        recordGpuDeviceLoss();
        clearSharedIfOwned();
        triggerFatalSessionFallback("device-lost");
        notifyLostListeners("device-lost");
      };

      if (device.lost && typeof device.lost.then === "function") {
        device.lost.then(() => {
          handleDeviceLost();
        }).catch(() => {
          handleDeviceLost();
        });
      }

      if (device.addEventListener) {
        device.addEventListener("uncapturederror", onUncapturedError);
      }

      const limits: WebGpuLimits = {
        maxBufferSize: device.limits?.maxBufferSize ?? 268435456,
        maxTextureDimension2D: device.limits?.maxTextureDimension2D ?? 8192,
      };

      const handle: WebGpuDeviceHandle = {
        adapter,
        device,
        format,
        limits,
        adapterInfo: resolvedAdapterInfo,
        supportsTimestampQuery,
        isLost(): boolean {
          return terminalState !== "alive";
        },
        onLost(callback: (reason: string) => void): () => void {
          lostListeners.add(callback);
          return () => {
            lostListeners.delete(callback);
          };
        },
        dispose(): void {
          if (terminalState === "destroyed") return;
          const wasAlive = terminalState === "alive";
          terminalState = "destroyed";
          try {
            device.removeEventListener?.("uncapturederror", onUncapturedError);
          } catch {
            // mock safety
          }
          if (wasAlive) {
            recordGpuDeviceDestroyed();
          }
          lostListeners.clear();
          clearSharedIfOwned();
          try {
            device.destroy?.();
          } catch {
            // device might already be destroyed or mock
          }
        },
      };

      if (slot) {
        if (sharedSlotEpoch !== slotEpoch) {
          handle.dispose();
          return null;
        }
        slot.handle = handle;
      }
      return handle;
    } catch {
      setGpuAdapterInfo(undefined);
      incrementPerformanceCounter("chart.gpu.contextCreateFailed");
      emitFallback("device_creation_exception");
      return null;
    }
  })();

  if (slot) {
    slot.promise = acquirePromise;
  }

  void acquirePromise.finally(() => {
    if (slot && slot.promise === acquirePromise) {
      slot.promise = null;
    }
  });

  return acquirePromise;
}

export function resetSharedWebGpuDevice(): void {
  sharedSlotEpoch++;
  const slots = [...sharedSlots.values()];
  sharedSlots.clear();
  for (const slot of slots) {
    if (slot.handle) {
      slot.handle.dispose();
      slot.handle = null;
    }
    slot.promise = null;
  }
  fatalDeviceReason = null;
  sessionResetHandler?.();
}

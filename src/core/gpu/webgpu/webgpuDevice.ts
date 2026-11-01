import { incrementPerformanceCounter } from "../../performanceTelemetry.js";
import { recordGpuContextEvent, recordGpuFallback, setGpuAdapterInfo } from "../gpuDiagnostics.js";
import type { ChartPowerPreference } from "../../model/chartDisplayOptions.js";

export interface WebGpuLimits {
  readonly maxBufferSize: number;
  readonly maxTextureDimension2D: number;
}

export interface WebGpuDeviceHandle {
  readonly adapter: any;
  readonly device: any;
  readonly format: string;
  readonly limits: WebGpuLimits;
  isLost(): boolean;
  onLost(callback: (reason: string) => void): () => void;
  dispose(): void;
}

let sharedHandle: WebGpuDeviceHandle | null = null;
let sharedDevicePromise: Promise<WebGpuDeviceHandle | null> | null = null;
let sharedPowerPreference: ChartPowerPreference = "default";

export function isWebGpuSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as any).gpu);
}

export async function requestWebGpuDevice(options?: {
  powerPreference?: ChartPowerPreference;
  forceNew?: boolean;
}): Promise<WebGpuDeviceHandle | null> {
  if (!isWebGpuSupported()) {
    return null;
  }

  const requestedPref: ChartPowerPreference = options?.powerPreference ?? "default";
  const prefChanged = options?.powerPreference !== undefined && options.powerPreference !== sharedPowerPreference;

  if (!options?.forceNew && !prefChanged && sharedHandle && !sharedHandle.isLost()) {
    return sharedHandle;
  }

  if (!options?.forceNew && !prefChanged && sharedDevicePromise) {
    return sharedDevicePromise;
  }

  const acquirePromise = (async (): Promise<WebGpuDeviceHandle | null> => {
    try {
      const gpu = (navigator as any).gpu;
      const adapter = await (requestedPref === "low-power" || requestedPref === "high-performance"
        ? gpu.requestAdapter({ powerPreference: requestedPref })
        : gpu.requestAdapter());

      if (!adapter) {
        recordGpuFallback("webgpu", "webgl2", "adapter_request_failed");
        return null;
      }

      if (typeof adapter.requestAdapterInfo === "function") {
        try {
          const info = await adapter.requestAdapterInfo();
          setGpuAdapterInfo({
            vendor: info.vendor,
            architecture: info.architecture,
            description: info.description,
            isFallbackAdapter: adapter.isFallbackAdapter,
          });
        } catch {
          setGpuAdapterInfo({
            isFallbackAdapter: adapter.isFallbackAdapter,
          });
        }
      } else if (adapter.info) {
        setGpuAdapterInfo({
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          description: adapter.info.description,
          isFallbackAdapter: adapter.isFallbackAdapter,
        });
      } else {
        setGpuAdapterInfo({
          isFallbackAdapter: adapter.isFallbackAdapter,
        });
      }

      const device = await adapter.requestDevice();
      if (!device) {
        recordGpuFallback("webgpu", "webgl2", "device_request_failed");
        return null;
      }

      const format = typeof gpu.getPreferredCanvasFormat === "function"
        ? gpu.getPreferredCanvasFormat()
        : "rgba8unorm";

      let lost = false;
      const lostListeners = new Set<(reason: string) => void>();

      const handleLoss = (reason: string): void => {
        if (lost) return;
        lost = true;
        recordGpuContextEvent("lost");
        if (sharedHandle === handle) {
          sharedHandle = null;
          sharedPowerPreference = "default";
        }
        if (sharedDevicePromise === acquirePromise) {
          sharedDevicePromise = null;
        }
        for (const listener of [...lostListeners]) {
          try {
            listener(reason);
          } catch (err) {
            console.error("[WebGPU] device lost listener error", err);
          }
        }
      };

      if (device.lost && typeof device.lost.then === "function") {
        device.lost.then((info: any) => {
          handleLoss(info?.reason ?? "device-lost");
        }).catch(() => {
          handleLoss("device-lost");
        });
      }

      if (device.addEventListener) {
        device.addEventListener("uncapturederror", (event: any) => {
          console.error("[WebGPU] uncaptured error", event?.error);
          handleLoss("validation-failed");
        });
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
        isLost(): boolean {
          return lost;
        },
        onLost(callback: (reason: string) => void): () => void {
          lostListeners.add(callback);
          return () => {
            lostListeners.delete(callback);
          };
        },
        dispose(): void {
          lost = true;
          lostListeners.clear();
          try {
            device.destroy?.();
          } catch {
            // device might already be destroyed or mock
          }
          if (sharedHandle === handle) {
            sharedHandle = null;
            sharedDevicePromise = null;
            sharedPowerPreference = "default";
          }
        },
      };

      if (!options?.forceNew) {
        sharedHandle = handle;
        sharedPowerPreference = requestedPref;
      }
      return handle;
    } catch (error) {
      incrementPerformanceCounter("chart.gpu.contextCreateFailed");
      recordGpuFallback("webgpu", "webgl2", "device_creation_exception");
      return null;
    }
  })();

  if (!options?.forceNew) {
    sharedDevicePromise = acquirePromise;
  }

  void acquirePromise.finally(() => {
    if (sharedDevicePromise === acquirePromise) {
      sharedDevicePromise = null;
    }
  });

  return acquirePromise;
}

export function resetSharedWebGpuDevice(): void {
  if (sharedHandle) {
    sharedHandle.dispose();
    sharedHandle = null;
  }
  sharedDevicePromise = null;
  sharedPowerPreference = "default";
}

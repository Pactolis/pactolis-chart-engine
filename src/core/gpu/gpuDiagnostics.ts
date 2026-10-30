import { incrementPerformanceCounter, recordPerformanceDuration } from "../performanceTelemetry.js";

export interface GpuFallbackRecord {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly timestamp: number;
}

export interface GpuAdapterInfo {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly description?: string;
  readonly isFallbackAdapter?: boolean;
}

export interface GpuFrameMetrics {
  readonly renderP50Ms?: number;
  readonly renderP95Ms?: number;
  readonly intervalP95Ms?: number;
}

export interface GpuDiagnosticsSnapshot {
  readonly engine: string;
  readonly requested: string;
  readonly active: string;
  readonly fallbacks: readonly GpuFallbackRecord[];
  readonly adapter?: GpuAdapterInfo;
  readonly limits?: Record<string, number>;
  readonly counters: Record<string, number>;
  readonly frame?: GpuFrameMetrics;
}

const ENGINE_VERSION = "0.2.3";
const MAX_SAMPLES = 120;

const FRAME_COUNTER_KEYS: Record<string, string> = {
  webgpu: "gpu.backend.webgpu.frames",
  webgl2: "gpu.backend.webgl2.frames",
  canvas2d: "gpu.backend.canvas2d.frames",
};

let requestedBackend = "webgl2";
let activeBackend = "webgl2";
const fallbacks: GpuFallbackRecord[] = [];
let adapterInfo: GpuAdapterInfo | undefined;
let limits: Record<string, number> | undefined;
const counters: Record<string, number> = {};

const renderSamples: number[] = [];
const intervalSamples: number[] = [];

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

export function recordGpuBackendSelection(requested: string, active: string): void {
  requestedBackend = requested;
  activeBackend = active;
}

export function recordGpuFrame(kind: string, renderMs?: number, intervalMs?: number): void {
  const counterKey = FRAME_COUNTER_KEYS[kind] ?? `gpu.backend.${kind}.frames`;
  counters[counterKey] = (counters[counterKey] ?? 0) + 1;
  incrementPerformanceCounter(counterKey);

  if (typeof renderMs === "number" && Number.isFinite(renderMs) && renderMs >= 0) {
    if (renderSamples.length >= MAX_SAMPLES) renderSamples.shift();
    renderSamples.push(renderMs);
  }

  if (typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs >= 0) {
    if (intervalSamples.length >= MAX_SAMPLES) intervalSamples.shift();
    intervalSamples.push(intervalMs);
    recordPerformanceDuration("chart.frame.interval.ms", intervalMs);
  }
}

export function recordGpuFallback(from: string, to: string, reason: string): void {
  fallbacks.push({
    from,
    to,
    reason,
    timestamp: Date.now(),
  });
  const counterKey = `gpu.fallback.${from}.${reason}`;
  counters[counterKey] = (counters[counterKey] ?? 0) + 1;
  incrementPerformanceCounter(counterKey);
}

export function recordGpuContextEvent(kind: "lost" | "restored" | "createFailed"): void {
  let counterKey: string;
  if (kind === "lost") {
    counterKey = "chart.gpu.contextLost";
  } else if (kind === "restored") {
    counterKey = "chart.gpu.contextRestored";
  } else {
    counterKey = "chart.gpu.contextCreateFailed";
  }
  counters[counterKey] = (counters[counterKey] ?? 0) + 1;
  incrementPerformanceCounter(counterKey);
}

export function setGpuAdapterInfo(info: GpuAdapterInfo | undefined): void {
  adapterInfo = info;
}

export function setGpuLimits(nextLimits: Record<string, number> | undefined): void {
  limits = nextLimits;
}

export function getGpuDiagnostics(): GpuDiagnosticsSnapshot {
  let frameMetrics: GpuFrameMetrics | undefined;
  if (renderSamples.length > 0 || intervalSamples.length > 0) {
    const sortedRender = [...renderSamples].sort((a, b) => a - b);
    const sortedInterval = [...intervalSamples].sort((a, b) => a - b);
    frameMetrics = {
      renderP50Ms: percentile(sortedRender, 0.5),
      renderP95Ms: percentile(sortedRender, 0.95),
      intervalP95Ms: percentile(sortedInterval, 0.95),
    };
  }

  return {
    engine: ENGINE_VERSION,
    requested: requestedBackend,
    active: activeBackend,
    fallbacks: [...fallbacks],
    adapter: adapterInfo,
    limits: limits ? { ...limits } : undefined,
    counters: { ...counters },
    frame: frameMetrics,
  };
}

export function copyGpuDiagnosticsJson(): string {
  return JSON.stringify(getGpuDiagnostics(), null, 2);
}

export function resetGpuDiagnosticsForTest(): void {
  requestedBackend = "webgl2";
  activeBackend = "webgl2";
  fallbacks.length = 0;
  adapterInfo = undefined;
  limits = undefined;
  for (const key of Object.keys(counters)) {
    delete counters[key];
  }
  renderSamples.length = 0;
  intervalSamples.length = 0;
}

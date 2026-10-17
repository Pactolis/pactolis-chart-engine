export interface PerformanceMetricSnapshot {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface PerformanceTelemetrySnapshot {
  enabled: boolean;
  metrics: Record<string, PerformanceMetricSnapshot>;
  counters: Record<string, number>;
}

const MAX_SAMPLES = 2_048;
const samples = new Map<string, number[]>();
const totals = new Map<string, number>();
const counts = new Map<string, number>();
const counters = new Map<string, number>();
let enabled = false;

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

export function configurePerformanceTelemetry(next: { enabled: boolean }): void {
  enabled = next.enabled;
}

export function isPerformanceTelemetryEnabled(): boolean {
  return enabled;
}

export function recordPerformanceDuration(name: string, durationMs: number): void {
  if (!enabled || !Number.isFinite(durationMs) || durationMs < 0) return;
  const metricSamples = samples.get(name) ?? [];
  if (metricSamples.length >= MAX_SAMPLES) metricSamples.shift();
  metricSamples.push(durationMs);
  samples.set(name, metricSamples);
  totals.set(name, (totals.get(name) ?? 0) + durationMs);
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

export function incrementPerformanceCounter(name: string, amount = 1): void {
  if (!enabled || !Number.isFinite(amount)) return;
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function measurePerformance<T>(name: string, work: () => T): T {
  if (!enabled) return work();
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    recordPerformanceDuration(name, performance.now() - startedAt);
  }
}

export async function measurePerformanceAsync<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (!enabled) return work();
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    recordPerformanceDuration(name, performance.now() - startedAt);
  }
}

export function snapshotPerformanceTelemetry(): PerformanceTelemetrySnapshot {
  const metrics: Record<string, PerformanceMetricSnapshot> = {};
  for (const [name, metricSamples] of samples) {
    const sorted = [...metricSamples].sort((a, b) => a - b);
    const count = counts.get(name) ?? metricSamples.length;
    metrics[name] = {
      count,
      totalMs: totals.get(name) ?? 0,
      minMs: sorted[0] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
    };
  }
  return { enabled, metrics, counters: Object.fromEntries(counters) };
}

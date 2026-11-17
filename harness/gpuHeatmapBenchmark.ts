import type { ChartPanelState } from "../src/core/chartPanelState.js";
import type { ChartCaptureReadiness } from "../src/features/chart/captureReadiness.js";
import type { FootprintSeries } from "../src/core/model/footprint.js";
import type { View } from "../src/core/engine/view.js";
import {
  createChartSurfaceModel,
  getChartRuntime,
  mountChart,
  setOrderbookHeatmapModeFor,
  updateOrderbookHeatmapSettings,
} from "./chart.js";
import { createHarnessServices } from "./services.js";
import { settings } from "../src/core/settings.js";
import type { OrderbookHeatmapStep } from "../src/core/orderbookHeatmap/settings.js";

export interface GpuHeatmapBenchmarkInput {
  cellCount: 15_000 | 40_000;
  chartCount: 1 | 8;
  phase: "cpu-cold" | "cpu-hot" | "gpu";
  samples: number;
  barsCount: number;
  levelsPerBar: number;
  basePrice: number;
  bucketStep: OrderbookHeatmapStep;
}

interface CaptureFrame {
  captureCompositePng(): Promise<unknown>;
}

interface HeatmapOverlayProbe {
  bars: Map<number, unknown>;
  chunks: Map<number, { status: string }>;
  inFlight: Set<AbortController>;
  prepareGpuCells(view: View, series: FootprintSeries, range: [number, number]): {
    main: unknown[];
    extension: unknown[];
  } | null;
  releaseRasterCache(): void;
  reservedRasterBytes(): number;
  setRasterCacheDisabledForTest(disabled: boolean): void;
}

interface BenchmarkRuntime {
  heatmapTexturePrototypeEnabled: boolean;
  heatmapGpuFrame: unknown;
  view: View;
  pipeline: { series: FootprintSeries };
  orderbookHeatmap: HeatmapOverlayProbe;
  session: CaptureFrame & { gl: WebGL2RenderingContext };
  getCaptureReadiness(): ChartCaptureReadiness;
  setVisibleTimeRange(range: { from: number; to: number }): void;
  invalidate(): void;
  whenHeatmapGpuRendererReady(): Promise<void>;
}

interface FrameMetricSnapshot {
  count: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface BrowserMemorySnapshot {
  available: boolean;
  usedJSHeapSizeBytes: number | null;
  totalJSHeapSizeBytes: number | null;
  jsHeapSizeLimitBytes: number | null;
}

const MARKET = "BINANCE_FUTURES:btcusdt";
const TIMEFRAME = "15m";
const FRAME_METRIC = "chart.frame.render.ms";
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software raster|basic render|warp device/i;

function waitForFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function memorySnapshot(): BrowserMemorySnapshot {
  const memory = (performance as Performance & {
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
      jsHeapSizeLimit?: number;
    };
  }).memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize)) {
    return {
      available: false,
      usedJSHeapSizeBytes: null,
      totalJSHeapSizeBytes: null,
      jsHeapSizeLimitBytes: null,
    };
  }
  return {
    available: true,
    usedJSHeapSizeBytes: memory.usedJSHeapSize ?? null,
    totalJSHeapSizeBytes: memory.totalJSHeapSize ?? null,
    jsHeapSizeLimitBytes: memory.jsHeapSizeLimit ?? null,
  };
}

function memoryDeltaBytes(before: BrowserMemorySnapshot, after: BrowserMemorySnapshot): number | null {
  if (!before.available || !after.available || before.usedJSHeapSizeBytes === null || after.usedJSHeapSizeBytes === null) {
    return null;
  }
  return after.usedJSHeapSizeBytes - before.usedJSHeapSizeBytes;
}

function getFrameMetric(telemetry: typeof import("../src/core/performanceTelemetry.js")): FrameMetricSnapshot {
  const metric = telemetry.snapshotPerformanceTelemetry().metrics[FRAME_METRIC];
  return metric
    ? {
        count: metric.count,
        totalMs: metric.totalMs,
        p50Ms: metric.p50Ms,
        p95Ms: metric.p95Ms,
        p99Ms: metric.p99Ms,
      }
    : { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
}

function captureDelta(
  before: FrameMetricSnapshot,
  after: FrameMetricSnapshot,
): { count: number; meanMs: number | null } {
  const count = after.count - before.count;
  const totalMs = after.totalMs - before.totalMs;
  return { count, meanMs: count > 0 ? totalMs / count : null };
}

function summarizeFrameSamples(samples: readonly { meanMs: number | null }[]): FrameMetricSnapshot {
  const values = samples
    .map((sample) => sample.meanMs)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  const percentile = (quantile: number): number => values[
    Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))
  ] ?? 0;
  return {
    count: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

function gpuAllocationEstimate(cellCount: number): {
  textureTexels: number;
  textureBytes: number;
  instanceBytes: number;
  fixedVertexBytes: number;
  totalBytes: number;
} {
  const width = Math.min(cellCount, 1024);
  const height = Math.ceil(cellCount / width);
  const textureTexels = width * height;
  const textureBytes = textureTexels * 5; // R32F density texture + R8 present-cell mask.
  const instanceBytes = cellCount * 7 * Float32Array.BYTES_PER_ELEMENT;
  const fixedVertexBytes = 12 * Float32Array.BYTES_PER_ELEMENT;
  return {
    textureTexels,
    textureBytes,
    instanceBytes,
    fixedVertexBytes,
    totalBytes: textureBytes + instanceBytes + fixedVertexBytes,
  };
}

export async function probeGpuRenderer(): Promise<{
  webgl2Available: boolean;
  webglDebugExtensionAvailable: boolean;
  vendor: string | null;
  renderer: string | null;
  unmaskedVendor: string | null;
  unmaskedRenderer: string | null;
  hardwareValid: boolean;
  invalidReason: string | null;
}> {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false });
  if (!gl) {
    return {
      webgl2Available: false,
      webglDebugExtensionAvailable: false,
      vendor: null,
      renderer: null,
      unmaskedVendor: null,
      unmaskedRenderer: null,
      hardwareValid: false,
      invalidReason: "webgl2-unavailable",
    };
  }
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  const vendor = gl.getParameter(gl.VENDOR) as string;
  const renderer = gl.getParameter(gl.RENDERER) as string;
  const unmaskedVendor = extension
    ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) as string
    : null;
  const unmaskedRenderer = extension
    ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) as string
    : null;
  const identity = `${unmaskedVendor ?? vendor} ${unmaskedRenderer ?? renderer}`;
  const software = SOFTWARE_RENDERER.test(identity);
  const hasUnmaskedProbe = Boolean(extension && unmaskedVendor && unmaskedRenderer);
  return {
    webgl2Available: true,
    webglDebugExtensionAvailable: Boolean(extension),
    vendor,
    renderer,
    unmaskedVendor,
    unmaskedRenderer,
    hardwareValid: hasUnmaskedProbe && !software,
    invalidReason: software
      ? "software-renderer"
      : !hasUnmaskedProbe
        ? "unmasked-renderer-unavailable"
        : null,
  };
}

export async function runGpuHeatmapBenchmark(input: GpuHeatmapBenchmarkInput): Promise<Record<string, unknown>> {
  const columns = input.chartCount === 1 ? 1 : 4;
  const rows = input.chartCount === 1 ? 1 : 2;
  const heatmapCells = input.cellCount / input.barsCount;
  if (!Number.isInteger(heatmapCells) || heatmapCells !== input.levelsPerBar) {
    throw new Error("Benchmark fixture must divide evenly into bars and price levels");
  }

  settings.grid = false;
  const frameBoard = document.createElement("div");
  frameBoard.dataset.gpuBenchmarkBoard = "true";
  frameBoard.style.cssText = "position:fixed;inset:0;overflow:hidden;background:#121418;";
  document.body.appendChild(frameBoard);

  const panelIds: string[] = [];
  for (let chartIndex = 0; chartIndex < input.chartCount; chartIndex++) {
    const root = document.createElement("div");
    const column = chartIndex % columns;
    const row = Math.floor(chartIndex / columns);
    root.className = "harness-chart gpu-benchmark-chart";
    root.dataset.gpuBenchmarkChart = String(chartIndex + 1);
    root.style.cssText = [
      "position:absolute",
      "overflow:hidden",
      `left:${(column * 100) / columns}%`,
      `top:${(row * 100) / rows}%`,
      `width:${100 / columns}%`,
      `height:${100 / rows}%`,
    ].join(";");
    frameBoard.appendChild(root);
    const panelId = `gpu-benchmark-${chartIndex + 1}`;
    panelIds.push(panelId);
    const state: ChartPanelState = {
      type: "chart",
      market: MARKET,
      timeframe: TIMEFRAME,
      scaleMode: "linear",
      chartType: "candlestick",
      candles: true,
    } as ChartPanelState;
    const services = createHarnessServices({ priceStep: input.bucketStep, priceStepResolved: false });
    mountChart(root, state, services, panelId, createChartSurfaceModel());
  }

  await waitForFrame();
  await waitForFrame();
  const runtimes = panelIds.map((panelId) => getChartRuntime(panelId) as unknown as BenchmarkRuntime | undefined);
  if (runtimes.some((runtime) => !runtime)) throw new Error("One or more chart runtimes failed to mount");
  const charts = runtimes as BenchmarkRuntime[];

  await waitUntil(() => charts.every((runtime) => {
    const readiness = runtime.getCaptureReadiness();
    return readiness.ready && readiness.history.status === "settled"
      && runtime.pipeline.series.length === input.barsCount;
  }), "chart history settlement");

  const first = charts[0].pipeline.series;
  const last = charts[0].pipeline.series.length - 1;
  const from = first.timeOfIndex(0);
  const to = first.timeOfIndex(last);

  for (const runtime of charts) {
    runtime.setVisibleTimeRange({ from, to });
    const topBucket = input.basePrice + (input.levelsPerBar - 1) * input.bucketStep;
    runtime.view.fitPriceRange(input.basePrice - 200, topBucket + 200, 0.05);
    runtime.view.colWidth = (runtime.view.area.width - 6) / input.barsCount;
    runtime.view.offsetX = 3;
  }

  updateOrderbookHeatmapSettings({
    unit: "btc",
    bucketStep: input.bucketStep,
    single: { usd: 1, btc: 1 },
    aggregated: { usd: 1, btc: 1 },
  });
  setOrderbookHeatmapModeFor(MARKET, "single");

  await waitUntil(() => charts.every((runtime) => {
    const overlay = runtime.orderbookHeatmap;
    return overlay.bars.size >= input.barsCount && overlay.inFlight.size === 0
      && overlay.chunks.size > 0 && [...overlay.chunks.values()].every((chunk) => chunk.status === "ready");
  }), "heatmap fixture acknowledgement");
  for (const runtime of charts) runtime.invalidate();
  await waitForFrame();

  const visibleCounts = charts.map((runtime) => {
    const frame = runtime.orderbookHeatmap.prepareGpuCells(
      runtime.view,
      runtime.pipeline.series,
      [0, runtime.pipeline.series.length - 1],
    );
    return frame
      ? { mainCells: frame.main.length, extensionCells: frame.extension.length, totalGpuInstances: frame.main.length + frame.extension.length }
      : { mainCells: 0, extensionCells: 0, totalGpuInstances: 0 };
  });
  if (visibleCounts.some((count) => count.mainCells !== input.cellCount)) {
    throw new Error(`Expected ${input.cellCount} visible main cells per chart; observed ${visibleCounts.map((count) => count.mainCells).join(", ")}`);
  }

  for (const runtime of charts) {
    runtime.heatmapTexturePrototypeEnabled = false;
    runtime.orderbookHeatmap.setRasterCacheDisabledForTest(false);
  }
  for (const runtime of charts) runtime.invalidate();
  await waitForFrame();

  const telemetry = await import("../src/core/performanceTelemetry.js");
  let gpuFirstFrame: Array<{ chart: number; meanMs: number | null; sampleCount: number }> = [];
  const measurementHeapBefore = memorySnapshot();
  let gpuBytesPerChart: ReturnType<typeof gpuAllocationEstimate> | null = null;
  const preModeRasterBytes = charts.reduce((sum, runtime) => sum + runtime.orderbookHeatmap.reservedRasterBytes(), 0);

  if (input.phase === "gpu") {
    telemetry.configurePerformanceTelemetry({ enabled: true });
    for (const runtime of charts) runtime.heatmapTexturePrototypeEnabled = true;
    await Promise.all(charts.map((runtime) => runtime.whenHeatmapGpuRendererReady()));
    const beforeCold = getFrameMetric(telemetry);
    for (const runtime of charts) runtime.invalidate();
    await waitForFrame();
    const afterCold = getFrameMetric(telemetry);
    const coldDelta = captureDelta(beforeCold, afterCold);
    gpuFirstFrame = [{
      chart: input.chartCount,
      meanMs: coldDelta.meanMs,
      sampleCount: coldDelta.count,
    }];
    if (charts.some((runtime) => runtime.heatmapGpuFrame === null)) {
      throw new Error("GPU heatmap never owned the frame; CPU fallback must not be measured as GPU");
    }
    gpuBytesPerChart = gpuAllocationEstimate(visibleCounts[0].totalGpuInstances);
    const warmCaptureHeap = memorySnapshot();
    const hotFrames = await measureFrames(charts, telemetry, input.samples, "gpu");
    const metric = summarizeFrameSamples(hotFrames);
    const memoryAfter = memorySnapshot();
    const gpuTotalBytes = gpuBytesPerChart.totalBytes * input.chartCount;
    const rasterBytesAfter = charts.reduce((sum, runtime) => sum + runtime.orderbookHeatmap.reservedRasterBytes(), 0);
    return {
      workload: {
        cellCount: input.cellCount,
        cellsPerBar: input.levelsPerBar,
        bars: input.barsCount,
        chartCount: input.chartCount,
        chartLayout: { columns, rows, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight },
        actualVisibleCellsPerChart: visibleCounts,
      },
      phase: input.phase,
      frameTime: { metric: FRAME_METRIC, ...metric },
      sampledHotFrames: hotFrames,
      gpuColdFirstFrame: gpuFirstFrame,
      memory: {
        performanceMemoryBefore: measurementHeapBefore,
        performanceMemoryAfter: memoryAfter,
        jsHeapDeltaBytes: memoryDeltaBytes(measurementHeapBefore, memoryAfter),
        gpuAllocationEstimate: {
          model: "known heatmap WebGL textures + instance buffer + fixed quad vertex buffer; excludes driver overhead and JS copies",
          perChart: gpuBytesPerChart,
          totalBytes: gpuTotalBytes,
        },
        cpuRasterCacheBytesBeforeGpuOptIn: preModeRasterBytes,
        cpuRasterCacheBytesAfterGpuOptIn: rasterBytesAfter,
        estimatedTotalRetainedBytes: totalEstimatedBytes(
          memoryDeltaBytes(measurementHeapBefore, memoryAfter),
          gpuTotalBytes + rasterBytesAfter,
        ),
        heapBeforeHeatmap: measurementHeapBefore,
        heapAtGpuWarmup: warmCaptureHeap,
      },
      gpuOwned: true,
    };
  }

  // CPU-cold repeatedly releases the raster backing store before a sampled draw.
  // CPU-hot builds it once before telemetry starts and measures cache-hit draws.
  if (input.phase === "cpu-hot") {
    for (const runtime of charts) {
      runtime.invalidate();
      await waitForFrame();
    }
  }
  const cpuRasterBytesBeforeSamples = charts.reduce((sum, runtime) => sum + runtime.orderbookHeatmap.reservedRasterBytes(), 0);
  telemetry.configurePerformanceTelemetry({ enabled: true });
  const sampledFrames = await measureFrames(
    charts,
    telemetry,
    input.samples,
    input.phase === "cpu-cold" ? "cpu-cold" : "cpu-hot",
  );
  const metric = summarizeFrameSamples(sampledFrames);
  const memoryAfter = memorySnapshot();
  const cpuRasterBytesAfterSamples = charts.reduce((sum, runtime) => sum + runtime.orderbookHeatmap.reservedRasterBytes(), 0);
  const heapDelta = memoryDeltaBytes(measurementHeapBefore, memoryAfter);
  return {
    workload: {
      cellCount: input.cellCount,
      cellsPerBar: input.levelsPerBar,
      bars: input.barsCount,
      chartCount: input.chartCount,
      chartLayout: { columns, rows, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight },
      actualVisibleCellsPerChart: visibleCounts,
    },
    phase: input.phase,
    frameTime: { metric: FRAME_METRIC, ...metric },
    sampledFrames,
    memory: {
      performanceMemoryBeforeHeatmap: measurementHeapBefore,
      performanceMemoryAfter: memoryAfter,
      jsHeapDeltaBytes: heapDelta,
      cpuRasterCacheBytesBeforeSamples: cpuRasterBytesBeforeSamples,
      cpuRasterCacheBytesAfterSamples: cpuRasterBytesAfterSamples,
      cpuRasterAllocationEstimateBytes: cpuRasterBytesAfterSamples,
      estimatedTotalRetainedBytes: totalEstimatedBytes(heapDelta, cpuRasterBytesAfterSamples),
    },
    gpuOwned: false,
  };
}

async function measureFrames(
  charts: BenchmarkRuntime[],
  telemetry: typeof import("../src/core/performanceTelemetry.js"),
  samplesPerChart: number,
  mode: "cpu-cold" | "cpu-hot" | "gpu",
): Promise<Array<{ chart: number; count: number; meanMs: number | null }>> {
  const sampled: Array<{ chart: number; count: number; meanMs: number | null }> = [];
  for (let index = 0; index < charts.length; index++) {
    const runtime = charts[index];
    for (let sample = 0; sample < samplesPerChart; sample++) {
      if (mode === "cpu-cold") runtime.orderbookHeatmap.releaseRasterCache();
      const before = getFrameMetric(telemetry);
      runtime.invalidate();
      await waitForFrame();
      const after = getFrameMetric(telemetry);
      const delta = captureDelta(before, after);
      if (delta.meanMs === null) throw new Error(`No ${FRAME_METRIC} sample for chart ${index + 1}`);
      sampled.push({ chart: index + 1, count: delta.count, meanMs: delta.meanMs });
    }
  }
  return sampled;
}

function totalEstimatedBytes(jsHeapDelta: number | null, backingBytes: number): number | null {
  return jsHeapDelta === null ? null : Math.max(0, jsHeapDelta) + backingBytes;
}

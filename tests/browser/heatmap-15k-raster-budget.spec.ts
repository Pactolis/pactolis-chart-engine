import { expect, test, type Page } from "@playwright/test";
import type { ChartCaptureReadiness } from "../../src/features/chart/captureReadiness.js";
import type { View } from "../../src/core/engine/view.js";
import type { FootprintSeries } from "../../src/core/model/footprint.js";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import type { HeatmapGpuCellFrame } from "../../src/features/chart/heatmap/gpu/heatmapGpuRenderer.js";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

const BARS_COUNT = 250;
const LEVELS_PER_BAR = 60;
const EXPECTED_VISIBLE_CELLS = BARS_COUNT * LEVELS_PER_BAR;
const BASE_PRICE = 50_000;
const BUCKET_STEP = 50;
const HOOK_SELECTOR = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

type RuntimeProbe = {
  heatmapTexturePrototypeEnabled: boolean;
  view: View;
  pipeline: { series: FootprintSeries };
  getState(): ChartPanelState;
  updateState(state: ChartPanelState): void;
  getCaptureReadiness(): ChartCaptureReadiness;
  subscribeCaptureReadiness(cb: (snapshot: ChartCaptureReadiness) => void): () => void;
  setVisibleTimeRange(range: { from: number; to: number }): void;
  invalidate(): void;
  whenHeatmapGpuRendererReady(): Promise<void>;
  orderbookHeatmap: {
    bars: Map<number, { t: number; cells: number[][] }>;
    chunks: Map<number, { status: string }>;
    inFlight: Set<AbortController>;
    prepareGpuCells(view: View, series: FootprintSeries, range: [number, number]): HeatmapGpuCellFrame | null;
    reservedRasterBytes(): number;
    releaseRasterCache(): void;
    setVisible(visible: boolean): void;
    setRasterCacheDisabledForTest(disabled: boolean): void;
  };
  session: {
    gl: WebGL2RenderingContext;
    pendingCapture: unknown;
    captureCompositePng(): Promise<{ blob: Blob; width: number; height: number }>;
  };
};

function makeDenseHeatmapCells(barIndex: number): Array<[number, number, number]> {
  const cells: Array<[number, number, number]> = [];
  for (let level = 0; level < LEVELS_PER_BAR; level++) {
    const price = BASE_PRICE + level * BUCKET_STEP;
    const bid = 2_000 + ((barIndex + level) % 10) * 400;
    const ask = 2_000 + ((barIndex * 3 + level) % 10) * 400;
    cells.push([price, bid, ask]);
  }
  return cells;
}

async function install15kFixture(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1800, height: 1000 });
  const bars = buildBars(BARS_COUNT).map((bar) => ({
    ...bar,
    o: BASE_PRICE + 1_200,
    h: BASE_PRICE + (LEVELS_PER_BAR - 1) * BUCKET_STEP,
    l: BASE_PRICE,
    c: BASE_PRICE + 1_500,
    v: 20,
    d: 2,
    n: 20,
    cells: [
      [BASE_PRICE, 5, 5, 0, 0, 10, 5, 5],
      [BASE_PRICE + 1_500, 5, 5, 0, 0, 10, 5, 5],
    ],
    lb: 0,
    ls: 0,
  }));

  const heatmapBars = bars.map((bar, barIndex) => ({
    t: bar.t,
    cells: makeDenseHeatmapCells(barIndex),
  }));

  await page.route(/\/history(?:\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    const candleOnly = q.get("includeFootprint") === "0";
    const meta = candleOnly
      ? { schemaVersion: 1, generatedAt: FROZEN_NOW }
      : {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          footprint: { available: true, allowed: true, priceStep: 25 },
          footprintCoverage: {
            status: "complete",
            requestedFrom: from,
            requestedTo: to,
            coveredFrom: from,
            coveredThrough: to,
          },
        };
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { bars }, meta }),
    });
  });

  await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          base: "BTC",
          source: q.get("source") ?? "single",
          resolution: q.get("resolution") ?? "15m",
          bucketStep: Number(q.get("bucketStep") ?? BUCKET_STEP),
          from,
          to,
          bars: heatmapBars.filter((bar) => bar.t >= from && bar.t <= to),
        },
      }),
    });
  });

  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0");
  const hook = page.locator(HOOK_SELECTOR);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  await expect(hook).toHaveAttribute("data-series-len", String(BARS_COUNT));
  const id = await hook.getAttribute("data-panel-id");
  if (!id) throw new Error("Fixture: missing panel id");
  return id;
}

test("15,000-cell SwiftShader benchmark and CPU raster cache budget / GPU takeover release", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const id = await install15kFixture(page);

  const report = await page.evaluate(async ({ id, barsCount, expectedCells, basePrice, bucketStep, levelsPerBar, intervalMs }) => {
    const {
      getChartRuntime,
      updateOrderbookHeatmapSettings,
      setOrderbookHeatmapModeFor,
    } = await import("/harness/chart.ts");
    const { settings } = await import("/src/core/settings.ts");
    const telemetry = await import("/src/core/performanceTelemetry.ts");
    const {
      HEATMAP_CPU_RASTER_CHART_BUDGET_BYTES,
      HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES,
      getHeatmapCpuRasterModuleReservedBytes,
    } = await import("/src/features/orderbook/heatmapOverlay.ts");

    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    if (!r || !r.orderbookHeatmap || !r.session) throw new Error("Runtime/orderbookHeatmap unavailable");

    settings.grid = false;
    r.updateState({ ...r.getState(), chartType: "candlestick", scaleMode: "linear" });

    // Wait for initial history settlement before calibrating viewport.
    const selection = r.getState();
    let stopReadiness: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("history-settled deadline exceeded")), 10_000);
        stopReadiness = r.subscribeCaptureReadiness((snapshot) => {
          if (snapshot.disposed) {
            reject(new Error("runtime disposed"));
          } else if (
            snapshot.history.market === selection.market &&
            snapshot.history.timeframe === selection.timeframe
          ) {
            if (snapshot.history.status === "settled" && snapshot.ready) resolve();
            else if (snapshot.history.status === "failed") reject(new Error("history readiness failed"));
          }
        });
      });
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      stopReadiness?.();
    }

    r.invalidate();
    await r.session.captureCompositePng();

    const s = r.pipeline.series;
    const v = r.view;
    r.setVisibleTimeRange({ from: s.timeOfIndex(0), to: s.timeOfIndex(barsCount - 1) });
    await r.session.captureCompositePng();

    // Fit all 250 bars and all 60 price levels cleanly inside the viewport.
    const topBucket = basePrice + (levelsPerBar - 1) * bucketStep;
    v.fitPriceRange(basePrice - 200, topBucket + 200, 0.05);
    const calibratedColWidth = (v.area.width - 6) / barsCount;
    const calibratedOffsetX = 3;
    v.colWidth = calibratedColWidth;
    v.offsetX = calibratedOffsetX;

    updateOrderbookHeatmapSettings({
      unit: "btc",
      bucketStep,
      single: { usd: 0, btc: 0.05 },
      aggregated: { usd: 0, btc: 0.05 },
    });
    setOrderbookHeatmapModeFor("BINANCE_FUTURES:btcusdt", "single");

    // Wait until heatmap chunks covering the 250 bars finish loading.
    for (let attempt = 0; attempt < 80; attempt++) {
      r.invalidate();
      await r.session.captureCompositePng();
      const chunks = [...r.orderbookHeatmap.chunks.values()];
      const allReady = chunks.length > 0 && chunks.every((c) => c.status === "ready");
      if (allReady && r.orderbookHeatmap.inFlight.size === 0 && r.orderbookHeatmap.bars.size >= barsCount) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const root = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`)?.parentElement as HTMLElement | null;
    const annotation = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
    if (!root || !annotation || annotation.width <= 0 || annotation.height <= 0) {
      throw new Error("Annotation canvas unavailable");
    }
    const expectedRasterBytes = annotation.width * annotation.height * 4;

    const preparedAtBase = r.orderbookHeatmap.prepareGpuCells(v, s, [0, barsCount - 1]);
    v.offsetX = calibratedOffsetX + 0.25;
    const preparedAtShift = r.orderbookHeatmap.prepareGpuCells(v, s, [0, barsCount - 1]);
    v.offsetX = calibratedOffsetX;
    const visibleCellsMain = preparedAtBase?.main.length ?? 0;
    const visibleCellsShift = preparedAtShift?.main.length ?? 0;
    if (visibleCellsMain !== expectedCells || visibleCellsShift !== expectedCells) {
      throw new Error(
        `Expected ${expectedCells} visible cells (interval ${intervalMs}), got main=${visibleCellsMain}, shift=${visibleCellsShift}`,
      );
    }

    const summarize = (samples: number[]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      const sum = samples.reduce((acc, value) => acc + value, 0);
      const p50 = sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0;
      const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
      return {
        samples: samples.length,
        meanMs: Number((sum / Math.max(1, samples.length)).toFixed(3)),
        p50Ms: Number(p50.toFixed(3)),
        p95Ms: Number(p95.toFixed(3)),
      };
    };

    const metricDelta = (
      before: ReturnType<typeof telemetry.snapshotPerformanceTelemetry>,
      after: ReturnType<typeof telemetry.snapshotPerformanceTelemetry>,
      name: string,
    ): { count: number; totalMs: number } => {
      const b = before.metrics[name];
      const a = after.metrics[name];
      return {
        count: (a?.count ?? 0) - (b?.count ?? 0),
        totalMs: (a?.totalMs ?? 0) - (b?.totalMs ?? 0),
      };
    };

    const counterDelta = (
      before: ReturnType<typeof telemetry.snapshotPerformanceTelemetry>,
      after: ReturnType<typeof telemetry.snapshotPerformanceTelemetry>,
      name: string,
    ): number => (after.counters[name] ?? 0) - (before.counters[name] ?? 0);

    telemetry.configurePerformanceTelemetry({ enabled: true });

    // Phase 0: CPU Direct (no rasterCache — paints 15k cells directly to annotation canvas each frame)
    r.heatmapTexturePrototypeEnabled = false;
    r.orderbookHeatmap.setRasterCacheDisabledForTest(true);
    // Unmeasured warm-up frame ensures steady JIT parity before direct vs cold sampling.
    r.invalidate();
    await r.session.captureCompositePng();
    const reservedDuringDirect = r.orderbookHeatmap.reservedRasterBytes();
    const cpuDirectFrameMs: number[] = [];
    const cpuDirectAnnotationMs: number[] = [];
    const cpuDirectHeatmapMs: number[] = [];
    let cpuDirectDraws = 0;
    let cpuDirectMisses = 0;
    let cpuDirectHits = 0;
    for (let i = 0; i < 6; i++) {
      const b = telemetry.snapshotPerformanceTelemetry();
      r.invalidate();
      await r.session.captureCompositePng();
      const a = telemetry.snapshotPerformanceTelemetry();
      const frame = metricDelta(b, a, "chart.frame.render.ms");
      const ann = metricDelta(b, a, "chart.surface.annotation.draw.ms");
      const hm = metricDelta(b, a, "chart.cpu.heatmap.draw.ms");
      if (frame.count > 0) cpuDirectFrameMs.push(frame.totalMs / frame.count);
      if (ann.count > 0) cpuDirectAnnotationMs.push(ann.totalMs / ann.count);
      if (hm.count > 0) cpuDirectHeatmapMs.push(hm.totalMs / hm.count);
      cpuDirectDraws += counterDelta(b, a, "chart.cpu.heatmap.raster.direct");
      cpuDirectMisses += counterDelta(b, a, "chart.cpu.heatmap.raster.miss");
      cpuDirectHits += counterDelta(b, a, "chart.cpu.heatmap.raster.hit");
    }
    r.orderbookHeatmap.setRasterCacheDisabledForTest(false);

    // Phase 1: CPU Cold (rasterCache miss — rebuilds 15k cells into offscreen rasterCache)
    const cpuColdFrameMs: number[] = [];
    const cpuColdAnnotationMs: number[] = [];
    const cpuColdHeatmapMs: number[] = [];
    let cpuColdMisses = 0;
    let cpuColdDirectDraws = 0;
    let cpuColdBudgetFallbacks = 0;
    for (let i = 0; i < 6; i++) {
      r.orderbookHeatmap.releaseRasterCache();
      const b = telemetry.snapshotPerformanceTelemetry();
      r.invalidate();
      await r.session.captureCompositePng();
      const a = telemetry.snapshotPerformanceTelemetry();
      const frame = metricDelta(b, a, "chart.frame.render.ms");
      const ann = metricDelta(b, a, "chart.surface.annotation.draw.ms");
      const hm = metricDelta(b, a, "chart.cpu.heatmap.draw.ms");
      if (frame.count > 0) cpuColdFrameMs.push(frame.totalMs / frame.count);
      if (ann.count > 0) cpuColdAnnotationMs.push(ann.totalMs / ann.count);
      if (hm.count > 0) cpuColdHeatmapMs.push(hm.totalMs / hm.count);
      cpuColdMisses += counterDelta(b, a, "chart.cpu.heatmap.raster.miss");
      cpuColdDirectDraws += counterDelta(b, a, "chart.cpu.heatmap.raster.direct");
      cpuColdBudgetFallbacks += counterDelta(b, a, "chart.cpu.heatmap.raster.budgetFallback");
    }
    const reservedDuringCpu = r.orderbookHeatmap.reservedRasterBytes();
    const moduleReservedDuringCpu = getHeatmapCpuRasterModuleReservedBytes();

    // Phase 2: CPU Warm (rasterCache hit — blits cached 15k bitmap without cell loop)
    // One warm-up frame ensures steady warm hit path cleanly.
    r.invalidate();
    await r.session.captureCompositePng();
    const cpuWarmFrameMs: number[] = [];
    const cpuWarmAnnotationMs: number[] = [];
    const cpuWarmHeatmapMs: number[] = [];
    let cpuWarmHits = 0;
    let cpuWarmMisses = 0;
    for (let i = 0; i < 20; i++) {
      const b = telemetry.snapshotPerformanceTelemetry();
      r.invalidate();
      await r.session.captureCompositePng();
      const a = telemetry.snapshotPerformanceTelemetry();
      const frame = metricDelta(b, a, "chart.frame.render.ms");
      const ann = metricDelta(b, a, "chart.surface.annotation.draw.ms");
      const hm = metricDelta(b, a, "chart.cpu.heatmap.draw.ms");
      if (frame.count > 0) cpuWarmFrameMs.push(frame.totalMs / frame.count);
      if (ann.count > 0) cpuWarmAnnotationMs.push(ann.totalMs / ann.count);
      if (hm.count > 0) cpuWarmHeatmapMs.push(hm.totalMs / hm.count);
      cpuWarmHits += counterDelta(b, a, "chart.cpu.heatmap.raster.hit");
      cpuWarmMisses += counterDelta(b, a, "chart.cpu.heatmap.raster.miss");
    }

    // Same viewport-changing workload for direct and adaptive paths. The injected
    // clock makes every sampled frame active motion independently of CI wall time.
    // Waiting on requestAnimationFrame after draining two trailing frames avoids
    // captureCompositePng()'s async PNG encoding gap so background timers cannot
    // squeeze an extra render between telemetry snapshots.
    const waitNextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const motionOverlay = r.orderbookHeatmap as typeof r.orderbookHeatmap & { now: () => number };
    const originalNow = motionOverlay.now;
    let motionClock = originalNow();
    motionOverlay.now = () => motionClock;
    const panSampleValues: Record<string, { heatmapMs: number[]; directs: number; misses: number; hits: number; skips: number }> = {
      direct: { heatmapMs: [], directs: 0, misses: 0, hits: 0, skips: 0 },
      adaptive: { heatmapMs: [], directs: 0, misses: 0, hits: 0, skips: 0 },
    };
    const samplePanFrame = async (name: "direct" | "adaptive", direct: boolean) => {
      v.offsetX = calibratedOffsetX;
      r.orderbookHeatmap.setRasterCacheDisabledForTest(direct);
      r.orderbookHeatmap.releaseRasterCache();
      r.invalidate();
      await r.session.captureCompositePng();
      await waitNextFrame();
      await waitNextFrame();
      motionClock += 16;
      v.offsetX += 0.25;
      const b = telemetry.snapshotPerformanceTelemetry();
      r.invalidate();
      await waitNextFrame();
      const a = telemetry.snapshotPerformanceTelemetry();
      const hm = metricDelta(b, a, "chart.cpu.heatmap.draw.ms");
      const sample = panSampleValues[name];
      if (hm.count > 0) sample.heatmapMs.push(hm.totalMs / hm.count);
      sample.directs += counterDelta(b, a, "chart.cpu.heatmap.raster.direct");
      sample.misses += counterDelta(b, a, "chart.cpu.heatmap.raster.miss");
      sample.hits += counterDelta(b, a, "chart.cpu.heatmap.raster.hit");
      sample.skips += counterDelta(b, a, "chart.cpu.heatmap.raster.skip");
    };
    // Pair each direct/adaptive observation from the same baseline viewport and
    // alternate which path runs first to balance time/order effects (AB, BA, ...).
    for (let pair = 0; pair < 30; pair++) {
      const order: readonly (readonly ["direct" | "adaptive", boolean])[] = pair % 2 === 0
        ? [["direct", true], ["adaptive", false]]
        : [["adaptive", false], ["direct", true]];
      for (const [name, direct] of order) await samplePanFrame(name, direct);
    }
    const trimmedMean = (values: number[], trimFraction = 0.1) => {
      const sorted = [...values].sort((a, b) => a - b);
      const trimCount = Math.floor(sorted.length * trimFraction);
      const retained = sorted.slice(trimCount, sorted.length - trimCount);
      return retained.reduce((total, value) => total + value, 0) / retained.length;
    };
    const pairedBlockRatios: number[] = [];
    const pairedBlockCount = Math.floor(Math.min(
      panSampleValues.direct.heatmapMs.length,
      panSampleValues.adaptive.heatmapMs.length,
    ) / 2);
    for (let block = 0; block < pairedBlockCount; block++) {
      const start = block * 2;
      const directBlock = panSampleValues.direct.heatmapMs.slice(start, start + 2);
      const adaptiveBlock = panSampleValues.adaptive.heatmapMs.slice(start, start + 2);
      const directMean = directBlock.reduce((total, value) => total + value, 0) / directBlock.length;
      const adaptiveMean = adaptiveBlock.reduce((total, value) => total + value, 0) / adaptiveBlock.length;
      pairedBlockRatios.push(directMean > 0 ? adaptiveMean / directMean : Number.POSITIVE_INFINITY);
    }
    const panSamples = {
      direct: { ...panSampleValues.direct, heatmapMs: summarize(panSampleValues.direct.heatmapMs) },
      adaptive: { ...panSampleValues.adaptive, heatmapMs: summarize(panSampleValues.adaptive.heatmapMs) },
      paired: {
        samples: Math.min(panSampleValues.direct.heatmapMs.length, panSampleValues.adaptive.heatmapMs.length),
        blocks: pairedBlockCount,
        adaptiveToDirectTrimmedMeanRatio: trimmedMean(pairedBlockRatios),
        trimFraction: 0.1,
        blockOrder: "ABBA (direct, adaptive, adaptive, direct)",
      },
    };
    v.offsetX = calibratedOffsetX;
    r.orderbookHeatmap.setRasterCacheDisabledForTest(false);
    r.orderbookHeatmap.releaseRasterCache();
    motionOverlay.now = originalNow;

    // Phase 3: GPU Prototype Cold + Steady (takeover releases CPU rasterCache immediately)
    r.heatmapTexturePrototypeEnabled = true;
    await r.whenHeatmapGpuRendererReady();
    r.invalidate();
    await r.session.captureCompositePng();
    const reservedAfterGpuTakeover = r.orderbookHeatmap.reservedRasterBytes();
    const moduleReservedAfterGpuTakeover = getHeatmapCpuRasterModuleReservedBytes();

    const gpuColdFrameMs: number[] = [];
    const gpuColdPrepareMs: number[] = [];
    const gpuColdRenderMs: number[] = [];
    const calibratedPriceTop = v.priceTop;
    for (let i = 0; i < 6; i++) {
      v.priceTop = i % 2 === 0 ? calibratedPriceTop + 0.05 : calibratedPriceTop;
      const b = telemetry.snapshotPerformanceTelemetry();
      r.invalidate();
      await r.session.captureCompositePng();
      const a = telemetry.snapshotPerformanceTelemetry();
      const frame = metricDelta(b, a, "chart.frame.render.ms");
      const prep = metricDelta(b, a, "chart.gpu.heatmap.prepare.ms");
      const rend = metricDelta(b, a, "chart.gpu.heatmap.render.ms");
      if (frame.count > 0) gpuColdFrameMs.push(frame.totalMs / frame.count);
      if (prep.count > 0) gpuColdPrepareMs.push(prep.totalMs / prep.count);
      if (rend.count > 0) gpuColdRenderMs.push(rend.totalMs / rend.count);
    }
    v.priceTop = calibratedPriceTop;
    r.invalidate();
    await r.session.captureCompositePng();

    const gpuWarmFrameMs: number[] = [];
    const gpuWarmRenderMs: number[] = [];
    let gpuWarmCpuHeatmapDraws = 0;
    for (let i = 0; i < 20; i++) {
      const b = telemetry.snapshotPerformanceTelemetry();
      r.invalidate();
      await r.session.captureCompositePng();
      const a = telemetry.snapshotPerformanceTelemetry();
      const frame = metricDelta(b, a, "chart.frame.render.ms");
      const rend = metricDelta(b, a, "chart.gpu.heatmap.render.ms");
      const cpuDraw = metricDelta(b, a, "chart.cpu.heatmap.draw.ms");
      if (frame.count > 0) gpuWarmFrameMs.push(frame.totalMs / frame.count);
      if (rend.count > 0) gpuWarmRenderMs.push(rend.totalMs / rend.count);
      gpuWarmCpuHeatmapDraws += cpuDraw.count;
    }

    // Phase 4: Return to CPU -> hide/show panel (IntersectionObserver + setVisible) -> mode === "off".
    r.heatmapTexturePrototypeEnabled = false;
    r.invalidate();
    await r.session.captureCompositePng();
    const reservedAfterGpuOff = r.orderbookHeatmap.reservedRasterBytes();

    const waitUntil = (predicate: () => boolean, label: string): Promise<void> =>
      new Promise((resolve, reject) => {
        let frames = 0;
        const step = () => {
          if (predicate()) {
            resolve();
            return;
          }
          if (++frames >= 120) {
            reject(new Error(`Timed out waiting for ${label}`));
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });

    root.style.display = "none";
    await waitUntil(
      () => r.orderbookHeatmap.reservedRasterBytes() === 0 && getHeatmapCpuRasterModuleReservedBytes() === 0,
      "hidden panel IntersectionObserver rasterCache release",
    );
    const reservedAfterContainerHide = r.orderbookHeatmap.reservedRasterBytes();
    const moduleReservedAfterContainerHide = getHeatmapCpuRasterModuleReservedBytes();

    const becameVisible = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        io.disconnect();
        reject(new Error("Timed out waiting for restored panel IntersectionObserver"));
      }, 5_000);
      const io = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last?.isIntersecting) {
          clearTimeout(deadline);
          io.disconnect();
          resolve();
        }
      });
      io.observe(annotation);
    });
    root.style.display = "";
    await becameVisible;
    r.invalidate();
    await r.session.captureCompositePng();
    const reservedAfterContainerShow = r.orderbookHeatmap.reservedRasterBytes();
    const moduleReservedAfterContainerShow = getHeatmapCpuRasterModuleReservedBytes();

    r.orderbookHeatmap.setVisible(false);
    const reservedImmediatelyOnSetVisibleFalse = r.orderbookHeatmap.reservedRasterBytes();
    const moduleReservedImmediatelyOnSetVisibleFalse = getHeatmapCpuRasterModuleReservedBytes();
    r.orderbookHeatmap.setVisible(true);
    r.invalidate();
    await r.session.captureCompositePng();
    const reservedAfterSetVisibleTrue = r.orderbookHeatmap.reservedRasterBytes();

    setOrderbookHeatmapModeFor("BINANCE_FUTURES:btcusdt", "off");
    const reservedImmediatelyOnModeOff = r.orderbookHeatmap.reservedRasterBytes();
    const moduleReservedImmediatelyOnModeOff = getHeatmapCpuRasterModuleReservedBytes();
    r.invalidate();
    await r.session.captureCompositePng();
    const reservedAfterModeOffPaint = r.orderbookHeatmap.reservedRasterBytes();
    const moduleReservedAfterModeOffPaint = getHeatmapCpuRasterModuleReservedBytes();

    return {
      continuousPan: panSamples,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      annotationCanvas: { width: annotation.width, height: annotation.height, expectedRasterBytes },
      budgets: {
        perChartBytes: HEATMAP_CPU_RASTER_CHART_BUDGET_BYTES,
        moduleBytes: HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES,
      },
      visibleCells: visibleCellsMain,
      cpuDirect: {
        draws: cpuDirectDraws,
        misses: cpuDirectMisses,
        hits: cpuDirectHits,
        reservedDuringDirect,
        frameMs: summarize(cpuDirectFrameMs),
        annotationMs: summarize(cpuDirectAnnotationMs),
        heatmapMs: summarize(cpuDirectHeatmapMs),
      },
      cpuCold: {
        misses: cpuColdMisses,
        directDraws: cpuColdDirectDraws,
        budgetFallbacks: cpuColdBudgetFallbacks,
        frameMs: summarize(cpuColdFrameMs),
        annotationMs: summarize(cpuColdAnnotationMs),
        heatmapMs: summarize(cpuColdHeatmapMs),
      },
      cpuWarm: {
        hits: cpuWarmHits,
        misses: cpuWarmMisses,
        frameMs: summarize(cpuWarmFrameMs),
        annotationMs: summarize(cpuWarmAnnotationMs),
        heatmapMs: summarize(cpuWarmHeatmapMs),
      },
      gpuCold: {
        frameMs: summarize(gpuColdFrameMs),
        prepareMs: summarize(gpuColdPrepareMs),
        renderMs: summarize(gpuColdRenderMs),
      },
      gpuWarm: {
        cpuHeatmapDrawsDuringGpu: gpuWarmCpuHeatmapDraws,
        frameMs: summarize(gpuWarmFrameMs),
        renderMs: summarize(gpuWarmRenderMs),
      },
      memoryBytes: {
        reservedDuringCpu,
        moduleReservedDuringCpu,
        reservedAfterGpuTakeover,
        moduleReservedAfterGpuTakeover,
        reservedAfterGpuOff,
        reservedAfterContainerHide,
        moduleReservedAfterContainerHide,
        reservedAfterContainerShow,
        moduleReservedAfterContainerShow,
        reservedImmediatelyOnSetVisibleFalse,
        moduleReservedImmediatelyOnSetVisibleFalse,
        reservedAfterSetVisibleTrue,
        reservedImmediatelyOnModeOff,
        moduleReservedImmediatelyOnModeOff,
        reservedAfterModeOffPaint,
        moduleReservedAfterModeOffPaint,
      },
    };
  }, {
    id,
    barsCount: BARS_COUNT,
    expectedCells: EXPECTED_VISIBLE_CELLS,
    basePrice: BASE_PRICE,
    bucketStep: BUCKET_STEP,
    levelsPerBar: LEVELS_PER_BAR,
    intervalMs: INTERVAL_MS,
  });

  console.log("HEATMAP_15K_SWIFTSHADER_EVIDENCE", JSON.stringify(report));
  console.log("HEATMAP_15K_PAN_SUMMARY", JSON.stringify({
    cpuWarm: { hits: report.cpuWarm.hits, misses: report.cpuWarm.misses, heatmapMs: report.cpuWarm.heatmapMs },
    continuousPan: report.continuousPan,
  }));
  await testInfo.attach("heatmap-15k-swiftshader-evidence.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });

  expect(report.visibleCells).toBe(EXPECTED_VISIBLE_CELLS);
  expect(report.cpuDirect.draws).toBe(6);
  expect(report.cpuDirect.misses).toBe(0);
  expect(report.cpuDirect.hits).toBe(0);
  expect(report.cpuDirect.reservedDuringDirect).toBe(0);
  expect(report.cpuCold.misses).toBe(6);
  expect(report.cpuCold.directDraws).toBe(0);
  expect(report.cpuCold.budgetFallbacks).toBe(0);
  expect(report.cpuWarm.hits).toBe(20);
  expect(report.cpuWarm.misses).toBe(0);
  expect(report.cpuWarm.heatmapMs.meanMs).toBeLessThan(0.1);
  expect(report.continuousPan.direct.heatmapMs.samples).toBe(30);
  expect(report.continuousPan.direct.directs).toBe(30);
  expect(report.continuousPan.direct.misses).toBe(0);
  expect(report.continuousPan.direct.hits).toBe(0);
  expect(report.continuousPan.direct.skips).toBe(0);
  expect(report.continuousPan.adaptive.heatmapMs.samples).toBe(30);
  expect(report.continuousPan.adaptive.skips).toBe(30);
  expect(report.continuousPan.adaptive.directs).toBe(30);
  expect(report.continuousPan.adaptive.misses).toBe(0);
  expect(report.continuousPan.adaptive.hits).toBe(0);
  expect(report.continuousPan.paired.samples).toBe(30);
  expect(report.continuousPan.paired.adaptiveToDirectTrimmedMeanRatio).toBeLessThanOrEqual(1.1);
  expect(report.gpuCold.prepareMs.samples).toBe(6);
  expect(report.gpuCold.renderMs.samples).toBe(6);
  expect(report.gpuWarm.renderMs.samples).toBe(20);
  expect(report.gpuWarm.cpuHeatmapDrawsDuringGpu).toBe(0);

  expect(report.memoryBytes.reservedDuringCpu).toBe(report.annotationCanvas.expectedRasterBytes);
  expect(report.memoryBytes.moduleReservedDuringCpu).toBe(report.annotationCanvas.expectedRasterBytes);
  expect(report.memoryBytes.reservedAfterGpuTakeover).toBe(0);
  expect(report.memoryBytes.moduleReservedAfterGpuTakeover).toBe(0);
  expect(report.memoryBytes.reservedAfterGpuOff).toBe(report.annotationCanvas.expectedRasterBytes);
  expect(report.memoryBytes.reservedAfterContainerHide).toBe(0);
  expect(report.memoryBytes.moduleReservedAfterContainerHide).toBe(0);
  expect(report.memoryBytes.reservedAfterContainerShow).toBe(report.annotationCanvas.expectedRasterBytes);
  expect(report.memoryBytes.moduleReservedAfterContainerShow).toBe(report.annotationCanvas.expectedRasterBytes);
  expect(report.memoryBytes.reservedImmediatelyOnSetVisibleFalse).toBe(0);
  expect(report.memoryBytes.moduleReservedImmediatelyOnSetVisibleFalse).toBe(0);
  expect(report.memoryBytes.reservedAfterSetVisibleTrue).toBe(report.annotationCanvas.expectedRasterBytes);
  expect(report.memoryBytes.reservedImmediatelyOnModeOff).toBe(0);
  expect(report.memoryBytes.moduleReservedImmediatelyOnModeOff).toBe(0);
  expect(report.memoryBytes.reservedAfterModeOffPaint).toBe(0);
  expect(report.memoryBytes.moduleReservedAfterModeOffPaint).toBe(0);
});

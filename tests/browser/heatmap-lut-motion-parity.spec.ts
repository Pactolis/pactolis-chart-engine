import { expect, test, type Page } from "@playwright/test";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import type { View } from "../../src/core/engine/view.js";
import type { FootprintSeries } from "../../src/core/model/footprint.js";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

const BARS_COUNT = 60;
const BASE_PRICE = 50_000;
const BUCKET_STEP = 50;
const HOOK_SELECTOR = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

type RuntimeProbe = {
  heatmapTexturePrototypeEnabled: boolean;
  view: View;
  pipeline: { series: FootprintSeries };
  getState(): ChartPanelState;
  updateState(state: ChartPanelState): void;
  setVisibleTimeRange(range: { from: number; to: number }): void;
  invalidate(): void;
  orderbookHeatmap: {
    bars: Map<number, { t: number; cells: Array<[number, number, number]> }>;
    chunks: Map<number, { status: string }>;
    inFlight: Set<AbortController>;
    now: () => number;
    applyLiveTailBars(bars: Array<{ t: number; cells: Array<[number, number, number]> }>, market?: string): void;
    prepareGpuCells(view: View, series: FootprintSeries, range: [number, number]): {
      main: Array<{ x: number; yTop: number; width: number; height: number; value: number }>;
      extension: Array<{ x: number; yTop: number; width: number; height: number; value: number }>;
      floor: number;
      ceiling: number;
    } | null;
    reservedRasterBytes(): number;
    releaseRasterCache(): void;
    setRasterCacheDisabledForTest(disabled: boolean): void;
  };
};

async function installFixture(page: Page): Promise<{ id: string; getHeatmapRequests: () => number }> {
  await page.setViewportSize({ width: 1200, height: 700 });
  const bars = buildBars(BARS_COUNT).map((bar) => ({
    ...bar,
    o: BASE_PRICE + 250,
    h: BASE_PRICE + 750,
    l: BASE_PRICE,
    c: BASE_PRICE + 300,
    v: 10,
    d: 1,
    n: 10,
    cells: [
      [BASE_PRICE, 5, 5, 0, 0, 10, 5, 5],
      [BASE_PRICE + 300, 5, 5, 0, 0, 10, 5, 5],
    ],
    lb: 0,
    ls: 0,
  }));

  // Price levels: 50_000 (10 BTC, below 20 BTC), 50_100 (25 BTC), 50_600 (60 BTC), 50_700 (120 BTC)
  // Kept >= 150 USD (3 * BUCKET_STEP) away from close = 50_300 for clean pixel sampling.
  const makeCells = (shift = 0): Array<[number, number, number]> => {
    const levels: Array<[number, number]> = [
      [BASE_PRICE, 10],
      [BASE_PRICE + 100, 25 + shift],
      [BASE_PRICE + 600, 60],
      [BASE_PRICE + 700, 120],
    ];
    return levels.map(([price, btc]) => {
      const mid = price + BUCKET_STEP / 2;
      const usd = Math.round(btc * mid);
      const bid = Math.floor(usd / 2);
      return [price, bid, usd - bid];
    });
  };
  const heatmapBars = bars.map((bar) => ({ t: bar.t, cells: makeCells(0) }));

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
          footprint: { available: true, allowed: true, priceStep: BUCKET_STEP },
          footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to },
        };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars }, meta }) });
  });

  let heatmapRequests = 0;
  await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, (route) => {
    heatmapRequests++;
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

  await openHarness(page, `?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=${BUCKET_STEP}&priceStepResolved=0`);
  const hook = page.locator(HOOK_SELECTOR);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  await expect(hook).toHaveAttribute("data-series-len", String(BARS_COUNT));
  const id = await hook.getAttribute("data-panel-id");
  if (!id) throw new Error("Missing panel id");
  return { id, getHeatmapRequests: () => heatmapRequests };
}

test("LUT 0.65/0.85 pixel parity, motion reuse + post-settle zoom parity, live-tail patch, and #262 threshold filter", async ({ page }) => {
  test.setTimeout(60_000);
  const { id, getHeatmapRequests } = await installFixture(page);

  const result = await page.evaluate(async ({ id, barsCount, basePrice, bucketStep }) => {
    const [
      harness,
      telemetry,
      { settings },
      { getHeatmapCpuRasterModuleReservedBytes, HEATMAP_CPU_RASTER_QUIET_MS },
      { heatmapCellRgba, heatmapIntensity },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/src/core/performanceTelemetry.ts"),
      import("/src/core/settings.ts"),
      import("/src/features/orderbook/heatmapOverlay.ts"),
      import("/src/features/orderbook/heatmapModel.ts"),
    ]);

    settings.grid = false;
    const r = harness.getChartRuntime(id) as unknown as RuntimeProbe;
    r.heatmapTexturePrototypeEnabled = false;
    r.updateState({ ...r.getState(), chartType: "candlestick", scaleMode: "linear" });

    const waitNextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const waitUntil = async (pred: () => boolean, label: string) => {
      const deadline = performance.now() + 15_000;
      while (!pred()) {
        if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((res) => setTimeout(res, 20));
      }
    };

    await waitNextFrame();
    await waitNextFrame();
    const s = r.pipeline.series;
    r.setVisibleTimeRange({ from: s.timeOfIndex(0), to: s.timeOfIndex(barsCount - 1) });
    r.view.fitPriceRange(basePrice - 150, basePrice + 850, 0.05);
    const plotW = r.view.area.width * 0.78;
    r.view.colWidth = plotW / barsCount;
    r.view.offsetX = 12;

    harness.updateOrderbookHeatmapSettings({
      mode: "single",
      unit: "btc",
      bucketStep,
      opacity: 0.65,
      scaleMode: "auto",
      contrast: "medium",
      single: { usd: 0, btc: 10 },
      aggregated: { usd: 0, btc: 10 },
    });
    harness.setOrderbookHeatmapModeFor("BINANCE_FUTURES:btcusdt", "single");

    await waitUntil(() => {
      const hm = r.orderbookHeatmap;
      return hm.bars.size >= barsCount && hm.inFlight.size === 0
        && hm.chunks.size > 0 && [...hm.chunks.values()].every((c) => c.status === "ready");
    }, "heatmap load");

    const root = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`)?.parentElement!;
    const annotation = root.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]')!;
    const ctx2d = annotation.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;

    const expectedStraightRgba = (value: number, floor: number, ceiling: number, alphaScale: number, opacity: number) => {
      const k = heatmapIntensity(value, floor, ceiling);
      const rgba = heatmapCellRgba(k, alphaScale, opacity);
      const ref = document.createElement("canvas");
      ref.width = 1;
      ref.height = 1;
      const refCtx = ref.getContext("2d")!;
      refCtx.fillStyle = `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a.toFixed(3)})`;
      refCtx.fillRect(0, 0, 1, 1);
      const d = refCtx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    };

    const sampleCell = (cell: { x: number; yTop: number; width: number; height: number }) => {
      const px = Math.min(annotation.width - 1, Math.max(0, Math.floor((cell.x + cell.width * 0.5) * dpr)));
      const py = Math.min(annotation.height - 1, Math.max(0, Math.floor((cell.yTop + cell.height * 0.5) * dpr)));
      const d = ctx2d.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    };

    const maxDiff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

    // 1. 0.65 and 0.85 opacity pixel parity (normal cell + live extension 0.45)
    const parityChecks: Array<{ opacity: number; normalDiff: number; liveDiff: number }> = [];
    for (const opacity of [0.65, 0.85]) {
      harness.updateOrderbookHeatmapSettings({ opacity });
      r.orderbookHeatmap.releaseRasterCache();
      r.invalidate();
      await waitNextFrame();
      await waitNextFrame();
      const gpuFrame = r.orderbookHeatmap.prepareGpuCells(r.view, s, [0, barsCount - 1])!;
      const closePrice = basePrice + 300;
      const mainSafe = gpuFrame.main.filter((c) => {
        const py = c.yTop + c.height * 0.5;
        return Math.abs(r.view.priceOfY(py) - closePrice) >= 3 * bucketStep
          && c.x >= r.view.area.left + 8 && c.x + c.width <= r.view.area.left + r.view.area.width - 8;
      });
      const extSafe = gpuFrame.extension.filter((c) => {
        const py = c.yTop + c.height * 0.5;
        return Math.abs(r.view.priceOfY(py) - closePrice) >= 3 * bucketStep;
      });
      const normalCell = mainSafe[Math.floor(mainSafe.length / 2)];
      const liveCell = extSafe[Math.floor(extSafe.length / 2)];
      const normalDiff = maxDiff(
        sampleCell(normalCell),
        expectedStraightRgba(normalCell.value, gpuFrame.floor, gpuFrame.ceiling, 1, opacity),
      );
      const liveDiff = maxDiff(
        sampleCell(liveCell),
        expectedStraightRgba(liveCell.value, gpuFrame.floor, gpuFrame.ceiling, 0.45, opacity),
      );
      parityChecks.push({ opacity, normalDiff, liveDiff });
    }

    // 2. Motion reuse during pan & zoom (1-canvas budget), plus post-settle zoom pixel parity vs cache-disabled direct draw
    let simClock = Date.now();
    const origNow = r.orderbookHeatmap.now;
    r.orderbookHeatmap.now = () => simClock;
    telemetry.configurePerformanceTelemetry({ enabled: true });

    const expectedBytes = annotation.width * annotation.height * 4;
    r.orderbookHeatmap.releaseRasterCache();
    r.invalidate();
    await waitNextFrame(); // warm cache miss at base view

    const beforeMotion = telemetry.snapshotPerformanceTelemetry().counters;
    simClock += 16;
    r.view.panX(14);
    r.invalidate();
    await waitNextFrame();
    const reservedDuringPan = r.orderbookHeatmap.reservedRasterBytes();
    const moduleReservedDuringPan = getHeatmapCpuRasterModuleReservedBytes();

    simClock += 16;
    r.view.zoomX(1.25, r.view.area.left + r.view.area.width * 0.5);
    r.invalidate();
    await waitNextFrame();
    const afterMotion = telemetry.snapshotPerformanceTelemetry().counters;

    // Settle past quiet interval -> full rebuild (miss)
    simClock += HEATMAP_CPU_RASTER_QUIET_MS + 10;
    r.invalidate();
    await waitNextFrame();
    const afterSettle = telemetry.snapshotPerformanceTelemetry().counters;

    const settledGpu = r.orderbookHeatmap.prepareGpuCells(r.view, s, [0, barsCount - 1])!;
    const settleSampleCell = settledGpu.main.find((c) => c.x >= r.view.area.left + 8 && c.x + c.width <= r.view.area.left + r.view.area.width - 8)!;
    const settledCachedPixel = sampleCell(settleSampleCell);

    r.orderbookHeatmap.setRasterCacheDisabledForTest(true);
    r.invalidate();
    await waitNextFrame();
    const directPixel = sampleCell(settleSampleCell);
    r.orderbookHeatmap.setRasterCacheDisabledForTest(false);
    r.invalidate();
    await waitNextFrame(); // restore raster cache

    // 3. Static live-tail patch (keep cells inside [25, 90] BTC so Auto P96 ceiling 120 BTC stays invariant)
    const beforePatch = telemetry.snapshotPerformanceTelemetry().counters;
    const liveT = s.timeOfIndex(s.length - 1);
    r.orderbookHeatmap.applyLiveTailBars([{
      t: liveT,
      cells: [
        [basePrice, Math.round(10 * (basePrice + bucketStep / 2) / 2), Math.round(10 * (basePrice + bucketStep / 2) / 2)],
        [basePrice + 100, Math.round(35 * (basePrice + 100 + bucketStep / 2) / 2), Math.round(35 * (basePrice + 100 + bucketStep / 2) / 2)],
        [basePrice + 600, Math.round(60 * (basePrice + 600 + bucketStep / 2) / 2), Math.round(60 * (basePrice + 600 + bucketStep / 2) / 2)],
        [basePrice + 700, Math.round(120 * (basePrice + 700 + bucketStep / 2) / 2), Math.round(120 * (basePrice + 700 + bucketStep / 2) / 2)],
      ],
    }]);
    r.invalidate();
    await waitNextFrame();
    const afterPatch = telemetry.snapshotPerformanceTelemetry().counters;

    // 4. #262 raising threshold clears below-threshold pixels in same frame with 0 refetches, lowering restores them
    const lowPriceCell = settledGpu.main.find((c) =>
      c.x >= r.view.area.left + 8 &&
      c.x + c.width <= r.view.area.left + r.view.area.width - 8 &&
      Math.abs(r.view.priceOfY(c.yTop + c.height * 0.5) - (basePrice + bucketStep / 2)) < bucketStep / 2
    )!;
    const pixelAt10Btc = sampleCell(lowPriceCell);
    const reqsBeforeThreshold = -1; // checked outside evaluate
    harness.updateOrderbookHeatmapSettings({ single: { usd: 0, btc: 50 }, aggregated: { usd: 0, btc: 50 } });
    r.invalidate();
    await waitNextFrame();
    const pixelAt50Btc = sampleCell(lowPriceCell);
    harness.updateOrderbookHeatmapSettings({ single: { usd: 0, btc: 10 }, aggregated: { usd: 0, btc: 10 } });
    r.invalidate();
    await waitNextFrame();
    const pixelRestored10Btc = sampleCell(lowPriceCell);

    r.orderbookHeatmap.now = origNow;

    return {
      parityChecks,
      motionReuseCount: (afterMotion["chart.cpu.heatmap.raster.motionReuse"] ?? 0) - (beforeMotion["chart.cpu.heatmap.raster.motionReuse"] ?? 0),
      settleMissCount: (afterSettle["chart.cpu.heatmap.raster.miss"] ?? 0) - (afterMotion["chart.cpu.heatmap.raster.miss"] ?? 0),
      tailPatchCount: (afterPatch["chart.cpu.heatmap.raster.tailPatch"] ?? 0) - (beforePatch["chart.cpu.heatmap.raster.tailPatch"] ?? 0),
      expectedBytes,
      reservedDuringPan,
      moduleReservedDuringPan,
      settledZoomDiff: maxDiff(settledCachedPixel, directPixel),
      pixelAt10Btc,
      pixelAt50Btc,
      pixelRestored10Btc,
      reqsBeforeThreshold,
    };
  }, { id, barsCount: BARS_COUNT, basePrice: BASE_PRICE, bucketStep: BUCKET_STEP });

  expect(result.parityChecks).toHaveLength(2);
  for (const check of result.parityChecks) {
    expect(check.normalDiff, `normal cell parity opacity=${check.opacity}`).toBeLessThanOrEqual(3);
    expect(check.liveDiff, `live ext parity opacity=${check.opacity}`).toBeLessThanOrEqual(3);
  }
  expect(result.motionReuseCount).toBeGreaterThanOrEqual(2);
  expect(result.settleMissCount).toBe(1);
  expect(result.settledZoomDiff).toBeLessThanOrEqual(2);
  expect(result.tailPatchCount).toBe(1);
  expect(result.reservedDuringPan).toBe(result.expectedBytes);
  expect(result.moduleReservedDuringPan).toBe(result.expectedBytes);
  expect(result.pixelAt10Btc[3]).toBeGreaterThan(0);
  expect(result.pixelAt50Btc).toEqual([0, 0, 0, 0]);
  expect(result.pixelRestored10Btc).toEqual(result.pixelAt10Btc);
  expect(getHeatmapRequests()).toBe(1);
});

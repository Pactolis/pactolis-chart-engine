import { expect, test } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
  viewport: { width: 1000, height: 600 },
});

function buildFootprintBars(count: number) {
  const alignedEnd = Math.floor(FROZEN_NOW / INTERVAL_MS) * INTERVAL_MS;
  const first = alignedEnd - (count - 1) * INTERVAL_MS;
  return Array.from({ length: count }, (_, idx) => ({
    t: first + idx * INTERVAL_MS,
    o: 100,
    h: 103,
    l: 100,
    c: 102,
    v: 85,
    d: 5,
    n: 15,
    cells: [
      [100, 30, 10, 4, 1],
      [101, 5, 25, 1, 5],
      [102, 15, 10, 3, 2],
    ],
    lb: 0,
    ls: 0,
    completeness: "complete",
    updatedAt: FROZEN_NOW,
  }));
}

test("Order Flow Profile oi-delta vs volume live tick browser performance and split rendering", async ({ page }) => {
  test.setTimeout(60_000);
  const bars = buildFootprintBars(60);

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });

  await page.route(/\/history(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { bars },
        meta: {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          footprint: { available: true, allowed: true, priceStep: 1 },
          footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to },
        },
      }),
    });
  });

  await openHarness(page, "?fit=60");

  const evidence = await page.evaluate(async () => {
    const [
      harness,
      { createHarnessServices },
      { createIndicatorInstanceAsync },
      { configureIndicatorDataSource },
      { configurePerformanceTelemetry, snapshotPerformanceTelemetry },
      { volumeProfileIndicatorDefinition },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
      import("/src/features/indicators/registry.ts"),
      import("/src/features/indicators/indicatorDataSource.ts"),
      import("/src/core/performanceTelemetry.ts"),
      import("/src/features/indicators/builtins/volumeProfile.ts"),
    ]);

    configurePerformanceTelemetry({ enabled: true });

    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:0;top:0;width:900px;height:500px;";
    document.body.appendChild(root);

    const vpInstance = await createIndicatorInstanceAsync("volume-profile", 0);
    vpInstance.settings.mode = "visible";
    vpInstance.settings.profileMetric = "volume";
    vpInstance.settings.maxWidth = 140;

    const services = createHarnessServices({ priceStep: 1, priceStepResolved: true });
    const market = "BINANCE_FUTURES:btcusdt";
    const panelId = "vp-oi-delta-perf";
    const chartState = {
      type: "chart",
      market,
      timeframe: "15m",
      scaleMode: "linear",
      chartType: "candlestick",
      candles: true,
      indicators: [vpInstance],
    } as any;

    const handle = harness.mountChart(
      root,
      chartState,
      services,
      panelId,
      harness.createChartSurfaceModel(),
    );

    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const rt = harness.getChartRuntime(panelId);
      if (rt && rt.pipeline.series.length >= 60) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const rt = harness.getChartRuntime(panelId)!;
    const allBars = rt.pipeline.series.listReadonly();
    const intervalMs = rt.pipeline.series.config.intervalMs;
    const oiPoints = allBars.map((b, i) => ({
      time: b.startTime,
      value: 10_000 + (i % 2 === 0 ? i * 15 : -i * 10),
    }));
    oiPoints.push({
      time: allBars[allBars.length - 1].startTime + intervalMs,
      value: 10_500,
    });

    configureIndicatorDataSource({
      requestLiquidationSeries: () => ({ status: "idle" }),
      requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
      requestFuturesPositioningSeries: () => ({ status: "idle" }),
      requestOpenInterestSeries: () => ({
        status: "ready",
        data: {
          unit: "base",
          resolution: "15m",
          venues: [
            { venue: "binance", points: oiPoints },
            { venue: "bybit", points: oiPoints.map((p) => ({ time: p.time, value: p.value * 0.5 })) },
          ],
        },
      }),
      fetchOptionsGexSurface: async () => {
        throw new Error("unused");
      },
    });

    const tailTime = allBars[allBars.length - 1].startTime;
    const makeCtx = () => ({
      ctx: (root.querySelector('[data-chart-surface="annotation"]') as HTMLCanvasElement).getContext("2d")!,
      series: rt.pipeline.series,
      range: [0, rt.pipeline.series.length] as [number, number],
      rect: { left: 0, top: 0, width: 900, height: 500 },
      settings: vpInstance.settings as any,
      instance: vpInstance,
      chart: { market, timeframe: "15m", intervalMs },
      view: rt.view,
      requestRefresh: () => {},
    });

    // 1. Warm up and measure volume mode live ticks
    await rt.session.captureCompositePng();
    volumeProfileIndicatorDefinition.prepareData(makeCtx());
    const ticks = 25;
    const volHitsBefore = snapshotPerformanceTelemetry().counters["indicator.incremental.hit.volumeProfile"] ?? 0;
    const volStart = performance.now();
    for (let k = 0; k < ticks; k += 1) {
      rt.pipeline.series.addTrades([{
        time: tailTime + 1_000 + k,
        price: 101,
        qty: 2,
        isBuy: k % 2 === 0,
        id: `browser-vol-${k}`,
      }]);
      volumeProfileIndicatorDefinition.prepareData(makeCtx());
      rt.invalidate();
      await rt.session.captureCompositePng();
    }
    const volumeLiveTicksMs = performance.now() - volStart;
    const volHitsAfter = snapshotPerformanceTelemetry().counters["indicator.incremental.hit.volumeProfile"] ?? 0;

    // 2. Switch to oi-delta mode, warm up, and measure live ticks
    vpInstance.settings.profileMetric = "oi-delta";
    vpInstance.settings.oiDeltaDisplay = "split";
    handle.updateState({ ...chartState, indicators: [{ ...vpInstance, settings: { ...vpInstance.settings } }] });
    await rt.session.captureCompositePng();
    const oiWarm = volumeProfileIndicatorDefinition.prepareData(makeCtx());

    const oiHitsBefore = snapshotPerformanceTelemetry().counters["indicator.incremental.hit.volumeProfile"] ?? 0;
    const oiStart = performance.now();
    for (let k = 0; k < ticks; k += 1) {
      rt.pipeline.series.addTrades([{
        time: tailTime + 2_000 + k,
        price: 102,
        qty: 2,
        isBuy: k % 2 === 0,
        id: `browser-oi-${k}`,
      }]);
      volumeProfileIndicatorDefinition.prepareData(makeCtx());
      rt.invalidate();
      await rt.session.captureCompositePng();
    }
    const oiDeltaLiveTicksMs = performance.now() - oiStart;
    const oiHitsAfter = snapshotPerformanceTelemetry().counters["indicator.incremental.hit.volumeProfile"] ?? 0;

    // 3. Verify split overlay draws rectangles
    const annotationCanvas = root.querySelector('[data-chart-surface="annotation"]') as HTMLCanvasElement;
    const ctx2d = annotationCanvas.getContext("2d")!;
    const origFillRect = ctx2d.fillRect.bind(ctx2d);
    let drawRectCount = 0;
    ctx2d.fillRect = function (x: number, y: number, w: number, h: number) {
      drawRectCount += 1;
      return origFillRect(x, y, w, h);
    };
    const finalPrepared = volumeProfileIndicatorDefinition.prepareData(makeCtx());
    volumeProfileIndicatorDefinition.drawPriceOverlay?.(makeCtx(), finalPrepared);

    handle.dispose();
    root.remove();

    return {
      ticks,
      volumeLiveTicksMs,
      oiDeltaLiveTicksMs,
      volumeIncrementalHits: volHitsAfter - volHitsBefore,
      oiDeltaIncrementalHits: oiHitsAfter - oiHitsBefore,
      oiStatus: oiWarm.status,
      drawRectCount,
    };
  });

  console.log("OI_DELTA_BROWSER_PERF", JSON.stringify(evidence));

  expect(evidence.oiStatus).toBe("ok");
  expect(evidence.volumeIncrementalHits).toBeGreaterThanOrEqual(evidence.ticks - 1);
  expect(evidence.oiDeltaIncrementalHits).toBeGreaterThanOrEqual(evidence.ticks - 1);
  expect(evidence.drawRectCount).toBeGreaterThanOrEqual(2);
  expect(evidence.oiDeltaLiveTicksMs).toBeLessThan(15_000);
});

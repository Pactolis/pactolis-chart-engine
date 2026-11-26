import { expect, test } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
  viewport: { width: 1000, height: 600 },
});

function buildBtcBars(count: number) {
  const alignedEnd = Math.floor(FROZEN_NOW / INTERVAL_MS) * INTERVAL_MS;
  const first = alignedEnd - (count - 1) * INTERVAL_MS;
  return Array.from({ length: count }, (_, idx) => {
    const base = 74_200 + Math.sin(idx * 0.25) * 300;
    return {
      t: first + idx * INTERVAL_MS,
      o: base,
      h: base + 120,
      l: base - 120,
      c: idx === count - 1 ? 74_430 : base + 40,
      v: 120,
      d: 10,
      n: 20,
      cells: [],
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: FROZEN_NOW,
    };
  });
}

test("Liquidation Profile renders BTC fixture in right/left placement and keeps 1,186-bucket pan bounded", async ({ page }) => {
  test.setTimeout(60_000);
  const bars = buildBtcBars(80);

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
          footprint: { available: false, allowed: false, priceStep: 10 },
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
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
      import("/src/features/indicators/registry.ts"),
      import("/src/features/indicators/indicatorDataSource.ts"),
    ]);

    const clusters = Array.from({ length: 1_186 }, (_, i) => {
      const price = 68_000 + i * 11;
      const isLong = price < 74_453;
      return {
        price,
        longNotional: isLong ? 50_000 + (i % 17) * 25_000 : 0,
        shortNotional: isLong ? 0 : 45_000 + (i % 19) * 22_000,
        longCount: isLong ? 1 + (i % 8) : 0,
        shortCount: isLong ? 0 : 1 + (i % 7),
      };
    });

    configureIndicatorDataSource({
      requestLiquidationSeries: () => ({ status: "idle" }),
      requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
      requestFuturesPositioningSeries: () => ({ status: "idle" }),
      fetchOptionsGexSurface: () => Promise.reject(new Error("unused")),
      requestLiquidationClusters: () => ({
        status: "ready",
        data: {
          status: "ready",
          source: "hyperliquid",
          hlCoin: "BTC",
          takenAt: Date.now() - 120_000,
          hlMarkPx: 74_453,
          hlMarkAt: Date.now() - 5_000,
          clusters,
        },
      }),
    });

    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:0;top:0;width:900px;height:500px;";
    document.body.appendChild(root);

    const lpInstance = await createIndicatorInstanceAsync("liquidation-profile", 0);
    lpInstance.settings.profileWidth = 140;
    lpInstance.settings.rangePct = 100;

    const services = createHarnessServices({ priceStep: 10, priceStepResolved: true });
    const panelId = "lp-browser-test";
    const baseState = {
      type: "chart",
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "15m",
      scaleMode: "linear",
      chartType: "candlestick",
      candles: true,
      indicators: [lpInstance],
    } as any;

    const handle = harness.mountChart(
      root,
      baseState,
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

    type RectCall = { x: number; y: number; w: number; h: number; alpha: number };
    const rects: RectCall[] = [];
    const annotationCanvas = root.querySelector('[data-chart-surface="annotation"]') as HTMLCanvasElement;
    const ctx2d = annotationCanvas.getContext("2d")!;
    const origFillRect = ctx2d.fillRect.bind(ctx2d);
    ctx2d.fillRect = function (x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, alpha: ctx2d.globalAlpha });
      return origFillRect(x, y, w, h);
    };

    const captureBars = async (placement: "right" | "left") => {
      handle.updateState({
        ...baseState,
        indicators: [{
          ...lpInstance,
          settings: { ...lpInstance.settings, profilePlacement: placement },
        }],
      } as any);
      rects.length = 0;
      rt.invalidate();
      await rt.session.captureCompositePng();
      return rects.filter((r) => Math.abs(r.alpha - 0.72) < 0.02 && r.h === 1 && r.w > 0);
    };

    const rightBars = await captureBars("right");
    const leftBars = await captureBars("left");

    // Pan benchmark across 10 frames with 1,186 buckets
    const frameTimesMs: number[] = [];
    for (let step = 0; step < 10; step += 1) {
      rects.length = 0;
      const t0 = performance.now();
      rt.view.panX(-25);
      rt.invalidate();
      await rt.session.captureCompositePng();
      frameTimesMs.push(performance.now() - t0);
    }

    const avgFrameMs = frameTimesMs.reduce((a, b) => a + b, 0) / frameTimesMs.length;
    const maxFrameMs = Math.max(...frameTimesMs);

    const areaLeft = rt.view.area.left;
    const areaRight = rt.view.area.left + rt.view.area.width;
    const areaHeight = rt.view.area.height;

    handle.dispose();
    root.remove();

    return {
      areaLeft,
      areaRight,
      areaHeight,
      rightCount: rightBars.length,
      leftCount: leftBars.length,
      rightAnchored: rightBars.some((r) => Math.abs((r.x + r.w) - (areaRight - 4)) < 1),
      leftAnchored: leftBars.some((r) => Math.abs(r.x - (areaLeft + 4)) < 1),
      avgFrameMs,
      maxFrameMs,
    };
  });

  console.log(
    `[liquidation-profile 1186-bucket pan] rightBars=${evidence.rightCount}, leftBars=${evidence.leftCount}, avgFrameMs=${evidence.avgFrameMs.toFixed(2)}, maxFrameMs=${evidence.maxFrameMs.toFixed(2)}`,
  );

  expect(evidence.rightCount).toBeGreaterThan(0);
  expect(evidence.rightCount).toBeLessThanOrEqual(Math.ceil(evidence.areaHeight) + 5);
  expect(evidence.leftCount).toBeGreaterThan(0);
  expect(evidence.rightAnchored).toBe(true);
  expect(evidence.leftAnchored).toBe(true);
});

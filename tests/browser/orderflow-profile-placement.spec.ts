import { expect, test } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
  viewport: { width: 1000, height: 600 },
});

function buildDeltaFootprintBars(count: number) {
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

test("Order Flow Profile indicator and Fixed-Range drawing render left/right placements including delta zero-axis", async ({ page }) => {
  test.setTimeout(60_000);
  const bars = buildDeltaFootprintBars(40);

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

  await openHarness(page, "?fit=40");

  const evidence = await page.evaluate(async () => {
    const [
      harness,
      { createHarnessServices },
      { createIndicatorInstanceAsync },
      { drawAnalysisDrawings },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
      import("/src/features/indicators/registry.ts"),
      import("/src/core/render/analysisDrawings.ts"),
    ]);

    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:0;top:0;width:900px;height:500px;";
    document.body.appendChild(root);

    const vpInstance = await createIndicatorInstanceAsync("volume-profile", 0);
    vpInstance.settings.maxWidth = 120;
    vpInstance.settings.mode = "visible";

    const services = createHarnessServices({ priceStep: 1, priceStepResolved: true });
    const market = "BINANCE_FUTURES:btcusdt";
    const panelId = "vp-placement-test";
    const baseState = {
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
      baseState,
      services,
      panelId,
      harness.createChartSurfaceModel(),
    );

    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const rt = harness.getChartRuntime(panelId);
      if (rt && rt.pipeline.series.length >= 40) break;
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

    const areaLeft = rt.view.area.left;
    const areaRight = rt.view.area.left + rt.view.area.width;
    const effectiveMaxWidth = Math.min(rt.view.area.width * 0.34, 120);

    const captureIndicatorRects = async (overrides: Record<string, unknown>) => {
      handle.updateState({
        ...baseState,
        indicators: [{
          ...vpInstance,
          settings: { ...vpInstance.settings, ...overrides },
        }],
      } as any);
      rects.length = 0;
      rt.invalidate();
      await rt.session.captureCompositePng();
      return rects.filter((r) => Math.abs(r.alpha - 0.55) < 0.01 && r.w > 0);
    };

    const indVolRight = await captureIndicatorRects({ profileMetric: "volume", profilePlacement: "right" });
    const indVolLeft = await captureIndicatorRects({ profileMetric: "volume", profilePlacement: "left" });
    const indDeltaRight = await captureIndicatorRects({ profileMetric: "delta", profilePlacement: "right" });
    const indDeltaLeft = await captureIndicatorRects({ profileMetric: "delta", profilePlacement: "left" });

    // Remove indicator from overlay before exercising drawAnalysisDrawings directly.
    handle.updateState({
      ...baseState,
      indicators: [{
        ...vpInstance,
        visible: false,
      }],
    } as any);
    rt.invalidate();
    await rt.session.captureCompositePng();

    const drawingFrom = rt.pipeline.series.timeOfIndex(5);
    const drawingTo = rt.pipeline.series.timeOfIndex(25);
    const rangeLeft = rt.view.xOfIndex(rt.pipeline.series.indexOfTime(drawingFrom));
    const rangeRight = rt.view.xOfIndex(rt.pipeline.series.indexOfTime(drawingTo)) + rt.view.colWidth;
    const rangeMaxWidth = Math.max(16, (rangeRight - rangeLeft) * 0.3);
    const drawingTime = {
      indexForTime: (time: number) => rt.pipeline.series.indexOfTime(time),
      timeForIndex: (index: number) => rt.pipeline.series.timeOfIndex(Math.round(index)),
    };

    const captureDrawingRects = (overrides: Record<string, unknown>) => {
      rects.length = 0;
      drawAnalysisDrawings(
        ctx2d,
        rt.view,
        rt.pipeline.series,
        drawingTime,
        [{
          id: "frvp-placement-test",
          type: "fixed-range-volume-profile",
          points: [
            { time: drawingFrom, price: 100 },
            { time: drawingTo, price: 103 },
          ],
          color: "#ffffff",
          lineWidth: 1,
          locked: false,
          visible: true,
          market,
          profileSide: "total",
          ...overrides,
        } as any],
        market,
      );
      return rects.filter((r) => Math.abs(r.alpha - 0.55) < 0.01 && r.w > 0);
    };

    const drawVolLeft = captureDrawingRects({ profileMetric: "volume" });
    const drawVolRight = captureDrawingRects({ profileMetric: "volume", profilePlacement: "right" });
    const drawDeltaLeft = captureDrawingRects({ profileMetric: "delta", profilePlacement: "left" });
    const drawDeltaRight = captureDrawingRects({ profileMetric: "delta", profilePlacement: "right" });

    handle.dispose();
    root.remove();

    return {
      areaLeft,
      areaRight,
      effectiveMaxWidth,
      rangeLeft,
      rangeRight,
      rangeMaxWidth,
      indVolRight,
      indVolLeft,
      indDeltaRight,
      indDeltaLeft,
      drawVolLeft,
      drawVolRight,
      drawDeltaLeft,
      drawDeltaRight,
    };
  });

  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

  // Indicator volume: right (default) vs left
  expect(evidence.indVolRight.length).toBeGreaterThan(0);
  expect(evidence.indVolRight.some((r) => near(r.x + r.w, evidence.areaRight - 4))).toBe(true);
  expect(evidence.indVolLeft.length).toBeGreaterThan(0);
  expect(evidence.indVolLeft.some((r) => near(r.x, evidence.areaLeft + 4))).toBe(true);

  // Indicator delta zero-axis: right vs left
  const indDeltaZeroRight = (evidence.areaRight - 4) - evidence.effectiveMaxWidth / 2;
  const indDeltaZeroLeft = (evidence.areaLeft + 4) + evidence.effectiveMaxWidth / 2;
  expect(evidence.indDeltaRight.some((r) => near(r.x, indDeltaZeroRight))).toBe(true);
  expect(evidence.indDeltaRight.some((r) => near(r.x + r.w, indDeltaZeroRight))).toBe(true);
  expect(evidence.indDeltaLeft.some((r) => near(r.x, indDeltaZeroLeft))).toBe(true);
  expect(evidence.indDeltaLeft.some((r) => near(r.x + r.w, indDeltaZeroLeft))).toBe(true);

  // Fixed-Range drawing volume: left (default) vs right
  expect(evidence.drawVolLeft.length).toBeGreaterThan(0);
  expect(evidence.drawVolLeft.some((r) => near(r.x, evidence.rangeLeft))).toBe(true);
  expect(evidence.drawVolRight.length).toBeGreaterThan(0);
  expect(evidence.drawVolRight.some((r) => near(r.x + r.w, evidence.rangeRight))).toBe(true);

  // Fixed-Range drawing delta zero-axis: left vs right
  const drawDeltaZeroLeft = evidence.rangeLeft + evidence.rangeMaxWidth / 2;
  const drawDeltaZeroRight = evidence.rangeRight - evidence.rangeMaxWidth / 2;
  expect(evidence.drawDeltaLeft.some((r) => near(r.x, drawDeltaZeroLeft))).toBe(true);
  expect(evidence.drawDeltaLeft.some((r) => near(r.x + r.w, drawDeltaZeroLeft))).toBe(true);
  expect(evidence.drawDeltaRight.some((r) => near(r.x, drawDeltaZeroRight))).toBe(true);
  expect(evidence.drawDeltaRight.some((r) => near(r.x + r.w, drawDeltaZeroRight))).toBe(true);
});

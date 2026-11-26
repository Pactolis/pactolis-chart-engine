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

test("Fixed-Range OI Delta: recordingStartedAt coverage, light/dark themes, annotation-only invalidation, and pan/zoom perf vs volume", async ({ page }) => {
  test.setTimeout(60_000);
  const bars = buildFootprintBars(80);

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

  await openHarness(page, "?fit=80");

  const evidence = await page.evaluate(async () => {
    const [
      harness,
      { createHarnessServices },
      { configureIndicatorDataSource },
      { ChartSurfaceDirty },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
      import("/src/features/indicators/indicatorDataSource.ts"),
      import("/src/core/render/scene/chartScene.ts"),
    ]);

    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:0;top:0;width:900px;height:500px;";
    document.body.appendChild(root);

    const services = createHarnessServices({ priceStep: 1, priceStepResolved: true });
    const market = "BINANCE_FUTURES:btcusdt";
    const panelId = "frvp-oi-delta-browser";
    const chartState = {
      type: "chart",
      market,
      timeframe: "15m",
      scaleMode: "linear",
      chartType: "candlestick",
      candles: true,
      indicators: [],
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
      if (rt && rt.pipeline.series.length >= 80) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const rt = harness.getChartRuntime(panelId)!;
    const allBars = rt.pipeline.series.listReadonly();
    const intervalMs = rt.pipeline.series.config.intervalMs;
    const recordingStartedAt = allBars[30].startTime;

    const oiPoints = allBars.map((b, i) => ({
      time: b.startTime,
      value: 10_000 + (i % 2 === 0 ? i * 25 : -i * 15),
    }));
    oiPoints.push({
      time: allBars[allBars.length - 1].startTime + intervalMs,
      value: 11_000,
    });

    let asyncStatus: "loading" | "ready" = "loading";
    let capturedOnUpdate: (() => void) | undefined;
    configureIndicatorDataSource({
      requestLiquidationSeries: () => ({ status: "idle" }),
      requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
      requestFuturesPositioningSeries: () => ({ status: "idle" }),
      requestOpenInterestSeries: (input) => {
        capturedOnUpdate = input.onUpdate;
        if (asyncStatus === "loading") return { status: "loading" };
        return {
          status: "ready",
          data: {
            status: "ok" as const,
            unit: "base",
            resolution: "15m",
            recordingStartedAt,
            venues: [
              { venue: "binance", points: oiPoints },
              { venue: "bybit", points: oiPoints.map((p) => ({ time: p.time, value: p.value * 0.5 })) },
            ],
          },
        };
      },
      fetchOptionsGexSurface: async () => { throw new Error("unused"); },
    });

    const drawings = services.drawings;
    const drawingFrom = allBars[15].startTime;
    const drawingTo = allBars[45].startTime;
    const frvpDrawing = {
      id: "frvp-oi-browser-1",
      type: "fixed-range-volume-profile" as const,
      points: [
        { time: drawingFrom, price: 100 },
        { time: drawingTo, price: 103 },
      ],
      color: "#ffffff",
      lineWidth: 1,
      opacity: 0.55,
      locked: false,
      visible: true,
      market,
      profileMetric: "oi-delta" as const,
      profileSide: "total" as const,
      oiDeltaDisplay: "split" as const,
      profilePlacement: "left" as const,
    };
    drawings.replace([frvpDrawing]);

    // Track surface invalidations to verify annotation-only invalidation on async OI update
    const origInvalidateSurface = rt.session.invalidateSurface.bind(rt.session);
    const invalidations: number[] = [];
    rt.session.invalidateSurface = (surfaces: number) => {
      invalidations.push(surfaces);
      return origInvalidateSurface(surfaces);
    };

    const annotationCanvas = root.querySelector('[data-chart-surface="annotation"]') as HTMLCanvasElement;
    const ctx2d = annotationCanvas.getContext("2d")!;
    const drawnTexts: string[] = [];
    let drawnRectCount = 0;
    const origFillText = ctx2d.fillText.bind(ctx2d);
    const origFillRect = ctx2d.fillRect.bind(ctx2d);
    ctx2d.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
      drawnTexts.push(String(text));
      return maxWidth !== undefined ? origFillText(text, x, y, maxWidth) : origFillText(text, x, y);
    };
    ctx2d.fillRect = function (x: number, y: number, w: number, h: number) {
      if (w > 0 && h > 0 && Math.abs(ctx2d.globalAlpha - 0.55) < 0.05) drawnRectCount += 1;
      return origFillRect(x, y, w, h);
    };

    // 1. Render while loading
    rt.invalidate();
    await rt.session.captureCompositePng();
    const loadingTextSeen = drawnTexts.some((t) => t.includes("OI") && (t.includes("yükleniyor") || t.includes("Loading")));

    // 2. Async onUpdate fires -> must invalidate ONLY Annotation surface
    invalidations.length = 0;
    drawnTexts.length = 0;
    drawnRectCount = 0;
    asyncStatus = "ready";
    capturedOnUpdate?.();
    const annotationOnlyInvalidation = invalidations.length === 1 && invalidations[0] === ChartSurfaceDirty.Annotation;
    await rt.session.captureCompositePng();
    const coverageBadgeSeen = drawnTexts.some((t) => (t.includes("OI kaydı") || t.includes("OI recorded since")) && (t.includes("50") || t.includes("48") || t.includes("52")));
    const darkRectCount = drawnRectCount;

    // 3. Light & Dark theme check
    document.documentElement.setAttribute("data-theme", "light");
    drawnRectCount = 0;
    rt.session.invalidateSurface(ChartSurfaceDirty.Annotation);
    await rt.session.captureCompositePng();
    const lightRectCount = drawnRectCount;
    document.documentElement.setAttribute("data-theme", "dark");

    // 4. Side-by-side pan/zoom frame duration measurement: oi-delta vs volume
    const measurePanZoom = async (metric: "oi-delta" | "volume") => {
      drawings.replace([{ ...frvpDrawing, profileMetric: metric }]);
      rt.invalidate();
      await rt.session.captureCompositePng();

      const steps = 20;
      const durations: number[] = [];
      for (let i = 0; i < steps; i += 1) {
        const deltaX = i % 2 === 0 ? -12 : 12;
        const t0 = performance.now();
        rt.view.panX(deltaX);
        if (i % 4 === 0) rt.view.zoomX(i % 8 === 0 ? 1.05 : 0.95, 450);
        rt.session.invalidateSurface(ChartSurfaceDirty.Annotation);
        await rt.session.captureCompositePng();
        durations.push(performance.now() - t0);
      }
      const totalMs = durations.reduce((s, d) => s + d, 0);
      const avgMs = totalMs / durations.length;
      const maxMs = Math.max(...durations);
      return { steps, totalMs, avgMs, maxMs };
    };

    const oiDeltaPanZoom = await measurePanZoom("oi-delta");
    const volumePanZoom = await measurePanZoom("volume");

    handle.dispose();
    root.remove();

    return {
      loadingTextSeen,
      annotationOnlyInvalidation,
      coverageBadgeSeen,
      darkRectCount,
      lightRectCount,
      oiDeltaPanZoom,
      volumePanZoom,
    };
  });

  console.log("FRVP_PAN_ZOOM_PERF", JSON.stringify({
    oiDelta: evidence.oiDeltaPanZoom,
    volume: evidence.volumePanZoom,
  }));

  expect(evidence.loadingTextSeen).toBe(true);
  expect(evidence.annotationOnlyInvalidation).toBe(true);
  expect(evidence.coverageBadgeSeen).toBe(true);
  expect(evidence.darkRectCount).toBeGreaterThanOrEqual(2);
  expect(evidence.lightRectCount).toBeGreaterThanOrEqual(2);
  expect(evidence.oiDeltaPanZoom.avgMs).toBeLessThan(250);
});

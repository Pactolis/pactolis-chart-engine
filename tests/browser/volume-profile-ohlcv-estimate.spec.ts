import { expect, test } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
  viewport: { width: 1000, height: 600 },
});

function buildOhlcvOnlyBars(count: number) {
  const alignedEnd = Math.floor(FROZEN_NOW / INTERVAL_MS) * INTERVAL_MS;
  const first = alignedEnd - (count - 1) * INTERVAL_MS;
  return Array.from({ length: count }, (_, idx) => ({
    t: first + idx * INTERVAL_MS,
    o: 100.5,
    h: 103,
    l: 100,
    c: 102,
    v: 30,
    d: 0,
    n: 0,
    cells: [],
    lb: 0,
    ls: 0,
    completeness: "complete",
    updatedAt: FROZEN_NOW,
  }));
}

function buildFootprintBars(count: number) {
  const alignedEnd = Math.floor(FROZEN_NOW / INTERVAL_MS) * INTERVAL_MS;
  const first = alignedEnd - (count - 1) * INTERVAL_MS;
  return Array.from({ length: count }, (_, idx) => ({
    t: first + idx * INTERVAL_MS,
    o: 100,
    h: 103,
    l: 100,
    c: 102,
    v: 50,
    d: 10,
    n: 10,
    cells: [
      [100, 6, 4, 2, 1],
      [101, 20, 10, 4, 2],
      [102, 4, 6, 1, 0],
    ],
    lb: 0,
    ls: 0,
    completeness: "complete",
    updatedAt: FROZEN_NOW,
  }));
}

test("Order Flow Profile renders Estimated OHLCV profile on non-footprint markets while preserving exact markets", async ({ page }) => {
  test.setTimeout(60_000);
  const ohlcvBars = buildOhlcvOnlyBars(40);
  const footprintBars = buildFootprintBars(40);

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });

  await page.route(/\/history(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const market = url.searchParams.get("markets") ?? "";
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (market === "BYBIT:solusdt") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: { bars: ohlcvBars },
          meta: {
            schemaVersion: 1,
            generatedAt: FROZEN_NOW,
            footprint: { available: false, allowed: false, priceStep: 1 },
          },
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { bars: footprintBars },
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
      { chartLocale, configureChartLocale },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
      import("/src/features/indicators/registry.ts"),
      import("/src/core/chartLocale.ts"),
    ]);

    const mountWithProfile = async (market: string, panelId: string, priceStep: number) => {
      const root = document.createElement("div");
      root.style.cssText = "position:fixed;left:0;top:0;width:900px;height:500px;";
      document.body.appendChild(root);

      const vpInstance = await createIndicatorInstanceAsync("volume-profile", 0);
      const services = createHarnessServices({ priceStep, priceStepResolved: true });
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
      const drawnTexts: string[] = [];
      const annotationCanvas = root.querySelector('[data-chart-surface="annotation"]') as HTMLCanvasElement;
      const ctx2d = annotationCanvas.getContext("2d")!;
      const origFillText = ctx2d.fillText.bind(ctx2d);
      ctx2d.fillText = function (text: string, x: number, y: number, maxW?: number) {
        drawnTexts.push(String(text));
        return maxW === undefined ? origFillText(text, x, y) : origFillText(text, x, y, maxW);
      };

      // Force one fresh overlay draw & snapshot readout.
      rt.invalidate();
      await rt.session.captureCompositePng();
      const enTexts = [...drawnTexts];

      const lastTime = rt.pipeline.series.timeOfIndex(rt.pipeline.series.length - 1);
      const snapTotal = rt.getAnalysisSnapshot({
        now: lastTime + 15 * 60_000,
        visibleTimeRange: { from: rt.pipeline.series.timeOfIndex(0), to: lastTime },
        maxLevelsAndDrawings: 0,
        maxIndicatorSamples: 1,
      });

      // Switch to TR locale fallback check for the overlay badge & delta fail-closed.
      const trTexts: string[] = [];
      const prevLocale = chartLocale();
      configureChartLocale({
        locale: () => "tr-TR",
        timeZone: () => "UTC",
        translate: (key) => key,
        onLocaleChange: () => () => {},
      });
      let snapDeltaTr: any;
      try {
        drawnTexts.length = 0;
        rt.invalidate();
        await rt.session.captureCompositePng();
        trTexts.push(...drawnTexts);

        handle.updateState({
          ...rt.getState(),
          indicators: [{ ...vpInstance, settings: { ...vpInstance.settings, profileMetric: "delta" } }],
        });
        await new Promise((r) => requestAnimationFrame(r));
        rt.invalidate();
        await rt.session.captureCompositePng();
        trTexts.push(...drawnTexts);
        snapDeltaTr = rt.getAnalysisSnapshot({
          now: lastTime + 15 * 60_000,
          visibleTimeRange: { from: rt.pipeline.series.timeOfIndex(0), to: lastTime },
          maxLevelsAndDrawings: 0,
          maxIndicatorSamples: 1,
        });
      } finally {
        configureChartLocale(prevLocale);
      }

      handle.dispose();
      root.remove();
      return {
        enTexts,
        snapTotalInd: snapTotal.indicators[0],
        trTexts,
        snapDeltaTrInd: snapDeltaTr.indicators[0],
      };
    };

    const exact = await mountWithProfile("BINANCE_FUTURES:btcusdt", "vp-exact", 1);
    const ohlcv = await mountWithProfile("BYBIT:solusdt", "vp-ohlcv", 1);
    return { exact, ohlcv };
  });

  // Exact market preserves normal numeric levels & delta support with zero Estimated/Tahmini tags.
  expect(evidence.exact.snapTotalInd.status).toBe("ok");
  expect(evidence.exact.snapTotalInd.warnings).toEqual([]);
  expect(evidence.exact.snapTotalInd.series.find((s: any) => s.key === "poc")?.samples[0]?.value).toBe(101);
  expect(evidence.exact.snapDeltaTrInd.status).toBe("ok");
  expect(evidence.exact.enTexts.some((t: string) => /estimated|tahmini/i.test(t))).toBe(false);
  expect(evidence.exact.trTexts.some((t: string) => /estimated|tahmini/i.test(t))).toBe(false);

  // OHLCV-only market produces deterministic estimated total volume profile with explicit EN/TR labels
  // and fails closed when switched to delta.
  expect(evidence.ohlcv.snapTotalInd.status).toBe("ok");
  expect(evidence.ohlcv.snapTotalInd.series.find((s: any) => s.key === "poc")?.samples[0]?.value).toBe(100);
  expect(evidence.ohlcv.snapTotalInd.warnings.some((w: string) => /Estimated/.test(w))).toBe(true);
  expect(evidence.ohlcv.enTexts.some((t: string) => t.includes("Estimated"))).toBe(true);
  expect(evidence.ohlcv.trTexts.some((t: string) => t.includes("Tahmini"))).toBe(true);
  expect(evidence.ohlcv.snapDeltaTrInd.status).toBe("no-data");
  expect(evidence.ohlcv.snapDeltaTrInd.warnings.some((w: string) => tHas(w, "Tahmini"))).toBe(true);
});

function tHas(value: string, needle: string): boolean {
  return value.includes(needle);
}

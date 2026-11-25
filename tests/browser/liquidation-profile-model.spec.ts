import { expect, test } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
  viewport: { width: 1000, height: 600 },
});

function buildBars(count: number, basePrice: number) {
  const alignedEnd = Math.floor(FROZEN_NOW / INTERVAL_MS) * INTERVAL_MS;
  const first = alignedEnd - (count - 1) * INTERVAL_MS;
  return Array.from({ length: count }, (_, idx) => {
    const base = basePrice + Math.sin(idx * 0.25) * (basePrice * 0.004);
    return {
      t: first + idx * INTERVAL_MS,
      o: base,
      h: base * 1.002,
      l: base * 0.998,
      c: idx === count - 1 ? basePrice : base * 1.0005,
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

test("Liquidation Profile auto mode renders Hyperliquid badge on BTC and Model badge on non-HL pair", async ({ page }) => {
  test.setTimeout(60_000);
  const btcBars = buildBars(80, 74_430);
  const wifBars = buildBars(80, 2.5);

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });

  await page.route(/\/history(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    const market = url.searchParams.get("market") ?? "";
    const bars = market.toLowerCase().includes("wif") ? wifBars : btcBars;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { bars },
        meta: {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          footprint: { available: false, allowed: false, priceStep: market.toLowerCase().includes("wif") ? 0.01 : 10 },
          footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to },
        },
      }),
    });
  });

  await openHarness(page, "?fit=60");

  const result = await page.evaluate(async () => {
    const [
      harness,
      { createHarnessServices },
      { createIndicatorInstanceAsync },
      { configureIndicatorDataSource },
      { encodeF32LeBase64 },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
      import("/src/features/indicators/registry.ts"),
      import("/src/features/indicators/indicatorDataSource.ts"),
      import("/src/core/analysis/liquidationModel.ts"),
    ]);

    const now = Date.now();
    const nbk = 400;
    const zeros = new Array(nbk).fill(0);
    const modelState = {
      schemaVersion: 1,
      modelVersion: 1,
      symbol: "WIFUSDT",
      params: {
        lev: [5, 10, 20, 25, 50, 100],
        lw: [0.25, 0.30, 0.20, 0.10, 0.10, 0.05],
        mmr: 0.004,
        bw: 0.001,
        p0: 2.0,
        nbk,
      },
      asOf: now - 600_000,
      lastOi: 100_000,
      longb: encodeF32LeBase64(zeros),
      shortb: encodeF32LeBase64(zeros),
      v1: { passed: true, tested: true, fallingBp: 14, risingBp: 12, bestPlaceboBp: 2, days: 200 },
      seam: [
        { t: now - 600_000, h: 2.51, l: 2.49, c: 2.5, v: 1000, tb: 550, oi: 100_000 },
      ],
    };
    const modelBars = [
      { t: now - 600_000, h: 2.51, l: 2.49, c: 2.5, v: 1000, tb: 550, oi: 100_000 },
      { t: now - 300_000, h: 2.52, l: 2.48, c: 2.5, v: 1200, tb: 700, oi: 120_000 },
    ];

    configureIndicatorDataSource({
      requestLiquidationSeries: () => ({ status: "idle" }),
      requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
      requestFuturesPositioningSeries: () => ({ status: "idle" }),
      fetchOptionsGexSurface: () => Promise.reject(new Error("unused")),
      requestLiquidationClusters: ({ market }) => {
        if (market.toLowerCase().includes("btc")) {
          return {
            status: "ready",
            data: {
              status: "ready",
              source: "hyperliquid",
              hlCoin: "BTC",
              takenAt: now - 60_000,
              hlMarkPx: 74_430,
              hlMarkAt: now - 5_000,
              clusters: [
                { price: 73_500, longNotional: 1_200_000, shortNotional: 0, longCount: 5, shortCount: 0 },
                { price: 75_500, longNotional: 0, shortNotional: 900_000, longCount: 0, shortCount: 4 },
              ],
            },
          };
        }
        return { status: "unsupported" };
      },
      requestLiquidationModel: ({ market }) => {
        if (market.toLowerCase().includes("wif")) {
          return { status: "ready", data: { status: "ready", state: modelState, bars: modelBars } };
        }
        return { status: "unsupported" };
      },
    });

    const runScenario = async (market: string, priceStep: number) => {
      const root = document.createElement("div");
      root.style.cssText = "position:fixed;left:0;top:0;width:900px;height:500px;";
      document.body.appendChild(root);

      const lpInstance = await createIndicatorInstanceAsync("liquidation-profile", 0);
      lpInstance.settings.rangePct = 100;
      lpInstance.settings.source = "auto";

      const services = createHarnessServices({ priceStep, priceStepResolved: true });
      const panelId = `lp-${market}`;
      const handle = harness.mountChart(
        root,
        {
          type: "chart",
          market,
          timeframe: "15m",
          scaleMode: "linear",
          chartType: "candlestick",
          candles: true,
          indicators: [lpInstance],
        } as any,
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

      const texts: string[] = [];
      const annotationCanvas = root.querySelector('[data-chart-surface="annotation"]') as HTMLCanvasElement;
      const ctx2d = annotationCanvas.getContext("2d")!;
      const origFillText = ctx2d.fillText.bind(ctx2d);
      ctx2d.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
        texts.push(String(text));
        return maxWidth === undefined ? origFillText(text, x, y) : origFillText(text, x, y, maxWidth);
      };

      rt.invalidate();
      await rt.session.captureCompositePng();
      const capturedTexts = texts.slice();

      const t0 = performance.now();
      for (let i = 0; i < 5; i += 1) {
        rt.view.panX(-20);
        rt.invalidate();
        await rt.session.captureCompositePng();
      }
      const avgPanMs = (performance.now() - t0) / 5;

      handle.dispose();
      root.remove();
      return { capturedTexts, avgPanMs };
    };

    const btc = await runScenario("BINANCE_FUTURES:btcusdt", 10);
    const wif = await runScenario("BINANCE_FUTURES:wifusdt", 0.01);
    return { btc, wif };
  });

  expect(result.btc.capturedTexts.some((t) => t.includes("Hyperliquid"))).toBe(true);
  expect(result.btc.capturedTexts.some((t) => t.includes("Model ·"))).toBe(false);

  expect(result.wif.capturedTexts.some((t) => t.includes("Model ·"))).toBe(true);
  expect(result.wif.capturedTexts.some((t) => t.includes("Hyperliquid"))).toBe(false);
  expect(result.wif.avgPanMs).toBeLessThan(200);
});

import { expect, test } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

const hookSelector = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

function buildAltcoinBars(count: number, basePrice: number, priceStep: number) {
  const lastTime = Math.floor(FROZEN_NOW / INTERVAL_MS) * INTERVAL_MS;
  const firstTime = lastTime - Math.max(0, count - 1) * INTERVAL_MS;
  return Array.from({ length: count }, (_, i) => {
    const t = firstTime + i * INTERVAL_MS;
    const o = basePrice;
    const h = basePrice + priceStep * 20;
    const l = basePrice - priceStep * 20;
    const c = basePrice + priceStep * 5;
    return {
      t,
      o,
      h,
      l,
      c,
      v: 100,
      d: 10,
      n: 10,
      cells: [[basePrice, 50, 50, 0, 0]],
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: FROZEN_NOW,
    };
  });
}

test("renders browser-sourced heatmap for ETH and small-price altcoin without REST history requests", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });

  const ethBars = buildAltcoinBars(60, 3000, 0.1);
  const pepeBars = buildAltcoinBars(60, 0.0001, 0.000001);
  let heatmapRestRequests = 0;

  await page.route(/\/history(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const market = (url.searchParams.get("market") ?? "").toLowerCase();
    const isPepe = market.includes("pepe");
    const bars = isPepe ? pepeBars : ethBars;
    const priceStep = isPepe ? 0.000001 : 0.1;
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
          footprint: { available: true, allowed: true, priceStep },
          footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to },
        },
      }),
    });
  });

  await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, async (route) => {
    heatmapRestRequests++;
    await route.abort();
  });

  // 1) ETHUSDT with relative bucket step (0.6)
  await openHarness(page, "?chart=BINANCE_FUTURES:ethusdt&timeframe=1m&priceStep=0.1&priceStepResolved=1");
  const hook = page.locator(hookSelector);
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  const ethPanelId = await hook.getAttribute("data-panel-id");
  if (!ethPanelId) throw new Error("Missing panel id for ETH");

  const ethStatus = await page.evaluate(async (id) => {
    const harness = await import("/harness/chart.ts");
    const { computeRelativeHeatmapBucketStep } = await import("/src/core/orderbookHeatmap/settings.ts");
    const r = harness.getChartRuntime(id) as unknown as {
      pipeline: { series: { length: number; timeOfIndex(i: number): number } };
      invalidate(): void;
      invalidateOrderbookHeatmapLiveTail(event: unknown): void;
      getOrderbookHeatmapStatus(): unknown;
      whenOrderbookHeatmapReady?: () => Promise<void>;
      session: { captureCompositePng(): Promise<{ blob: Blob }> };
    };
    const step = computeRelativeHeatmapBucketStep({ lastPrice: 3000, priceStep: 0.1, multiplier: 1 });
    harness.updateOrderbookHeatmapSettings({
      unit: "usd",
      bucketStep: step,
      bucketStepMultiplier: 1,
      single: { usd: 1_000, btc: 1 },
    });
    harness.setOrderbookHeatmapModeFor("BINANCE_FUTURES:ethusdt", "single");
    await r.whenOrderbookHeatmapReady?.();
    r.invalidate();
    await r.session.captureCompositePng();
    const lastTime = r.pipeline.series.timeOfIndex(r.pipeline.series.length - 1);
    r.invalidateOrderbookHeatmapLiveTail({
      market: "BINANCE_FUTURES:ethusdt",
      bars: [{ t: lastTime, cells: [[3000, 250_000, 150_000], [3000 + step, 120_000, 80_000]] }],
    });
    await r.session.captureCompositePng();
    return { step, status: r.getOrderbookHeatmapStatus() };
  }, ethPanelId);

  expect(ethStatus.step).toBe(0.6);
  expect(ethStatus.status).toMatchObject({
    state: "ready",
    hasBars: true,
    sourceKind: "browser",
    sourceLabel: "since app opened",
  });
  expect(heatmapRestRequests).toBe(0);

  // 2) Small-price altcoin ($0.0001) with priceStep = 0.000001
  await openHarness(page, "?chart=BINANCE_FUTURES:pepeusdt&timeframe=1m&priceStep=0.000001&priceStepResolved=1");
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  const pepePanelId = await hook.getAttribute("data-panel-id");
  if (!pepePanelId) throw new Error("Missing panel id for PEPE");

  const pepeStatus = await page.evaluate(async (id) => {
    const harness = await import("/harness/chart.ts");
    const { computeRelativeHeatmapBucketStep } = await import("/src/core/orderbookHeatmap/settings.ts");
    const r = harness.getChartRuntime(id) as unknown as {
      pipeline: { series: { length: number; timeOfIndex(i: number): number } };
      invalidate(): void;
      invalidateOrderbookHeatmapLiveTail(event: unknown): void;
      getOrderbookHeatmapStatus(): unknown;
      whenOrderbookHeatmapReady?: () => Promise<void>;
      session: { captureCompositePng(): Promise<{ blob: Blob }> };
    };
    const step = computeRelativeHeatmapBucketStep({ lastPrice: 0.0001, priceStep: 0.000001, multiplier: 1 });
    harness.updateOrderbookHeatmapSettings({
      unit: "usd",
      bucketStep: step,
      bucketStepMultiplier: 1,
      single: { usd: 500, btc: 1 },
    });
    harness.setOrderbookHeatmapModeFor("BINANCE_FUTURES:pepeusdt", "single");
    await r.whenOrderbookHeatmapReady?.();
    r.invalidate();
    await r.session.captureCompositePng();
    const lastTime = r.pipeline.series.timeOfIndex(r.pipeline.series.length - 1);
    r.invalidateOrderbookHeatmapLiveTail({
      market: "BINANCE_FUTURES:pepeusdt",
      bars: [{ t: lastTime, cells: [[0.0001, 50_000, 40_000]] }],
    });
    await r.session.captureCompositePng();
    return { step, status: r.getOrderbookHeatmapStatus() };
  }, pepePanelId);

  expect(pepeStatus.step).toBe(0.000001);
  expect(pepeStatus.status).toMatchObject({
    state: "ready",
    hasBars: true,
    sourceKind: "browser",
    sourceLabel: "since app opened",
  });
  expect(heatmapRestRequests).toBe(0);
});

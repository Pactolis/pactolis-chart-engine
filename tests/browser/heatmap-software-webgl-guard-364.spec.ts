import { expect, test, type Page } from "@playwright/test";
import {
  buildBars,
  FROZEN_NOW,
  FUNCTIONAL_WEBGL_ARGS,
  openHarness,
} from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

const HOOK_SELECTOR = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

async function installChartAndHeatmapRoutes(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  const bars = buildBars(120).map((bar) => ({
    ...bar,
    o: 250,
    h: 350,
    l: 50,
    c: 260,
    v: 4,
    d: 0,
    n: 4,
    cells: [
      [50, 0, 1, 0, 0, 1, 0, 1],
      [250, 1, 1, 0, 0, 2, 1, 1],
      [350, 1, 0, 0, 0, 1, 1, 0],
    ],
    lb: 0,
    ls: 0,
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
          source: "single",
          resolution: "15m",
          bucketStep: 50,
          from,
          to,
          bars: bars
            .filter((bar) => bar.t >= from && bar.t <= to)
            .map((bar) => ({
              t: bar.t,
              cells: [
                [50, 600, 600],
                [100, 2000, 2000],
                [200, 7200, 7200],
              ],
            })),
        },
      }),
    });
  });
}

test("default SwiftShader WebGL2 session guards heatmap to cpu-raster with software_renderer", async ({
  page,
}) => {
  await installChartAndHeatmapRoutes(page);
  await openHarness(
    page,
    "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0",
  );

  const hook = page.locator(HOOK_SELECTOR);
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  await expect(hook).toHaveAttribute("data-heatmap-path", "cpu-raster");

  const panelId = await hook.getAttribute("data-panel-id");
  expect(panelId).toBeTruthy();

  const probe = await page.evaluate(async (id) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const { getGpuDiagnostics } = await import("/src/core/gpu/gpuDiagnostics.ts");
    const runtime = getChartRuntime(id!) as {
      getDiagnostics(): {
        heatmap: {
          enabled: boolean;
          heatmapPath: string;
          fallbackReason: string | null;
          renderer: string | null;
        };
      };
    };
    return {
      diagnostics: runtime.getDiagnostics(),
      gpuDiagnostics: getGpuDiagnostics(),
    };
  }, panelId);

  expect(probe.diagnostics.heatmap.heatmapPath).toBe("cpu-raster");
  expect(probe.diagnostics.heatmap.fallbackReason).toBe("software_renderer");
  expect(
    probe.gpuDiagnostics.counters["gpu.featureFallback.orderbook-heatmap.software_renderer"],
  ).toBeGreaterThanOrEqual(1);
});

test("explicit ?residentHeatmap=1 override keeps GPU heatmap path open on SwiftShader", async ({
  page,
}) => {
  await installChartAndHeatmapRoutes(page);
  await openHarness(
    page,
    "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0&residentHeatmap=1",
  );

  const hook = page.locator(HOOK_SELECTOR);
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false");

  const panelId = await hook.getAttribute("data-panel-id");
  expect(panelId).toBeTruthy();

  const probe = await page.evaluate(async (id) => {
    const { getChartRuntime, setOrderbookHeatmapModeFor } = await import("/harness/chart.ts");
    const runtime = getChartRuntime(id!) as {
      whenHeatmapGpuRendererReady(): Promise<void>;
      invalidate(): void;
      getDiagnostics(): {
        heatmap: {
          enabled: boolean;
          heatmapPath: string;
          fallbackReason: string | null;
        };
      };
    };
    setOrderbookHeatmapModeFor("BINANCE_FUTURES:btcusdt", id!, "single");
    await runtime.whenHeatmapGpuRendererReady();
    runtime.invalidate();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return runtime.getDiagnostics();
  }, panelId);

  expect(probe.heatmap.enabled).toBe(true);
  expect(probe.heatmap.fallbackReason).not.toBe("software_renderer");
  expect(probe.heatmap.heatmapPath).toBe("webgl2");
});

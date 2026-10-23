import { expect, test } from "@playwright/test";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

/**
 * Given a BTCUSDT perp chart with acknowledged books and the private GPU
 * density opt-in on,
 * When frames render with performance telemetry off and then on,
 * Then `chart.gpu.heatmap.prepare.ms` and `chart.gpu.heatmap.render.ms` each
 * get a sample for every frame rendered with telemetry on, none before, and
 * the density was really GPU-owned.
 */
type RuntimeProbe = {
  heatmapTexturePrototypeEnabled: boolean;
  heatmapGpuFrame: unknown;
  invalidate(): void;
  orderbookHeatmap: {
    bars: Map<number, { t: number; cells: number[][] }>;
    chunks: Map<number, { status: string }>;
    inFlight: Set<AbortController>;
  };
  pipeline: { series: { length: number; timeOfIndex(index: number): number } };
  session: { captureCompositePng(): Promise<{ blob: Blob }> };
};
const hookSelector = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';
const METRICS = ["chart.gpu.heatmap.prepare.ms", "chart.gpu.heatmap.render.ms"];

test("GPU heatmap stage times reach performance telemetry only while it is on", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  // Four unit trades per bar: open 250, low 50, high 350, close 260.
  const bars = buildBars(500).map((bar) => ({
    ...bar, o: 250, h: 350, l: 50, c: 260, v: 4, d: 0, n: 4,
    cells: [[50, 0, 1, 0, 0, 1, 0, 1], [250, 1, 1, 0, 0, 2, 1, 1], [350, 1, 0, 0, 0, 1, 1, 0]], lb: 0, ls: 0,
  }));
  await page.route(/\/history(?:\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from")), to = Number(q.get("to"));
    const candleOnly = q.get("includeFootprint") === "0";
    const meta = candleOnly ? { schemaVersion: 1, generatedAt: FROZEN_NOW } : {
      schemaVersion: 1, generatedAt: FROZEN_NOW,
      footprint: { available: true, allowed: true, priceStep: 25 },
      footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to },
    };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars }, meta }) });
  });
  let acknowledgements = 0;
  await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, async (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from")), to = Number(q.get("to"));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      ok: true, data: {
        schemaVersion: 1, generatedAt: FROZEN_NOW, base: "BTC", source: "single",
        resolution: "15m", bucketStep: 50, from, to,
        // 32 BTC at 125 and 64 BTC at 225 clear the 16 BTC threshold.
        bars: bars.filter((bar) => bar.t >= from && bar.t <= to).map((bar) => ({
          t: bar.t, cells: [[50, 0, 0], [100, 2000, 2000], [200, 7200, 7200]],
        })),
      },
    }) });
    acknowledgements++;
  });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0");
  const hook = page.locator(hookSelector);
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  await expect(hook).toHaveAttribute("data-series-len", "500");
  const id = await hook.getAttribute("data-panel-id");
  if (!id) throw new Error("Fixture: missing actual panel id");

  await page.evaluate(async (id) => {
    const harness = await import("/harness/chart.ts");
    const { settings } = await import("/src/core/settings.ts");
    const r = harness.getChartRuntime(id) as unknown as RuntimeProbe;
    settings.grid = false;
    harness.updateOrderbookHeatmapSettings({ unit: "btc", bucketStep: 50, single: { usd: 0, btc: 16 } });
    harness.setOrderbookHeatmapModeFor("BINANCE_FUTURES:btcusdt", "single");
    r.invalidate();
  }, id);
  await expect.poll(() => acknowledgements).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(async (id) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    const s = r.pipeline.series, book = r.orderbookHeatmap;
    return book.bars.get(s.timeOfIndex(s.length - 1))?.cells.length === 3
      && book.inFlight.size === 0 && book.chunks.size > 0
      && [...book.chunks.values()].every((chunk) => chunk.status === "ready");
  }, id)).toBe(true);

  const result = await page.evaluate(async ({ id, metrics }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const telemetry = await import("/src/core/performanceTelemetry.ts");
    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    const counts = () => Object.fromEntries(
      metrics.map((metric) => [metric, telemetry.snapshotPerformanceTelemetry().metrics[metric]?.count ?? 0]),
    );
    // Each capture renders one frame of all three surfaces.
    const frames = async (n: number) => {
      for (let i = 0; i < n; i++) {
        r.invalidate();
        await r.session.captureCompositePng();
      }
    };
    const wasEnabled = telemetry.isPerformanceTelemetryEnabled();
    try {
      r.heatmapTexturePrototypeEnabled = true;
      telemetry.configurePerformanceTelemetry({ enabled: false });
      await frames(2);
      const whileOff = counts();
      telemetry.configurePerformanceTelemetry({ enabled: true });
      await frames(3);
      const whileOn = counts();
      const snapshot = telemetry.snapshotPerformanceTelemetry().metrics;
      return { whileOff, whileOn, gpuOwned: r.heatmapGpuFrame !== null,
        snapshot: Object.fromEntries(metrics.map((metric) => [metric, snapshot[metric]])) };
    } finally {
      r.heatmapTexturePrototypeEnabled = false;
      telemetry.configurePerformanceTelemetry({ enabled: wasEnabled });
    }
  }, { id, metrics: METRICS });

  console.log("heatmap-gpu-stage-telemetry " + JSON.stringify(result));
  expect(result.gpuOwned, "the density must really be GPU-owned").toBe(true);
  for (const metric of METRICS) {
    expect(result.whileOff[metric], `${metric}: no sample while telemetry is off`).toBe(0);
    expect(result.whileOn[metric], `${metric}: a sample for every frame rendered with telemetry on`).toBeGreaterThanOrEqual(3);
    expect(result.snapshot[metric].p95Ms, `${metric}: p95`).toBeGreaterThanOrEqual(0);
  }
});

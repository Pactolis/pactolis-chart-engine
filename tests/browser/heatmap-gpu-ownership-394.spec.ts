import { expect, test, type Page } from "@playwright/test";
import type { View } from "../../src/core/engine/view.js";
import type { FootprintSeries } from "../../src/core/model/footprint.js";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

const BARS_COUNT = 160;
const LEVELS_PER_BAR = 40;
const BASE_PRICE = 65_000;
const BUCKET_STEP = 25;
const HOOK_SELECTOR = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

type RuntimeProbe = {
  view: View;
  pipeline: { series: FootprintSeries };
  getState(): ChartPanelState;
  updateState(state: ChartPanelState): void;
  setVisibleTimeRange(range: { from: number; to: number }): void;
  invalidate(): void;
  whenHeatmapGpuRendererReady(): Promise<void>;
  getHeatmapGpuDiagnostics(): {
    enabled: boolean;
    backend: string;
    requestedBackend: string;
    effectiveBackend: string;
    heatmapPath: string;
    failureLatched: boolean;
    fallbackReason: string | null;
    fallbackActive: boolean;
    fallbackRecoveries: number;
    lastLayerSubmitMs: number;
    lastPreparedCells: number;
    renderer: string | null;
  };
  orderbookHeatmap: {
    bars: Map<number, { t: number; cells: number[][] }>;
    chunks: Map<number, { status: string }>;
    inFlight: Set<AbortController>;
    getRasterDiagnostics(): {
      totalPaintedCells: number;
      totalFillRectCalls: number;
      lastPaintedCells: number;
    };
  };
  session: {
    captureCompositePng(): Promise<{ blob: Blob; width: number; height: number }>;
  };
};

function makeHeatmapCells(barIndex: number): Array<[number, number, number]> {
  const cells: Array<[number, number, number]> = [];
  for (let level = 0; level < LEVELS_PER_BAR; level++) {
    const price = BASE_PRICE + level * BUCKET_STEP;
    const bid = 60 + ((barIndex + level) % 8) * 35;
    const ask = 60 + ((barIndex * 3 + level) % 8) * 35;
    cells.push([price, bid, ask]);
  }
  return cells;
}

async function installScenarioFixture(page: Page): Promise<string> {
  await page.addInitScript(() => {
    const UNMASKED_RENDERER = 0x9246;
    const UNMASKED_VENDOR = 0x9245;
    const origGetExtension = WebGL2RenderingContext.prototype.getExtension;
    const origGetParameter = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getExtension = function (name: string) {
      if (name === "WEBGL_debug_renderer_info") {
        return {
          UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER,
          UNMASKED_VENDOR_WEBGL: UNMASKED_VENDOR,
        };
      }
      return origGetExtension.call(this, name);
    };
    WebGL2RenderingContext.prototype.getParameter = function (pname: number) {
      if (pname === UNMASKED_RENDERER) {
        return "AMD Radeon AI Pro R9700";
      }
      return origGetParameter.call(this, pname);
    };
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  const bars = buildBars(BARS_COUNT).map((bar) => ({
    ...bar,
    o: BASE_PRICE + 250,
    h: BASE_PRICE + (LEVELS_PER_BAR - 1) * BUCKET_STEP,
    l: BASE_PRICE,
    c: BASE_PRICE + 500,
    v: 120,
    d: 10,
    n: 40,
    cells: [
      [BASE_PRICE, 15, 10, 0, 0, 25, 15, 10],
      [BASE_PRICE + 500, 10, 15, 0, 0, 25, 10, 15],
    ],
    lb: 0,
    ls: 0,
  }));

  const heatmapBars = bars.map((bar, barIndex) => ({
    t: bar.t,
    cells: makeHeatmapCells(barIndex),
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
          footprint: { available: true, allowed: true, priceStep: BUCKET_STEP },
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

  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=25&priceStepResolved=0");
  const hook = page.locator(HOOK_SELECTOR);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  await expect(hook).toHaveAttribute("data-series-len", String(BARS_COUNT));
  const id = await hook.getAttribute("data-panel-id");
  if (!id) throw new Error("Fixture: missing panel id");
  return id;
}

for (const theme of ["dark", "light"] as const) {
  test(`CE-394 (${theme} theme): default WebGL2 keeps heatmap GPU ownership across pan/zoom and 6 slow global frames`, async ({ page }) => {
    test.setTimeout(60_000);
    const id = await installScenarioFixture(page);

    const summary = await page.evaluate(async ({ id, barsCount, bucketStep, intervalMs, theme }) => {
      document.documentElement.setAttribute("data-theme", theme);
      const {
        getChartRuntime,
        updateOrderbookHeatmapSettings,
        setOrderbookHeatmapModeFor,
      } = await import("/harness/chart.ts");
      const telemetry = await import("/src/core/performanceTelemetry.ts");

      const r = getChartRuntime(id) as unknown as RuntimeProbe;
      if (!r || !r.orderbookHeatmap || !r.session) throw new Error("Runtime/orderbookHeatmap unavailable");

      r.updateState({ ...r.getState(), chartType: "candlestick", scaleMode: "linear" });
      updateOrderbookHeatmapSettings({
        unit: "btc",
        bucketStep,
        single: { usd: 0, btc: 50 },
        aggregated: { usd: 0, btc: 50 },
        scaleMode: "fixed",
        fixedCeiling: { usd: 0, btc: 500 },
        palette: "pactolis",
        opacity: 0.85,
      });
      setOrderbookHeatmapModeFor("BINANCE_FUTURES:btcusdt", "single");

      await r.whenHeatmapGpuRendererReady();

      for (let attempt = 0; attempt < 80; attempt++) {
        r.invalidate();
        await r.session.captureCompositePng();
        const chunks = [...r.orderbookHeatmap.chunks.values()];
        const allReady = chunks.length > 0 && chunks.every((c) => c.status === "ready");
        if (allReady && r.orderbookHeatmap.inFlight.size === 0 && r.orderbookHeatmap.bars.size >= barsCount) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // Reset telemetry once steady-state WebGL2 heatmap is warm so we measure
      // initial steady render + pan/zoom + 6 synthetic slow frames cleanly.
      telemetry.resetPerformanceTelemetry();
      telemetry.configurePerformanceTelemetry({ enabled: true });

      const firstTime = r.pipeline.series.at(0)?.startTime ?? 0;
      const lastTime = r.pipeline.series.at(r.pipeline.series.length - 1)?.startTime ?? 0;
      const span = Math.max(intervalMs * 40, lastTime - firstTime);

      // Pan & zoom cycles
      for (let step = 0; step < 4; step++) {
        const shift = step * intervalMs * 5;
        r.setVisibleTimeRange({
          from: firstTime + shift,
          to: firstTime + span * (0.75 + step * 0.05) + shift,
        });
        r.invalidate();
        await r.session.captureCompositePng();
      }

      // 6 synthetic main-thread >55ms slow frames
      for (let slow = 0; slow < 6; slow++) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            const until = performance.now() + 58;
            while (performance.now() < until) {
              // intentional main-thread busy stall > 55ms
            }
            r.invalidate();
            resolve();
          });
        });
        await r.session.captureCompositePng();
      }

      const diag = r.getHeatmapGpuDiagnostics();
      const snap = telemetry.snapshotPerformanceTelemetry();
      const raster = r.orderbookHeatmap.getRasterDiagnostics();
      return {
        theme,
        diag,
        gpuFrames: snap.counters["chart.gpu.heatmap.frames"] ?? 0,
        cpuDensityCells: snap.counters["chart.cpu.heatmap.density.cells"] ?? 0,
        cpuDensityFillRects: snap.counters["chart.cpu.heatmap.density.fillRects"] ?? 0,
        globalSlowFrames: snap.counters["chart.gpu.heatmap.globalSlowFrame"] ?? 0,
        rasterLastPaintedCells: raster.lastPaintedCells,
      };
    }, { id, barsCount: BARS_COUNT, bucketStep: BUCKET_STEP, intervalMs: INTERVAL_MS, theme });

    console.log("CE_394_BROWSER_EVIDENCE", JSON.stringify(summary));

    expect(summary.diag.heatmapPath).toBe("webgl2");
    expect(summary.diag.failureLatched).toBe(false);
    expect(summary.diag.fallbackReason).toBeNull();
    expect(summary.diag.renderer).toBe("AMD Radeon AI Pro R9700");
    expect(summary.gpuFrames).toBeGreaterThan(0);
    expect(summary.cpuDensityCells).toBe(0);
  });
}

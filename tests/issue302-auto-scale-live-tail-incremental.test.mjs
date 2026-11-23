import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import {
  resolveHeatmapColorRange,
  resolveHeatmapColorRangeFromTwoSorted,
} from "../dist/features/orderbook/heatmapModel.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";

test("#302: stationary live-tail update resolves exact Auto P96 without rescanning historical bars", async () => {
  // 1. Exact mathematical equivalence between resolveHeatmapColorRangeFromTwoSorted and resolveHeatmapColorRange
  const hist = new Float64Array([10, 20, 40, 80, 160, 320, 640, 1280]);
  const live = new Float64Array([15, 2500]);
  const combined = new Float64Array([...hist, ...live]);
  for (const threshold of [0, 50]) {
    for (const contrast of ["low", "medium", "high"]) {
      const ref = resolveHeatmapColorRange({ values: combined, threshold, scaleMode: "auto", contrast });
      const inc = resolveHeatmapColorRangeFromTwoSorted({
        histSorted: hist,
        histCount: hist.length,
        liveSorted: live,
        liveCount: live.length,
        threshold,
        scaleMode: "auto",
        contrast,
      });
      assert.deepEqual(inc, ref);
    }
  }

  // 2. Stationary viewport live-tail updates scan only the live bar's cells
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      opacity: 0.85,
      scaleMode: "auto",
      contrast: "medium",
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }),
    onChange: () => () => {},
  });

  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const MINUTE = 60_000;
  const barCount = 60;
  const cellsPerBar = 50;
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 25 });
  series.loadBars(Array.from({ length: barCount }, (_, i) => ({
    startTime: i * MINUTE,
    open: 50_000, high: 52_000, low: 49_500, close: 50_500,
    volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 600, height: 300 };
  view.colWidth = 10;
  view.priceTop = 53_000;
  view.pricePerPx = 20;

  let overlay;
  try {
    overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: barCount * MINUTE,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: Array.from({ length: barCount }, (_, i) => ({
          t: i * MINUTE,
          cells: Array.from({ length: cellsPerBar }, (_, j) => [50_000 + j * 25, 1000 + j * 100, 1000]),
        })),
      }),
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => barCount * MINUTE,
    });

    overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
    await new Promise((r) => setTimeout(r, 20));
    resetPerformanceTelemetry();

    // Cold scan visits 60 * 50 = 3000 cells
    overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
    const afterCold = snapshotPerformanceTelemetry().counters["chart.heatmap.scale.scan.cells"] ?? 0;
    assert.equal(afterCold, barCount * cellsPerBar);

    // 5 live-tail mutations on stationary viewport -> each scans only 1 bar (50 cells), 250 total instead of 15,000
    for (let step = 1; step <= 5; step++) {
      overlay.applyLiveTailBars([{
        t: (barCount - 1) * MINUTE,
        cells: Array.from({ length: cellsPerBar }, (_, j) => [50_000 + j * 25, 1000 + step * 500 + j * 100, 1000]),
      }]);
      overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
    }
    const totalScanned = snapshotPerformanceTelemetry().counters["chart.heatmap.scale.scan.cells"] ?? 0;
    assert.equal(totalScanned - afterCold, 5 * cellsPerBar);
  } finally {
    overlay?.dispose();
    resetPerformanceTelemetry();
    configurePerformanceTelemetry({ enabled: wasEnabled });
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});

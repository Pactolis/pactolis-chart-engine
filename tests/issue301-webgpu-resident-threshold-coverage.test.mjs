import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import { WebGpuNativeHeatmapPipeline } from "../dist/core/gpu/webgpu/webgpuNativeHeatmapPipeline.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

test("#301: raising threshold within loaded coverage uploads 0 cell bytes in WebGPU resident; lowering triggers rebuild", async () => {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  let threshold = 100;
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      opacity: 0.85,
      scaleMode: "fixed",
      fixedCeiling: { usd: 10_000, btc: 10 },
      single: { usd: threshold, btc: 1 },
      aggregated: { usd: threshold, btc: 1 },
    }),
    onChange: () => () => {},
  });

  const MINUTE = 60_000;
  const barCount = 60;
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 25 });
  series.loadBars(Array.from({ length: barCount }, (_, i) => ({
    startTime: i * MINUTE,
    open: 50_000, high: 50_500, low: 49_500, close: 50_200,
    volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 600, height: 300 };
  view.colWidth = 10;
  view.priceTop = 51_000;
  view.pricePerPx = 10;

  const cellWrites = [];
  const device = {
    limits: { maxBufferSize: 128 * 1024 * 1024 },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: (desc) => ({ label: desc.label, size: desc.size, destroy() {} }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setScissorRect() {}, setPipeline() {}, setBindGroup() {}, draw() {}, end() {},
      }),
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(buf, _off, _src, _dOff, size) {
        if (buf.label === "NativeResidentHeatmapCellStorage") cellWrites.push(size);
      },
      submit() {},
    },
  };

  let overlay;
  const pipeline = new WebGpuNativeHeatmapPipeline(device, "rgba8unorm");
  const target = { createView: () => ({}) };
  const plot = { left: 0, top: 0, width: 600, height: 300, pixelRatio: 1 };
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
          cells: [[50_000, 1500, 1500], [50_025, 250, 250]],
        })),
      }),
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => barCount * MINUTE,
    });

    overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
    await new Promise((r) => setTimeout(r, 20));
    const f1 = overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
    assert.equal(pipeline.renderResidentFrame(target, 600, 300, 1, f1, plot), true);
    assert.equal(cellWrites.length, 1);

    // Raise threshold 100 -> 1000 (within loaded coverage): 0 cell bytes uploaded, only uniform
    threshold = 1000;
    const f2 = overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
    assert.equal(f2.syncGeneration, f1.syncGeneration);
    assert.equal(pipeline.renderResidentFrame(target, 600, 300, 1, f2, plot), true);
    assert.equal(cellWrites.length, 1, "raising threshold within coverage must upload 0 cell bytes");

    // Lower threshold below initial coverage 100 -> 50: triggers syncGeneration rebuild
    threshold = 50;
    const f3 = overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
    assert.ok(f3.syncGeneration > f2.syncGeneration);
    assert.equal(pipeline.renderResidentFrame(target, 600, 300, 1, f3, plot), true);
    assert.equal(cellWrites.length, 2);
  } finally {
    overlay?.dispose();
    pipeline.dispose();
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});

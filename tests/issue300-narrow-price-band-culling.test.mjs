import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import { visibleHeatmapCellBounds } from "../dist/features/orderbook/heatmapModel.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import { WebGpuNativeHeatmapPipeline } from "../dist/core/gpu/webgpu/webgpuNativeHeatmapPipeline.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

test("#300: narrow vertical price band binary-searches sorted cells in Canvas2D and culls WebGPU resident instances", async () => {
  // 1. Direct helper check for sorted & unsorted inputs
  const sortedCells = Array.from({ length: 200 }, (_, j) => [50_000 + j * 25, 1000, 1000]);
  const narrow = visibleHeatmapCellBounds(sortedCells, 51_000, 51_100, 25);
  assert.ok(narrow.end - narrow.start <= 6);
  const unsorted = [[52_000, 100, 100], [50_000, 100, 100]];
  assert.deepEqual(visibleHeatmapCellBounds(unsorted, 50_000, 50_050, 25), { start: 0, end: 2 });

  // 2. Canvas2D cold draw visits only visible band instead of all 60*200 = 12,000 cells
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      opacity: 0.85,
      scaleMode: "fixed",
      fixedCeiling: { usd: 10_000, btc: 10 },
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }),
    onChange: () => () => {},
  });

  const barCount = 60;
  const MINUTE = 60_000;
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 25 });
  series.loadBars(Array.from({ length: barCount }, (_, i) => ({
    startTime: i * MINUTE,
    open: 51_000, high: 51_200, low: 50_800, close: 51_050,
    volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 600, height: 100 };
  view.colWidth = 10;
  view.priceTop = 51_100;
  view.pricePerPx = 1; // visible prices [51_000, 51_100] -> ~4-5 buckets out of 200 per bar

  let fillRects = 0;
  const ctx = {
    canvas: { width: 600, height: 100 },
    fillStyle: "",
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    fillRect() { fillRects++; },
  };

  const draws = [];
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
        setScissorRect() {},
        setPipeline() {},
        setBindGroup() {},
        draw(_v, instanceCount, _fv, firstInstance) { draws.push({ instanceCount, firstInstance }); },
        end() {},
      }),
      finish: () => ({}),
    }),
    queue: { writeBuffer() {}, submit() {} },
  };

  let overlay;
  const pipeline = new WebGpuNativeHeatmapPipeline(device, "rgba8unorm");
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
        bars: Array.from({ length: barCount }, (_, i) => ({ t: i * MINUTE, cells: sortedCells })),
      }),
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => barCount * MINUTE,
    });

    overlay.draw(ctx, view, series, [0, barCount - 1]);
    await new Promise((r) => setTimeout(r, 20));
    fillRects = 0;
    overlay.draw(ctx, view, series, [0, barCount - 1]);
    assert.ok(fillRects > 0 && fillRects <= 360, `expected narrow band fillRects <= 360, got ${fillRects}`);

    // WebGPU resident draws far fewer than 12,000 instances on the same narrow price band
    const residentFrame = overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
    assert.ok(residentFrame);
    assert.equal(pipeline.renderResidentFrame({ createView: () => ({}) }, 600, 100, 1, residentFrame, { left: 0, top: 0, width: 600, height: 100, pixelRatio: 1 }), true);
    const totalInstances = draws.reduce((sum, d) => sum + d.instanceCount, 0);
    assert.ok(totalInstances > 0 && totalInstances < 1000, `expected culled WebGPU instances < 1000, got ${totalInstances}`);
  } finally {
    overlay?.dispose();
    pipeline.dispose();
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});

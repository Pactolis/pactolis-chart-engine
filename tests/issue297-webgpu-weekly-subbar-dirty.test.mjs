import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import { WebGpuNativeHeatmapPipeline } from "../dist/core/gpu/webgpu/webgpuNativeHeatmapPipeline.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;

function makeDevice() {
  const storageWrites = [];
  const device = {
    limits: { maxBufferSize: 128 * 1024 * 1024, maxTextureDimension2D: 8192 },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: (desc) => ({
      label: desc.label,
      size: desc.size,
      data: new Uint8Array(desc.size),
      destroy() {},
    }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setScissorRect() {},
        setPipeline() {},
        setBindGroup() {},
        draw() {},
        end() {},
      }),
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(buf, offset, source, dataOffset = 0, size) {
        const bytes = source instanceof ArrayBuffer
          ? new Uint8Array(source, dataOffset, size)
          : new Uint8Array(source.buffer, (source.byteOffset ?? 0) + dataOffset, size);
        buf.data.set(bytes, offset);
        if (buf.label === "NativeResidentHeatmapCellStorage") {
          storageWrites.push({ offset, size });
        }
      },
      submit() {},
    },
  };
  return { device, storageWrites };
}

test("#297: weekly chart with 1d heatmap sub-bar correction updates dirty chart bar 1 in WebGPU resident storage", async () => {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      opacity: 0.85,
      scaleMode: "fixed",
      fixedCeiling: { usd: 2000, btc: 10 },
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }),
    onChange: () => () => {},
  });

  const w0 = Date.UTC(2026, 0, 5);
  const w1 = Date.UTC(2026, 0, 12);
  const w2 = Date.UTC(2026, 0, 19);
  const d11 = Date.UTC(2026, 0, 11);
  const d18 = Date.UTC(2026, 0, 18);
  const d19 = Date.UTC(2026, 0, 19);

  const series = new FootprintSeries({ intervalMs: WEEK_MS, priceStep: 25 });
  series.loadBars([
    { startTime: w0, open: 100, high: 110, low: 90, close: 105, volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true },
    { startTime: w1, open: 105, high: 115, low: 95, close: 110, volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true },
    { startTime: w2, open: 110, high: 120, low: 100, close: 115, volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true },
  ]);

  const view = new View();
  view.area = { left: 0, top: 0, width: 600, height: 300 };
  view.colWidth = 20;
  view.priceTop = 200;
  view.pricePerPx = 1;

  let responseBars = [
    { t: d11, cells: [[100, 50, 50]] },
    { t: d18, cells: [[100, 150, 150]] },
    { t: d19, cells: [[100, 200, 200]] },
  ];
  let now = d19 + 60_000;
  const { device, storageWrites } = makeDevice();
  const pipeline = new WebGpuNativeHeatmapPipeline(device, "rgba8unorm");
  const target = { createView: () => ({}) };
  const plot = { left: 0, top: 0, width: 600, height: 300, pixelRatio: 1 };
  let overlay;
  try {
    overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: now,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: responseBars,
      }),
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => now,
    });

    overlay.prepareResidentGpuScene(view, series, [0, 2]);
    await new Promise((r) => setTimeout(r, 20));
    const frame1 = overlay.prepareResidentGpuScene(view, series, [0, 2]);
    assert.ok(frame1);
    assert.equal(pipeline.renderResidentFrame(target, 600, 300, 1, frame1, plot), true);

    // Correct Jan 18 (inside weekly bar 1) from 300 -> 750; Jan 19 unchanged
    responseBars = [
      { t: d18, cells: [[100, 375, 375]] },
      { t: d19, cells: [[100, 200, 200]] },
    ];
    now += 25_000;
    const writesBefore = storageWrites.length;
    overlay.prepareResidentGpuScene(view, series, [0, 2]);
    await new Promise((r) => setTimeout(r, 20));
    const frame2 = overlay.prepareResidentGpuScene(view, series, [0, 2]);
    assert.ok(frame2);
    assert.equal(frame2.dirtyFromBarIndex, 1);
    assert.equal(pipeline.renderResidentFrame(target, 600, 300, 1, frame2, plot), true);

    const newWrites = storageWrites.slice(writesBefore);
    assert.equal(newWrites.length, 1);
    // Bar 0 (16 B) untouched; only bars 1 and 2 (32 B) uploaded
    assert.equal(newWrites[0].offset, 16);
    assert.equal(newWrites[0].size, 32);

    const storageBuf = device.createBuffer;
    assert.ok(storageBuf);
    assert.equal(frame2.readBarCells(1)[0].value, 750);
  } finally {
    overlay?.dispose();
    pipeline.dispose();
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});

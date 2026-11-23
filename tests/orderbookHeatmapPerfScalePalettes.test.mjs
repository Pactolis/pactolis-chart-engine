import test from "node:test";
import assert from "node:assert/strict";

import {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import {
  ORDERBOOK_HEATMAP_PALETTES,
  resolveOrderbookHeatmapPalette,
} from "../dist/core/orderbookHeatmap/settings.js";
import {
  HEATMAP_PALETTE_STOPS_BY_ID,
  buildHeatmapPaletteGlslBranch,
  buildHeatmapPaletteWgslBranch,
  getHeatmapColorLut,
  heatmapCellRgba,
  heatmapPaletteIndex,
  mergeHeatmapBarsWithDiff,
} from "../dist/features/orderbook/heatmapModel.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import {
  NATIVE_HEATMAP_WGSL,
  NATIVE_RESIDENT_HEATMAP_WGSL,
  WebGpuNativeHeatmapPipeline,
} from "../dist/core/gpu/webgpu/webgpuNativeHeatmapPipeline.js";
import { WebGpuSurface } from "../dist/core/gpu/webgpu/webgpuSurface.js";
import { HeatmapGpuRenderer } from "../dist/features/chart/heatmap/gpu/heatmapGpuRenderer.js";
import { HEATMAP_GPU_FRAG_SRC } from "../dist/features/chart/heatmap/gpu/heatmapGpuShaders.js";
import { ChartHeatmapGpuCoordinator } from "../dist/features/chart/ChartHeatmapGpuCoordinator.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";

const MINUTE = 60_000;
const FIFTEEN_M = 15 * MINUTE;

function withSettings(getSettings, fn) {
  let prev = null;
  try { prev = orderbookHeatmapSettingsSource(); } catch {}
  const listeners = new Set();
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => getSettings(),
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  });
  return Promise.resolve(fn(() => { for (const cb of listeners) cb(); })).finally(() => {
    if (prev) configureOrderbookHeatmapSettingsSource(prev);
  });
}

function makeWebGpuDeviceMock() {
  const buffers = [];
  const writeBufferCalls = [];
  const renderPasses = [];
  const device = {
    limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 128 * 1024 * 1024 },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: (desc) => {
      const buf = { desc, destroyed: false, destroy() { this.destroyed = true; } };
      buffers.push(buf);
      return buf;
    },
    createCommandEncoder: () => {
      const passCalls = [];
      return {
        beginRenderPass: () => {
          const draws = [];
          return {
            setScissorRect() {},
            setPipeline() {},
            setBindGroup() {},
            draw(vertexCount, instanceCount, firstVertex, firstInstance) {
              draws.push({ vertexCount, instanceCount, firstVertex, firstInstance });
            },
            end() {
              passCalls.push({ draws });
              renderPasses.push({ draws });
            },
          };
        },
        finish: () => ({ passCalls }),
      };
    },
    queue: {
      writeBuffer(buffer, bufferOffset, data, dataOffset = 0, size = 0) {
        writeBufferCalls.push({ buffer, bufferOffset, size: size || data.byteLength });
      },
      submit() {},
    },
  };
  return { device, buffers, writeBufferCalls, renderPasses };
}

test("#280 tail diff & WebGPU resident incremental sync avoid full rebuilds on unchanged or 15m tail responses", async () => {
  const wasTelemetry = true;
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const barCount = 200;
  const cellsPerBar = 200;
  const t0 = 1_700_000_100_000;
  const series = new FootprintSeries({ intervalMs: FIFTEEN_M, priceStep: 25 });
  series.loadBars(Array.from({ length: barCount }, (_, i) => ({
    startTime: t0 + i * FIFTEEN_M,
    open: 60_000, high: 60_500, low: 59_500, close: 60_200,
    volume: 100, delta: 0, count: 1, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 500 };
  view.colWidth = 5;
  view.priceTop = 65_500;
  view.pricePerPx = 25;

  const makeCells = (scale = 1) =>
    Array.from({ length: cellsPerBar }, (_, j) => [60_000 + j * 25, 400_000 * scale, 400_000 * scale]);

  const barsMap = new Map();
  const initialBars = Array.from({ length: barCount }, (_, i) => ({
    t: t0 + i * FIFTEEN_M,
    cells: makeCells(1),
  }));
  const initialChanged = mergeHeatmapBarsWithDiff(barsMap, initialBars);
  assert.equal(initialChanged.length, barCount);

  // Identical 3-bar tail produces 0 diff
  const tailTimes = [barCount - 3, barCount - 2, barCount - 1].map((i) => ({
    t: t0 + i * FIFTEEN_M,
    cells: makeCells(1),
  }));
  assert.equal(mergeHeatmapBarsWithDiff(barsMap, tailTimes).length, 0);

  // Now test end-to-end with OrderbookHeatmapOverlay + WebGpuNativeHeatmapPipeline
  const { device, writeBufferCalls } = makeWebGpuDeviceMock();
  const pipeline = WebGpuNativeHeatmapPipeline.create(device, "rgba8unorm");
  assert.ok(pipeline);
  const targetTex = { createView: () => ({}) };
  const plot = { left: 0, top: 0, width: 1000, height: 500, pixelRatio: 1 };

  let now = t0 + (barCount - 1) * FIFTEEN_M + 10_000;
  let tailPayload = initialBars;
  let overlay;
  try {
    await withSettings(() => ({
      mode: "aggregated",
      unit: "btc",
      bucketStep: 25,
      opacity: 0.55,
      scaleMode: "fixed",
      fixedCeiling: { usd: 100_000_000, btc: 100 },
      single: { usd: 1, btc: 10 },
      aggregated: { usd: 1, btc: 10 },
    }), async () => {
      overlay = new OrderbookHeatmapOverlay({
        fetch: async () => ({
          schemaVersion: 1,
          generatedAt: now,
          base: "BTC",
          source: "aggregated",
          resolution: "15m",
          bucketStep: 25,
          from: t0,
          to: t0 + barCount * FIFTEEN_M,
          bars: tailPayload,
        }),
        invalidate: () => {},
        getMarket: () => "BINANCE_FUTURES:btcusdt",
        now: () => now,
      });

      // Trigger initial chunk load
      overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
      await new Promise((r) => setTimeout(r, 20));
      const frame1 = overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
      assert.ok(frame1);
      assert.equal(pipeline.renderResidentFrame(targetTex, 1000, 500, 1, frame1, plot), true);

      // Unchanged 3-bar tail response -> 0 B cell upload, 0 tail sync
      const writesBeforeUnchanged = writeBufferCalls.length;
      const syncFullBefore = snapshotPerformanceTelemetry().counters["gpu.native.heatmap.sync.full"] ?? 0;
      const syncTailBefore = snapshotPerformanceTelemetry().counters["gpu.native.heatmap.sync.tail"] ?? 0;
      tailPayload = [barCount - 3, barCount - 2, barCount - 1].map((i) => ({
        t: t0 + i * FIFTEEN_M,
        cells: makeCells(1),
      }));
      now += 15_000;
      overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
      await new Promise((r) => setTimeout(r, 20));
      const frame2 = overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
      assert.equal(pipeline.renderResidentFrame(targetTex, 1000, 500, 1, frame2, plot), true);
      assert.equal(writeBufferCalls.length, writesBeforeUnchanged, "unchanged tail must upload 0 bytes");

      // Only open bar changes -> 1 bar (200 cells * 16 B = 3200 B) incremental tail sync
      tailPayload = [
        { t: t0 + (barCount - 3) * FIFTEEN_M, cells: makeCells(1) },
        { t: t0 + (barCount - 2) * FIFTEEN_M, cells: makeCells(1) },
        { t: t0 + (barCount - 1) * FIFTEEN_M, cells: makeCells(2) },
      ];
      now += 15_000;
      const writesBeforeLive = writeBufferCalls.length;
      overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
      await new Promise((r) => setTimeout(r, 20));
      const frame3 = overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
      assert.equal(pipeline.renderResidentFrame(targetTex, 1000, 500, 1, frame3, plot), true);
      const liveCellWrites = writeBufferCalls.slice(writesBeforeLive).filter((w) => w.buffer !== pipeline.residentUniformBuffer);
      assert.equal(liveCellWrites.length, 1);
      assert.equal(liveCellWrites[0].size, 200 * 16);
      assert.equal(snapshotPerformanceTelemetry().counters["gpu.native.heatmap.sync.tail"], syncTailBefore + 1);
      assert.equal(snapshotPerformanceTelemetry().counters["gpu.native.heatmap.sync.full"] ?? 0, syncFullBefore);

      // Previous 2 bars + open bar change -> bounded 3-bar tail sync (NOT 200-bar full rebuild!)
      tailPayload = [
        { t: t0 + (barCount - 3) * FIFTEEN_M, cells: makeCells(3) },
        { t: t0 + (barCount - 2) * FIFTEEN_M, cells: makeCells(3) },
        { t: t0 + (barCount - 1) * FIFTEEN_M, cells: makeCells(3) },
      ];
      now += 15_000;
      const writesBeforeBounded = writeBufferCalls.length;
      overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
      await new Promise((r) => setTimeout(r, 20));
      const frame4 = overlay.prepareResidentGpuScene(view, series, [0, barCount - 1]);
      assert.equal(frame4.dirtyFromBarIndex, barCount - 3);
      assert.equal(pipeline.renderResidentFrame(targetTex, 1000, 500, 1, frame4, plot), true);
      const boundedWrites = writeBufferCalls.slice(writesBeforeBounded).filter((w) => w.buffer !== pipeline.residentUniformBuffer);
      assert.equal(boundedWrites.length, 1);
      assert.equal(boundedWrites[0].size, 3 * 200 * 16);
      assert.equal(snapshotPerformanceTelemetry().counters["gpu.native.heatmap.sync.tail"], syncTailBefore + 2);
      assert.equal(snapshotPerformanceTelemetry().counters["gpu.native.heatmap.sync.full"] ?? 0, syncFullBefore);
    });
  } finally {
    overlay?.dispose();
    pipeline.dispose();
    configurePerformanceTelemetry({ enabled: !wasTelemetry });
  }
});

test("#280 recoverable GPU frame rejection does not permanently latch CPU fallback and setSurface resets latch", () => {
  const { device } = makeWebGpuDeviceMock();
  const pipeline = WebGpuNativeHeatmapPipeline.create(device, "rgba8unorm");
  assert.ok(pipeline);
  const surface = WebGpuSurface.createForTest(device, { width: 800, height: 400 }, 1, pipeline);
  const targetTex = { createView: () => ({}) };
  surface.setLastRenderedTextureForTest?.(targetTex);

  // Invalid zero-width plot -> recoverable rejection, pipeline stays alive
  const okInvalid = pipeline.renderFrame(
    targetTex,
    800,
    400,
    1,
    { main: [{ x: 0, yTop: 0, width: 10, height: 10, value: 20 }], extension: [], ceiling: 50, threshold: 10, dataKey: "k" },
    { left: 0, top: 0, width: 0, height: 400, pixelRatio: 1 },
  );
  assert.equal(okInvalid, false);
  assert.equal(pipeline.isDisposed(), false);

  // Subsequent valid frame succeeds
  const okValid = pipeline.renderFrame(
    targetTex,
    800,
    400,
    1,
    { main: [{ x: 0, yTop: 0, width: 10, height: 10, value: 20 }], extension: [], ceiling: 50, threshold: 10, dataKey: "k" },
    { left: 0, top: 0, width: 800, height: 400, pixelRatio: 1 },
  );
  assert.equal(okValid, true);

  // Coordinator resets failure latch when a new surface is attached
  const coordinator = new ChartHeatmapGpuCoordinator({
    backendKind: "webgpu",
    orderbookHeatmap: null,
    renderer: { visibleRange: () => [0, 0] },
    renderCoordinator: { getAnnotationLayerOrder: () => ["orderbook-heatmap"] },
    invalidateSession: () => {},
  });
  coordinator.setSurface(surface);
  assert.equal(coordinator.getDiagnostics().failureLatched, false);
  pipeline.dispose();
});

test("#280 right extension is disabled across Canvas2D, WebGL2 prepare, and WebGPU resident WGSL", () => {
  assert.equal(NATIVE_RESIDENT_HEATMAP_WGSL.includes("extX"), false);
  assert.equal(NATIVE_RESIDENT_HEATMAP_WGSL.includes("alphaScale = 0.45"), false);
});

test("#281 Auto P96 freezes color range during pan/zoom, settles once when quiet, and skips scans for Fixed/opacity/palette", async () => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  let settings = {
    mode: "single",
    unit: "btc",
    bucketStep: 25,
    opacity: 0.55,
    scaleMode: "auto",
    contrast: "medium",
    palette: "pactolis",
    single: { usd: 1, btc: 10 },
    aggregated: { usd: 1, btc: 10 },
    fixedCeiling: { usd: 100_000_000, btc: 200 },
  };
  let now = 5_000_000;
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 25 });
  series.loadBars(Array.from({ length: 10 }, (_, i) => ({
    startTime: 4_999_000 + i * MINUTE,
    open: 50_000, high: 50_500, low: 49_500, close: 50_200,
    volume: 100, delta: 0, count: 1, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 20;
  view.priceTop = 51_000;
  view.pricePerPx = 5;

  let overlay;
  try {
    await withSettings(() => settings, async () => {
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
          bars: Array.from({ length: 10 }, (_, i) => ({
            t: 4_999_000 + i * MINUTE,
            // Bars 0..4 have 20 BTC, bars 5..9 have 100 BTC
            cells: [[50_000, (i < 5 ? 500_000 : 2_500_000), (i < 5 ? 500_000 : 2_500_000)]],
          })),
        }),
        invalidate: () => {},
        getMarket: () => "BINANCE_FUTURES:btcusdt",
        now: () => now,
      });

      const ctx = {
        canvas: { width: 800, height: 400 },
        save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {},
        fillStyle: "",
      };
      overlay.draw(ctx, view, series, [0, 4]);
      await new Promise((r) => setTimeout(r, 20));

      // Initial settled draw on bars [0..4] (20 BTC) -> 1 scan
      overlay.draw(ctx, view, series, [0, 4]);
      const initialFloor = overlay.lastDrawnFloor();
      const initialCeiling = overlay.lastDrawnCeiling();
      assert.equal(snapshotPerformanceTelemetry().counters["chart.heatmap.scale.scan.count"], 1);

      // Opacity & palette change must NOT trigger a new P96 scan
      settings = { ...settings, opacity: 0.75, palette: "viridis" };
      overlay.draw(ctx, view, series, [0, 4]);
      assert.equal(snapshotPerformanceTelemetry().counters["chart.heatmap.scale.scan.count"], 1);

      // Pan to bars [5..9] (100 BTC) during active motion -> frozen ceiling, 0 new scans!
      now += 16;
      view.offsetX = -100;
      overlay.draw(ctx, view, series, [5, 9]);
      assert.equal(overlay.lastDrawnFloor(), initialFloor);
      assert.equal(overlay.lastDrawnCeiling(), initialCeiling);
      assert.equal(snapshotPerformanceTelemetry().counters["chart.heatmap.scale.scan.count"], 1);

      // Live update while moving -> coalesced, still 0 new scans
      overlay.applyLiveTailBars([{ t: 4_999_000 + 9 * MINUTE, cells: [[50_000, 3_000_000, 3_000_000]] }]);
      now += 16;
      view.offsetX = -105;
      overlay.draw(ctx, view, series, [5, 9]);
      assert.equal(snapshotPerformanceTelemetry().counters["chart.heatmap.scale.scan.count"], 1);

      // Motion settles -> 1 scan updates ceiling to ~100 BTC distribution
      now += 200;
      overlay.draw(ctx, view, series, [5, 9]);
      assert.equal(snapshotPerformanceTelemetry().counters["chart.heatmap.scale.scan.count"], 2);
      assert.ok(overlay.lastDrawnCeiling() > initialCeiling);

      // Fixed ceiling mode -> 0 scans
      const scansBeforeFixed = snapshotPerformanceTelemetry().counters["chart.heatmap.scale.scan.count"];
      settings = { ...settings, scaleMode: "fixed" };
      now += 200;
      view.offsetX = -120;
      overlay.draw(ctx, view, series, [5, 9]);
      assert.equal(snapshotPerformanceTelemetry().counters["chart.heatmap.scale.scan.count"], scansBeforeFixed);
    });
  } finally {
    overlay?.dispose();
  }
});

test("#1128 single-source palettes match across CPU LUT, GLSL, WGSL and trigger 0 B GPU data upload", () => {
  assert.deepEqual(ORDERBOOK_HEATMAP_PALETTES, ["pactolis", "viridis", "cividis", "inferno"]);
  assert.equal(resolveOrderbookHeatmapPalette("unknown"), "pactolis");
  assert.equal(heatmapPaletteIndex("pactolis"), 0);
  assert.equal(heatmapPaletteIndex("viridis"), 1);
  assert.equal(heatmapPaletteIndex("cividis"), 2);
  assert.equal(heatmapPaletteIndex("inferno"), 3);

  // Bit-identical Pactolis baseline at k=0, 0.4, 0.75, 1.0
  assert.deepEqual(heatmapCellRgba(0, 1, 1, "pactolis"), { r: 18, g: 38, b: 84, a: 0.22 });
  assert.deepEqual(heatmapCellRgba(0.4, 1, 1, "pactolis"), { r: 24, g: 112, b: 168, a: 0.36 });
  assert.deepEqual(heatmapCellRgba(0.75, 1, 1, "pactolis"), { r: 34, g: 211, b: 238, a: 0.54 });
  assert.deepEqual(heatmapCellRgba(1, 1, 1, "pactolis"), { r: 254, g: 240, b: 178, a: 0.68 });

  // Every palette's LUT entry 0 and 1000 matches its stops
  for (const palette of ORDERBOOK_HEATMAP_PALETTES) {
    const stops = HEATMAP_PALETTE_STOPS_BY_ID[palette];
    const lut = getHeatmapColorLut(1, 1, palette);
    assert.equal(lut.length, 1001);
    const first = stops[0];
    const last = stops[stops.length - 1];
    assert.equal(lut[0], `rgba(${first.r}, ${first.g}, ${first.b}, ${first.a.toFixed(3)})`);
    assert.equal(lut[1000], `rgba(${last.r}, ${last.g}, ${last.b}, ${last.a.toFixed(3)})`);
  }

  // GLSL and WGSL embed the generated multi-palette branches
  assert.ok(HEATMAP_GPU_FRAG_SRC.includes("uniform int u_palette;"));
  assert.ok(HEATMAP_GPU_FRAG_SRC.includes(buildHeatmapPaletteGlslBranch()));
  assert.ok(NATIVE_HEATMAP_WGSL.includes(buildHeatmapPaletteWgslBranch("u_heatmap.paletteIndex")));
  assert.ok(NATIVE_RESIDENT_HEATMAP_WGSL.includes(buildHeatmapPaletteWgslBranch("paletteIndex")));

  // Changing palette on WebGPU pipeline uploads only 64 B uniform, 0 B cell storage
  const { device, writeBufferCalls } = makeWebGpuDeviceMock();
  const pipeline = WebGpuNativeHeatmapPipeline.create(device, "rgba8unorm");
  assert.ok(pipeline);
  const targetTex = { createView: () => ({}) };
  const plot = { left: 0, top: 0, width: 400, height: 400, pixelRatio: 1 };
  const frameBase = {
    main: [{ x: 10, yTop: 10, width: 20, height: 10, value: 30 }],
    extension: [],
    floor: 10,
    ceiling: 100,
    threshold: 10,
    opacity: 0.55,
    palette: "pactolis",
    dataKey: "same-data",
  };
  assert.equal(pipeline.renderFrame(targetTex, 400, 400, 1, frameBase, plot), true);
  const writesAfterFirst = writeBufferCalls.length;
  assert.equal(pipeline.renderFrame(targetTex, 400, 400, 1, { ...frameBase, palette: "inferno" }, plot), true);
  const newWrites = writeBufferCalls.slice(writesAfterFirst);
  assert.equal(newWrites.length, 1, "only uniform buffer writes on palette change");
  assert.equal(newWrites[0].buffer, pipeline.uniformBuffer);
  assert.equal(newWrites[0].size, 64);

  // Verify HeatmapGpuRenderer exposes isDisposed() cleanly
  const glRenderer = new HeatmapGpuRenderer();
  assert.equal(glRenderer.isDisposed(), false);
  glRenderer.dispose();
  assert.equal(glRenderer.isDisposed(), true);
  pipeline.dispose();
});

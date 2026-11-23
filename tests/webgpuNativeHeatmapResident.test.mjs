import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import {
  DEFAULT_GPU_SETTINGS,
  readGpuSettings,
  resetGpuSettingsForTest,
} from "../dist/core/gpu/gpuSettings.js";
import {
  getGpuDiagnostics,
  resetGpuDiagnosticsForTest,
} from "../dist/core/gpu/gpuDiagnostics.js";
import {
  getWebGpuHeatmapModuleReservedBytesForTest,
  HEATMAP_WEBGPU_CHART_BUDGET_BYTES,
  HEATMAP_WEBGPU_MODULE_BUDGET_BYTES,
  NATIVE_RESIDENT_HEATMAP_WGSL,
  RESIDENT_HEATMAP_CELL_BYTES,
  RESIDENT_HEATMAP_TAIL_HEADROOM,
  RESIDENT_HEATMAP_UNIFORM_BYTES,
  WebGpuNativeHeatmapPipeline,
} from "../dist/core/gpu/webgpu/webgpuNativeHeatmapPipeline.js";
import { WebGpuSurface } from "../dist/core/gpu/webgpu/webgpuSurface.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import { ChartHeatmapGpuCoordinator } from "../dist/features/chart/ChartHeatmapGpuCoordinator.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

function makeFakeWebGpuDevice({
  format = "rgba8unorm",
  maxBufferSize = 268435456,
} = {}) {
  const buffers = [];
  const writtenBuffers = [];
  const renderPasses = [];

  const device = {
    format,
    features: new Set(),
    limits: { maxBufferSize, maxTextureDimension2D: 8192 },
    addEventListener() {},
    removeEventListener() {},
    createShaderModule(desc) {
      return { label: desc.label, code: desc.code };
    },
    createBuffer(desc) {
      const data = new Uint8Array(desc.size);
      const buf = {
        label: desc.label,
        size: desc.size,
        usage: desc.usage,
        data,
        destroyed: false,
        destroy() { this.destroyed = true; },
      };
      buffers.push(buf);
      return buf;
    },
    createBindGroupLayout(desc) { return { label: desc.label, entries: desc.entries }; },
    createBindGroup(desc) { return { label: desc.label, layout: desc.layout, entries: desc.entries }; },
    createPipelineLayout(desc) { return { label: desc.label, bindGroupLayouts: desc.bindGroupLayouts }; },
    createRenderPipeline(desc) { return { label: desc.label, desc }; },
    createCommandEncoder(desc) {
      const passCalls = [];
      return {
        label: desc.label,
        beginRenderPass() {
          const draws = [];
          const scissors = [];
          const pass = {
            setPipeline() {},
            setBindGroup() {},
            setScissorRect(x, y, w, h) { scissors.push([x, y, w, h]); },
            draw(vertexCount, instanceCount, firstVertex, firstInstance) {
              draws.push({ vertexCount, instanceCount, firstVertex, firstInstance });
            },
            end() {
              passCalls.push({ draws, scissors });
              renderPasses.push({ draws, scissors });
            },
          };
          return pass;
        },
        finish() { return { label: desc.label, passCalls }; },
      };
    },
    queue: {
      writeBuffer(buffer, bufferOffset, source, dataOffset = 0, size) {
        const bytes = source instanceof ArrayBuffer
          ? new Uint8Array(source, dataOffset, size)
          : new Uint8Array(source.buffer, (source.byteOffset ?? 0) + dataOffset, size);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        buffer.data.set(copy, bufferOffset);
        writtenBuffers.push({
          label: buffer.label,
          bufferOffset,
          byteLength: copy.byteLength,
          data: copy,
        });
      },
      submit() {},
    },
  };

  return { device, buffers, writtenBuffers, renderPasses };
}

function makeFakeSurface(mock, format = "rgba8unorm") {
  const ctx = {
    configure() {},
    unconfigure() {},
    getCurrentTexture() { return { createView() { return {}; } }; },
  };
  const canvas = { width: 1000, height: 600, getContext: (k) => (k === "webgpu" ? ctx : null) };
  const surface = new WebGpuSurface(canvas, {
    adapter: {},
    device: mock.device,
    format,
    limits: mock.device.limits,
    isLost: () => false,
    onLost: () => () => {},
    dispose: () => {},
  });
  const f = surface.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
  f.flushQuads(1000, 600);
  f.end();
  return surface;
}

test("Resident heatmap constants and WGSL match 16 B/cell + 64 B uniform + 4-stop parity", () => {
  assert.equal(RESIDENT_HEATMAP_CELL_BYTES, 16);
  assert.equal(RESIDENT_HEATMAP_UNIFORM_BYTES, 64);
  assert.equal(RESIDENT_HEATMAP_TAIL_HEADROOM, 4096);
  assert.match(NATIVE_RESIDENT_HEATMAP_WGSL, /barIndex:\s*u32/);
  assert.match(NATIVE_RESIDENT_HEATMAP_WGSL, /priceBinRel:\s*f32/);
  assert.match(NATIVE_RESIDENT_HEATMAP_WGSL, /value:\s*f32/);
  assert.match(NATIVE_RESIDENT_HEATMAP_WGSL, /flags:\s*u32/);
  assert.match(NATIVE_RESIDENT_HEATMAP_WGSL, /let\s+alphaScale\s*=\s*1\.0/);
  assert.match(NATIVE_RESIDENT_HEATMAP_WGSL, /vec3<f32>\(18\.0,\s*38\.0,\s*84\.0\)/);
  assert.match(NATIVE_RESIDENT_HEATMAP_WGSL, /vec3<f32>\(254\.0,\s*240\.0,\s*178\.0\)/);
});

test("readGpuSettings supports ?residentHeatmap=0|1 and ?heatmapGpu=0|1 while keeping default false", () => {
  resetGpuSettingsForTest();
  assert.equal(DEFAULT_GPU_SETTINGS.residentHeatmap, false);
  assert.equal(readGpuSettings({ location: { search: "" } }).residentHeatmap, false);
  assert.equal(readGpuSettings({ location: { search: "?residentHeatmap=1" } }).residentHeatmap, true);
  assert.equal(readGpuSettings({ location: { search: "?heatmapGpu=1" } }).residentHeatmap, true);
  assert.equal(readGpuSettings({ location: { search: "?residentHeatmap=0" } }).residentHeatmap, false);
  assert.equal(readGpuSettings({ location: { search: "?heatmapGpu=0" } }).residentHeatmap, false);
  resetGpuSettingsForTest();
});

test("WebGpuNativeHeatmapPipeline.renderResidentFrame performs 0 B data upload on pan/zoom and incremental tail + rollover sync", () => {
  const prevTelemetry = snapshotPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const mock = makeFakeWebGpuDevice();
  const pipeline = new WebGpuNativeHeatmapPipeline(mock.device, "rgba8unorm");
  const target = { createView() { return {}; } };
  const plot = { left: 0, top: 0, width: 1000, height: 600, pixelRatio: 1 };

  const bars = [
    [{ priceStart: 60_000, value: 20, liveEligible: false }, { priceStart: 60_050, value: 40, liveEligible: false }],
    [{ priceStart: 60_100, value: 30, liveEligible: false }],
    [{ priceStart: 60_150, value: 50, liveEligible: true }],
  ];
  let readCalls = [];
  const makeFrame = ({ syncGeneration, tailSyncRevision, barCount, liveBarIndex, offsetX = 0, colWidth = 20, visibleRange = [0, barCount - 1] }) => ({
    syncGeneration,
    tailSyncRevision,
    barCount,
    priceOrigin: 60_000,
    bucketStep: 50,
    liveBarIndex,
    dataKey: "single||1m|50",
    view: { offsetX, colWidth, priceTop: 61_000, pricePerPx: 2 },
    floor: 10,
    ceiling: 100,
    threshold: 10,
    opacity: 0.85,
    visibleRange,
    readBarCells: (barIndex) => {
      readCalls.push(barIndex);
      return bars[barIndex] ?? [];
    },
  });

  try {
    // 1. Initial full sync (4 cells = 64 B)
    assert.equal(pipeline.renderResidentFrame(target, 1000, 600, 1, makeFrame({ syncGeneration: 1, tailSyncRevision: 1, barCount: 3, liveBarIndex: 2 }), plot), true);
    assert.deepEqual(readCalls, [0, 1, 2]);
    let snap = snapshotPerformanceTelemetry();
    assert.equal(snap.counters["gpu.native.heatmap.dataBytes"], 4 * 16);
    assert.equal(snap.counters["gpu.native.heatmap.uniformBytes"], 64);
    assert.equal(mock.renderPasses[0].draws[0].vertexCount, 6);
    assert.equal(mock.renderPasses[0].draws[0].instanceCount, 4);

    // Check packed bytes in storage buffer (cell 3 is live barIndex 2, rel price 150, value 50, flags 1)
    const storageWrite = mock.writtenBuffers.find((w) => w.label === "NativeResidentHeatmapCellStorage");
    assert.ok(storageWrite);
    const dv = new DataView(storageWrite.data.buffer, storageWrite.data.byteOffset, storageWrite.data.byteLength);
    assert.equal(dv.getUint32(3 * 16, true), 2);
    assert.equal(dv.getFloat32(3 * 16 + 4, true), 150);
    assert.equal(dv.getFloat32(3 * 16 + 8, true), 50);
    assert.equal(dv.getUint32(3 * 16 + 12, true), 1);

    // 2. Pan / Zoom: 0 B data upload, only 64 B uniform write, visibility culling limits instanceCount
    resetPerformanceTelemetry();
    readCalls = [];
    assert.equal(pipeline.renderResidentFrame(target, 1000, 600, 1, makeFrame({
      syncGeneration: 1, tailSyncRevision: 1, barCount: 3, liveBarIndex: 2,
      offsetX: -120, colWidth: 32, visibleRange: [1, 2],
    }), plot), true);
    assert.deepEqual(readCalls, []);
    snap = snapshotPerformanceTelemetry();
    assert.equal(snap.counters["gpu.native.heatmap.dataBytes"] ?? 0, 0, "pan/zoom must upload 0 B of cell data");
    assert.equal(snap.counters["gpu.native.heatmap.uniformBytes"], 64);
    assert.equal(mock.renderPasses[1].draws[0].instanceCount, 2, "visibility range [1,2] culls bar 0 (2 cells)");

    // 3. Incremental live tail overwrite in-place
    resetPerformanceTelemetry();
    readCalls = [];
    bars[2] = [{ priceStart: 60_150, value: 65, liveEligible: true }, { priceStart: 60_200, value: 25, liveEligible: true }];
    assert.equal(pipeline.renderResidentFrame(target, 1000, 600, 1, makeFrame({
      syncGeneration: 1, tailSyncRevision: 2, barCount: 3, liveBarIndex: 2,
    }), plot), true);
    assert.deepEqual(readCalls, [2]);
    snap = snapshotPerformanceTelemetry();
    assert.equal(snap.counters["gpu.native.heatmap.dataBytes"], 2 * 16);
    const storageWrites = mock.writtenBuffers.filter((w) => w.label === "NativeResidentHeatmapCellStorage");
    const tailWrite = storageWrites[storageWrites.length - 1];
    assert.ok(tailWrite);
    assert.equal(tailWrite.bufferOffset, 3 * 16, "overwrites tail bar starting at bar 2 offset in-place");

    // 4. Incremental rollover append (bar 2 closes without liveEligible + bar 3 opens live)
    resetPerformanceTelemetry();
    readCalls = [];
    bars[2] = [{ priceStart: 60_150, value: 65, liveEligible: false }, { priceStart: 60_200, value: 25, liveEligible: false }];
    bars[3] = [{ priceStart: 60_250, value: 75, liveEligible: true }];
    assert.equal(pipeline.renderResidentFrame(target, 1000, 600, 1, makeFrame({
      syncGeneration: 1, tailSyncRevision: 3, barCount: 4, liveBarIndex: 3,
    }), plot), true);
    assert.deepEqual(readCalls, [2, 3]);
    snap = snapshotPerformanceTelemetry();
    assert.equal(snap.counters["gpu.native.heatmap.dataBytes"], 3 * 16);

    // 5. Full sync when syncGeneration increments
    resetPerformanceTelemetry();
    readCalls = [];
    assert.equal(pipeline.renderResidentFrame(target, 1000, 600, 1, makeFrame({
      syncGeneration: 2, tailSyncRevision: 3, barCount: 4, liveBarIndex: 3,
    }), plot), true);
    assert.deepEqual(readCalls, [0, 1, 2, 3]);
    snap = snapshotPerformanceTelemetry();
    assert.equal(snap.counters["gpu.native.heatmap.dataBytes"], 6 * 16);
  } finally {
    pipeline.dispose();
    assert.equal(getWebGpuHeatmapModuleReservedBytesForTest(), 0);
    configurePerformanceTelemetry({ enabled: prevTelemetry.enabled });
    resetPerformanceTelemetry();
  }
});

test("WebGpuNativeHeatmapPipeline enforces 64 MiB chart / 256 MiB module budgets on resident storage", () => {
  const mock = makeFakeWebGpuDevice();
  const pipeline = new WebGpuNativeHeatmapPipeline(mock.device, "rgba8unorm");
  const target = { createView() { return {}; } };
  const plot = { left: 0, top: 0, width: 1000, height: 600, pixelRatio: 1 };
  const lease = pipeline.reservePreparedPayload(HEATMAP_WEBGPU_CHART_BUDGET_BYTES - 512 * 1024);
  assert.ok(lease);

  const bigBars = Array.from({ length: 1000 }, (_, b) => ({ priceStart: 60_000 + b, value: 20, liveEligible: false }));
  const frame = {
    syncGeneration: 1,
    tailSyncRevision: 1,
    barCount: 1,
    priceOrigin: 60_000,
    bucketStep: 50,
    liveBarIndex: -1,
    dataKey: "k",
    view: { offsetX: 0, colWidth: 20, priceTop: 61_000, pricePerPx: 2 },
    floor: 10,
    ceiling: 100,
    threshold: 10,
    opacity: 0.85,
    visibleRange: [0, 0],
    readBarCells: () => Array.from({ length: 65_000 }, (_, i) => ({ priceStart: 60_000 + i, value: 20, liveEligible: false })),
  };
  void bigBars;

  try {
    assert.throws(
      () => pipeline.renderResidentFrame(target, 1000, 600, 1, frame, plot),
      /Heatmap GPU prototype budget exceeded/,
    );
  } finally {
    lease.release();
    pipeline.dispose();
    assert.equal(getWebGpuHeatmapModuleReservedBytesForTest(), 0);
    assert.ok(HEATMAP_WEBGPU_MODULE_BUDGET_BYTES > HEATMAP_WEBGPU_CHART_BUDGET_BYTES);
  }
});

test("OrderbookHeatmapOverlay.prepareResidentGpuScene applies Auto P96 motion freeze and skips prepareReservedGpuCells", () => {
  let prevSettingsSource = null;
  try { prevSettingsSource = orderbookHeatmapSettingsSource(); } catch {}
  let currentSettings = {
    mode: "single",
    unit: "btc",
    bucketStep: 50,
    scaleMode: "auto",
    single: { usd: 0, btc: 5 },
    aggregated: { usd: 0, btc: 5 },
  };
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => currentSettings,
    onChange: () => () => {},
  });

  let nowMs = 1_700_000_105_000;
  const intervalMs = 60_000;
  const bar0Time = 1_700_000_040_000;
  const bar1Time = bar0Time + intervalMs;
  const series = new FootprintSeries({ intervalMs, priceStep: 50 });
  series.loadBars([
    { startTime: bar0Time, open: 60_000, high: 60_500, low: 59_900, close: 60_400, volume: 10, delta: 2, count: 1, cells: new Map() },
    { startTime: bar1Time, open: 60_400, high: 60_800, low: 60_200, close: 60_700, volume: 10, delta: 2, count: 1, cells: new Map() },
  ]);

  const overlay = new OrderbookHeatmapOverlay({
    fetch: async ({ from, to }) => ({ from, to, bars: [] }),
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    now: () => nowMs,
  });

  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 600 };
  view.colWidth = 20;
  view.offsetX = 100;
  view.priceTop = 60_500;
  view.pricePerPx = 1;

  try {
    // Initialize currentTier = "1m" before live-tail push
    overlay.prepareResidentGpuScene(view, series, [0, 1]);
    overlay.handleLiveTailEvent({
      market: "BINANCE_FUTURES:btcusdt",
      bars: [
        { t: bar0Time, cells: [[60_000, 10 * 60_000, 0], [60_100, 40 * 60_000, 0]] },
        { t: bar1Time, cells: [[60_200, 20 * 60_000, 0], [60_300, 120 * 60_000, 0]] },
      ],
    });

    const f0 = overlay.prepareResidentGpuScene(view, series, [0, 1]);
    assert.ok(f0);
    const initialCeiling = f0.ceiling;
    assert.ok(initialCeiling >= 100);

    // Move viewport within 150ms settle window showing only lower bar -> ceiling stays frozen
    nowMs += 30;
    view.offsetX = 140;
    view.priceTop = 60_150;
    view.pricePerPx = 0.4;
    const f1 = overlay.prepareResidentGpuScene(view, series, [0, 0]);
    assert.ok(f1);
    assert.equal(f1.ceiling, initialCeiling, "P96 ceiling must freeze during active viewport motion (<150ms)");

    // After 150ms settle on same moved viewport -> ceiling updates from visible bar 0 cells
    nowMs += 200;
    const f2 = overlay.prepareResidentGpuScene(view, series, [0, 0]);
    assert.ok(f2);
    assert.notEqual(f2.ceiling, initialCeiling, "P96 ceiling recomputes after 150ms settle");
    assert.equal(f2.syncGeneration, f0.syncGeneration, "pan/zoom never bumps syncGeneration");
    assert.equal(f2.tailSyncRevision, f0.tailSyncRevision, "pan/zoom never bumps tailSyncRevision");

    // Live-only bar push bumps tailSyncRevision only (syncGeneration unchanged)
    overlay.handleLiveTailEvent({
      market: "BINANCE_FUTURES:btcusdt",
      bars: [{ t: bar1Time, cells: [[60_200, 35 * 60_000, 0], [60_300, 140 * 60_000, 0]] }],
    });
    const f3 = overlay.prepareResidentGpuScene(view, series, [0, 1]);
    assert.ok(f3);
    assert.equal(f3.syncGeneration, f2.syncGeneration, "live-only push keeps syncGeneration unchanged");
    assert.ok(f3.tailSyncRevision > f2.tailSyncRevision, "live-only push increments tailSyncRevision");

    // Unit change bumps syncGeneration
    currentSettings = { ...currentSettings, unit: "usd" };
    const f4 = overlay.prepareResidentGpuScene(view, series, [0, 1]);
    assert.ok(f4);
    assert.ok(f4.syncGeneration > f3.syncGeneration, "unit change triggers full syncGeneration increment");
  } finally {
    overlay.dispose();
    if (prevSettingsSource) configureOrderbookHeatmapSettingsSource(prevSettingsSource);
  }
});

test("ChartHeatmapGpuCoordinator routes WebGPU linear to resident pipeline and falls back cleanly on log scale", () => {
  resetGpuDiagnosticsForTest();
  const mock = makeFakeWebGpuDevice();
  const surface = makeFakeSurface(mock);
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 600 };
  view.colWidth = 20;
  view.priceTop = 61_000;
  view.pricePerPx = 2;

  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 50 });
  series.loadBars([
    { startTime: 0, open: 60_000, high: 60_500, low: 59_900, close: 60_400, volume: 10, delta: 0, count: 1, cells: new Map() },
  ]);

  let legacyPrepareCalls = 0;
  let residentPrepareCalls = 0;
  const fakeOverlay = {
    currentDataKey: () => "single||1m|50",
    getPrepareCacheKey: () => "cache-1",
    prepareResidentGpuScene: () => {
      residentPrepareCalls++;
      return {
        syncGeneration: 1,
        tailSyncRevision: 1,
        barCount: 1,
        priceOrigin: 60_000,
        bucketStep: 50,
        liveBarIndex: 0,
        dataKey: "single||1m|50",
        view: { offsetX: view.offsetX, colWidth: view.colWidth, priceTop: view.priceTop, pricePerPx: view.pricePerPx },
        floor: 10,
        ceiling: 100,
        threshold: 10,
        opacity: 0.85,
        visibleRange: [0, 0],
        readBarCells: () => [{ priceStart: 60_000, value: 40, liveEligible: true }],
      };
    },
    prepareGpuCells: (_v, _s, _r, reserve) => {
      legacyPrepareCalls++;
      const lease = reserve(2048);
      return {
        dataKey: "single||1m|50",
        threshold: 10,
        floor: 10,
        ceiling: 100,
        opacity: 0.85,
        main: [{ x: 0, yTop: 100, width: 20, height: 25, value: 40 }],
        extension: [],
        preparedLease: lease,
      };
    },
  };

  const coord = new ChartHeatmapGpuCoordinator({
    backendKind: "webgpu",
    orderbookHeatmap: fakeOverlay,
    renderCoordinator: { getAnnotationLayerOrder: () => ["orderbook-heatmap"] },
    renderer: { visibleRange: () => [0, 0] },
    invalidateSession: () => {},
  });

  try {
    coord.setSurface(surface);
    coord.setResidentHeatmapEnabled(true);

    // 1. Linear scale uses resident pipeline without calling prepareGpuCells
    coord.beginFrameAttempt();
    const resFrame = coord.prepareHeatmapGpuCells(view, series);
    assert.equal(resFrame, null);
    assert.equal(residentPrepareCalls, 1);
    assert.equal(legacyPrepareCalls, 0);
    coord.renderHeatmapGpuCells(resFrame, view, series);
    assert.equal(getGpuDiagnostics().featurePaths.heatmap, "webgpu-native");
    assert.equal(getGpuDiagnostics().featurePaths["orderbook-heatmap"], "webgpu");
    assert.equal(coord.heatmapGpuSuppressedAnnotation(view, series, [0, 0]), true);

    // 2. Log scale falls back cleanly to legacy CPU-projected path
    view.setScaleMode("logarithmic");
    coord.beginFrameAttempt();
    const logFrame = coord.prepareHeatmapGpuCells(view, series);
    assert.ok(logFrame);
    assert.equal(legacyPrepareCalls, 1);
    coord.renderHeatmapGpuCells(logFrame, view, series);
    assert.equal(getGpuDiagnostics().featurePaths.heatmap, "webgpu-immediate");
    assert.equal(getGpuDiagnostics().featurePaths["orderbook-heatmap"], "webgpu");
  } finally {
    coord.dispose();
    surface.dispose();
    assert.equal(getWebGpuHeatmapModuleReservedBytesForTest(), 0);
    resetGpuDiagnosticsForTest();
  }
});

test("ChartHeatmapGpuCoordinator and heatmapOverlay have zero static core/gpu/webgpu/* imports", () => {
  for (const rel of [
    "../src/core/gpu/gpuBackend.ts",
    "../src/features/orderbook/heatmapOverlay.ts",
    "../src/features/chart/ChartHeatmapGpuCoordinator.ts",
    "../src/features/chart/ChartRuntime.ts",
  ]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from\s+["'][^"']*webgpu\//, `${rel} must not statically import core/gpu/webgpu/*`);
  }
});

test("evaluateWebGpuHeatmapAssessment and formatWebGpuHeatmapMarkdown format A/B comparison table cleanly", async () => {
  const {
    evaluateWebGpuHeatmapAssessment,
    formatWebGpuHeatmapMarkdown,
  } = await import("../harness/webgpuNativeHeatmapBenchmark.mjs");

  const ab = {
    canvas2d: {
      pan: {
        frame: { count: 40, p50Ms: 12, p95Ms: 18, p99Ms: 20, meanMs: 13, maxMs: 21 },
        heatmap: { count: 40, p50Ms: 8, p95Ms: 12, p99Ms: 14, meanMs: 9, maxMs: 15 },
        rafMissed: 6,
        dataBytes: 0,
        uniformBytes: 0,
        prepareCount: 0,
      },
      zoom: {
        frame: { count: 30, p50Ms: 14, p95Ms: 20, p99Ms: 22, meanMs: 15, maxMs: 23 },
        heatmap: { count: 30, p50Ms: 9, p95Ms: 13, p99Ms: 15, meanMs: 10, maxMs: 16 },
        rafMissed: 5,
        dataBytes: 0,
        uniformBytes: 0,
        prepareCount: 0,
      },
    },
    resident: {
      pan: {
        frame: { count: 40, p50Ms: 2, p95Ms: 3, p99Ms: 4, meanMs: 2.2, maxMs: 4.5 },
        heatmap: { count: 40, p50Ms: 0.4, p95Ms: 0.6, p99Ms: 0.8, meanMs: 0.45, maxMs: 0.9 },
        rafMissed: 0,
        dataBytes: 0,
        uniformBytes: 2560,
        prepareCount: 0,
      },
      zoom: {
        frame: { count: 30, p50Ms: 2.1, p95Ms: 3.2, p99Ms: 4.1, meanMs: 2.3, maxMs: 4.4 },
        heatmap: { count: 30, p50Ms: 0.4, p95Ms: 0.65, p99Ms: 0.8, meanMs: 0.45, maxMs: 0.9 },
        rafMissed: 0,
        dataBytes: 0,
        uniformBytes: 1920,
        prepareCount: 0,
      },
    },
  };
  const parity = { matchRatio: 0.995, nonBg: 42000 };
  const assessment = evaluateWebGpuHeatmapAssessment({ hardwareValid: true, ab, parity });
  assert.equal(assessment.decision, "PASS");
  assert.equal(assessment.ab.pan.frameP95Speedup, 6);
  assert.equal(assessment.ab.pan.heatmapP95Speedup, 20);

  const md = formatWebGpuHeatmapMarkdown({
    runId: "test-run",
    createdAt: "2026-11-23T00:00:00Z",
    fixture: { barCount: 2000, cellsPerBar: 20 },
    adapter: { vendor: "intel", description: "UHD Graphics 620", isFallbackAdapter: false },
    hardwareValid: true,
    residentPanZoomDataBytes: 0,
    residentPanZoomUniformBytes: 4480,
    residentPanZoomPrepareCount: 0,
    parity,
    assessment,
  });
  assert.match(md, /A\/B Comparison/);
  assert.match(md, /\| pan \| canvas2d \|/);
  assert.match(md, /\| pan \| webgpu-native \| .*6\.00x/);
  assert.match(md, /99\.50%/);
});

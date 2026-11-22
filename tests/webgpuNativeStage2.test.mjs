import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import {
  configureGpuSettingsSource,
  resetGpuSettingsForTest,
} from "../dist/core/gpu/gpuSettings.js";
import {
  getGpuDiagnostics,
  resetGpuDiagnosticsForTest,
} from "../dist/core/gpu/gpuDiagnostics.js";
import {
  MERGED_ROW_BUFFER_MAX_BYTES,
  MERGED_ROW_RECORD_BYTES,
  PIXEL_BUCKET_RECORD_BYTES,
  WebGpuNativeScenePipeline,
} from "../dist/core/gpu/webgpu/webgpuNativeScenePipeline.js";
import {
  getWebGpuHeatmapModuleReservedBytesForTest,
  HEATMAP_CELL_RECORD_BYTES,
  HEATMAP_UNIFORM_BYTES,
  HEATMAP_WEBGPU_CHART_BUDGET_BYTES,
  HEATMAP_WEBGPU_MODULE_BUDGET_BYTES,
  WebGpuNativeHeatmapPipeline,
} from "../dist/core/gpu/webgpu/webgpuNativeHeatmapPipeline.js";
import { WebGpuSurface } from "../dist/core/gpu/webgpu/webgpuSurface.js";
import { FootprintRenderer } from "../dist/core/render/footprintRenderer.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { quantizeToStep } from "../dist/core/priceStep.js";
import { View } from "../dist/core/engine/view.js";
import { settings } from "../dist/core/settings.js";
import { ChartHeatmapGpuCoordinator } from "../dist/features/chart/ChartHeatmapGpuCoordinator.js";

function makeStage2FakeWebGpuDevice({
  format = "rgba8unorm",
  maxBufferSize = 268435456,
} = {}) {
  const buffers = [];
  const shaderModules = [];
  const computePipelines = [];
  const renderPipelines = [];
  const computeDispatches = [];
  const renderPasses = [];
  const scissorRects = [];
  const copyOps = [];
  const writtenBuffers = [];
  const pendingMapResolvers = [];

  const device = {
    format,
    features: new Set(),
    limits: { maxBufferSize, maxTextureDimension2D: 8192 },
    addEventListener() {},
    removeEventListener() {},
    createShaderModule(desc) {
      const m = { label: desc.label, code: desc.code };
      shaderModules.push(m);
      return m;
    },
    createBuffer(desc) {
      const data = new Uint8Array(desc.size);
      const buf = {
        label: desc.label,
        size: desc.size,
        usage: desc.usage,
        data,
        destroyed: false,
        unmapped: false,
        destroy() { this.destroyed = true; },
        mapAsync() {
          return new Promise((resolve) => {
            pendingMapResolvers.push(() => resolve());
          });
        },
        getMappedRange() { return data.buffer; },
        unmap() { this.unmapped = true; },
      };
      buffers.push(buf);
      return buf;
    },
    createBindGroupLayout(desc) {
      return { label: desc.label, entries: desc.entries };
    },
    createBindGroup(desc) {
      return { label: desc.label, layout: desc.layout, entries: desc.entries };
    },
    createPipelineLayout(desc) {
      return { label: desc.label, bindGroupLayouts: desc.bindGroupLayouts };
    },
    createComputePipeline(desc) {
      const p = { label: desc.label, layout: desc.layout, compute: desc.compute };
      computePipelines.push(p);
      return p;
    },
    createRenderPipeline(desc) {
      const p = { label: desc.label, layout: desc.layout, vertex: desc.vertex, fragment: desc.fragment };
      renderPipelines.push(p);
      return p;
    },
    createCommandEncoder(desc) {
      return {
        label: desc.label,
        beginComputePass(cDesc) {
          const pass = {
            label: cDesc?.label,
            pipeline: null,
            setPipeline(p) { this.pipeline = p; },
            setBindGroup() {},
            dispatchWorkgroups(x, y = 1, z = 1) {
              computeDispatches.push({ pipeline: this.pipeline?.label, x, y, z });
            },
            end() {},
          };
          return pass;
        },
        beginRenderPass(rDesc) {
          const pass = {
            label: rDesc?.label,
            desc: rDesc,
            pipeline: null,
            draws: [],
            setPipeline(p) { this.pipeline = p; },
            setBindGroup() {},
            setVertexBuffer() {},
            setScissorRect(x, y, w, h) {
              scissorRects.push({ x, y, w, h });
            },
            draw(vertexCount, instanceCount, firstVertex, firstInstance) {
              this.draws.push({
                pipeline: this.pipeline?.label,
                vertexCount,
                instanceCount,
                firstVertex,
                firstInstance,
              });
            },
            end() {
              renderPasses.push(this);
            },
          };
          return pass;
        },
        copyBufferToBuffer(src, srcOffset, dst, dstOffset, size) {
          copyOps.push({ src: src.label, dst: dst.label, size });
          if (src.data && dst.data) {
            dst.data.set(src.data.subarray(srcOffset, srcOffset + size), dstOffset);
          }
        },
        finish() { return { ok: true }; },
      };
    },
    queue: {
      writeBuffer(buffer, dstOffset, data, dataOffset = 0, byteLength) {
        const srcBytes = data instanceof ArrayBuffer
          ? new Uint8Array(data, dataOffset, byteLength ?? (data.byteLength - dataOffset))
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (buffer.data && dstOffset + srcBytes.byteLength <= buffer.data.byteLength) {
          buffer.data.set(srcBytes, dstOffset);
        }
        writtenBuffers.push({
          label: buffer.label,
          dstOffset,
          byteLength: srcBytes.byteLength,
        });
      },
      submit() {
        while (pendingMapResolvers.length > 0) {
          pendingMapResolvers.shift()();
        }
      },
    },
  };

  return {
    device,
    buffers,
    shaderModules,
    computePipelines,
    renderPipelines,
    computeDispatches,
    renderPasses,
    scissorRects,
    copyOps,
    writtenBuffers,
    flushMaps() {
      while (pendingMapResolvers.length > 0) {
        pendingMapResolvers.shift()();
      }
    },
  };
}

function makeFakeWebGpuContext(format = "rgba8unorm") {
  let texSeq = 0;
  return {
    configure() {},
    getCurrentTexture() {
      texSeq++;
      return { id: texSeq, format, createView() { return { texture: this }; } };
    },
  };
}

function makeSeriesWithBars(count = 8, { basePrice = 60_000, priceStep = 10, cellsPerBar = 3 } = {}) {
  const intervalMs = 60_000;
  const startBase = 1_700_000_040_000;
  const series = new FootprintSeries({ intervalMs, priceStep });
  const bars = Array.from({ length: count }, (_, idx) => {
    const low = quantizeToStep(basePrice + (idx % 17) * priceStep, priceStep);
    const open = quantizeToStep(low + priceStep, priceStep);
    const close = quantizeToStep(low + Math.max(1, cellsPerBar - 1) * priceStep, priceStep);
    const high = quantizeToStep(low + Math.max(2, cellsPerBar) * priceStep, priceStep);
    const cells = new Map();
    for (let c = 0; c < cellsPerBar; c++) {
      const bin = quantizeToStep(low + c * priceStep, priceStep);
      cells.set(bin, { priceBin: bin, buyVol: 5 + c + idx, sellVol: 3 + c, count: 8 });
    }
    return {
      startTime: startBase + idx * intervalMs,
      open,
      high,
      low,
      close,
      volume: 30,
      delta: 10,
      count: 32,
      cells,
      hasRef: true,
      completeness: "complete",
      sources: ["history"],
      updatedAt: startBase + idx * intervalMs,
      cellRevision: 1,
    };
  });
  series.loadBars(bars);
  return series;
}

function makeView({ colWidth = 20, offsetX = 0, priceTop = 60_200, pricePerPx = 0.5, width = 800, height = 600 } = {}) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height };
  view.colWidth = colWidth;
  view.offsetX = offsetX;
  view.priceTop = priceTop;
  view.pricePerPx = pricePerPx;
  return view;
}

test("Stage 2 GPU pixel-bucket LOD computes buckets per CSS pixel column and draws 12-vertex bucket candles", () => {
  assert.equal(PIXEL_BUCKET_RECORD_BYTES, 32);
  const mock = makeStage2FakeWebGpuDevice();
  const pipeline = new WebGpuNativeScenePipeline(mock.device, "rgba8unorm");
  const series = makeSeriesWithBars(400, { basePrice: 60_000, priceStep: 10 });
  const view = makeView({ colWidth: 0.25, offsetX: 0, width: 800, height: 600 });

  const scene = {
    series,
    view: {
      area: view.area,
      offsetX: view.offsetX,
      colWidth: view.colWidth,
      priceTop: view.priceTop,
      pricePerPx: view.pricePerPx,
      candleWidth: view.candleStripWidth(),
    },
    candleStyle: "full",
    lodMode: "pixel-bucket",
    drawGrid: false,
    drawCandles: true,
    drawFootprint: false,
    drawHeat: false,
    drawPoc: false,
  };

  const prep = pipeline.prepareFrame(scene, 800, 600);
  assert.equal(prep.ok, true);
  assert.equal(prep.lodMode, "pixel-bucket");
  assert.equal(prep.pixelBucketCount, 100);
  assert.equal(pipeline.needsComputeDispatch(), true);

  const enc = mock.device.createCommandEncoder({ label: "PB" });
  pipeline.recordComputePass(enc);
  assert.ok(mock.computeDispatches.some((d) => d.pipeline === "NativeScenePixelBucketComputePipeline"));

  const pass = enc.beginRenderPass({ label: "PB_PASS", colorAttachments: [] });
  pipeline.recordRenderPasses(pass, scene, prep);
  pass.end();
  const draw = pass.draws.find((d) => d.pipeline === "NativeScenePixelBucketCandlePipeline");
  assert.ok(draw);
  assert.equal(draw.vertexCount, 12);
  assert.equal(draw.instanceCount, 100);

  // Panning in pixel-bucket mode still requires compute dispatch to re-bucket columns
  const prepPan = pipeline.prepareFrame({
    ...scene,
    view: { ...scene.view, offsetX: -10 },
  }, 800, 600);
  assert.equal(prepPan.ok, true);
  assert.equal(pipeline.needsComputeDispatch(), true);

  pipeline.dispose();
  assert.equal(mock.buffers.find((b) => b.label === "NativeScenePixelBucketStorage").destroyed, true);
  assert.equal(mock.buffers.find((b) => b.label === "NativeSceneLodUniform").destroyed, true);
});

test("Stage 2 GPU sub-pixel merged-cells LOD accumulates per pixel row with 4 MiB cap and clean fallback above cap", () => {
  assert.equal(MERGED_ROW_RECORD_BYTES, 16);
  assert.equal(MERGED_ROW_BUFFER_MAX_BYTES, 4 * 1024 * 1024);

  const mock = makeStage2FakeWebGpuDevice();
  const pipeline = new WebGpuNativeScenePipeline(mock.device, "rgba8unorm");
  const smallSeries = makeSeriesWithBars(20, { basePrice: 60_000, priceStep: 10, cellsPerBar: 4 });
  const view = makeView({ colWidth: 20, priceTop: 60_200, pricePerPx: 20, width: 800, height: 600 });

  const baseScene = {
    series: smallSeries,
    view: {
      area: view.area,
      offsetX: view.offsetX,
      colWidth: view.colWidth,
      priceTop: view.priceTop,
      pricePerPx: view.pricePerPx,
      candleWidth: view.candleStripWidth(),
    },
    candleStyle: "strip",
    lodMode: "merged-cells",
    drawGrid: false,
    drawCandles: true,
    drawFootprint: true,
    drawHeat: true,
    drawPoc: true,
  };

  // 20 visible bars * 600px * 16B = 192 KiB <= 4 MiB -> GPU merged-cells path active
  const prep1 = pipeline.prepareFrame(baseScene, 800, 600);
  assert.equal(prep1.ok, true);
  assert.equal(prep1.lodMode, "merged-cells");
  assert.equal(prep1.mergedVisibleBars, 20);
  assert.equal(prep1.mergedPlotHeight, 600);

  const lodBuf = mock.buffers.find((b) => b.label === "NativeSceneLodUniform");
  const gen1 = new Uint32Array(lodBuf.data.buffer)[3];
  assert.equal(gen1, 1);

  const enc1 = mock.device.createCommandEncoder({ label: "MC1" });
  pipeline.recordComputePass(enc1);
  assert.ok(mock.computeDispatches.some((d) => d.pipeline === "NativeSceneMergedCellsComputePipeline"));
  const pass1 = enc1.beginRenderPass({ label: "MC1_PASS", colorAttachments: [] });
  pipeline.recordRenderPasses(pass1, baseScene, prep1);
  pass1.end();
  assert.deepEqual(
    pass1.draws.map((d) => `${d.pipeline}:${d.vertexCount}:${d.instanceCount}`),
    [
      "NativeSceneCandlePipeline:12:20",
      "NativeSceneMergedCellsRenderPipeline:12:12000",
    ],
  );

  // Frame 2 bumps frameGen without needing a clear pass
  const prep2 = pipeline.prepareFrame(baseScene, 800, 600);
  assert.equal(prep2.ok, true);
  assert.equal(new Uint32Array(lodBuf.data.buffer)[3], 2);

  // > 4 MiB case: 801 visible bars * 600px * 16B = 7.69 MiB > 4 MiB -> prepareFrame returns ok=false
  const largeSeries = makeSeriesWithBars(1000, { basePrice: 60_000, priceStep: 10, cellsPerBar: 2 });
  const largeView = makeView({ colWidth: 6, priceTop: 60_200, pricePerPx: 20, width: 4800, height: 600 });
  const prepLarge = pipeline.prepareFrame({
    ...baseScene,
    series: largeSeries,
    view: {
      area: largeView.area,
      offsetX: largeView.offsetX,
      colWidth: largeView.colWidth,
      priceTop: largeView.priceTop,
      pricePerPx: largeView.pricePerPx,
      candleWidth: largeView.candleStripWidth(),
    },
  }, 4800, 600);
  assert.equal(prepLarge.ok, false);

  pipeline.dispose();
  assert.equal(mock.buffers.find((b) => b.label === "NativeSceneMergedRowStorage").destroyed, true);
  assert.equal(mock.buffers.find((b) => b.label === "NativeSceneMergedBarMaxStorage").destroyed, true);

  // Verify FootprintRenderer falls back cleanly to immediate-quads when 4 MiB cap is exceeded
  resetGpuDiagnosticsForTest();
  configureGpuSettingsSource({
    read: () => ({ backend: "webgpu", residentHeatmap: false, asyncCapture: false, nativeWebGpu: true }),
    onChange: () => () => {},
  });
  try {
    const surfaceMock = makeStage2FakeWebGpuDevice();
    const ctx = makeFakeWebGpuContext("rgba8unorm");
    const canvas = { width: 4800, height: 600, getContext: (k) => (k === "webgpu" ? ctx : null) };
    const surface = new WebGpuSurface(canvas, {
      adapter: {},
      device: surfaceMock.device,
      format: "rgba8unorm",
      limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
      isLost: () => false,
      onLost: () => () => {},
      dispose: () => {},
    });
    const renderer = new FootprintRenderer(surface);
    renderer.setChartConfig({
      chartType: "footprint",
      candles: true,
      heat: true,
      poc: true,
      stackedImbalance: false,
      cellNumbers: false,
      clusterCellData: "bidask",
      profileCellData: "volume",
      tpoMode: "blocks",
      tpoProfilePeriod: "daily",
      tpoBracketSize: "30m",
    });
    renderer.renderLayers(largeView, largeSeries, new Set(["candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");
    surface.dispose();
  } finally {
    resetGpuSettingsForTest();
  }
});

test("Stage 2 WebGpuNativeHeatmapPipeline enforces 32B/64B layouts, static 0-upload, 64 MiB/256 MiB budgets and telemetry", () => {
  assert.equal(HEATMAP_CELL_RECORD_BYTES, 32);
  assert.equal(HEATMAP_UNIFORM_BYTES, 64);
  assert.equal(HEATMAP_WEBGPU_CHART_BUDGET_BYTES, 64 * 1024 * 1024);
  assert.equal(HEATMAP_WEBGPU_MODULE_BUDGET_BYTES, 256 * 1024 * 1024);

  const prev = isPerformanceTelemetryEnabled();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  const created = [];
  const leases = [];
  try {
    const mock = makeStage2FakeWebGpuDevice();
    const pipeline = new WebGpuNativeHeatmapPipeline(mock.device, "rgba8unorm");
    created.push(pipeline);
    const targetTexture = { createView: () => ({ tex: true }) };
    const plot = { left: 10, top: 20, width: 780, height: 560, pixelRatio: 1 };
    const lease = pipeline.reservePreparedPayload(1024);
    assert.ok(lease);
    leases.push(lease);

    const frame = {
      dataKey: "k-1",
      threshold: 10,
      floor: 10,
      ceiling: 1000,
      opacity: 0.85,
      main: [
        { x: 20, yTop: 100, width: 12, height: 8, value: 50 },
        { x: 32, yTop: 110, width: 12, height: 8, value: 500 },
      ],
      extension: [
        { x: 44, yTop: 110, width: 12, height: 8, value: 500, sourceMainIndex: 1 },
      ],
      preparedLease: lease,
    };

    assert.equal(pipeline.renderFrame(targetTexture, 800, 600, 1, frame, plot), true);
    assert.equal(mock.scissorRects[0].x, 10);
    assert.equal(mock.scissorRects[0].y, 20);
    assert.equal(mock.renderPasses[0].draws[0].instanceCount, 3);

    const snap1 = snapshotPerformanceTelemetry();
    assert.ok(snap1.metrics["chart.gpu.heatmap.render.ms"]?.count === 1);
    const firstUploadBytes = snap1.counters["gpu.native.heatmap.upload.bytes"];
    assert.equal(firstUploadBytes, 3 * 32 + 64);

    // Static frame: 0 storage + 0 uniform upload
    assert.equal(pipeline.renderFrame(targetTexture, 800, 600, 1, frame, plot), true);
    const snap2 = snapshotPerformanceTelemetry();
    assert.equal(snap2.counters["gpu.native.heatmap.upload.bytes"], firstUploadBytes, "static repeat frame uploads 0 bytes");

    // Verify 64 MiB per-chart budget & 256 MiB module-wide budget enforcement
    assert.equal(pipeline.reservePreparedPayload(HEATMAP_WEBGPU_CHART_BUDGET_BYTES), null);

    const extraPipelines = [];
    for (let i = 0; i < 4; i++) {
      const m = makeStage2FakeWebGpuDevice();
      const p = new WebGpuNativeHeatmapPipeline(m.device, "rgba8unorm");
      created.push(p);
      extraPipelines.push(p);
    }
    // 5 total pipelines x ~60 MiB lease -> 4th fits within 256 MiB, 5th fails module budget cleanly
    for (let i = 0; i < 4; i++) {
      const l = extraPipelines[i].reservePreparedPayload(60 * 1024 * 1024);
      assert.ok(l, `chart ${i} within 256 MiB module budget`);
      leases.push(l);
    }
    assert.equal(
      pipeline.reservePreparedPayload(30 * 1024 * 1024),
      null,
      "256 MiB module-wide budget rejects overflow without mutating ledger",
    );
  } finally {
    for (const l of leases) l.release();
    for (const p of created) p.dispose();
    assert.equal(getWebGpuHeatmapModuleReservedBytesForTest(), 0, "all WebGPU heatmap reservations cleanly released");
    configurePerformanceTelemetry({ enabled: prev });
    resetPerformanceTelemetry();
  }
});

test("Stage 2 ChartHeatmapGpuCoordinator routes WebGPU backend to native surface, caches leases, handles budget and failure latches", () => {
  resetGpuDiagnosticsForTest();
  const mock = makeStage2FakeWebGpuDevice();
  const ctx = makeFakeWebGpuContext("rgba8unorm");
  const canvas = { width: 800, height: 600, getContext: (k) => (k === "webgpu" ? ctx : null) };
  const surface = new WebGpuSurface(canvas, {
    adapter: {},
    device: mock.device,
    format: "rgba8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    isLost: () => false,
    onLost: () => () => {},
    dispose: () => {},
  });
  // Seed lastRenderedTexture via beginFrame
  const f = surface.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
  f.flushQuads(800, 600);
  f.end();

  const view = makeView({ colWidth: 20, priceTop: 200, pricePerPx: 0.5 });
  const series = makeSeriesWithBars(10, { basePrice: 100, priceStep: 10 });

  let invalidateCount = 0;
  let prepareCalls = 0;
  const fakeOverlay = {
    currentDataKey: () => "hm-key-1",
    getPrepareCacheKey: () => "cache-key-1",
    prepareGpuCells: (_v, _s, _range, reserve) => {
      prepareCalls++;
      const lease = reserve(2048);
      if (!lease) return null;
      return {
        dataKey: "hm-key-1",
        threshold: 10,
        floor: 10,
        ceiling: 500,
        opacity: 0.85,
        main: [{ x: 10, yTop: 20, width: 18, height: 10, value: 100 }],
        extension: [],
        preparedLease: lease,
      };
    },
  };

  const coord = new ChartHeatmapGpuCoordinator({
    backendKind: "webgpu",
    orderbookHeatmap: fakeOverlay,
    renderCoordinator: { getAnnotationLayerOrder: () => ["orderbook-heatmap"] },
    renderer: { visibleRange: () => [0, 10] },
    invalidateSession: () => { invalidateCount++; },
  });

  try {
    coord.setSurface(surface);
    coord.setHeatmapTexturePrototypeEnabled(true);
    assert.ok(invalidateCount >= 1);

    coord.beginFrameAttempt();
    const frame1 = coord.prepareHeatmapGpuCells(view, series);
    assert.ok(frame1);
    assert.equal(prepareCalls, 1);

    coord.renderHeatmapGpuCells(frame1, view, series);
    assert.equal(getGpuDiagnostics().featurePaths["orderbook-heatmap"], "webgpu");
    assert.equal(coord.heatmapGpuSuppressedAnnotation(view, series, [0, 10]), true);

    // Second frame hits prepared cache without invoking prepareGpuCells again
    coord.beginFrameAttempt();
    const frame2 = coord.prepareHeatmapGpuCells(view, series);
    assert.ok(frame2);
    assert.equal(prepareCalls, 1);
    coord.renderHeatmapGpuCells(frame2, view, series);
    assert.equal(getGpuDiagnostics().featurePaths["orderbook-heatmap"], "webgpu");

    // Transient budget pressure sets cpu without latching permanent failure
    const coordBudgetSurface = {
      kind: "webgpu",
      canvas,
      resize() {},
      beginFrame: surface.beginFrame.bind(surface),
      requestCapture: surface.requestCapture.bind(surface),
      onLost: () => () => {},
      dispose() {},
      supportsNativeHeatmap: () => true,
      reserveNativeHeatmapPayload: () => ({ release() {} }),
      renderNativeHeatmap: () => { throw new Error("Heatmap GPU prototype budget exceeded"); },
      disposeNativeHeatmap() {},
    };
    coord.setSurface(coordBudgetSurface);
    coord.beginFrameAttempt();
    const bFrame = coord.prepareHeatmapGpuCells(view, series);
    assert.ok(bFrame);
    coord.renderHeatmapGpuCells(bFrame, view, series);
    assert.equal(getGpuDiagnostics().featurePaths["orderbook-heatmap"], "cpu");

    // Returning to healthy surface renders again (not latched by transient budget exceeded!)
    coord.setSurface(surface);
    coord.beginFrameAttempt();
    const okAgain = coord.prepareHeatmapGpuCells(view, series);
    assert.ok(okAgain);
    coord.renderHeatmapGpuCells(okAgain, view, series);
    assert.equal(getGpuDiagnostics().featurePaths["orderbook-heatmap"], "webgpu");

    // Hard render failure (false) latches failure and stops future prepares until reset/toggle
    const failSurface = {
      ...coordBudgetSurface,
      renderNativeHeatmap: () => false,
    };
    coord.setSurface(failSurface);
    coord.beginFrameAttempt();
    const fFrame = coord.prepareHeatmapGpuCells(view, series);
    assert.ok(fFrame);
    coord.renderHeatmapGpuCells(fFrame, view, series);
    assert.equal(getGpuDiagnostics().featurePaths["orderbook-heatmap"], "cpu");
    coord.beginFrameAttempt();
    assert.equal(coord.prepareHeatmapGpuCells(view, series), null, "hard failure latched");
  } finally {
    coord.dispose();
    surface.dispose();
    assert.equal(getWebGpuHeatmapModuleReservedBytesForTest(), 0);
  }
});

test("Stage 2 gpuBackend, ChartHeatmapGpuCoordinator, ChartRuntime and footprintRenderer have zero static core/gpu/webgpu/* imports", () => {
  for (const rel of [
    "../src/core/gpu/gpuBackend.ts",
    "../src/core/render/footprintRenderer.ts",
    "../src/features/chart/ChartHeatmapGpuCoordinator.ts",
    "../src/features/chart/ChartRuntime.ts",
  ]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from\s+["'][^"']*webgpu\//, `${rel} must not statically import core/gpu/webgpu/*`);
  }
});

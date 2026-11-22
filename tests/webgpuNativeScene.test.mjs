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
  DEFAULT_GPU_SETTINGS,
  readGpuSettings,
  resetGpuSettingsForTest,
} from "../dist/core/gpu/gpuSettings.js";
import {
  getGpuDiagnostics,
  resetGpuDiagnosticsForTest,
} from "../dist/core/gpu/gpuDiagnostics.js";
import {
  requestWebGpuDevice,
  resetSharedWebGpuDevice,
} from "../dist/core/gpu/webgpu/webgpuDevice.js";
import { WebGpuQuadPipeline } from "../dist/core/gpu/webgpu/webgpuQuadPipeline.js";
import {
  BAR_RECORD_BYTES,
  CELL_RECORD_BYTES,
  COMPUTE_UNIFORM_BYTES,
  VIEW_UNIFORM_BYTES,
  WebGpuNativeScenePipeline,
} from "../dist/core/gpu/webgpu/webgpuNativeScenePipeline.js";
import { WebGpuSurface } from "../dist/core/gpu/webgpu/webgpuSurface.js";
import { FootprintRenderer } from "../dist/core/render/footprintRenderer.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { quantizeToStep } from "../dist/core/priceStep.js";
import { View } from "../dist/core/engine/view.js";
import { settings } from "../dist/core/settings.js";
import {
  buildWebGpuNativeAssessment,
  computeMissedFrameStats,
  computeUploadStats,
  formatTimestampSummary,
  formatWebGpuNativeMarkdown,
  WEBGPU_NATIVE_FIXTURE,
  WEBGPU_NATIVE_SCENARIOS,
} from "../harness/webgpuNativeBenchmark.mjs";
import { parseArgs as parseBenchmarkCliArgs } from "../scripts/webgpu-native-benchmark.mjs";

function makeFakeNativeWebGpuDevice({ timestampQuery = false, format = "rgba8unorm" } = {}) {
  const buffers = [];
  const querySets = [];
  const shaderModules = [];
  const computePipelines = [];
  const renderPipelines = [];
  const writtenBuffers = [];
  const computeDispatches = [];
  const renderPasses = [];
  const timestampResolutions = [];
  const pendingMapResolvers = [];

  const features = new Set(timestampQuery ? ["timestamp-query"] : []);

  const device = {
    format,
    features,
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    addEventListener() {},
    removeEventListener() {},
    createShaderModule(desc) {
      const mod = { label: desc.label, code: desc.code };
      shaderModules.push(mod);
      return mod;
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
        destroy() {
          this.destroyed = true;
        },
        mapAsync() {
          return new Promise((resolve) => {
            pendingMapResolvers.push(() => resolve());
          });
        },
        getMappedRange() {
          return data.buffer;
        },
        unmap() {
          this.unmapped = true;
        },
      };
      buffers.push(buf);
      return buf;
    },
    createQuerySet(desc) {
      const qs = { label: desc.label, type: desc.type, count: desc.count, destroyed: false, destroy() { this.destroyed = true; } };
      querySets.push(qs);
      return qs;
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
            bindGroups: new Map(),
            dispatches: [],
            setPipeline(p) { this.pipeline = p; },
            setBindGroup(idx, bg) { this.bindGroups.set(idx, bg); },
            dispatchWorkgroups(x, y = 1, z = 1) {
              this.dispatches.push({ x, y, z });
              computeDispatches.push({ x, y, z });
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
            bindGroups: new Map(),
            draws: [],
            setPipeline(p) { this.pipeline = p; },
            setBindGroup(idx, bg) { this.bindGroups.set(idx, bg); },
            setVertexBuffer() {},
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
        resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset) {
          timestampResolutions.push({ op: "resolveQuerySet", querySet, firstQuery, queryCount, destination, destinationOffset });
        },
        copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
          timestampResolutions.push({ op: "copyBufferToBuffer", source, sourceOffset, destination, destinationOffset, size });
        },
        copyTextureToBuffer() {},
        finish() {
          return { ok: true };
        },
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
          buffer,
          label: buffer.label,
          dstOffset,
          byteLength: srcBytes.byteLength,
        });
      },
      submit() {},
    },
  };

  return {
    device,
    buffers,
    querySets,
    shaderModules,
    computePipelines,
    renderPipelines,
    writtenBuffers,
    computeDispatches,
    renderPasses,
    timestampResolutions,
    flushTimestampReadbacks(deltaNs = 1_500_000n) {
      const readBuffers = buffers.filter((b) => b.label?.startsWith("NativeSceneTimestampRead"));
      for (const rb of readBuffers) {
        const view = new BigInt64Array(rb.data.buffer);
        view[0] = 10_000_000n;
        view[1] = 10_000_000n + deltaNs;
      }
      while (pendingMapResolvers.length > 0) {
        pendingMapResolvers.shift()();
      }
    },
  };
}

function makeFakeWebGpuContext(format = "rgba8unorm") {
  let configured = null;
  let texSeq = 0;
  return {
    configure(desc) { configured = desc; },
    getConfiguredDesc() { return configured; },
    getCurrentTexture() {
      texSeq++;
      return { id: texSeq, format, createView() { return { texture: this }; } };
    },
  };
}

function makeSeriesWithBars(count = 4, { basePrice = 60_000, priceStep = 10 } = {}) {
  const intervalMs = 60_000;
  const startBase = 1_700_000_040_000;
  const series = new FootprintSeries({ intervalMs, priceStep });
  const bars = Array.from({ length: count }, (_, idx) => {
    const low = quantizeToStep(basePrice + idx * priceStep, priceStep);
    const bin1 = quantizeToStep(low + priceStep, priceStep);
    const bin2 = quantizeToStep(low + priceStep * 2, priceStep);
    const high = quantizeToStep(low + priceStep * 3, priceStep);
    const open = bin1;
    const close = bin2;
    const cells = new Map([
      [low, { priceBin: low, buyVol: 5 + idx, sellVol: 3, count: 8 }],
      [bin1, { priceBin: bin1, buyVol: 12 + idx, sellVol: 6, count: 18 }],
      [bin2, { priceBin: bin2, buyVol: 2, sellVol: 4, count: 6 }],
    ]);
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

function makeView({ colWidth = 20, offsetX = 0, priceTop = 60_100, pricePerPx = 0.5 } = {}) {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = colWidth;
  view.offsetX = offsetX;
  view.priceTop = priceTop;
  view.pricePerPx = pricePerPx;
  return view;
}

test("gpuSettings supports nativeWebGpu default, backward compatibility and URL overrides", () => {
  resetGpuSettingsForTest();
  assert.equal(DEFAULT_GPU_SETTINGS.nativeWebGpu, false);
  assert.equal(readGpuSettings(null).nativeWebGpu, false);

  configureGpuSettingsSource({
    read: () => ({ backend: "webgpu", residentHeatmap: false, asyncCapture: false }),
    onChange: () => () => {},
  });
  const withoutField = readGpuSettings(null);
  assert.equal(withoutField.backend, "webgpu");
  assert.equal(withoutField.nativeWebGpu, undefined);

  assert.equal(readGpuSettings({ location: { search: "?webgpuNative=1" } }).nativeWebGpu, true);
  assert.equal(readGpuSettings({ location: { search: "?webgpuNative=true" } }).nativeWebGpu, true);
  assert.equal(readGpuSettings({ location: { search: "?webgpuNative=0" } }).nativeWebGpu, false);
  assert.equal(readGpuSettings({ location: { search: "?webgpuNative=false" } }).nativeWebGpu, false);
  assert.equal(readGpuSettings({ location: { search: "?gpu=webgpu&gpuNative=1" } }).nativeWebGpu, true);
  assert.equal(readGpuSettings({ location: { search: "?gpu=webgpu&gpuNative=0" } }).nativeWebGpu, false);
  resetGpuSettingsForTest();
});

test("requestWebGpuDevice negotiates optional timestamp-query and falls back safely when requestDevice fails", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    // 1. Adapter supports timestamp-query and grants it
    const tsRequests = [];
    const devWithTs = makeFakeNativeWebGpuDevice({ timestampQuery: true }).device;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {
        gpu: {
          getPreferredCanvasFormat: () => "rgba8unorm",
          async requestAdapter() {
            return {
              features: new Set(["timestamp-query"]),
              async requestDevice(desc) {
                tsRequests.push(desc ?? null);
                return devWithTs;
              },
            };
          },
        },
      },
    });
    const handleTs = await requestWebGpuDevice({ forceNew: true });
    assert.ok(handleTs);
    assert.equal(handleTs.supportsTimestampQuery, true);
    assert.deepEqual(tsRequests, [{ requiredFeatures: ["timestamp-query"] }]);

    // 2. Adapter reports timestamp-query, but requestDevice({ requiredFeatures }) throws -> falls back to plain requestDevice()
    const fallbackRequests = [];
    const devWithoutTs = makeFakeNativeWebGpuDevice({ timestampQuery: false }).device;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {
        gpu: {
          getPreferredCanvasFormat: () => "rgba8unorm",
          async requestAdapter() {
            return {
              features: new Set(["timestamp-query"]),
              async requestDevice(desc) {
                fallbackRequests.push(desc ?? null);
                if (desc?.requiredFeatures) {
                  throw new Error("timestamp-query disallowed");
                }
                return devWithoutTs;
              },
            };
          },
        },
      },
    });
    const handleFallback = await requestWebGpuDevice({ forceNew: true });
    assert.ok(handleFallback);
    assert.equal(handleFallback.supportsTimestampQuery, false);
    assert.deepEqual(fallbackRequests, [{ requiredFeatures: ["timestamp-query"] }, null]);
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, "navigator", originalDescriptor);
    resetSharedWebGpuDevice();
  }
});

test("WebGpuQuadPipeline uploadInstances increments gpu.upload.bytes telemetry", () => {
  const prev = isPerformanceTelemetryEnabled();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const { device } = makeFakeNativeWebGpuDevice();
    const pipeline = new WebGpuQuadPipeline(device, "rgba8unorm", 16);
    const quads = new Float32Array(10 * 5);
    pipeline.uploadInstances(quads, 10);
    const snap = snapshotPerformanceTelemetry();
    assert.equal(snap.counters["gpu.upload.bytes"], 10 * 20);
    pipeline.dispose();
  } finally {
    configurePerformanceTelemetry({ enabled: prev });
    resetPerformanceTelemetry();
  }
});

test("WebGpuNativeScenePipeline enforces 32B/16B layouts, priceOrigin precision, pan/zoom 0-data-upload, live tail sync and resetEpoch rebuild", () => {
  assert.equal(BAR_RECORD_BYTES, 32);
  assert.equal(CELL_RECORD_BYTES, 16);
  assert.equal(VIEW_UNIFORM_BYTES, 64);
  assert.equal(COMPUTE_UNIFORM_BYTES, 16);

  const prev = isPerformanceTelemetryEnabled();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  try {
    const mock = makeFakeNativeWebGpuDevice();
    const pipeline = new WebGpuNativeScenePipeline(mock.device, "rgba8unorm");

    // High-price series with 0.01 tick step to test f64->f32 priceOrigin relative precision
    const series = makeSeriesWithBars(4, { basePrice: 100_000.01, priceStep: 0.01 });
    const view = makeView({ priceTop: 100_000.1, pricePerPx: 0.001 });

    const sceneInput = {
      series,
      view: {
        area: view.area,
        offsetX: view.offsetX,
        colWidth: view.colWidth,
        priceTop: view.priceTop,
        pricePerPx: view.pricePerPx,
        candleWidth: view.candleStripWidth(),
      },
      candleStyle: "strip",
      drawGrid: false,
      drawCandles: true,
      drawFootprint: true,
      drawHeat: true,
      drawPoc: true,
    };

    // 1. Initial load: 4 bars (4 * 32 = 128B) + 12 cells (12 * 16 = 192B) = 320B data
    const prep1 = pipeline.prepareFrame(sceneInput, 800, 600);
    assert.equal(prep1.ok, true);
    assert.equal(pipeline.needsComputeDispatch(), true);
    assert.equal(pipeline.priceOrigin, 100_000.01);

    const enc1 = mock.device.createCommandEncoder({ label: "E1" });
    pipeline.recordComputePass(enc1);
    assert.equal(mock.computeDispatches.length, 1);
    assert.equal(mock.computeDispatches[0].x, 1);

    const barStorage = mock.buffers.find((b) => b.label === "NativeSceneBarStorage" && !b.destroyed);
    const cellStorage = mock.buffers.find((b) => b.label === "NativeSceneCellStorage" && !b.destroyed);
    const bar0F32 = new Float32Array(barStorage.data.buffer, 0, 8);
    assert.ok(Math.abs(bar0F32[0] - 0.01) < 1e-6, "bar0 openRel preserves 0.01 precision relative to priceOrigin");
    const cell1F32 = new Float32Array(cellStorage.data.buffer, 16, 4);
    assert.ok(Math.abs(cell1F32[1] - 0.01) < 1e-6, "cell1 priceBinRel preserves 0.01 precision");

    let counters = snapshotPerformanceTelemetry().counters;
    assert.equal(counters["gpu.native.upload.dataBytes"], 4 * 32 + 12 * 16);
    assert.equal(counters["gpu.native.upload.uniformBytes"], COMPUTE_UNIFORM_BYTES + VIEW_UNIFORM_BYTES);

    // 2. Pan / Zoom: 0 bytes storage upload, 0 compute dispatch, only ViewUniform (64B)
    const beforePanData = counters["gpu.native.upload.dataBytes"];
    const beforePanUniform = counters["gpu.native.upload.uniformBytes"];
    const panScene = {
      ...sceneInput,
      view: { ...sceneInput.view, offsetX: -20, colWidth: 24 },
    };
    const prepPan = pipeline.prepareFrame(panScene, 800, 600);
    assert.equal(prepPan.ok, true);
    assert.equal(pipeline.needsComputeDispatch(), false);
    counters = snapshotPerformanceTelemetry().counters;
    assert.equal(counters["gpu.native.upload.dataBytes"] - beforePanData, 0, "pan/zoom uploads 0 storage bytes");
    assert.equal(counters["gpu.native.upload.uniformBytes"] - beforePanUniform, VIEW_UNIFORM_BYTES);

    // 3. Live tail update: add trade to last bar -> only tail BarRecord (32B) + tail cells (3 * 16 = 48B)
    const beforeLiveData = counters["gpu.native.upload.dataBytes"];
    const beforeLiveUniform = counters["gpu.native.upload.uniformBytes"];
    const lastBar = series.at(series.length - 1);
    series.addTrade({
      time: lastBar.startTime + 1_000,
      price: lastBar.low + 0.01,
      qty: 5,
      isBuy: true,
      source: "live",
      id: "t-live-1",
    });

    const prepLive = pipeline.prepareFrame(panScene, 800, 600);
    assert.equal(prepLive.ok, true);
    assert.equal(pipeline.needsComputeDispatch(), true);

    const computeUniformBuf = mock.buffers.find((b) => b.label === "NativeSceneComputeUniform");
    const cu32 = new Uint32Array(computeUniformBuf.data.buffer);
    assert.equal(cu32[0], 3, "dirtyStart is tail bar index 3");
    assert.equal(cu32[1], 1, "dirtyCount is 1 bar");

    counters = snapshotPerformanceTelemetry().counters;
    assert.equal(counters["gpu.native.upload.dataBytes"] - beforeLiveData, 32 + 3 * 16);
    assert.equal(counters["gpu.native.upload.uniformBytes"] - beforeLiveUniform, COMPUTE_UNIFORM_BYTES + VIEW_UNIFORM_BYTES);

    // 4. resetEpoch / full reload: triggers full rebuild
    const beforeResetData = counters["gpu.native.upload.dataBytes"];
    const nextBars = makeSeriesWithBars(6, { basePrice: 100_000.01, priceStep: 0.01 }).list();
    series.loadBars(nextBars);
    const prepReset = pipeline.prepareFrame(panScene, 800, 600);
    assert.equal(prepReset.ok, true);
    assert.equal(pipeline.needsComputeDispatch(), true);
    assert.equal(cu32[0], 0);
    assert.equal(cu32[1], 6);
    counters = snapshotPerformanceTelemetry().counters;
    assert.equal(counters["gpu.native.upload.dataBytes"] - beforeResetData, 6 * 32 + 18 * 16);

    pipeline.dispose();
    assert.equal(pipeline.viewUniformBuffer.destroyed, true);
    assert.equal(pipeline.computeUniformBuffer.destroyed, true);
    assert.equal(mock.buffers.some((b) => b.label === "NativeSceneBarStorage" && b.destroyed), true);
    assert.equal(mock.buffers.some((b) => b.label === "NativeSceneCellStorage" && b.destroyed), true);
  } finally {
    configurePerformanceTelemetry({ enabled: prev });
    resetPerformanceTelemetry();
  }
});

test("WebGpuNativeScenePipeline timestamp-query 2-slot ring records chart.gpu.timestamp.ms and cleans up on dispose", async () => {
  const prev = isPerformanceTelemetryEnabled();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  try {
    const mock = makeFakeNativeWebGpuDevice({ timestampQuery: true });
    const ctx = makeFakeWebGpuContext("rgba8unorm");
    const canvas = {
      width: 800,
      height: 600,
      getContext: (k) => (k === "webgpu" ? ctx : null),
    };
    const handle = {
      adapter: {},
      device: mock.device,
      format: "rgba8unorm",
      limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
      supportsTimestampQuery: true,
      isLost: () => false,
      onLost: () => () => {},
      dispose: () => {},
    };

    const surface = new WebGpuSurface(canvas, handle);
    assert.equal(mock.shaderModules.length, 1, "WebGpuSurface ctor stays lazy for native scene shaders");
    assert.equal(mock.renderPipelines.length, 1, "WebGpuSurface ctor compiles only quad pipeline");
    assert.equal(surface.supportsNativeScene(), true);

    const series = makeSeriesWithBars(3);
    const view = makeView();

    // Render frame 1 & frame 2 while slot 0 is still mapping -> uses slot 0 then slot 1; frame 3 skips timestamp non-blocking
    for (let i = 0; i < 3; i++) {
      const ok = surface.renderNativeScene(
        { r: 0.07, g: 0.08, b: 0.1, a: 1 },
        800,
        600,
        {
          series,
          view: {
            area: view.area,
            offsetX: view.offsetX,
            colWidth: view.colWidth,
            priceTop: view.priceTop,
            pricePerPx: view.pricePerPx,
            candleWidth: view.candleStripWidth(),
          },
          candleStyle: "strip",
          drawGrid: true,
          drawCandles: true,
          drawFootprint: true,
          drawHeat: true,
          drawPoc: true,
          drawGridQuads: (q) => q.rect(10, 0, 1, 600, { r: 1, g: 1, b: 1, a: 0.055 }),
          drawForegroundOverlay: (q) => q.rect(20, 100, 2, 10, { r: 0.25, g: 0.95, b: 0.6, a: 0.95 }),
        },
      );
      assert.equal(ok, true);
    }

    assert.equal(mock.renderPasses.length, 3);
    assert.ok(mock.renderPasses[0].desc.timestampWrites);
    assert.equal(mock.renderPasses[0].desc.timestampWrites.beginningOfPassWriteIndex, 0);
    assert.equal(mock.renderPasses[1].desc.timestampWrites.beginningOfPassWriteIndex, 2);
    assert.equal(mock.renderPasses[2].desc.timestampWrites, undefined, "3rd frame skips timestamp non-blocking when 2 slots are busy");

    // Verify draw order within the single render pass: grid -> native candles -> native footprint -> foreground overlay
    const draws = mock.renderPasses[0].draws.map((d) => `${d.pipeline}:${d.firstInstance}:${d.instanceCount}`);
    assert.deepEqual(draws, [
      "QuadRenderPipeline:0:1",
      "NativeSceneCandlePipeline:0:3",
      "NativeSceneFootprintPipeline:0:9",
      "QuadRenderPipeline:1:1",
    ]);

    mock.flushTimestampReadbacks(2_500_000n);
    await new Promise((r) => setTimeout(r, 0));

    const tsMetric = snapshotPerformanceTelemetry().metrics["chart.gpu.timestamp.ms"];
    assert.ok(tsMetric);
    assert.equal(tsMetric.count, 2);
    assert.ok(Math.abs(tsMetric.totalMs / tsMetric.count - 2.5) < 1e-6);
    assert.ok(Math.abs(tsMetric.p50Ms - 2.5) < 1e-6);

    surface.dispose();
    assert.equal(mock.querySets[0].destroyed, true);
    const tsBuffers = mock.buffers.filter((b) => b.label?.startsWith("NativeSceneTimestamp"));
    assert.equal(tsBuffers.length, 4);
    assert.ok(tsBuffers.every((b) => b.destroyed));
  } finally {
    configurePerformanceTelemetry({ enabled: prev });
    resetPerformanceTelemetry();
  }
});

test("FootprintRenderer routes to renderNativeScene when eligible and falls back cleanly otherwise", () => {
  resetGpuDiagnosticsForTest();
  const prevTelemetry = isPerformanceTelemetryEnabled();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  const prevGrid = settings.grid;
  settings.grid = true;

  try {
    const mock = makeFakeNativeWebGpuDevice();
    const ctx = makeFakeWebGpuContext("rgba8unorm");
    let searchQuery = "?gpu=webgpu&webgpuNative=1";
    const canvas = {
      width: 800,
      height: 600,
      ownerDocument: {
        defaultView: {
          devicePixelRatio: 1,
          location: {
            get search() { return searchQuery; },
          },
        },
      },
      getContext: (k) => (k === "webgpu" ? ctx : null),
    };
    const handle = {
      adapter: {},
      device: mock.device,
      format: "rgba8unorm",
      limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
      isLost: () => false,
      onLost: () => () => {},
      dispose: () => {},
    };
    const surface = new WebGpuSurface(canvas, handle);
    const renderer = new FootprintRenderer(surface);
    const series = makeSeriesWithBars(4);
    const view = makeView({ colWidth: 20, priceTop: 60_060, pricePerPx: 0.2 });

    // 1. Eligible footprint mode -> webgpu-native
    renderer.setChartConfig({
      chartType: "footprint",
      candles: true,
      heat: true,
      poc: true,
      stackedImbalance: false,
      cellNumbers: true,
      clusterCellData: "bidask",
      profileCellData: "volume",
      tpoMode: "blocks",
      tpoProfilePeriod: "daily",
      tpoBracketSize: "30m",
    });
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "webgpu-native");
    const metricsSnap = snapshotPerformanceTelemetry().metrics;
    assert.ok(metricsSnap["chart.gpu.clear.ms"]?.count >= 1);
    assert.ok(metricsSnap["chart.gpu.grid.ms"]?.count >= 1);
    assert.ok(metricsSnap["chart.gpu.candles.ms"]?.count >= 1);
    assert.ok(metricsSnap["chart.gpu.footprint.ms"]?.count >= 1);
    assert.ok(metricsSnap["chart.gpu.flush.ms"]?.count >= 1);

    // 2. nativeWebGpu=0 -> immediate-quads
    searchQuery = "?gpu=webgpu&webgpuNative=0";
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");

    // 3. Log scale -> immediate-quads
    searchQuery = "?gpu=webgpu&webgpuNative=1";
    view.setScaleMode("logarithmic");
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");
    view.setScaleMode("linear");

    // 4. pixel-bucket LOD -> immediate-quads
    view.colWidth = 0.5;
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");
    view.colWidth = 20;

    // 5. Sub-pixel cell merge height (< 2px) -> immediate-quads
    view.pricePerPx = 20; // priceStep 10 / 20 = 0.5px < 2px
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");
    view.pricePerPx = 0.2;

    // 6. footprintProfile -> immediate-quads
    renderer.setChartConfig({
      chartType: "footprintProfile",
      candles: true,
      heat: true,
      poc: true,
      stackedImbalance: false,
      cellNumbers: true,
      clusterCellData: "bidask",
      profileCellData: "volume",
      tpoMode: "blocks",
      tpoProfilePeriod: "daily",
      tpoBracketSize: "30m",
    });
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint-profile"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");

    surface.dispose();
  } finally {
    settings.grid = prevGrid;
    configurePerformanceTelemetry({ enabled: prevTelemetry });
    resetPerformanceTelemetry();
  }
});

test("webgpuNativeBenchmark helpers compute missedFrameRatio, upload stats, hardware-invalid vs measured reports and CLI args", () => {
  assert.equal(WEBGPU_NATIVE_FIXTURE.markets.length, 4);
  assert.deepEqual(WEBGPU_NATIVE_FIXTURE.viewport, { width: 1600, height: 900 });
  assert.equal(WEBGPU_NATIVE_FIXTURE.barCount, 600);
  assert.equal(WEBGPU_NATIVE_FIXTURE.cellsPerBar, 40);
  assert.deepEqual(WEBGPU_NATIVE_SCENARIOS, ["pan", "zoom", "live"]);

  const raf = computeMissedFrameStats([16.6, 16.7, 25.0, 16.5], 20);
  assert.equal(raf.sampleCount, 4);
  assert.equal(raf.missedCount, 1);
  assert.equal(raf.missedFrameRatio, 0.25);

  const uploads = computeUploadStats({
    "gpu.upload.bytes": 6400,
    "gpu.native.upload.dataBytes": 0,
    "gpu.native.upload.uniformBytes": 6400,
  }, 100);
  assert.equal(uploads.totalBytes, 6400);
  assert.equal(uploads.perFrameBytes, 64);
  assert.equal(uploads.dataBytes, 0);

  assert.equal(formatTimestampSummary(null), "yok");
  assert.equal(formatTimestampSummary({ count: 0, meanMs: 0, p95Ms: 0 }), "yok");
  assert.equal(formatTimestampSummary({ count: 10, meanMs: 1.25, p95Ms: 2.5 }), "1.250 / 2.500 ms");

  const invalidAssessment = buildWebGpuNativeAssessment({ hardwareValid: false });
  assert.equal(invalidAssessment.decision, "NOT_EVALUATED_HARDWARE_INVALID");

  const makeMode = (frameMean, uploadTotal, dataBytes) => ({
    featurePaths: { scene: dataBytes === 0 ? "webgpu-native" : "immediate-quads" },
    scenarios: Object.fromEntries(WEBGPU_NATIVE_SCENARIOS.map((s) => [s, {
      combined: {
        "chart.frame.render.ms": { count: 10, meanMs: frameMean, p50Ms: frameMean, p95Ms: frameMean * 1.2, p99Ms: frameMean * 1.3 },
        "chart.surface.gpu.draw.ms": { count: 10, meanMs: frameMean * 0.6, p50Ms: frameMean * 0.6, p95Ms: frameMean * 0.8, p99Ms: frameMean * 0.9 },
        "chart.gpu.candles.ms": { count: 10, meanMs: 0.1, p50Ms: 0.1, p95Ms: 0.2, p99Ms: 0.2 },
        "chart.gpu.footprint.ms": { count: 10, meanMs: 0.2, p50Ms: 0.2, p95Ms: 0.3, p99Ms: 0.3 },
        "chart.gpu.flush.ms": { count: 10, meanMs: 0.1, p50Ms: 0.1, p95Ms: 0.15, p99Ms: 0.2 },
        "chart.gpu.timestamp.ms": { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
      },
      raf: computeMissedFrameStats([16.6, 16.7], 20),
      uploads: computeUploadStats({
        "gpu.upload.bytes": uploadTotal,
        "gpu.native.upload.dataBytes": s === "live" ? dataBytes : 0,
        "gpu.native.upload.uniformBytes": uploadTotal,
      }, 140),
    }])),
  });

  const measured = buildWebGpuNativeAssessment({
    hardwareValid: true,
    immediate: makeMode(3.0, 500_000, 500_000),
    gpuNative: makeMode(0.5, 8_960, 0),
  });
  assert.equal(measured.decision, "MEASURED");
  const md = formatWebGpuNativeMarkdown({
    runId: "test-run",
    hardwareValid: true,
    timestampQuerySupported: false,
    presentation: "real",
    ...measured,
  });
  assert.match(md, /\| pan \| gpu-native \|/);
  assert.match(md, /yok/);

  assert.equal(parseBenchmarkCliArgs(["--list"]).list, true);
  assert.equal(parseBenchmarkCliArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseBenchmarkCliArgs(["--help"]).help, true);
  assert.ok(parseBenchmarkCliArgs(["--output-dir", "gpu-rapor"]).outputDir.endsWith("gpu-rapor"));
});

test("gpuBackend, gpuSettings and footprintRenderer contain no static imports of core/gpu/webgpu/*", () => {
  for (const rel of [
    "../src/core/gpu/gpuBackend.ts",
    "../src/core/gpu/gpuSettings.ts",
    "../src/core/render/footprintRenderer.ts",
  ]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from\s+["'][^"']*webgpu\//, `${rel} must not statically import core/gpu/webgpu/*`);
  }
});

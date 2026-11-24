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
  buildDenseFootprintBars,
  buildWebGpuNativeAssessment,
  computeMissedFrameStats,
  computeUploadStats,
  formatTimestampSummary,
  formatWebGpuNativeMarkdown,
  resolveWebGpuNativeFixture,
  WEBGPU_NATIVE_DEFAULT_DECISION_RULE,
  WEBGPU_NATIVE_FIXTURE,
  WEBGPU_NATIVE_PROFILES,
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
    flushTimestampReadbacks(renderDeltaNs = 1_500_000n, computeDeltaNs = 0n) {
      const readBuffers = buffers.filter((b) => b.label?.startsWith("NativeSceneTimestampRead"));
      for (const rb of readBuffers) {
        const view = new BigInt64Array(rb.data.buffer);
        view[0] = 10_000_000n;
        view[1] = 10_000_000n + renderDeltaNs;
        if (view.length >= 4) {
          view[2] = computeDeltaNs > 0n ? 5_000_000n : 0n;
          view[3] = computeDeltaNs > 0n ? 5_000_000n + computeDeltaNs : 0n;
        }
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
  assert.equal(DEFAULT_GPU_SETTINGS.nativeWebGpu, true);
  assert.equal(readGpuSettings(null).nativeWebGpu, true);

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

    // 3. Live tail update: add trade to last bar -> only tail BarRecord (32B) + changed tail cell (1 * 16 = 16B)
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
    assert.equal(counters["gpu.native.upload.dataBytes"] - beforeLiveData, 32 + 16);
    assert.equal(counters["gpu.native.upload.uniformBytes"] - beforeLiveUniform, COMPUTE_UNIFORM_BYTES + VIEW_UNIFORM_BYTES);

    // 3b. Bar rollover incremental append: adds new bar without resetting prefix 0..2
    const beforeAppendData = counters["gpu.native.upload.dataBytes"];
    const beforeAppendUniform = counters["gpu.native.upload.uniformBytes"];
    const prevTail = series.at(series.length - 1);
    const newBarTime = prevTail.startTime + 60_000;
    const prevTailCellCount = prevTail.cells.size;
    series.addTrade({
      time: newBarTime + 1_000,
      price: prevTail.low + 0.02,
      qty: 7,
      isBuy: true,
      source: "live",
      id: "t-rollover-1",
    });
    assert.equal(series.length, 5);

    const prepAppend = pipeline.prepareFrame(panScene, 800, 600);
    assert.equal(prepAppend.ok, true);
    assert.equal(pipeline.needsComputeDispatch(), true);
    assert.equal(cu32[0], series.length - 2, "rollover append dirtyStart is barCount - 2");
    assert.equal(cu32[1], 2, "rollover append dirtyCount is 2 (prevTail + newTail)");

    const appendTailBar = series.at(series.length - 1);
    const expectedAppendBytes = 2 * BAR_RECORD_BYTES + (prevTailCellCount + appendTailBar.cells.size) * CELL_RECORD_BYTES;
    counters = snapshotPerformanceTelemetry().counters;
    assert.equal(counters["gpu.native.upload.dataBytes"] - beforeAppendData, expectedAppendBytes);
    assert.equal(counters["gpu.native.upload.uniformBytes"] - beforeAppendUniform, COMPUTE_UNIFORM_BYTES + VIEW_UNIFORM_BYTES);

    // 3c. Post-rollover pan still uploads 0 storage bytes
    const beforePostPanData = counters["gpu.native.upload.dataBytes"];
    const prepPostPan = pipeline.prepareFrame({
      ...panScene,
      view: { ...panScene.view, offsetX: -40 },
    }, 800, 600);
    assert.equal(prepPostPan.ok, true);
    assert.equal(pipeline.needsComputeDispatch(), false);
    counters = snapshotPerformanceTelemetry().counters;
    assert.equal(counters["gpu.native.upload.dataBytes"] - beforePostPanData, 0);

    // 3d. Post-rollover intra-bar trade uploads only 1 bar
    const beforePostLiveData = counters["gpu.native.upload.dataBytes"];
    series.addTrade({
      time: newBarTime + 2_000,
      price: prevTail.low + 0.03,
      qty: 4,
      isBuy: false,
      source: "live",
      id: "t-rollover-intra",
    });
    const prepPostLive = pipeline.prepareFrame(panScene, 800, 600);
    assert.equal(prepPostLive.ok, true);
    assert.equal(pipeline.needsComputeDispatch(), true);
    assert.equal(cu32[0], series.length - 1);
    assert.equal(cu32[1], 1);
    counters = snapshotPerformanceTelemetry().counters;
    assert.equal(
      counters["gpu.native.upload.dataBytes"] - beforePostLiveData,
      BAR_RECORD_BYTES + series.at(series.length - 1).cells.size * CELL_RECORD_BYTES,
    );

    // 3e. Multi-bar append within initial barCapacity (<= 64)
    const beforeMultiAppendBars = series.length;
    const growOffset = beforeMultiAppendBars - 1;
    for (let k = 1; k <= 20; k++) {
      series.addTrade({
        time: newBarTime + k * 60_000 + 500,
        price: prevTail.low + 0.01,
        qty: 2,
        isBuy: true,
        source: "live",
        id: `t-multi-append-${k}`,
      });
    }
    const prepMultiAppend = pipeline.prepareFrame(panScene, 800, 600);
    assert.equal(prepMultiAppend.ok, true);
    assert.equal(pipeline.needsComputeDispatch(), true);
    assert.equal(cu32[0], growOffset, "multi-bar append starts from previous tail");
    assert.equal(cu32[1], series.length - growOffset, "multi-bar append dispatches only appended slice");
    assert.equal(pipeline.barCellOffsets[0], 0);
    assert.equal(pipeline.barCellOffsets[1], 3);

    // 3f. Prefix mutation (< prevTailIdx) alongside rollover falls back cleanly to full rebuild
    const prefixBar = series.at(0);
    prefixBar.open += 0.01;
    const beforeFallbackData = snapshotPerformanceTelemetry().counters["gpu.native.upload.dataBytes"];
    series.addTrade({
      time: newBarTime + 21 * 60_000 + 500,
      price: prevTail.low + 0.01,
      qty: 1,
      isBuy: true,
      source: "live",
      id: "t-prefix-mutate-rollover",
    });
    const prepFallback = pipeline.prepareFrame(panScene, 800, 600);
    assert.equal(prepFallback.ok, true);
    assert.equal(cu32[0], 0, "mutated prefix triggers full rebuild from index 0");
    assert.equal(cu32[1], series.length);
    assert.ok(snapshotPerformanceTelemetry().counters["gpu.native.upload.dataBytes"] - beforeFallbackData > BAR_RECORD_BYTES * series.length);

    // 3g. Staging growth (> 128 bars while barCapacity = 256) preserves prefix barCellOffsets during append
    const grownSeries = makeSeriesWithBars(65, { basePrice: 100_000.01, priceStep: 0.01 });
    assert.equal(pipeline.prepareFrame({ ...panScene, series: grownSeries }, 800, 600).ok, true);
    const grownTail = grownSeries.at(grownSeries.length - 1);
    for (let k = 1; k <= 70; k++) {
      grownSeries.addTrade({
        time: grownTail.startTime + k * 60_000 + 500,
        price: grownTail.low + 0.01,
        qty: 2,
        isBuy: true,
        source: "live",
        id: `t-stage-grow-${k}`,
      });
    }
    assert.equal(pipeline.prepareFrame({ ...panScene, series: grownSeries }, 800, 600).ok, true);
    assert.equal(cu32[0], 64, "append across staging growth preserves prefix without full rebuild");
    assert.equal(cu32[1], grownSeries.length - 64);
    assert.equal(pipeline.barCellOffsets[0], 0, "staging growth preserves bar 0 offset");
    assert.equal(pipeline.barCellOffsets[1], 3, "staging growth preserves prefix bar offsets");

    // 4. resetEpoch / full reload: triggers full rebuild
    const prepReattach = pipeline.prepareFrame(panScene, 800, 600);
    assert.equal(prepReattach.ok, true);
    const beforeResetData = snapshotPerformanceTelemetry().counters["gpu.native.upload.dataBytes"];
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
    assert.equal(mock.renderPasses[1].desc.timestampWrites.beginningOfPassWriteIndex, 4);
    assert.equal(mock.renderPasses[2].desc.timestampWrites, undefined, "3rd frame skips timestamp non-blocking when 2 slots are busy");

    // Verify draw order within the single render pass: grid -> native candles -> native footprint -> foreground overlay
    const draws = mock.renderPasses[0].draws.map((d) => `${d.pipeline}:${d.firstInstance}:${d.instanceCount}`);
    assert.deepEqual(draws, [
      "QuadRenderPipeline:0:1",
      "NativeSceneCandlePipeline:0:3",
      "NativeSceneFootprintPipeline:0:9",
      "QuadRenderPipeline:1:1",
    ]);

    // Verify compute+render timestamp allocation (8 queries / 32B) and conditional query resolve counts (4 vs 2)
    assert.equal(mock.querySets[0].count, 8);
    const resolveOps = mock.timestampResolutions.filter((r) => r.op === "resolveQuerySet");
    const copyOps = mock.timestampResolutions.filter((r) => r.op === "copyBufferToBuffer");
    assert.equal(resolveOps.length, 2);
    assert.equal(resolveOps[0].queryCount, 4, "frame 0 ran compute -> resolves 4 queries");
    assert.equal(copyOps[0].size, 32, "frame 0 copies 32 bytes");
    assert.equal(resolveOps[1].queryCount, 2, "frame 1 pan skipped compute -> resolves 2 queries");
    assert.equal(copyOps[1].size, 16, "frame 1 copies 16 bytes");

    mock.flushTimestampReadbacks(2_500_000n, 500_000n);
    await new Promise((r) => setTimeout(r, 0));

    const tsMetric = snapshotPerformanceTelemetry().metrics["chart.gpu.timestamp.ms"];
    const tsComputeMetric = snapshotPerformanceTelemetry().metrics["chart.gpu.timestamp.compute.ms"];
    assert.ok(tsMetric);
    assert.equal(tsMetric.count, 2);
    // Slot 0 (ranCompute=true): 2.5 + 0.5 = 3.0 ms; Slot 1 (ranCompute=false): 2.5 ms -> mean = 2.75 ms
    assert.ok(Math.abs(tsMetric.totalMs - 5.5) < 1e-6);
    assert.ok(tsComputeMetric);
    assert.equal(tsComputeMetric.count, 1, "only compute frame records chart.gpu.timestamp.compute.ms");
    assert.ok(Math.abs(tsComputeMetric.totalMs - 0.5) < 1e-6);

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

test("WebGpuNativeScenePipeline enters O(1) memoized fallback on maxBufferSize overflow and recovers on new resetEpoch", () => {
  const mock = makeFakeNativeWebGpuDevice();
  const pipeline = new WebGpuNativeScenePipeline(mock.device, "rgba8unorm", { maxBufferSize: 128 });
  const series = makeSeriesWithBars(5); // 5 * 32 = 160B > 128B maxBufferSize
  const view = makeView();

  let atCalls = 0;
  const origAt = series.at.bind(series);
  series.at = (idx) => {
    atCalls++;
    return origAt(idx);
  };

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

  assert.equal(pipeline.prepareFrame(sceneInput, 800, 600).ok, false);
  const callsAfterFirst = atCalls;
  assert.ok(callsAfterFirst > 0);

  // Subsequent frames with same series & resetEpoch return false in O(1) without calling series.at
  assert.equal(pipeline.prepareFrame(sceneInput, 800, 600).ok, false);
  assert.equal(pipeline.prepareFrame(sceneInput, 800, 600).ok, false);
  assert.equal(atCalls, callsAfterFirst, "memoized overflow fallback skips scanning series bars");

  // New resetEpoch smaller than maxBufferSize recovers cleanly
  series.loadBars(makeSeriesWithBars(2).list()); // 2 bars * 32 = 64B <= 128B, 6 cells * 16 = 96B <= 128B
  assert.equal(pipeline.prepareFrame(sceneInput, 800, 600).ok, true);
  assert.deepEqual(pipeline.syncedCounts, { bars: 2, cells: 6 });

  pipeline.dispose();
});

test("FootprintRenderer routes to renderNativeScene when eligible and falls back cleanly otherwise", () => {
  resetGpuDiagnosticsForTest();
  const prevTelemetry = isPerformanceTelemetryEnabled();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  const prevGrid = settings.grid;
  settings.grid = true;

  try {
    resetGpuSettingsForTest();
    const mock = makeFakeNativeWebGpuDevice();
    const ctx = makeFakeWebGpuContext("rgba8unorm");
    let searchQuery = "?gpu=webgpu";
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

    // 1. Eligible footprint mode -> webgpu-native (does NOT emit synthetic 0ms candles/footprint timers; records native.overlay.ms)
    renderer.setChartConfig({
      chartType: "footprint",
      candles: true,
      heat: true,
      poc: true,
      stackedImbalance: true,
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
    assert.equal(metricsSnap["chart.gpu.candles.ms"]?.count ?? 0, 0, "native path omits synthetic zero chart.gpu.candles.ms");
    assert.equal(metricsSnap["chart.gpu.footprint.ms"]?.count ?? 0, 0, "native path omits synthetic zero chart.gpu.footprint.ms");
    assert.ok(metricsSnap["chart.gpu.native.overlay.ms"]?.count >= 1, "native path records chart.gpu.native.overlay.ms");
    assert.ok(metricsSnap["chart.gpu.flush.ms"]?.count >= 1);

    // 2. Host source omitting nativeWebGpu (undefined) -> defaults to webgpu-native
    configureGpuSettingsSource({
      read: () => ({ backend: "webgpu", residentHeatmap: false, asyncCapture: false }),
      onChange: () => () => {},
    });
    searchQuery = "?gpu=webgpu";
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "webgpu-native");

    // 2b. Host source with explicit nativeWebGpu: false -> immediate-quads
    configureGpuSettingsSource({
      read: () => ({ backend: "webgpu", residentHeatmap: false, asyncCapture: false, nativeWebGpu: false }),
      onChange: () => () => {},
    });
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");

    // 2c. Explicit URL opt-out (?webgpuNative=0 / ?gpuNative=0) -> immediate-quads
    resetGpuSettingsForTest();
    searchQuery = "?gpu=webgpu&webgpuNative=0";
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");
    searchQuery = "?gpu=webgpu&gpuNative=0";
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");

    // 3. Log scale -> immediate-quads
    searchQuery = "?gpu=webgpu&webgpuNative=1";
    view.setScaleMode("logarithmic");
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");
    view.setScaleMode("linear");

    // 4. pixel-bucket LOD -> webgpu-native (Stage 2 GPU pixel-bucket compute + render)
    view.colWidth = 0.5;
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "webgpu-native");
    view.colWidth = 20;

    // 5. Sub-pixel cell merge height (< 2px) -> webgpu-native (Stage 2 GPU merged-cells compute + render)
    view.pricePerPx = 20; // priceStep 10 / 20 = 0.5px < 2px
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "webgpu-native");
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
    resetGpuSettingsForTest();
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
  assert.equal(WEBGPU_NATIVE_FIXTURE.liveRolloverFramesPerRepetition, 40);
  assert.equal(WEBGPU_NATIVE_FIXTURE.liveRolloverEveryFrames, 3);
  assert.deepEqual(WEBGPU_NATIVE_SCENARIOS, ["pan", "zoom", "live", "live-rollover"]);

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

  const makeMode = (frameMean, uploadTotal, dataBytes, isNative, { fallbacks = [], rolloverP99Multiplier = 1.2 } = {}) => ({
    featurePaths: { scene: isNative ? "webgpu-native" : "immediate-quads" },
    fallbacks,
    scenarios: Object.fromEntries(WEBGPU_NATIVE_SCENARIOS.map((s) => [s, {
      combined: {
        "chart.frame.render.ms": { count: 10, meanMs: frameMean, p50Ms: frameMean, p95Ms: frameMean * 1.2, p99Ms: frameMean * 1.3 },
        "chart.surface.gpu.draw.ms": { count: 10, meanMs: frameMean * 0.6, p50Ms: frameMean * 0.6, p95Ms: frameMean * 0.8, p99Ms: frameMean * 0.9 },
        "chart.gpu.candles.ms": isNative ? { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 } : { count: 10, meanMs: 0.1, p50Ms: 0.1, p95Ms: 0.2, p99Ms: 0.2 },
        "chart.gpu.footprint.ms": isNative ? { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 } : { count: 10, meanMs: 0.2, p50Ms: 0.2, p95Ms: 0.3, p99Ms: 0.3 },
        "chart.gpu.flush.ms": { count: 10, meanMs: 0.1, p50Ms: 0.1, p95Ms: 0.15, p99Ms: 0.2 },
        "chart.gpu.timestamp.ms": { count: 10, meanMs: 0.4, p50Ms: 0.4, p95Ms: 0.6, p99Ms: 0.7 },
        "chart.gpu.timestamp.compute.ms": isNative && (s === "live" || s === "live-rollover")
          ? { count: 10, meanMs: 0.05, p50Ms: 0.05, p95Ms: 0.08, p99Ms: 0.1 }
          : { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
      },
      raf: computeMissedFrameStats([16.6, 16.7], 20),
      uploads: computeUploadStats({
        "gpu.upload.bytes": uploadTotal,
        "gpu.native.upload.dataBytes": s === "live" || s === "live-rollover" ? dataBytes : 0,
        "gpu.native.upload.uniformBytes": uploadTotal,
      }, 140),
      ...(s === "live-rollover"
        ? {
            rolloverCount: 26,
            rolloverFrames: {
              frameCount: 26,
              rolloverCount: 26,
              combined: {
                "chart.frame.render.ms": { count: 26, meanMs: frameMean, p50Ms: frameMean, p95Ms: frameMean * 1.1, p99Ms: frameMean * rolloverP99Multiplier },
                "chart.surface.gpu.draw.ms": { count: 26, meanMs: frameMean * 0.6, p50Ms: frameMean * 0.6, p95Ms: frameMean * 0.8, p99Ms: frameMean * 0.9 },
                "chart.gpu.flush.ms": { count: 26, meanMs: 0.1, p50Ms: 0.1, p95Ms: 0.15, p99Ms: 0.2 },
                "chart.gpu.timestamp.ms": { count: 26, meanMs: 0.4, p50Ms: 0.4, p95Ms: 0.6, p99Ms: 0.7 },
                "chart.gpu.timestamp.compute.ms": isNative
                  ? { count: 26, meanMs: 0.05, p50Ms: 0.05, p95Ms: 0.08, p99Ms: 0.1 }
                  : { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
              },
              uploads: computeUploadStats({
                "gpu.upload.bytes": isNative ? 40_000 : 1_200_000,
                "gpu.native.upload.dataBytes": isNative ? 32_000 : 0,
                "gpu.native.upload.uniformBytes": isNative ? 8_000 : 1_200_000,
              }, 104),
            },
          }
        : {}),
    }])),
  });

  const largeResolvedForGate = resolveWebGpuNativeFixture({ profile: "large" });
  const measured = buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolvedForGate,
    immediate: makeMode(3.0, 500_000, 500_000, false),
    gpuNative: makeMode(0.5, 8_960, 12_000, true),
    parity: { matchRatio: 1 },
  });
  assert.equal(measured.decision, "MEASURED");
  assert.equal(measured.defaultGate.decision, "DEFAULT_GO");
  assert.equal(measured.defaultGate.passed, true);
  assert.equal(invalidAssessment.defaultGate.decision, "NOT_EVALUATED_HARDWARE_INVALID");
  const standardProfileAssessment = buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: resolveWebGpuNativeFixture({ profile: "standard" }),
    immediate: makeMode(3.0, 500_000, 500_000, false),
    gpuNative: makeMode(0.5, 8_960, 12_000, true),
    parity: { matchRatio: 1 },
  });
  assert.equal(standardProfileAssessment.decision, "MEASURED");
  assert.equal(standardProfileAssessment.defaultGate.decision, "NOT_EVALUATED_PROFILE");
  const md = formatWebGpuNativeMarkdown({
    runId: "test-run",
    fixture: largeResolvedForGate,
    hardwareValid: true,
    timestampQuerySupported: true,
    presentation: "real",
    parity: { matchRatio: 1, nonBgPixelsNative: 213708 },
    ...measured,
  });
  assert.match(md, /\| pan \| gpu-native \|/);
  assert.match(md, /\| live-rollover \| gpu-native \|/);
  assert.match(md, /mean \/ p50 \/ p95 \/ p99 ms/);
  assert.match(md, /gpu\.ts\.compute/);
  assert.match(md, /Bar Devri \(Rollover\) Kareleri Özeti/);
  assert.match(md, /Telemetri Notu:/);
  assert.match(md, /defaultGate/);
  assert.match(md, /dgpu \+ igpu/);
  assert.match(md, /DEFAULT_GO/);

  assert.equal(parseBenchmarkCliArgs(["--list"]).list, true);
  assert.equal(parseBenchmarkCliArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseBenchmarkCliArgs(["--help"]).help, true);
  assert.ok(parseBenchmarkCliArgs(["--output-dir", "gpu-rapor"]).outputDir.endsWith("gpu-rapor"));
});

test("webgpuNativeBenchmark supports large profile, bounded custom fixtures, and defaultGate GO/NO_GO checks", () => {
  assert.deepEqual(WEBGPU_NATIVE_PROFILES.standard, { name: "standard", barCount: 600, cellsPerBar: 40, fitColumns: 60 });
  assert.deepEqual(WEBGPU_NATIVE_PROFILES.large, { name: "large", barCount: 2500, cellsPerBar: 120, fitColumns: 120 });
  assert.equal(WEBGPU_NATIVE_DEFAULT_DECISION_RULE.name, "webgpu-native-default-go");
  assert.equal(WEBGPU_NATIVE_DEFAULT_DECISION_RULE.maxP95Ratio, 0.80);
  assert.equal(WEBGPU_NATIVE_DEFAULT_DECISION_RULE.maxGpuTimestampP95Ms, 4.0);
  assert.equal(WEBGPU_NATIVE_DEFAULT_DECISION_RULE.requiredProfile, "large");
  assert.deepEqual(WEBGPU_NATIVE_DEFAULT_DECISION_RULE.requiredDeviceClasses, ["dgpu", "igpu"]);

  const defaultResolved = resolveWebGpuNativeFixture();
  assert.equal(defaultResolved.profile, "standard");
  assert.equal(defaultResolved.barCount, 600);
  assert.equal(defaultResolved.cellsPerBar, 40);

  const largeResolved = resolveWebGpuNativeFixture({ profile: "large" });
  assert.equal(largeResolved.profile, "large");
  assert.equal(largeResolved.barCount, 2500);
  assert.equal(largeResolved.cellsPerBar, 120);
  assert.equal(largeResolved.fitColumns, 120);

  const customResolved = resolveWebGpuNativeFixture({ profile: "large", barCount: "1200", cellsPerBar: "80", fitColumns: "90" });
  assert.equal(customResolved.barCount, 1200);
  assert.equal(customResolved.cellsPerBar, 80);
  assert.equal(customResolved.fitColumns, 90);

  assert.throws(() => resolveWebGpuNativeFixture({ profile: "huge" }), /Unknown WebGPU native profile/);
  assert.throws(() => resolveWebGpuNativeFixture({ barCount: 99 }), /Invalid barCount/);
  assert.throws(() => resolveWebGpuNativeFixture({ barCount: 10001 }), /Invalid barCount/);
  assert.throws(() => resolveWebGpuNativeFixture({ cellsPerBar: 9 }), /Invalid cellsPerBar/);
  assert.throws(() => resolveWebGpuNativeFixture({ cellsPerBar: 501 }), /Invalid cellsPerBar/);
  assert.throws(() => resolveWebGpuNativeFixture({ fitColumns: 19 }), /Invalid fitColumns/);
  assert.throws(() => resolveWebGpuNativeFixture({ fitColumns: 501 }), /Invalid fitColumns/);
  assert.throws(() => resolveWebGpuNativeFixture({ barCount: 500.5 }), /Invalid barCount/);

  const smallBars = buildDenseFootprintBars(Date.UTC(2026, 0, 15, 12, 0, 0), { barCount: 5, cellsPerBar: 12, priceStep: 10 });
  assert.equal(smallBars.length, 5);
  assert.equal(smallBars[0].cells.length, 12);
  assert.ok(smallBars[0].o >= smallBars[0].l && smallBars[0].o <= smallBars[0].h);
  assert.ok(smallBars[0].c >= smallBars[0].l && smallBars[0].c <= smallBars[0].h);

  const largeBars = buildDenseFootprintBars(Date.UTC(2026, 0, 15, 12, 0, 0), largeResolved);
  assert.equal(largeBars.length, 2500);
  assert.equal(largeBars[0].cells.length, 120);

  const cliLarge = parseBenchmarkCliArgs(["--profile", "large"]);
  assert.equal(cliLarge.fixture.profile, "large");
  assert.equal(cliLarge.fixture.barCount, 2500);
  const cliCustom = parseBenchmarkCliArgs(["--profile", "standard", "--bars", "1200", "--cells", "80", "--fit", "90"]);
  assert.equal(cliCustom.fixture.barCount, 1200);
  assert.equal(cliCustom.fixture.cellsPerBar, 80);
  assert.equal(cliCustom.fixture.fitColumns, 90);
  assert.throws(() => parseBenchmarkCliArgs(["--profile", "bad"]));
  assert.throws(() => parseBenchmarkCliArgs(["--bars", "50"]));
  assert.throws(() => parseBenchmarkCliArgs(["--cells"]));

  const buildReportMode = (
    frameMean,
    {
      fallbacks = [],
      rolloverP99Multiplier = 1.2,
      isNative = false,
      tsP95Ms = 0.6,
      tsCount = 10,
      rolloverTsP95Ms = 0.6,
      rolloverTsCount = 26,
      missedFrameRatio = 0,
      rafSampleCount = 58,
    } = {},
  ) => ({
    featurePaths: { scene: isNative ? "webgpu-native" : "immediate-quads" },
    fallbacks,
    scenarios: Object.fromEntries(WEBGPU_NATIVE_SCENARIOS.map((s) => [s, {
      combined: {
        "chart.frame.render.ms": { count: 10, meanMs: frameMean, p50Ms: frameMean, p95Ms: frameMean * 1.2, p99Ms: frameMean * 1.3 },
        "chart.surface.gpu.draw.ms": { count: 10, meanMs: frameMean * 0.5, p50Ms: frameMean * 0.5, p95Ms: frameMean * 0.7, p99Ms: frameMean * 0.8 },
        "chart.gpu.flush.ms": { count: 10, meanMs: 0.1, p50Ms: 0.1, p95Ms: 0.15, p99Ms: 0.2 },
        "chart.gpu.timestamp.ms": { count: tsCount, meanMs: tsP95Ms * 0.8, p50Ms: tsP95Ms * 0.8, p95Ms: tsP95Ms, p99Ms: tsP95Ms * 1.1 },
      },
      raf: { sampleCount: rafSampleCount, missedCount: 0, missedFrameRatio, maxIntervalMs: 17, p95IntervalMs: 16.7 },
      uploads: computeUploadStats({
        "gpu.upload.bytes": isNative ? 8_000 : 500_000,
        "gpu.native.upload.dataBytes": isNative && (s === "live" || s === "live-rollover") ? 4_000 : 0,
        "gpu.native.upload.uniformBytes": isNative ? 4_000 : 500_000,
      }, 140),
      ...(s === "live-rollover"
        ? {
            rolloverCount: 26,
            rolloverFrames: {
              frameCount: 26,
              rolloverCount: 26,
              combined: {
                "chart.frame.render.ms": { count: 26, meanMs: frameMean, p50Ms: frameMean, p95Ms: frameMean * 1.1, p99Ms: frameMean * rolloverP99Multiplier },
                "chart.gpu.timestamp.ms": { count: rolloverTsCount, meanMs: rolloverTsP95Ms * 0.8, p50Ms: rolloverTsP95Ms * 0.8, p95Ms: rolloverTsP95Ms, p99Ms: rolloverTsP95Ms * 1.1 },
              },
              uploads: computeUploadStats({
                "gpu.upload.bytes": isNative ? 30_000 : 1_000_000,
                "gpu.native.upload.dataBytes": isNative ? 20_000 : 0,
                "gpu.native.upload.uniformBytes": isNative ? 10_000 : 1_000_000,
              }, 104),
            },
          }
        : {}),
    }])),
  });

  const goAssess = buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false, missedFrameRatio: 0.02 }),
    gpuNative: buildReportMode(2.0, { isNative: true, missedFrameRatio: 0.01 }),
    parity: { matchRatio: 0.995 },
  });
  assert.equal(goAssess.defaultGate.profile, "large");
  assert.equal(goAssess.defaultGate.decision, "DEFAULT_GO");
  assert.equal(goAssess.defaultGate.passed, true);

  // Standard and shrunken large profiles -> NOT_EVALUATED_PROFILE
  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: defaultResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true }),
    parity: { matchRatio: 0.995 },
  }).defaultGate.decision, "NOT_EVALUATED_PROFILE");

  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: resolveWebGpuNativeFixture({ profile: "large", barCount: 500 }),
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true }),
    parity: { matchRatio: 0.995 },
  }).defaultGate.decision, "NOT_EVALUATED_PROFILE");

  // Missing timestamp-query, timestamp count, or rAF sampleCount -> NOT_EVALUATED_INCOMPLETE
  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: false,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true }),
    parity: { matchRatio: 0.995 },
  }).defaultGate.decision, "NOT_EVALUATED_INCOMPLETE");

  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true, tsCount: 0 }),
    parity: { matchRatio: 0.995 },
  }).defaultGate.decision, "NOT_EVALUATED_INCOMPLETE");

  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true, rafSampleCount: 0 }),
    parity: { matchRatio: 0.995 },
  }).defaultGate.decision, "NOT_EVALUATED_INCOMPLETE");

  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true }),
    parity: null,
  }).defaultGate.decision, "NOT_EVALUATED_INCOMPLETE");

  // p95 > 0.80x -> DEFAULT_NO_GO
  const slowAssess = buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(3.8, { isNative: true }),
    parity: { matchRatio: 0.995 },
  });
  assert.equal(slowAssess.defaultGate.decision, "DEFAULT_NO_GO");
  assert.equal(slowAssess.defaultGate.passed, false);

  // GPU timestamp p95 > 4.0ms (scenario or rollover) -> DEFAULT_NO_GO
  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true, tsP95Ms: 4.5 }),
    parity: { matchRatio: 0.995 },
  }).defaultGate.decision, "DEFAULT_NO_GO");

  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true, rolloverTsP95Ms: 4.2 }),
    parity: { matchRatio: 0.995 },
  }).defaultGate.decision, "DEFAULT_NO_GO");

  // missedFrameRatio regression -> DEFAULT_NO_GO
  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false, missedFrameRatio: 0.01 }),
    gpuNative: buildReportMode(2.0, { isNative: true, missedFrameRatio: 0.05 }),
    parity: { matchRatio: 0.995 },
  }).defaultGate.decision, "DEFAULT_NO_GO");

  // Parity < 0.99 -> DEFAULT_NO_GO
  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true }),
    parity: { matchRatio: 0.985 },
  }).defaultGate.decision, "DEFAULT_NO_GO");

  // Non-empty fallbacks -> DEFAULT_NO_GO
  assert.equal(buildWebGpuNativeAssessment({
    hardwareValid: true,
    timestampQuerySupported: true,
    fixture: largeResolved,
    immediate: buildReportMode(4.0, { isNative: false }),
    gpuNative: buildReportMode(2.0, { isNative: true, fallbacks: ["maxBufferSize"] }),
    parity: { matchRatio: 0.995 },
  }).defaultGate.decision, "DEFAULT_NO_GO");

  const largeMd = formatWebGpuNativeMarkdown({
    runId: "large-run",
    fixture: largeResolved,
    hardwareValid: true,
    timestampQuerySupported: true,
    presentation: "real",
    parity: { matchRatio: 0.995, nonBgPixelsNative: 213708 },
    ...goAssess,
  });
  assert.match(largeMd, /Profil: \*\*large\*\*/);
  assert.match(largeMd, /2500 bar × 120 hücre, fit=120/);
  assert.match(largeMd, /Varsayılan Bayrak/);
  assert.match(largeMd, /dgpu \+ igpu/);
  assert.match(largeMd, /DEFAULT_GO/);
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

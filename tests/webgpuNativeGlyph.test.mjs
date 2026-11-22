import test from "node:test";
import assert from "node:assert/strict";

import {
  configurePerformanceTelemetry,
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
  computeGlyphCellSdf,
  edt1d,
  getOrCreateGlyphAtlas,
  GLYPH_ATLAS_HEIGHT,
  GLYPH_ATLAS_WIDTH,
  GLYPH_CELL_SIZE,
  GLYPH_CHARSET,
  GLYPH_COUNT,
  GLYPH_INSTANCE_BYTES,
  glyphIndexForCharCode,
  resetGlyphAtlasForTest,
  WebGpuGlyphSink,
  WebGpuNativeGlyphPipeline,
} from "../dist/core/gpu/webgpu/webgpuNativeGlyphPipeline.js";
import { WebGpuSurface } from "../dist/core/gpu/webgpu/webgpuSurface.js";
import {
  cellTextCacheKey,
  formatFootprintCellText,
  getOrCreateBarCellTextEntries,
  parseCssColorToPackedRgba,
} from "../dist/core/render/overlay/footprintCellText.js";
import { drawCells } from "../dist/core/render/overlay/annotationRenderer.js";
import { Overlay } from "../dist/core/render/overlay.js";
import { FootprintRenderer } from "../dist/core/render/footprintRenderer.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { quantizeToStep } from "../dist/core/priceStep.js";
import { View } from "../dist/core/engine/view.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";
import { settings } from "../dist/core/settings.js";

function makeMockGlyphWebGpuDevice({ failGlyphPipeline = false } = {}) {
  const buffers = [];
  const textures = [];
  const samplers = [];
  const writtenTextures = [];
  const writtenBuffers = [];
  const renderPasses = [];
  const shaders = [];
  let ctxSeq = 0;

  const device = {
    features: new Set(),
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    createShaderModule(desc) {
      shaders.push(desc);
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
    createTexture(desc) {
      const tex = {
        label: desc.label,
        size: desc.size,
        format: desc.format,
        usage: desc.usage,
        destroyed: false,
        createView() { return { texture: tex }; },
        destroy() { this.destroyed = true; },
      };
      textures.push(tex);
      return tex;
    },
    createSampler(desc) {
      if (failGlyphPipeline) throw new Error("Simulated sampler creation failure");
      const s = { label: desc.label, ...desc };
      samplers.push(s);
      return s;
    },
    createBindGroupLayout(desc) { return { label: desc.label, entries: desc.entries }; },
    createBindGroup(desc) { return { label: desc.label, layout: desc.layout, entries: desc.entries }; },
    createPipelineLayout(desc) { return { label: desc.label, bindGroupLayouts: desc.bindGroupLayouts }; },
    createComputePipeline(desc) { return { label: desc.label, ...desc }; },
    createRenderPipeline(desc) { return { label: desc.label, ...desc }; },
    createCommandEncoder(desc) {
      return {
        label: desc.label,
        beginComputePass() {
          return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
        },
        beginRenderPass(rDesc) {
          const pass = {
            label: rDesc?.label,
            pipeline: null,
            draws: [],
            setPipeline(p) { this.pipeline = p; },
            setBindGroup() {},
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
            end() { renderPasses.push(pass); },
          };
          return pass;
        },
        finish() { return { ok: true }; },
      };
    },
    queue: {
      writeBuffer(buffer, dstOffset, data, dataOffset = 0, byteLength) {
        const src = data instanceof ArrayBuffer
          ? new Uint8Array(data, dataOffset, byteLength ?? (data.byteLength - dataOffset))
          : new Uint8Array(data.buffer, data.byteOffset, byteLength ?? data.byteLength);
        if (buffer.data && dstOffset + src.byteLength <= buffer.data.byteLength) {
          buffer.data.set(src, dstOffset);
        }
        writtenBuffers.push({ label: buffer.label, byteLength: src.byteLength });
      },
      writeTexture(dest, data, layout, size) {
        writtenTextures.push({ label: dest.texture?.label, byteLength: data.byteLength, layout, size });
      },
      submit() {},
    },
  };

  const ctx = {
    configure() {},
    getCurrentTexture() {
      ctxSeq++;
      return { id: ctxSeq, createView() { return { texture: this }; } };
    },
  };

  const canvas = {
    width: 800,
    height: 600,
    ownerDocument: { defaultView: null },
    getContext(kind) { return kind === "webgpu" ? ctx : null; },
  };

  const handle = {
    adapter: {},
    device,
    format: "rgba8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    supportsTimestampQuery: false,
    isLost() { return false; },
    onLost() { return () => {}; },
    dispose() {},
  };

  return { device, canvas, handle, buffers, textures, samplers, writtenTextures, writtenBuffers, renderPasses, shaders };
}

function makeTestSeries(priceStep = 10) {
  const intervalMs = 60_000;
  const t0 = 1_700_000_040_000;
  const series = new FootprintSeries({ intervalMs, priceStep });
  const bars = [0, 1, 2].map((idx) => {
    const low = quantizeToStep(60_000 + idx * priceStep, priceStep);
    const mid = quantizeToStep(low + priceStep, priceStep);
    const high = quantizeToStep(low + priceStep * 2, priceStep);
    return {
      startTime: t0 + idx * intervalMs,
      open: mid,
      high,
      low,
      close: high,
      volume: 30,
      delta: 6,
      buyVolume: 18,
      sellVolume: 12,
      count: 25,
      updatedAt: t0 + idx * intervalMs + 1000,
      cells: new Map([
        [low, { priceBin: low, buyVol: 14, sellVol: 3, count: 9 }],
        [mid, { priceBin: mid, buyVol: 4, sellVol: 13, count: 16 }],
      ]),
      cellRevision: idx + 1,
    };
  });
  series.loadBars(bars);
  return series;
}

function makeTestView({ colWidth = 96, pricePerPx = 10 / 12, scaleMode = "linear" } = {}) {
  const view = new View();
  view.pixelRatio = 1;
  view.area = { left: 0, top: 0, width: 740, height: 480 };
  view.colWidth = colWidth;
  view.offsetX = 740 - 3 * colWidth;
  view.setScaleMode(scaleMode);
  view.setPriceAutoScale(false);
  view.pricePerPx = pricePerPx;
  view.priceTop = 60_240;
  return view;
}

function makeRecordedCanvas2dContext() {
  const fillTextCalls = [];
  const canvas = {
    width: 800,
    height: 600,
    ownerDocument: null,
  };
  const ctx = {
    canvas,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    globalAlpha: 1,
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    setTransform() {},
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    setLineDash() {},
    measureText(text) { return { width: String(text).length * 6 }; },
    fillText(text, x, y) {
      fillTextCalls.push({ text: String(text), x, y, fillStyle: this.fillStyle, textAlign: this.textAlign });
    },
  };
  return { ctx, fillTextCalls };
}

test("EDT 1D and SDF glyph atlas satisfy geometric and caching invariants", () => {
  resetGlyphAtlasForTest();
  assert.equal(GLYPH_COUNT, 20);
  assert.equal(GLYPH_ATLAS_WIDTH, 1024);
  assert.equal(GLYPH_ATLAS_HEIGHT, 64);

  // Verify 1D squared EDT against brute-force distances on sparse impulse array
  const f = new Float32Array([1e9, 0, 1e9, 1e9, 1e9, 0, 1e9]);
  const d = new Float32Array(7);
  const v = new Int32Array(7);
  const z = new Float32Array(8);
  edt1d(f, 7, d, v, z);
  assert.deepEqual(Array.from(d), [1, 0, 1, 4, 1, 0, 1]);

  // Verify 2D SDF cell encoding (> 127 inside, < 128 outside, monotone away from border)
  const mask = new Uint8Array(GLYPH_CELL_SIZE * GLYPH_CELL_SIZE);
  for (let y = 16; y < 32; y++) {
    for (let x = 16; x < 32; x++) {
      mask[y * GLYPH_CELL_SIZE + x] = 1;
    }
  }
  const sdf = computeGlyphCellSdf(mask);
  const centerVal = sdf[24 * GLYPH_CELL_SIZE + 24];
  const innerEdgeVal = sdf[16 * GLYPH_CELL_SIZE + 24];
  const outerEdgeVal = sdf[15 * GLYPH_CELL_SIZE + 24];
  const farOutsideVal = sdf[2 * GLYPH_CELL_SIZE + 24];
  assert.ok(centerVal > innerEdgeVal && innerEdgeVal > 127, "inside SDF stays strictly > 127 and rises toward core");
  assert.ok(outerEdgeVal < 128 && farOutsideVal === 0, "outside SDF stays < 128 and decays to 0 past spread");

  // Module-level cached atlas in Node deterministic fallback
  const atlas1 = getOrCreateGlyphAtlas();
  const atlas2 = getOrCreateGlyphAtlas();
  assert.equal(atlas1, atlas2, "atlas is cached once at module level");
  assert.equal(atlas1.pixels.byteLength, 1024 * 64 * 4);
  assert.ok(atlas1.advanceRatio > 0);
  assert.equal(glyphIndexForCharCode("0".charCodeAt(0)), 0);
  assert.equal(glyphIndexForCharCode(" ".charCodeAt(0)), 19);
  assert.equal(glyphIndexForCharCode("$".charCodeAt(0)), -1);
});

test("shared formatFootprintCellText matches drawCells output across all 8 modes, full/compact, and showNotional", () => {
  const series = makeTestSeries(10);
  const modes = [
    "bidask",
    "volume",
    "count",
    "countBidask",
    "deltaPct",
    "avgTradeSize",
    "avgTradeSizeBidask",
    "delta",
  ];
  const prevSettings = { ...settings };

  try {
    settings.chartType = "footprint";
    settings.cellNumbers = true;

    for (const mode of modes) {
      for (const compact of [false, true]) {
        for (const showNotional of [true, false]) {
          settings.clusterCellData = mode;
          const view = makeTestView({ colWidth: compact ? 64 : 96 });
          const { ctx, fillTextCalls } = makeRecordedCanvas2dContext();
          const cellTextCache = new WeakMap();
          const host = {
            ctx,
            showNotional,
            chartConfig: { ...settings, chartType: "footprint", clusterCellData: mode, cellNumbers: true },
            profileCache: null,
            cellTextCache,
            lineLabels: [],
            pushIndicatorAxisRect() {},
            pushIndicatorScaleControlRects() {},
            queueLineObject() {},
            queuePriceMarker() {},
          };

          drawCells(host, view, series, [0, 3]);
          assert.ok(fillTextCalls.length > 0, `${mode} compact=${compact} notional=${showNotional} draws text`);

          const expected = [];
          const cache = new WeakMap();
          const key = cellTextCacheKey(mode, compact, showNotional, 10);
          for (let i = 0; i < 3; i++) {
            const bar = series.at(i);
            const barCache = getOrCreateBarCellTextEntries(cache, bar, key);
            for (const cell of bar.cells.values()) {
              const formatted = formatFootprintCellText(cell, mode, compact, 10, showNotional);
              barCache?.set(cell.priceBin, formatted);
              if (formatted.centerText !== undefined) {
                expected.push({ text: formatted.centerText, color: formatted.centerColor, align: "center" });
              } else {
                expected.push({ text: formatted.leftText, color: formatted.leftColor, align: "right" });
                expected.push({ text: formatted.rightText, color: formatted.rightColor, align: "left" });
              }
            }
          }

          assert.equal(fillTextCalls.length, expected.length, `call count matches for ${mode}`);
          for (let j = 0; j < expected.length; j++) {
            assert.equal(fillTextCalls[j].text, expected[j].text);
            assert.equal(fillTextCalls[j].fillStyle, expected[j].color);
            assert.equal(fillTextCalls[j].textAlign, expected[j].align);
          }
        }
      }
    }
  } finally {
    Object.assign(settings, prevSettings);
  }
});

test("parseCssColorToPackedRgba and WebGpuGlyphSink handle packing, spaces, clipping, and unsupported chars", () => {
  assert.equal(parseCssColorToPackedRgba("#3fe0a0"), 0xffa0e03f);
  assert.equal(parseCssColorToPackedRgba("rgba(10, 20, 30, 1)"), 0xff1e140a);

  const sink = new WebGpuGlyphSink(4, 0.6);
  const clip = { left: 0, top: 0, width: 200, height: 100 };
  // Spaces emit zero GPU quads yet succeed
  assert.equal(sink.addText("  ", 50, 50, 10, "center", 0xffffffff, clip), true);
  assert.equal(sink.count, 0);

  // Valid string emits packed instances
  assert.equal(sink.addText("+1.2k", 100, 50, 10, "center", parseCssColorToPackedRgba("#3fe0a0"), clip), true);
  assert.equal(sink.count, 5);
  assert.equal(sink.u32[5], 0xffa0e03f);

  // Off-screen clipped vertically -> succeeds with zero additional instances
  assert.equal(sink.addText("99M", 100, 160, 10, "center", 0xffffffff, clip), true);
  assert.equal(sink.count, 5);

  // Unsupported character rolls back atomically and returns false
  assert.equal(sink.addText("12$3", 100, 50, 10, "center", 0xffffffff, clip), false);
  assert.equal(sink.count, 5);
});

test("gpuSettings supports nativeWebGpuText default and URL overrides ?webgpuText=0|1 and ?gpuText=0|1", () => {
  resetGpuSettingsForTest();
  assert.equal(DEFAULT_GPU_SETTINGS.nativeWebGpuText, true);
  assert.equal(readGpuSettings(null).nativeWebGpuText, true);
  assert.equal(readGpuSettings({ location: { search: "?gpu=webgpu&webgpuText=0" } }).nativeWebGpuText, false);
  assert.equal(readGpuSettings({ location: { search: "?gpu=webgpu&webgpuText=1" } }).nativeWebGpuText, true);
  assert.equal(readGpuSettings({ location: { search: "?gpu=webgpu&gpuText=0" } }).nativeWebGpuText, false);
  assert.equal(readGpuSettings({ location: { search: "?gpu=webgpu&gpuText=true" } }).nativeWebGpuText, true);
  resetGpuSettingsForTest();
});

test("WebGpuSurface + FootprintRenderer + Overlay enforce zero-double-draw and full fallback matrix", () => {
  resetGpuSettingsForTest();
  resetGpuDiagnosticsForTest();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  try {
    const mock = makeMockGlyphWebGpuDevice();
    const surface = new WebGpuSurface(mock.canvas, mock.handle);
    const renderer = new FootprintRenderer(surface);
    const series = makeTestSeries(10);
    const view = makeTestView({ colWidth: 96, pricePerPx: 10 / 12 });
    const overlayCtx = makeRecordedCanvas2dContext();
    const overlay = new Overlay(
      overlayCtx.ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => renderer.renderedNativeFootprintText,
    );

    const baseConfig = {
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
    };
    renderer.setChartConfig(baseConfig);
    overlay.setChartConfig(baseConfig);

    // 1. Default -> webgpu-sdf renders inside same pass & skips Canvas2D drawCells completely
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "webgpu-native");
    assert.equal(getGpuDiagnostics().featurePaths.footprintText, "webgpu-sdf");
    assert.equal(renderer.renderedNativeFootprintText, true);
    assert.ok(mock.writtenTextures.some((t) => t.label === "NativeGlyphSdfAtlasTexture"));
    const firstPass = mock.renderPasses.at(-1);
    const glyphDraw = firstPass.draws.find((d) => d.pipeline === "NativeGlyphSdfRenderPipeline");
    assert.ok(glyphDraw && glyphDraw.vertexCount === 6 && glyphDraw.instanceCount > 0);
    const countersSnap = snapshotPerformanceTelemetry().counters;
    assert.ok((countersSnap["gpu.native.upload.glyphBytes"] ?? 0) === glyphDraw.instanceCount * GLYPH_INSTANCE_BYTES);
    assert.ok((snapshotPerformanceTelemetry().metrics["chart.gpu.native.text.ms"]?.count ?? 0) >= 1);

    overlayCtx.fillTextCalls.length = 0;
    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["footprint-text"], ChartChange.Viewport);
    assert.equal(overlayCtx.fillTextCalls.length, 0, "zero double-draw when webgpu-sdf rendered text");

    // 2. ?webgpuText=0 opt-out -> canvas2d text fallback while keeping webgpu-native scene
    mock.canvas.ownerDocument.defaultView = { location: { search: "?gpu=webgpu&webgpuText=0" } };
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "webgpu-native");
    assert.equal(getGpuDiagnostics().featurePaths.footprintText, "canvas2d");
    assert.equal(renderer.renderedNativeFootprintText, false);

    overlayCtx.fillTextCalls.length = 0;
    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["footprint-text"], ChartChange.Style);
    assert.ok(overlayCtx.fillTextCalls.length > 0, "Canvas2D drawCells runs when webgpuText=0");

    // 3. nativeWebGpuText: false via source -> canvas2d
    mock.canvas.ownerDocument.defaultView = null;
    configureGpuSettingsSource({
      read: () => ({ backend: "webgpu", residentHeatmap: false, asyncCapture: false, nativeWebGpu: true, nativeWebGpuText: false }),
      onChange: () => () => {},
    });
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.footprintText, "canvas2d");
    assert.equal(renderer.renderedNativeFootprintText, false);
    resetGpuSettingsForTest();

    // 4. allowNativeFootprintText = false (Canvas2D orderbook heatmap active) -> canvas2d
    renderer.setAllowNativeFootprintText(false);
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "webgpu-native");
    assert.equal(getGpuDiagnostics().featurePaths.footprintText, "canvas2d");
    assert.equal(renderer.renderedNativeFootprintText, false);
    renderer.setAllowNativeFootprintText(true);

    // 5. Log scale -> immediate-quads & canvas2d
    view.setScaleMode("logarithmic");
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");
    assert.equal(getGpuDiagnostics().featurePaths.footprintText, "canvas2d");
    assert.equal(renderer.renderedNativeFootprintText, false);
    view.setScaleMode("linear");

    // 6. footprintProfile -> immediate-quads & canvas2d
    renderer.setChartConfig({ ...baseConfig, chartType: "footprintProfile" });
    renderer.renderLayers(view, series, new Set(["grid", "candles", "footprint-profile"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "immediate-quads");
    assert.equal(getGpuDiagnostics().featurePaths.footprintText, "canvas2d");
    renderer.setChartConfig(baseConfig);

    // 7. Unsupported char fallback (Infinity volume -> "Infinity") -> returns false, falls back to canvas2d
    const badSeries = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
    badSeries.loadBars([{
      startTime: 1_700_000_040_000,
      open: 60_010,
      high: 60_020,
      low: 60_000,
      close: 60_020,
      volume: Number.POSITIVE_INFINITY,
      delta: 0,
      buyVolume: Number.POSITIVE_INFINITY,
      sellVolume: 0,
      count: 1,
      updatedAt: 1_700_000_041_000,
      cells: new Map([[60_000, { priceBin: 60_000, buyVol: Number.POSITIVE_INFINITY, sellVol: 0, count: 1 }]]),
      cellRevision: 1,
    }]);
    renderer.renderLayers(view, badSeries, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "webgpu-native");
    assert.equal(getGpuDiagnostics().featurePaths.footprintText, "canvas2d");
    assert.equal(renderer.renderedNativeFootprintText, false);

    // 8. Glyph pipeline init failure on WebGpuSurface -> latches disabled & falls back cleanly
    const failingMock = makeMockGlyphWebGpuDevice({ failGlyphPipeline: true });
    const failingSurface = new WebGpuSurface(failingMock.canvas, failingMock.handle);
    const failingRenderer = new FootprintRenderer(failingSurface);
    failingRenderer.setChartConfig(baseConfig);
    failingRenderer.renderLayers(view, series, new Set(["grid", "candles", "footprint"]));
    assert.equal(getGpuDiagnostics().featurePaths.scene, "webgpu-native");
    assert.equal(getGpuDiagnostics().featurePaths.footprintText, "canvas2d");
    assert.ok((getGpuDiagnostics().counters["gpu.featureFallback.footprintText.native_glyph_init_failed"] ?? 0) >= 1);

    surface.dispose();
    failingSurface.dispose();
    const gp = new WebGpuNativeGlyphPipeline(mock.device, "rgba8unorm");
    gp.dispose();
    assert.ok(gp.uniformBuffer.destroyed && gp.atlasTexture.destroyed);

    // 9. Overlay showNotional callback & DataTail skipFootprintText flip invalidates annotation pass cache
    let skipTextFlag = true;
    const notionalEvents = [];
    const flipOverlay = new Overlay(
      overlayCtx.ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => skipTextFlag,
      (val) => notionalEvents.push(val),
    );
    flipOverlay.setChartConfig(baseConfig);
    flipOverlay.showNotional = false;
    flipOverlay.showNotional = false;
    assert.deepEqual(notionalEvents, [false]);
    overlayCtx.fillTextCalls.length = 0;
    flipOverlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["footprint-text"], ChartChange.Viewport);
    assert.equal(overlayCtx.fillTextCalls.length, 0);
    skipTextFlag = false;
    flipOverlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["footprint-text"], ChartChange.DataTail);
    assert.ok(overlayCtx.fillTextCalls.length > 0, "DataTail draws Canvas2D cells when skipFootprintText flips false");
  } finally {
    resetGpuSettingsForTest();
    resetGpuDiagnosticsForTest();
    configurePerformanceTelemetry({ enabled: false });
    resetPerformanceTelemetry();
  }
});

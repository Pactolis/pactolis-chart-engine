import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { settings } from "../dist/core/settings.js";
import { resolveChartDisplayOptions } from "../dist/core/model/chartDisplayOptions.js";
import { calculateVolumeProfile } from "../dist/core/analysis/volumeProfile.js";
import { buildTpoBrackets } from "../dist/core/analysis/tpoProfile.js";
import { calculateNakedPocs } from "../dist/core/analysis/nakedPoc.js";
import { drawVolumeProfile } from "../dist/core/render/overlay/annotationRenderer.js";
import { drawHud } from "../dist/core/render/overlay/hudRenderer.js";
import { drawCrosshairPriceLabel } from "../dist/core/render/priceAxisRenderer.js";
import { drawCrosshairTimeLabel } from "../dist/core/render/timeAxisRenderer.js";
import { barStatsIndicatorDefinition } from "../dist/features/indicators/builtins/barStats.js";
import {
  getOrCreateGlyphAtlas,
  prewarmGlyphAtlasAsync,
  resetGlyphAtlasForTest,
} from "../dist/core/gpu/webgpu/webgpuNativeGlyphPipeline.js";
import { WebGpuSurface } from "../dist/core/gpu/webgpu/webgpuSurface.js";

const INTERVAL = 60_000;
const BASE_TIME = Date.UTC(2024, 0, 1);

function makeRichSeries(barCount) {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: "BINANCE_FUTURES:btcusdt" });
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const p = 100 + (i % 5);
    const cells = new Map([
      [p, { priceBin: p, buyVol: 12 + i, sellVol: 6, count: 2, buyCount: 1, sellCount: 1 }],
      [p + 1, { priceBin: p + 1, buyVol: 8, sellVol: 10 + (i % 3), count: 2, buyCount: 1, sellCount: 1 }],
    ]);
    bars.push({
      startTime: BASE_TIME + i * INTERVAL,
      open: p,
      high: p + 2,
      low: p - 1,
      close: p + 1,
      volume: 36 + i + (i % 3),
      delta: 4 + i - (i % 3),
      count: 4,
      liquidationBuyVol: 2,
      liquidationSellVol: 1,
      cells,
      hasRef: true,
      sources: i % 2 === 0 ? ["live"] : ["history"],
      completeness: "complete",
    });
  }
  series.loadBars(bars);
  return series;
}

function makeCounting2dCtx() {
  const counts = { measureText: 0 };
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "12px ui-monospace, monospace",
    textAlign: "left",
    textBaseline: "top",
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    save() {},
    restore() {},
    measureText(text) {
      counts.measureText++;
      return { width: String(text).length * 7 };
    },
    fillText() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    roundRect() {},
    fill() {},
    stroke() {},
    setLineDash() {},
    clearRect() {},
    getTransform() {
      return { a: 1, d: 1 };
    },
  };
  return { ctx, counts };
}

function makeFakeWebGpuSurfaceEnv() {
  const syncPipelineCalls = [];
  const asyncPipelineCalls = [];
  const makeBuffer = (desc) => ({
    label: desc.label,
    size: desc.size,
    usage: desc.usage,
    data: new Uint8Array(desc.size),
    destroyed: false,
    destroy() { this.destroyed = true; },
  });
  const makePass = () => ({
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setScissorRect() {},
    dispatchWorkgroups() {},
    draw() {},
    end() {},
  });
  const device = {
    features: new Set(),
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    createShaderModule(desc) { return { label: desc.label }; },
    createBuffer: makeBuffer,
    createTexture(desc) { return { label: desc.label, createView() { return {}; }, destroy() {} }; },
    createSampler(desc) { return { label: desc.label }; },
    createBindGroupLayout(desc) { return { label: desc.label }; },
    createBindGroup(desc) { return { label: desc.label }; },
    createPipelineLayout(desc) { return { label: desc.label }; },
    createComputePipeline(desc) {
      syncPipelineCalls.push(`compute:${desc.label}`);
      return { label: desc.label };
    },
    async createComputePipelineAsync(desc) {
      asyncPipelineCalls.push(`compute:${desc.label}`);
      return { label: desc.label };
    },
    createRenderPipeline(desc) {
      syncPipelineCalls.push(`render:${desc.label}`);
      return { label: desc.label };
    },
    async createRenderPipelineAsync(desc) {
      asyncPipelineCalls.push(`render:${desc.label}`);
      return { label: desc.label };
    },
    createCommandEncoder() {
      return {
        beginComputePass: makePass,
        beginRenderPass: makePass,
        finish() { return {}; },
      };
    },
    queue: {
      writeBuffer() {},
      writeTexture() {},
      submit() {},
    },
  };
  const canvas = {
    width: 800,
    height: 600,
    getContext() {
      return {
        configure() {},
        getCurrentTexture() {
          return { createView() { return {}; } };
        },
      };
    },
  };
  const handle = {
    device,
    format: "rgba8unorm",
    supportsTimestampQuery: false,
    limits: device.limits,
    isLost: () => false,
    onLost: () => () => {},
  };
  return { canvas, handle, syncPipelineCalls, asyncPipelineCalls };
}

test("#408: incremental prewarmGlyphAtlasAsync matches synchronous getOrCreateGlyphAtlas byte-for-byte", async () => {
  resetGlyphAtlasForTest();
  const syncAtlas = getOrCreateGlyphAtlas();
  const syncBytes = new Uint8Array(syncAtlas.pixels);

  resetGlyphAtlasForTest();
  const asyncAtlas = await prewarmGlyphAtlasAsync(5);
  assert.equal(asyncAtlas.width, syncAtlas.width);
  assert.equal(asyncAtlas.height, syncAtlas.height);
  assert.equal(asyncAtlas.advanceRatio, syncAtlas.advanceRatio);
  assert.deepEqual(asyncAtlas.pixels, syncBytes);

  // Also test sync completion resuming a started-in-flight async atlas build cleanly
  resetGlyphAtlasForTest();
  const pending = prewarmGlyphAtlasAsync(3);
  const completedSync = getOrCreateGlyphAtlas();
  const resolvedAsync = await pending;
  assert.equal(completedSync, resolvedAsync);
  assert.deepEqual(completedSync.pixels, syncBytes);
  resetGlyphAtlasForTest();
});

test("#408: WebGpuSurface.prewarmAsync compiles scene, LOD, glyph, and resident heatmap pipelines asynchronously", async () => {
  resetGlyphAtlasForTest();
  const { canvas, handle, syncPipelineCalls, asyncPipelineCalls } = makeFakeWebGpuSurfaceEnv();
  const surface = new WebGpuSurface(canvas, handle);
  // Clear initial WebGpuQuadPipeline construction call from constructor.
  syncPipelineCalls.length = 0;

  await surface.prewarmAsync();

  assert.equal(syncPipelineCalls.length, 0, "prewarmAsync should use async pipeline compilation APIs");
  assert.ok(asyncPipelineCalls.some((x) => x.includes("NativeScene") || x.includes("NativeCell") || x.includes("NativeMerged")));
  assert.ok(asyncPipelineCalls.some((x) => x.includes("NativeGlyphSdfRenderPipeline")));
  assert.ok(asyncPipelineCalls.some((x) => x.includes("NativeResidentHeatmapRenderPipeline")));

  // First renderNativeScene frame must not synchronously compile any pipeline
  const series = makeRichSeries(4);
  const rendered = surface.renderNativeScene({ r: 0, g: 0, b: 0, a: 1 }, 800, 600, {
    series,
    view: {
      area: { left: 0, top: 0, width: 800, height: 600 },
      offsetX: 0,
      colWidth: 20,
      priceTop: 120,
      pricePerPx: 0.5,
      candleWidth: 10,
    },
    lodMode: "standard",
    drawCandles: true,
    drawFootprint: true,
    drawHeat: false,
    drawPoc: false,
    drawFootprintText: false,
    candleStyle: "strip",
  });
  assert.equal(rendered, true);
  assert.equal(syncPipelineCalls.length, 0, "first render frame after prewarm must not compile synchronously");

  surface.dispose();
  resetGlyphAtlasForTest();
});

test("#409: drawVolumeProfile updates incrementally on tail tick/append and matches calculateVolumeProfile", () => {
  const prevEnabled = settings.volumeProfile;
  settings.volumeProfile = true;
  try {
    const series = makeRichSeries(15);
    const view = new View();
    view.area = { left: 0, top: 0, width: 800, height: 400 };
    view.fitPriceRange(95, 115);

    const { ctx } = makeCounting2dCtx();
    const host = {
      ctx,
      showNotional: false,
      chartConfig: null,
      profileCache: null,
      cellTextCache: new WeakMap(),
      lineLabels: [],
      getProfileSettings: () => ({
        enabled: true,
        mode: "visible",
        valueAreaPercent: 0.7,
        showPoc: true,
        showVah: true,
        showVal: true,
      }),
      pushIndicatorAxisRect() {},
      pushIndicatorScaleControlRects() {},
      queueLineObject() {},
      queuePriceMarker() {},
    };

    drawVolumeProfile(host, view, series, [0, series.length]);
    const initialAcc = host.profileCache.prefixAcc;
    assert.ok(initialAcc, "drawVolumeProfile stores closed-prefix accumulator");

    // Intra-bar tail tick -> reuses prefixAcc reference
    series.addTrade({
      time: BASE_TIME + 14 * INTERVAL + 5_000,
      price: 102,
      qty: 30,
      isBuy: true,
      liquidation: false,
      market: "BINANCE_FUTURES:btcusdt",
      source: "live",
    });
    drawVolumeProfile(host, view, series, [0, series.length]);
    assert.equal(host.profileCache.prefixAcc, initialAcc, "tail tick must reuse closed-prefix accumulator");

    // Append new bar -> advances closed-prefix accumulator in place
    series.appendOrUpdateBar({
      startTime: BASE_TIME + 15 * INTERVAL,
      open: 102,
      high: 104,
      low: 101,
      close: 103,
      volume: 20,
      delta: 4,
      count: 2,
      cells: new Map([[102, { priceBin: 102, buyVol: 12, sellVol: 8, count: 2 }]]),
      completeness: "complete",
    });
    drawVolumeProfile(host, view, series, [0, series.length]);
    assert.equal(host.profileCache.prefixAcc, initialAcc, "tail bar append must reuse prefix accumulator");

    const expected = calculateVolumeProfile(series.listReadonly(), 0.7);
    assert.deepEqual(host.profileCache.result.levels, expected.levels);
    assert.equal(host.profileCache.result.poc, expected.poc);
    assert.equal(host.profileCache.result.vah, expected.vah);
    assert.equal(host.profileCache.result.val, expected.val);
  } finally {
    settings.volumeProfile = prevEnabled;
  }
});

test("#409: barStats visible-sum single-pass and tail cache produce exact totals across ticks and appends", () => {
  const series = makeRichSeries(10);
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  const instance = {
    id: "bar-stats-1",
    type: "bar-stats",
    visible: true,
    settings: {
      mode: "visible-sum",
      fontSize: 12,
      textColor: "#fff",
      positiveColor: "#0f0",
      negativeColor: "#f00",
      showDeltaPercent: true,
      showLiquidations: true,
      showPlotLabel: true,
    },
  };
  const makeStatsCtx = (range) => ({
    ctx: null,
    view,
    series,
    rect: { top: 0, height: 100 },
    range,
    instance,
    settings: instance.settings,
    requestRefresh() {},
  });

  const p1 = barStatsIndicatorDefinition.prepareData(makeStatsCtx([2, 8]));
  // Exact cache hit returns same prepared object reference
  const p1Hit = barStatsIndicatorDefinition.prepareData(makeStatsCtx([2, 8]));
  assert.equal(p1Hit, p1);

  // Append bar to tail and expand visible range by 1
  series.appendOrUpdateBar({
    startTime: BASE_TIME + 10 * INTERVAL,
    open: 110,
    high: 125,
    low: 92,
    close: 120,
    volume: 55,
    delta: -11,
    count: 9,
    liquidationBuyVol: 3,
    liquidationSellVol: 7,
    sources: ["live"],
    cells: new Map(),
    completeness: "complete",
  });
  const p2 = barStatsIndicatorDefinition.prepareData(makeStatsCtx([2, series.length]));
  const slice = series.listReadonly().slice(2, series.length);
  const expectedVol = slice.reduce((a, b) => a + b.volume, 0);
  const expectedDelta = slice.reduce((a, b) => a + b.delta, 0);
  const expectedCount = slice.reduce((a, b) => a + b.count, 0);
  assert.equal(p2.meta.volume, expectedVol);
  assert.equal(p2.meta.delta, expectedDelta);
  assert.equal(p2.meta.count, expectedCount);
  assert.equal(p2.meta.high, 125);
  assert.equal(p2.meta.low, 92);
  assert.equal(p2.meta.open, slice[0].open);
  assert.equal(p2.meta.close, slice[slice.length - 1].close);
  assert.equal(p2.meta.liquidationsMeasured, true);
});

test("#410: drawHud uses WeakMap per-context memoization and caches measureText across alternating contexts", () => {
  const series = makeRichSeries(5);
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 400 };
  view.fitPriceRange(95, 115);

  const a = makeCounting2dCtx();
  const b = makeCounting2dCtx();
  const deps = { showNotional: false, displayOptions: resolveChartDisplayOptions({}) };
  const crosshair = { visible: true, x: 10, y: 50, touch: false };

  drawHud(a.ctx, view, series, crosshair, [0, 5], deps);
  const aAfterFirst = a.counts.measureText;
  assert.ok(aAfterFirst > 0);

  // Interleave second panel context ctxB (old module-level let lastHudMemo used to evict ctxA here!)
  drawHud(b.ctx, view, series, crosshair, [0, 5], deps);
  assert.ok(b.counts.measureText > 0);

  // Re-draw ctxA with identical state: zero extra measureText calls!
  drawHud(a.ctx, view, series, crosshair, [0, 5], deps);
  assert.equal(a.counts.measureText, aAfterFirst, "ctxA memo must survive interleaved draws on ctxB");
});

test("#410: priceAxisRenderer and timeAxisRenderer cache measureText widths per context", () => {
  const series = makeRichSeries(8);
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.priceAxisW = 70;
  view.fitPriceRange(95, 115);
  view.fitBarRange(0, 8);

  const p = makeCounting2dCtx();
  const displayOptions = resolveChartDisplayOptions({});
  drawCrosshairPriceLabel(p.ctx, view, series, { visible: true, x: 100, y: 200, touch: false }, displayOptions);
  const pAfterFirst = p.counts.measureText;
  assert.equal(pAfterFirst, 1);
  drawCrosshairPriceLabel(p.ctx, view, series, { visible: true, x: 120, y: 200, touch: false }, displayOptions);
  assert.equal(p.counts.measureText, pAfterFirst, "cached price text width should avoid repeated measureText");

  const t = makeCounting2dCtx();
  const xMid = view.xOfIndex(2) + view.colWidth / 2;
  drawCrosshairTimeLabel(t.ctx, view, series, { visible: true, x: xMid, y: 200, touch: false });
  const tAfterFirst = t.counts.measureText;
  assert.equal(tAfterFirst, 1);
  drawCrosshairTimeLabel(t.ctx, view, series, { visible: true, x: xMid, y: 220, touch: false });
  assert.equal(t.counts.measureText, tAfterFirst, "cached time text width should avoid repeated measureText");
});

test("#410: tpoProfile source dedup, nakedPoc calculation, and pass-key construction without per-frame JSON.stringify", async () => {
  const series = makeRichSeries(6);
  const bars = series.listReadonly();
  const brackets = buildTpoBrackets(bars, 300_000, 1);
  assert.ok(brackets.length >= 2);
  assert.deepEqual(brackets[0].bar.sources, ["live", "history"]);

  const naked = calculateNakedPocs(bars, "BINANCE_FUTURES:btcusdt", "D", BASE_TIME + 10 * 86_400_000, INTERVAL);
  assert.ok(Array.isArray(naked));

  const overlaySrc = await readFile(new URL("../src/core/render/overlay.ts", import.meta.url), "utf8");
  const tpoPaintSrc = await readFile(new URL("../src/core/render/overlay/tpoPaintHelpers.ts", import.meta.url), "utf8");
  assert.doesNotMatch(overlaySrc, /annotationPassCache\.begin\([^)]*JSON\.stringify/);
  assert.doesNotMatch(tpoPaintSrc, /retainHistory\([^)]*JSON\.stringify|key\s*=\s*JSON\.stringify/);
});

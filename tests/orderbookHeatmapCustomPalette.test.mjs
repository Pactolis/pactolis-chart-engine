import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import {
  DEFAULT_HEATMAP_CONTRAST,
  DEFAULT_HEATMAP_OPACITY,
  DEFAULT_HEATMAP_SCALE_MODE,
  DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
  activeOrderbookHeatmapThreshold,
  normalizeOrderbookHeatmapSources,
  resolveOrderbookHeatmapOpacity,
} from "../dist/core/orderbookHeatmap/settings.js";
import {
  HEATMAP_AUTO_PERCENTILES,
  HEATMAP_MAX_CELLS_PER_BAR,
  HEATMAP_SINGLE_CANONICAL_SOURCE,
  heatmapCellColor,
  heatmapCellRgba,
  heatmapIntensity,
  projectCanonicalHeatmapTailBar,
  resolveHeatmapColorRange,
} from "../dist/features/orderbook/heatmapModel.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import { HeatmapGpuRenderer } from "../dist/features/chart/heatmap/gpu/heatmapGpuRenderer.js";
import { HEATMAP_GPU_FRAG_SRC } from "../dist/features/chart/heatmap/gpu/heatmapGpuShaders.js";

const MINUTE = 60_000;
const MARKET = "BINANCE_FUTURES:btcusdt";

function makeView() {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 20;
  view.priceTop = 50_500;
  view.pricePerPx = 5;
  view.pixelRatio = 1;
  return view;
}

function makeSeries(length = 3, intervalMs = MINUTE) {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(Array.from({ length }, (_, i) => ({
    startTime: (1000 + i) * intervalMs,
    open: 50_000,
    high: 50_300,
    low: 49_700,
    close: 50_100,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  })));
  return series;
}

function makeRecordingCtx({ withOffscreen = false } = {}) {
  const fillStyles = [];
  const offFillStyles = [];
  let drawImageCalls = 0;
  const offCtx = {
    fillStyle: "",
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    setTransform() {},
    clearRect() {},
    fillRect() { offFillStyles.push(this.fillStyle); },
  };
  const offscreenCanvas = {
    width: 0,
    height: 0,
    getContext(kind) { return kind === "2d" ? offCtx : null; },
  };
  const ctx = {
    canvas: withOffscreen
      ? {
          width: 800,
          height: 400,
          ownerDocument: {
            createElement() { return offscreenCanvas; },
          },
        }
      : undefined,
    fillStyle: "",
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    setTransform() {},
    drawImage() { drawImageCalls++; },
    fillRect() { fillStyles.push(this.fillStyle); },
    strokeRect() {},
    fillText() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
  };
  return {
    ctx,
    fillStyles,
    offFillStyles,
    getDrawImageCalls: () => drawImageCalls,
  };
}

async function withSettings(settingsFor, work) {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  const listeners = new Set();
  configureOrderbookHeatmapSettingsSource({
    settingsFor,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  try {
    return await work(notify);
  } finally {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
}

test("settings helpers normalize custom sources, support custom mode, and preserve 5-field compatibility", () => {
  assert.deepEqual(
    normalizeOrderbookHeatmapSources(["  OKX:spot ", "binance:usd_perp", "okx:spot", "", "  ", "BYBIT:perp"]),
    ["binance:usd_perp", "bybit:perp", "okx:spot"],
  );
  assert.equal(DEFAULT_HEATMAP_OPACITY, 0.85);
  assert.equal(DEFAULT_HEATMAP_SCALE_MODE, "auto");
  assert.equal(DEFAULT_HEATMAP_CONTRAST, "medium");
  assert.equal(resolveOrderbookHeatmapOpacity(undefined), 0.85);
  assert.equal(resolveOrderbookHeatmapOpacity(1.5), 1);
  assert.equal(resolveOrderbookHeatmapOpacity(-0.2), 0);
  assert.equal(DEFAULT_ORDERBOOK_HEATMAP_SETTINGS.opacity, 0.85);

  // Legacy 5-field settings object still resolves cleanly
  const legacy = {
    mode: "single",
    unit: "usd",
    bucketStep: 25,
    single: { usd: 20_000_000, btc: 240 },
    aggregated: { usd: 50_000_000, btc: 600 },
  };
  assert.equal(activeOrderbookHeatmapThreshold(legacy), 20_000_000);
  assert.equal(activeOrderbookHeatmapThreshold({
    ...legacy,
    mode: "custom",
    custom: { usd: 12_500_000, btc: 150 },
  }), 12_500_000);
  assert.equal(activeOrderbookHeatmapThreshold({ ...legacy, mode: "custom" }), 0);
});

test("threshold=0 does not saturate positive values to 1 and separates multi-density levels", () => {
  assert.equal(heatmapIntensity(0, 0, 100), 0);
  assert.equal(heatmapIntensity(-5, 0, 100), 0);
  const low = heatmapIntensity(1_000_000, 0, 100_000_000);
  const mid = heatmapIntensity(10_000_000, 0, 100_000_000);
  const high = heatmapIntensity(50_000_000, 0, 100_000_000);
  const peak = heatmapIntensity(100_000_000, 0, 100_000_000);
  assert.ok(low > 0 && low < mid && mid < high && high < peak);
  assert.equal(peak, 1);

  // Without a positive ceiling, positive values still do not collapse to 1
  assert.ok(heatmapIntensity(500, 0) < 1);
  assert.ok(heatmapIntensity(500, 0) < heatmapIntensity(50_000, 0));

  const values = [0, 500_000, 1_000_000, 5_000_000, 10_000_000, 25_000_000, 80_000_000];
  const range = resolveHeatmapColorRange({ values, threshold: 0 });
  assert.ok(range.floor > 0 && range.ceiling > range.floor);
  const intensities = values.slice(1).map((v) => heatmapIntensity(v, range.floor, range.ceiling));
  assert.ok(intensities[0] < intensities[3] && intensities[3] < intensities[5]);
});

test("auto percentile defaults to P15-P96 over P5-P98 to preserve mid-band contrast alongside outliers and gaps", () => {
  assert.deepEqual(HEATMAP_AUTO_PERCENTILES.medium, [0.15, 0.96]);
  assert.deepEqual(HEATMAP_AUTO_PERCENTILES.low, [0.05, 0.99]);
  assert.deepEqual(HEATMAP_AUTO_PERCENTILES.high, [0.25, 0.92]);

  // Fixture: low density + mid-band walls + high walls + single 2B outlier + zeros (gaps)
  const fixture = [
    0, 0, 0,
    2, 3, 4, 5, 6, 7, 8, 9, 10, 12,
    20, 22, 25, 28, 30, 35, 38, 40, 42, 45, 50, 55,
    75, 85, 95, 110, 125, 140,
    2000,
  ];
  const p15p96 = resolveHeatmapColorRange({ values: fixture, threshold: 0, contrast: "medium" });
  const p05p99 = resolveHeatmapColorRange({ values: fixture, threshold: 0, contrast: "low" });
  const p25p92 = resolveHeatmapColorRange({ values: fixture, threshold: 0, contrast: "high" });

  // Simulate P5-P98 on the same sorted positive values
  const pos = fixture.filter((v) => v > 0).sort((a, b) => a - b);
  const pct = (q) => {
    const idx = (pos.length - 1) * q;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return pos[lo] + (pos[hi] - pos[lo]) * (idx - lo);
  };
  const p5 = pct(0.05);
  const p98 = pct(0.98);

  const spread = (floor, ceil) => heatmapIntensity(55, floor, ceil) - heatmapIntensity(20, floor, ceil);
  const p15p96Spread = spread(p15p96.floor, p15p96.ceiling);
  const p5p98Spread = spread(p5, p98);

  assert.ok(p15p96.ceiling < 200, "P15-P96 clips single extreme outlier");
  assert.ok(p98 > 500, "P5-P98 is pulled up by the extreme outlier");
  assert.ok(p15p96Spread > p5p98Spread * 1.5, "P15-P96 delivers markedly stronger mid-band separation");
  assert.ok(spread(p05p99.floor, p05p99.ceiling) < p15p96Spread);
  assert.ok(spread(p25p92.floor, p25p92.ceiling) > p15p96Spread);

  const fixed = resolveHeatmapColorRange({
    values: fixture,
    threshold: 10,
    scaleMode: "fixed",
    fixedCeiling: 100,
  });
  assert.deepEqual(fixed, { floor: 10, ceiling: 100 });
});

test("luminance palette increases brightness monotonically, keeps peak translucent, and matches WebGL2 shader math", () => {
  const luminance = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let prevLum = -1;
  for (let i = 0; i <= 20; i++) {
    const rgba = heatmapCellRgba(i / 20, 1, 0.85);
    const lum = luminance(rgba);
    assert.ok(lum > prevLum, `luminance must increase monotonically at step ${i}`);
    prevLum = lum;
  }
  const peakAtFullOpacity = heatmapCellRgba(1, 1, 1);
  assert.ok(peakAtFullOpacity.a <= 0.7, "peak cell stays translucent so candles/footprint marks stay readable");

  // Exact GLSL shader parity evaluator mirroring HEATMAP_GPU_FRAG_SRC
  function glslFragEval(value, floor, ceiling, alphaScale, opacity) {
    if (!(value > 0)) return { r: 18, g: 38, b: 84, a: Math.floor(0.22 * alphaScale * opacity * 1000 + 0.5) / 1000 };
    const effectiveCeiling = floor > 0 ? Math.max(ceiling, floor * 2) : ceiling;
    const uLogSpan = floor > 0 ? Math.log10(effectiveCeiling / floor) : (effectiveCeiling > 0 ? effectiveCeiling : 0);
    let k = 0;
    if (floor > 0 && uLogSpan > 0) {
      k = Math.min(1, Math.max(0, Math.log2(value / floor) * 0.30102999566398120 / uLogSpan));
    } else if (uLogSpan > 0) {
      k = Math.min(1, Math.max(0, Math.log2(1 + (value / uLogSpan) * 100) * 0.30102999566398120 / 2.0043213737826426));
    } else {
      k = Math.min(1, Math.max(0, Math.log2(1 + value) * 0.30102999566398120 / 8));
    }
    let c0;
    let c1;
    let a0;
    let a1;
    let t;
    if (k <= 0.40) {
      t = k / 0.40;
      c0 = [18, 38, 84]; c1 = [24, 112, 168]; a0 = 0.22; a1 = 0.36;
    } else if (k <= 0.75) {
      t = (k - 0.40) / 0.35;
      c0 = [24, 112, 168]; c1 = [34, 211, 238]; a0 = 0.36; a1 = 0.54;
    } else {
      t = (k - 0.75) / 0.25;
      c0 = [34, 211, 238]; c1 = [254, 240, 178]; a0 = 0.54; a1 = 0.68;
    }
    return {
      r: Math.floor(c0[0] + (c1[0] - c0[0]) * t + 0.5),
      g: Math.floor(c0[1] + (c1[1] - c0[1]) * t + 0.5),
      b: Math.floor(c0[2] + (c1[2] - c0[2]) * t + 0.5),
      a: Math.floor((a0 + (a1 - a0) * t) * alphaScale * opacity * 1000 + 0.5) / 1000,
    };
  }

  for (const [floor, ceiling] of [[10, 100], [0, 100], [0, 0]]) {
    for (const value of [0, 5, 25, 65, 100]) {
      for (const alphaScale of [1, 0.45]) {
        for (const opacity of [0.85, 1]) {
          const k = heatmapIntensity(value, floor, ceiling);
          const cpu = heatmapCellRgba(k, alphaScale, opacity);
          const gpu = glslFragEval(value, floor, ceiling, alphaScale, opacity);
          assert.deepEqual(cpu, gpu, `parity mismatch at value=${value}, floor=${floor}, ceiling=${ceiling}`);
          const css = heatmapCellColor(k, alphaScale, opacity);
          const cpuFromCss = css.match(/^rgba\((\d+), (\d+), (\d+), (\d+\.\d+)\)$/);
          assert.ok(cpuFromCss);
          assert.ok(Math.abs(Number(cpuFromCss[1]) - gpu.r) <= 1);
          assert.ok(Math.abs(Number(cpuFromCss[2]) - gpu.g) <= 1);
          assert.ok(Math.abs(Number(cpuFromCss[3]) - gpu.b) <= 1);
        }
      }
    }
  }

  // Verify shader source contains expected uniform names and renderer binds u_floor / u_logSpan / u_opacity
  assert.match(HEATMAP_GPU_FRAG_SRC, /uniform float u_floor;/);
  assert.match(HEATMAP_GPU_FRAG_SRC, /uniform float u_logSpan;/);
  assert.match(HEATMAP_GPU_FRAG_SRC, /uniform float u_opacity;/);

  const uniformValues = new Map();
  const modelled = {
    canvas: { ownerDocument: { defaultView: { devicePixelRatio: 1 } } },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    MAX_TEXTURE_SIZE: 0x0d33,
    getParameter: () => 4096,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getAttribLocation: (_p, name) => ["a_unit", "a_rect", "a_texel", "a_alphaScale"].indexOf(name),
    getUniformLocation: (_p, name) => ({ name }),
    uniform1f: (loc, v) => { uniformValues.set(loc.name, v); },
    drawArraysInstanced: () => {},
  };
  const gl = new Proxy(modelled, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== "string") return undefined;
      return /^[A-Z0-9_]+$/.test(key) ? 0 : () => ({});
    },
  });
  const renderer = new HeatmapGpuRenderer();
  try {
    // Explicit floor & opacity
    assert.equal(renderer.renderFrame(gl, {
      main: [{ x: 0, yTop: 10, width: 10, height: 10, value: 40 }],
      extension: [],
      threshold: 0,
      floor: 10,
      ceiling: 100,
      opacity: 0.72,
      dataKey: "parity-explicit",
    }, { left: 0, top: 0, width: 400, height: 300 }), true);
    assert.equal(uniformValues.get("u_floor"), 10);
    assert.equal(uniformValues.get("u_logSpan"), 1);
    assert.ok(Math.abs(uniformValues.get("u_opacity") - 0.72) < 1e-6);

    // Backward-compatible fallback when floor & opacity are omitted
    assert.equal(renderer.renderFrame(gl, {
      main: [{ x: 0, yTop: 10, width: 10, height: 10, value: 40 }],
      extension: [],
      threshold: 20,
      ceiling: 80,
      dataKey: "parity-legacy",
    }, { left: 0, top: 0, width: 400, height: 300 }), true);
    assert.equal(uniformValues.get("u_floor"), 20);
    assert.ok(Math.abs(uniformValues.get("u_logSpan") - Math.log10(4)) < 1e-6);
    assert.equal(uniformValues.get("u_opacity"), 1);
  } finally {
    renderer.dispose();
  }
});

test("mode=custom with empty customSources issues 0 requests (chunk/live/hover), draws nothing, and never falls back to aggregated", async () => {
  let requests = 0;
  let liveSubscriptions = 0;
  await withSettings(() => ({
    mode: "custom",
    unit: "usd",
    bucketStep: 50,
    single: { usd: 1_000_000, btc: 10 },
    aggregated: { usd: 2_000_000, btc: 20 },
    custom: { usd: 1_000_000, btc: 10 },
    customSources: ["  ", ""],
  }), async () => {
    const series = makeSeries(3);
    const view = makeView();
    const rec = makeRecordingCtx();
    const overlay = new OrderbookHeatmapOverlay({
      fetch: async () => {
        requests++;
        throw new Error("unexpected fetch");
      },
      invalidate: () => {},
      getMarket: () => MARKET,
      subscribeLiveTail: () => {
        liveSubscriptions++;
        return () => {};
      },
    });
    try {
      overlay.draw(rec.ctx, view, series, [0, 2]);
      overlay.drawHover(rec.ctx, view, series, { x: 25, y: 100, visible: true });
      const gpu = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
      await new Promise((resolve) => setTimeout(resolve, 160));
      assert.equal(requests, 0);
      assert.equal(liveSubscriptions, 0);
      assert.equal(rec.fillStyles.length, 0);
      assert.equal(gpu, null);
      assert.deepEqual(overlay.getCoverage(), {
        requestedSources: [],
        observedSources: [],
        missingSources: [],
      });
    } finally {
      overlay.dispose();
    }
  });
});

test("rapid customSources and mode changes abort stale chunk and hover requests and ignore late responses", async () => {
  let currentSettings = {
    mode: "custom",
    unit: "usd",
    bucketStep: 50,
    single: { usd: 1_000_000, btc: 10 },
    aggregated: { usd: 2_000_000, btc: 20 },
    custom: { usd: 1_000_000, btc: 10 },
    customSources: ["okx:spot", "binance:usd_perp"],
  };
  await withSettings(() => currentSettings, async (notify) => {
    const series = makeSeries(2);
    const view = makeView();
    const pending = [];
    const overlay = new OrderbookHeatmapOverlay({
      fetch: (req, signal) => new Promise((resolve, reject) => {
        pending.push({ req, signal, resolve, reject });
      }),
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => 1003 * MINUTE,
    });
    try {
      const rec = makeRecordingCtx();
      // Start initial custom chunk fetch + hover timer
      overlay.draw(rec.ctx, view, series, [0, 1]);
      overlay.drawHover(rec.ctx, view, series, { x: 25, y: 100, visible: true });
      assert.equal(pending.length, 1);
      assert.deepEqual(pending[0].req.sources, ["binance:usd_perp", "okx:spot"]);
      const firstControllerSignal = pending[0].signal;
      assert.equal(firstControllerSignal.aborted, false);

      // Wait for hover debounce so a hover request is in-flight too
      await new Promise((resolve) => setTimeout(resolve, 140));
      assert.equal(pending.length, 2);
      const staleHoverSignal = pending[1].signal;

      // Rapidly switch customSources twice
      currentSettings = { ...currentSettings, customSources: ["bybit:perp"] };
      notify();
      assert.equal(firstControllerSignal.aborted, true, "stale chunk request aborted immediately on source change");
      assert.equal(staleHoverSignal.aborted, true, "stale hover request aborted immediately on source change");

      overlay.draw(rec.ctx, view, series, [0, 1]);
      assert.equal(pending.length, 3);
      assert.deepEqual(pending[2].req.sources, ["bybit:perp"]);

      // Resolve the OLD aborted chunk request with bogus high-value bars and coverage: must be ignored!
      pending[0].resolve({
        schemaVersion: 1,
        generatedAt: 1003 * MINUTE,
        base: "BTC",
        source: "custom",
        resolution: "1m",
        bucketStep: 50,
        from: pending[0].req.from,
        to: pending[0].req.to,
        bars: [{ t: 1000 * MINUTE, cells: [[50_000, 99_000_000, 0]] }],
        requestedSources: ["binance:usd_perp", "okx:spot"],
        observedSources: ["binance:usd_perp"],
        missingSources: ["okx:spot"],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(overlay.cachedBarsCount(), 0, "stale aborted response never enters bars cache");
      assert.deepEqual(overlay.getCoverage(), {
        requestedSources: [],
        observedSources: [],
        missingSources: [],
      });

      // Resolve the CURRENT active request
      pending[2].resolve({
        schemaVersion: 1,
        generatedAt: 1003 * MINUTE,
        base: "BTC",
        source: "custom",
        resolution: "1m",
        bucketStep: 50,
        from: pending[2].req.from,
        to: pending[2].req.to,
        bars: [{ t: 1000 * MINUTE, cells: [[50_000, 5_000_000, 5_000_000]] }],
        requestedSources: ["BYBIT:perp"],
        observedSources: ["bybit:perp"],
        missingSources: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(overlay.cachedBarsCount(), 1);
      assert.deepEqual(overlay.getCoverage(), {
        requestedSources: ["bybit:perp"],
        observedSources: ["bybit:perp"],
        missingSources: [],
      });
    } finally {
      overlay.dispose();
    }
  });
});

test("visual-only settings changes invalidate raster & GPU prepare caches with 0 network requests", async () => {
  let currentSettings = {
    mode: "custom",
    unit: "usd",
    bucketStep: 50,
    single: { usd: 1_000_000, btc: 10 },
    aggregated: { usd: 2_000_000, btc: 20 },
    custom: { usd: 1_000_000, btc: 10 },
    customSources: ["binance:usd_perp", "okx:spot"],
    opacity: 0.85,
    scaleMode: "auto",
    fixedCeiling: { usd: 50_000_000, btc: 500 },
    contrast: "medium",
  };
  await withSettings(() => currentSettings, async (notify) => {
    const series = makeSeries(2);
    const view = makeView();
    let fetchCount = 0;
    let liveSubCount = 0;
    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => {
        fetchCount++;
        return {
          schemaVersion: 1,
          generatedAt: 1002 * MINUTE,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars: [
            { t: 1000 * MINUTE, cells: [[50_000, 5_000_000, 5_000_000], [50_050, 20_000_000, 20_000_000]] },
            { t: 1001 * MINUTE, cells: [[50_000, 2_000_000, 2_000_000], [50_050, 40_000_000, 40_000_000]] },
          ],
          requestedSources: ["binance:usd_perp", "okx:spot"],
          observedSources: ["binance:usd_perp"],
        };
      },
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => 1002 * MINUTE,
      subscribeLiveTail: () => {
        liveSubCount++;
        return () => {};
      },
    });
    try {
      const rec = makeRecordingCtx({ withOffscreen: true });
      overlay.draw(rec.ctx, view, series, [0, 1]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fetchCount, 1);
      assert.equal(liveSubCount, 1);
      assert.deepEqual(overlay.getCoverage(), {
        requestedSources: ["binance:usd_perp", "okx:spot"],
        observedSources: ["binance:usd_perp"],
        missingSources: ["okx:spot"],
      });

      // Initial warm draw fills raster cache
      overlay.draw(rec.ctx, view, series, [0, 1]);
      const initialKey = overlay.getPrepareCacheKey(view, series, [0, 1]);
      const initialOffCount = rec.offFillStyles.length;
      assert.ok(initialOffCount > 0);
      assert.equal(rec.getDrawImageCalls(), 1);

      // Hit on identical frame
      overlay.draw(rec.ctx, view, series, [0, 1]);
      assert.equal(rec.offFillStyles.length, initialOffCount);
      assert.equal(rec.getDrawImageCalls(), 2);

      // Change opacity, scaleMode, fixedCeiling, contrast -> 0 fetches, 0 live re-subs, cache keys invalidate!
      currentSettings = {
        ...currentSettings,
        opacity: 0.4,
        scaleMode: "fixed",
        fixedCeiling: { usd: 100_000_000, btc: 1000 },
        contrast: "high",
      };
      notify();
      const updatedKey = overlay.getPrepareCacheKey(view, series, [0, 1]);
      assert.notEqual(updatedKey, initialKey);
      overlay.draw(rec.ctx, view, series, [0, 1]);
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(fetchCount, 1, "visual-only changes trigger 0 new REST requests");
      assert.equal(liveSubCount, 1, "visual-only changes trigger 0 new live-tail subscriptions");
      assert.ok(rec.offFillStyles.length > initialOffCount, "raster cache rebuilt with new visual settings");
      const gpuFrame = overlay.prepareGpuCells(view, series, [0, 1], () => ({ release() {} }));
      assert.ok(gpuFrame);
      assert.equal(gpuFrame.opacity, 0.4);
      assert.equal(gpuFrame.ceiling, 100_000_000);
    } finally {
      overlay.dispose();
    }
  });
});

test("projectCanonicalHeatmapTailBar matches HeatmapBuilder parity and feeds 1m live tail projection", async () => {
  const canonicalBar = {
    t: 1002 * MINUTE,
    bucketStep: 25,
    sources: {
      "BINANCE:USD_PERP": [
        [50_000, 10_000_000, 5_000_000],
        [50_025, 2_000_000, 3_000_000],
        [50_050, 1_000_000, 1_000_000],
      ],
      "okx:spot": [
        [50_000, 4_000_000, 6_000_000],
        [50_025, 1_000_000, 1_000_000],
        [50_100, 500_000, 500_000],
      ],
      "coinbase:spot": [
        [50_050, 3_000_000, 2_000_000],
      ],
    },
  };

  // Single uses binance:usd_perp only
  const single = projectCanonicalHeatmapTailBar(canonicalBar, {
    source: "single",
    bucketStep: 50,
    minUsd: 10_000_000,
  });
  assert.equal(HEATMAP_SINGLE_CANONICAL_SOURCE, "binance:usd_perp");
  assert.deepEqual(single, {
    t: canonicalBar.t,
    cells: [[50_000, 12_000_000, 8_000_000]],
  });

  // Aggregated sums all sources and buckets $25 -> $50
  const aggregated = projectCanonicalHeatmapTailBar(canonicalBar, {
    source: "aggregated",
    bucketStep: 50,
    minUsd: 6_000_000,
  });
  assert.deepEqual(aggregated, {
    t: canonicalBar.t,
    cells: [
      [50_000, 17_000_000, 15_000_000],
      [50_050, 4_000_000, 3_000_000],
    ],
  });

  // Custom selects normalized customSources only & filters minBtc
  const custom = projectCanonicalHeatmapTailBar(canonicalBar, {
    source: "custom",
    customSources: [" OKX:SPOT ", "coinbase:spot"],
    bucketStep: 100,
    minBtc: 300, // at bucket 50_000..50_100 (mid 50_050): 17M / 50_050 ~= 339.66 >= 300
  });
  assert.deepEqual(custom, {
    t: canonicalBar.t,
    cells: [[50_000, 8_000_000, 9_000_000]],
  });

  // Empty customSources -> empty cells
  assert.deepEqual(projectCanonicalHeatmapTailBar(canonicalBar, {
    source: "custom",
    customSources: [],
    bucketStep: 25,
    minUsd: 0,
  }), { t: canonicalBar.t, cells: [] });

  // Caps at HEATMAP_MAX_CELLS_PER_BAR (200) strongest levels sorted by price ascending
  const denseCells = Array.from({ length: 260 }, (_, idx) => [
    50_000 + idx * 25,
    (idx + 1) * 1_000,
    (idx + 1) * 1_000,
  ]);
  const capped = projectCanonicalHeatmapTailBar({
    t: 123_000,
    sources: { "binance:usd_perp": denseCells },
  }, {
    source: "single",
    bucketStep: 25,
    minUsd: 0,
  });
  assert.equal(HEATMAP_MAX_CELLS_PER_BAR, 200);
  assert.equal(capped.cells.length, 200);
  assert.equal(capped.cells[0][0], 50_000 + 60 * 25);
  assert.equal(capped.cells[199][0], 50_000 + 259 * 25);

  // Live tail push with canonicalBars on 1m overlay
  await withSettings(() => ({
    mode: "custom",
    unit: "usd",
    bucketStep: 50,
    single: { usd: 1_000_000, btc: 10 },
    aggregated: { usd: 1_000_000, btc: 10 },
    custom: { usd: 10_000_000, btc: 100 },
    customSources: ["okx:spot", "binance:usd_perp"],
  }), async () => {
    const series = makeSeries(3, MINUTE);
    const view = makeView();
    let listener = null;
    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: 1002 * MINUTE,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: [],
      }),
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => 1002 * MINUTE + 500,
      subscribeLiveTail: (cb) => {
        listener = cb;
        return () => {};
      },
    });
    try {
      overlay.draw(makeRecordingCtx().ctx, view, series, [0, 2]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      listener({ market: MARKET, canonicalBars: [canonicalBar] });
      const frame = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
      assert.ok(frame);
      assert.equal(frame.main.length, 1);
      assert.equal(frame.main[0].value, 32_000_000);
    } finally {
      overlay.dispose();
    }
  });
});

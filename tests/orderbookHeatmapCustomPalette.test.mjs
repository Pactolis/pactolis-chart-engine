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

test("projectCanonicalHeatmapTailBar matches BE #532 wire shape, HeatmapBuilder parity, and 1m live tail projection", async () => {
  // Verbatim copy of Pactolis-Backend contracts/ws/fixtures/orderbook-v1.json (heatmap-tail-canonical snapshot)
  const beCanonicalSnapshotFixture = {
    type: "heatmap_tail",
    v: 1,
    id: "heatmap-tail-canonical",
    epoch: 1,
    seq: 1,
    prevSeq: null,
    kind: "snapshot",
    reason: "initial",
    confirmation: 1,
    data: {
      schemaVersion: 1,
      generatedAt: 1700000103500,
      base: "BTC",
      source: "canonical",
      resolution: "1m",
      bucketStep: 25,
      bars: [
        {
          t: 1700000040000,
          closed: true,
          sources: ["binance:usd_perp", "bybit:spot"],
          cells: [[99975, [[0, 120000, 0], [1, 79950, 0]]]],
        },
        {
          t: 1700000100000,
          closed: false,
          sources: ["binance:usd_perp"],
          cells: [[100000, [[0, 0, 150037]]]],
        },
      ],
    },
  };

  for (const bar of beCanonicalSnapshotFixture.data.bars) {
    const asSingle = projectCanonicalHeatmapTailBar(bar, {
      source: "single",
      bucketStep: 25,
      minUsd: 0,
    });
    const asSingleCustom = projectCanonicalHeatmapTailBar(bar, {
      source: "custom",
      customSources: ["binance:usd_perp"],
      bucketStep: 25,
      minUsd: 0,
    });
    assert.deepEqual(asSingleCustom, asSingle, "[\"binance:usd_perp\"] custom parity with single");
  }
  assert.deepEqual(projectCanonicalHeatmapTailBar(beCanonicalSnapshotFixture.data.bars[0], {
    source: "aggregated",
    bucketStep: 25,
    minUsd: 0,
  }), { t: 1700000040000, cells: [[99975, 199950, 0]] });
  assert.deepEqual(projectCanonicalHeatmapTailBar(beCanonicalSnapshotFixture.data.bars[0], {
    source: "custom",
    customSources: ["bybit:spot"],
    bucketStep: 25,
    minUsd: 0,
  }), { t: 1700000040000, cells: [[99975, 79950, 0]] });

  const canonicalBar = {
    t: 1002 * MINUTE,
    closed: false,
    sources: ["BINANCE:USD_PERP", "okx:spot", "coinbase:spot"],
    cells: [
      [50_000, [[0, 10_000_000, 5_000_000], [1, 4_000_000, 6_000_000]]],
      [50_025, [[0, 2_000_000, 3_000_000], [1, 1_000_000, 1_000_000]]],
      [50_050, [[0, 1_000_000, 1_000_000], [2, 3_000_000, 2_000_000]]],
      [50_100, [[1, 500_000, 500_000]]],
      // Out-of-bounds and invalid sourceIndex entries must be ignored safely
      [50_200, [[-1, 99_000_000, 0], [3, 99_000_000, 0], [1.5, 99_000_000, 0], [Number.NaN, 99_000_000, 0]]],
    ],
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

  // Aggregated sums all valid sources and buckets $25 -> $50
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
    [[0, (idx + 1) * 1_000, (idx + 1) * 1_000]],
  ]);
  const capped = projectCanonicalHeatmapTailBar({
    t: 123_000,
    closed: true,
    sources: ["binance:usd_perp"],
    cells: denseCells,
  }, {
    source: "single",
    bucketStep: 25,
    minUsd: 0,
  });
  assert.equal(HEATMAP_MAX_CELLS_PER_BAR, 200);
  assert.equal(capped.cells.length, 200);
  assert.equal(capped.cells[0][0], 50_000 + 60 * 25);
  assert.equal(capped.cells[199][0], 50_000 + 259 * 25);

  // Live tail canonical subscription (BE #532): request shape, no re-subscribe on client filter changes,
  // immediate re-projection from canonicalTailBars, and unsubscribe when customSources becomes empty.
  let currentSettings = {
    mode: "custom",
    unit: "usd",
    bucketStep: 50,
    single: { usd: 1_000_000, btc: 10 },
    aggregated: { usd: 1_000_000, btc: 10 },
    custom: { usd: 10_000_000, btc: 300 },
    customSources: ["okx:spot", "binance:usd_perp"],
  };
  let currentMarket = MARKET;
  await withSettings(() => currentSettings, async (notify) => {
    const series = makeSeries(3, MINUTE);
    const view = makeView();
    const subscriptions = [];
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
      getMarket: () => currentMarket,
      now: () => 1002 * MINUTE + 500,
      subscribeLiveTail: (cb, request) => {
        const entry = { listener: cb, request, unsubscribed: false };
        subscriptions.push(entry);
        return () => { entry.unsubscribed = true; };
      },
    });
    try {
      assert.equal(subscriptions.length, 1);
      assert.deepEqual(subscriptions[0].request, {
        market: MARKET,
        base: "BTC",
        source: "canonical",
        bucketStep: 25,
      });
      assert.equal("sources" in subscriptions[0].request, false);
      assert.equal("minQuantityUsd" in subscriptions[0].request, false);
      assert.equal("minUsd" in subscriptions[0].request, false);
      assert.equal("minBtc" in subscriptions[0].request, false);

      overlay.draw(makeRecordingCtx().ctx, view, series, [0, 2]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      subscriptions[0].listener({ market: MARKET, canonicalBars: [canonicalBar] });
      let frame = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
      assert.ok(frame);
      assert.equal(frame.main.length, 1);
      assert.equal(frame.main[0].value, 32_000_000);

      // Change customSources, bucketStep, unit, and threshold -> 0 re-subscriptions, immediate re-projection
      currentSettings = {
        ...currentSettings,
        customSources: ["okx:spot", "coinbase:spot"],
        bucketStep: 100,
        unit: "btc",
        custom: { usd: 10_000_000, btc: 300 },
      };
      notify();
      assert.equal(subscriptions.length, 1, "custom mode keeps single canonical subscription across client changes");
      assert.equal(subscriptions[0].unsubscribed, false);
      frame = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
      assert.ok(frame);
      assert.equal(frame.main.length, 1);
      assert.ok(Math.abs(frame.main[0].value - 17_000_000 / 50_050) < 1e-6);

      // Lower threshold in custom mode -> still 0 re-subscriptions, updates projected cells
      currentSettings = {
        ...currentSettings,
        custom: { usd: 1_000_000, btc: 10 },
      };
      notify();
      assert.equal(subscriptions.length, 1);
      frame = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
      assert.ok(frame);
      assert.equal(frame.main.length, 2, "lowered threshold reveals $50_100 bucket from stored canonicalTailBars");

      // Clearing customSources closes active live-tail subscription
      currentSettings = { ...currentSettings, customSources: [] };
      notify();
      assert.equal(subscriptions[0].unsubscribed, true);
      assert.equal(subscriptions.length, 1);

      // Restoring customSources re-subscribes canonical live tail
      currentSettings = { ...currentSettings, customSources: ["binance:usd_perp"] };
      notify();
      assert.equal(subscriptions.length, 2);
      assert.deepEqual(subscriptions[1].request, {
        market: MARKET,
        base: "BTC",
        source: "canonical",
        bucketStep: 25,
      });

      // Market change re-subscribes canonical live tail for new market
      currentMarket = "BINANCE_FUTURES:ethusdt";
      overlay.handleMarketChange();
      assert.equal(subscriptions[1].unsubscribed, true);
      assert.equal(subscriptions.length, 3);
      assert.deepEqual(subscriptions[2].request, {
        market: "BINANCE_FUTURES:ethusdt",
        base: "ETH",
        source: "canonical",
        bucketStep: 25,
      });
    } finally {
      overlay.dispose();
    }
  });
});

function createMulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateLogNormalValues(count, seed) {
  const rand = createMulberry32(seed);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[i] = Math.exp(14 + z * 1.35);
  }
  return out;
}

function referenceSortedColorRange({ values, threshold, scaleMode = "auto", fixedCeiling, contrast = "medium" }) {
  const [floorQ, ceilingQ] = HEATMAP_AUTO_PERCENTILES[contrast] ?? HEATMAP_AUTO_PERCENTILES.medium;
  const positive = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (Number.isFinite(value) && value > 0) positive.push(value);
  }
  positive.sort((a, b) => a - b);
  const pct = (q) => {
    if (positive.length === 0) return 0;
    if (positive.length === 1) return positive[0];
    const index = (positive.length - 1) * q;
    const lo = Math.floor(index);
    const hi = Math.ceil(index);
    if (lo === hi) return positive[lo];
    return positive[lo] + (positive[hi] - positive[lo]) * (index - lo);
  };
  const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
  if (scaleMode === "fixed" && fixedCeiling !== undefined && Number.isFinite(fixedCeiling) && fixedCeiling > 0) {
    const floor = safeThreshold > 0 ? safeThreshold : (positive.length > 0 ? Math.min(pct(floorQ), fixedCeiling / 2) : 0);
    const ceiling = floor > 0 ? Math.max(fixedCeiling, floor * 2) : fixedCeiling;
    return { floor, ceiling };
  }
  if (positive.length === 0) {
    return { floor: safeThreshold, ceiling: safeThreshold > 0 ? safeThreshold * 10 : 0 };
  }
  const pFloor = pct(floorQ);
  const pCeiling = pct(ceilingQ);
  const floor = safeThreshold > 0 ? safeThreshold : pFloor;
  const ceiling = Math.max(pCeiling, floor * 2);
  return { floor, ceiling };
}

function makeWebGlMock() {
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
  return { gl, uniformValues };
}

test("resolveHeatmapColorRange never calls Array.prototype.sort, avoids scanning in fixed mode, and honors inPlace", () => {
  let sortCalls = 0;
  const origSort = Array.prototype.sort;
  Array.prototype.sort = function (...args) {
    sortCalls++;
    return origSort.apply(this, args);
  };
  try {
    const sampleArr = [80_000_000, 500_000, 25_000_000, 0, 5_000_000, -10, Number.NaN];
    const sampleArrCopy = [...sampleArr];
    const sampleF64 = Float64Array.from(sampleArr);
    const sampleF64Copy = Float64Array.from(sampleArr);

    const rAuto = resolveHeatmapColorRange({ values: sampleArr, threshold: 0, scaleMode: "auto" });
    const rAutoThreshold = resolveHeatmapColorRange({ values: sampleArr, threshold: 1_000_000, scaleMode: "auto" });
    const rFixedZero = resolveHeatmapColorRange({ values: sampleArr, threshold: 0, scaleMode: "fixed", fixedCeiling: 50_000_000 });
    const rInPlaceFalse = resolveHeatmapColorRange({ values: sampleF64, threshold: 0, inPlace: false });
    assert.deepEqual(sampleArr, sampleArrCopy, "default inPlace=false does not mutate array input");
    assert.deepEqual(Array.from(sampleF64), Array.from(sampleF64Copy), "default inPlace=false does not mutate Float64Array");

    const rInPlaceTrue = resolveHeatmapColorRange({ values: sampleF64, threshold: 0, inPlace: true });
    assert.deepEqual(rInPlaceTrue, rAuto);
    assert.deepEqual(rInPlaceFalse, rAuto);
    assert.ok(rAutoThreshold.floor === 1_000_000 && rAutoThreshold.ceiling > 1_000_000);
    assert.ok(rFixedZero.floor > 0 && rFixedZero.ceiling === 50_000_000);

    // O(1) fixed mode with threshold > 0 and finite fixedCeiling > 0 must not scan values at all
    const unindexedValues = {
      length: 5,
      get 0() { throw new Error("fixed O(1) fast path must not read values"); },
      [Symbol.iterator]() { throw new Error("fixed O(1) fast path must not iterate values"); },
    };
    const rFixedO1 = resolveHeatmapColorRange({
      values: unindexedValues,
      threshold: 100,
      scaleMode: "fixed",
      fixedCeiling: 500,
    });
    assert.deepEqual(rFixedO1, { floor: 100, ceiling: 500 });
    assert.equal(sortCalls, 0, "resolveHeatmapColorRange must never invoke Array.prototype.sort");
  } finally {
    Array.prototype.sort = origSort;
  }
});

test("prepareGpuCells resolves color range once per frame without double collection or Array.prototype.sort", async () => {
  let sortCalls = 0;
  const origSort = Array.prototype.sort;
  Array.prototype.sort = function (...args) {
    sortCalls++;
    return origSort.apply(this, args);
  };

  let contrastReads = 0;
  let fixedCeilingReads = 0;
  let modeScale = "auto";
  try {
    await withSettings(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1_000_000, btc: 10 },
      aggregated: { usd: 2_000_000, btc: 20 },
      scaleMode: modeScale,
      get contrast() {
        contrastReads++;
        return "medium";
      },
      get fixedCeiling() {
        fixedCeilingReads++;
        return { usd: 50_000_000, btc: 500 };
      },
    }), async () => {
      const series = makeSeries(3);
      const view = makeView();
      const overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => ({
          schemaVersion: 1,
          generatedAt: 1003 * MINUTE,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars: [
            { t: 1000 * MINUTE, cells: [[50_000, 1_500_000, 500_000], [50_050, 8_000_000, 2_000_000]] },
            { t: 1001 * MINUTE, cells: [[50_000, 3_000_000, 1_000_000], [50_050, 25_000_000, 5_000_000]] },
          ],
        }),
        invalidate: () => {},
        getMarket: () => MARKET,
        now: () => 1003 * MINUTE,
      });
      try {
        overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
        await new Promise((resolve) => setTimeout(resolve, 20));

        contrastReads = 0;
        fixedCeilingReads = 0;
        sortCalls = 0;
        const autoFrame = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
        assert.ok(autoFrame && autoFrame.main.length === 6);
        assert.equal(contrastReads, 1, "auto mode prepareGpuCells must resolve range exactly once per frame");
        assert.equal(sortCalls, 0);

        modeScale = "fixed";
        contrastReads = 0;
        fixedCeilingReads = 0;
        sortCalls = 0;
        const fixedFrame = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
        assert.ok(fixedFrame && fixedFrame.main.length === 6);
        assert.equal(fixedFrame.ceiling, 50_000_000);
        assert.equal(fixedCeilingReads, 1, "fixed mode prepareGpuCells must resolve range exactly once per frame");
        assert.equal(sortCalls, 0);
      } finally {
        overlay.dispose();
      }
    });
  } finally {
    Array.prototype.sort = origSort;
  }
});

test("OrderbookHeatmapOverlay.draw and drawHover with threshold=0 produce distinct colors without saturating to peak yellow", async () => {
  for (const mode of ["single", "custom"]) {
    const settings = {
      mode,
      unit: "usd",
      bucketStep: 50,
      single: { usd: 0, btc: 0 },
      aggregated: { usd: 0, btc: 0 },
      custom: { usd: 0, btc: 0 },
      customSources: ["binance:usd_perp"],
      opacity: 0.85,
      scaleMode: "auto",
      contrast: "medium",
    };
    await withSettings(() => settings, async () => {
      const series = makeSeries(3);
      const view = makeView();
      const bar1Cells = [
        [50_000, 0, 0],
        [50_050, 500_000, 0],
        [50_100, 5_000_000, 0],
        [50_150, 25_000_000, 0],
        [50_200, 80_000_000, 0],
      ];
      const overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => ({
          schemaVersion: 1,
          generatedAt: 1003 * MINUTE,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars: [
            { t: 1000 * MINUTE, cells: [[49_700, 100_000, 0], [49_750, 200_000, 0], [49_800, 300_000, 0]] },
            { t: 1001 * MINUTE, cells: bar1Cells },
            { t: 1002 * MINUTE, cells: [[49_700, 100_000, 0]] },
          ],
        }),
        invalidate: () => {},
        getMarket: () => MARKET,
        now: () => 1003 * MINUTE,
      });
      try {
        const rects = [];
        const ctx = {
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 1,
          font: "",
          textAlign: "",
          textBaseline: "",
          save() {},
          restore() {},
          beginPath() {},
          rect() {},
          roundRect() {},
          clip() {},
          fillRect(x, y, w, h) { rects.push({ fillStyle: this.fillStyle, x, y, w, h }); },
          strokeRect() {},
          fillText() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          fill() {},
        };

        overlay.draw(ctx, view, series, [0, 2]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        rects.length = 0;

        overlay.draw(ctx, view, series, [0, 2]);
        const bar1X = view.xOfIndex(1);
        const bar1Rects = rects.filter((r) => r.x === bar1X);
        assert.equal(bar1Rects.length, 5, `${mode}: expected 5 painted cells on bar 1`);

        const colorByPrice = new Map();
        for (const [price] of bar1Cells) {
          const yTop = view.yOfPrice(price + 50);
          const match = bar1Rects.find((r) => Math.abs(r.y - yTop) < 1e-6);
          assert.ok(match, `${mode}: missing painted rect for price ${price}`);
          colorByPrice.set(price, match.fillStyle);
        }

        const k0Color = heatmapCellColor(0, 1, 0.85);
        const peakColor = heatmapCellColor(1, 1, 0.85);
        assert.equal(colorByPrice.get(50_000), k0Color, `${mode}: value=0 must get k=0 color`);
        assert.equal(new Set(colorByPrice.values()).size, 5, `${mode}: all 5 values [0, 500k, 5M, 25M, 80M] must have distinct colors`);
        for (const p of [50_000, 50_050, 50_100, 50_150]) {
          assert.notEqual(colorByPrice.get(p), peakColor, `${mode}: price ${p} must not saturate to peak yellow`);
        }

        // Hover over bar 1 with threshold=0: positive cells shaded distinctly without saturating
        const crosshair = { x: bar1X + 5, y: view.yOfPrice(50_125), visible: true };
        overlay.drawHover(ctx, view, series, crosshair);
        await new Promise((resolve) => setTimeout(resolve, 150));
        rects.length = 0;
        overlay.drawHover(ctx, view, series, crosshair);
        assert.equal(rects.length, 4, `${mode}: drawHover shades the 4 positive cells and skips value=0`);
        assert.equal(new Set(rects.map((r) => r.fillStyle)).size, 4, `${mode}: drawHover shades positive cells distinctly`);
        assert.ok(rects.filter((r) => r.fillStyle === peakColor).length <= 1, `${mode}: drawHover does not saturate lower cells`);
      } finally {
        overlay.dispose();
      }
    });
  }
});

test("prepareGpuCells + HeatmapGpuRenderer.renderFrame support threshold=0 and floor=0 shader branch", async () => {
  await withSettings(() => ({
    mode: "single",
    unit: "usd",
    bucketStep: 50,
    single: { usd: 0, btc: 0 },
    aggregated: { usd: 0, btc: 0 },
    opacity: 0.85,
    scaleMode: "auto",
    contrast: "medium",
  }), async () => {
    const series = makeSeries(3);
    const view = makeView();
    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: 1003 * MINUTE,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: [
          { t: 1000 * MINUTE, cells: [[49_700, 100_000, 0], [49_750, 200_000, 0], [49_800, 300_000, 0]] },
          { t: 1001 * MINUTE, cells: [[50_000, 0, 0], [50_050, 500_000, 0], [50_100, 5_000_000, 0], [50_150, 25_000_000, 0], [50_200, 80_000_000, 0]] },
        ],
      }),
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => 1003 * MINUTE,
    });
    const { gl, uniformValues } = makeWebGlMock();
    const renderer = new HeatmapGpuRenderer();
    try {
      overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const frame = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
      assert.ok(frame);
      assert.equal(frame.threshold, 0);
      assert.ok(frame.floor > 0);
      assert.ok(frame.ceiling > frame.floor);

      const ok = renderer.renderFrame(gl, frame, { left: 0, top: 0, width: 800, height: 400 });
      assert.equal(ok, true);
      assert.equal(uniformValues.get("u_floor"), frame.floor);
      const expectedLogSpan = Math.log10(Math.max(frame.ceiling, frame.floor * 2) / frame.floor);
      assert.ok(Math.abs(uniformValues.get("u_logSpan") - expectedLogSpan) < 1e-6);

      // Shader intensity parity with CPU heatmapIntensity for frame.floor / frame.ceiling
      const uFloor = uniformValues.get("u_floor");
      const uLogSpan = uniformValues.get("u_logSpan");
      for (const value of [0, 500_000, 5_000_000, 25_000_000, 80_000_000]) {
        const cpuK = heatmapIntensity(value, frame.floor, frame.ceiling);
        const gpuK = value <= 0
          ? 0
          : Math.min(1, Math.max(0, Math.log2(value / uFloor) * 0.30102999566398120 / uLogSpan));
        assert.ok(Math.abs(cpuK - gpuK) < 1e-12, `intensity parity mismatch for value=${value}`);
      }

      // Direct floor=0, ceiling=100 branch (u_floor <= 0 && u_logSpan > 0)
      const directOk = renderer.renderFrame(gl, {
        main: [{ x: 0, yTop: 10, width: 10, height: 10, value: 25 }],
        extension: [],
        threshold: 0,
        floor: 0,
        ceiling: 100,
        opacity: 0.85,
        dataKey: "direct-zero-floor",
      }, { left: 0, top: 0, width: 800, height: 400 });
      assert.equal(directOk, true);
      assert.equal(uniformValues.get("u_floor"), 0);
      assert.equal(uniformValues.get("u_logSpan"), 100);
      const directCpuK = heatmapIntensity(25, 0, 100);
      const directGpuK = Math.min(1, Math.max(0, Math.log2(1 + (25 / 100) * 100) * 0.30102999566398120 / 2.0043213737826426));
      assert.ok(Math.abs(directCpuK - directGpuK) < 1e-12);
    } finally {
      renderer.dispose();
      overlay.dispose();
    }
  });
});

test("3-way quickselect resolveHeatmapColorRange is bit-identical to sorted reference across distributions and edge cases", () => {
  const datasets = [
    ["15k-lognormal", generateLogNormalValues(15_000, 1337)],
    ["40k-lognormal", generateLogNormalValues(40_000, 7331)],
    ["10k-all-equal", Float64Array.from({ length: 10_000 }, () => 42_000)],
    ["10k-reverse", Float64Array.from({ length: 10_000 }, (_, i) => 10_000 - i)],
    ["single-element", [123.45]],
    ["two-desc", [500, 100]],
    ["two-asc", [100, 500]],
    ["non-positive-non-finite", [0, -5, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]],
    ["mixed-dirty", [0, -10, Number.NaN, 50, Number.POSITIVE_INFINITY, 10, 200, 50, Number.NEGATIVE_INFINITY, 0.25]],
    ["empty", []],
  ];

  for (const [label, values] of datasets) {
    for (const contrast of ["low", "medium", "high"]) {
      for (const threshold of [0, 25]) {
        for (const scaleMode of ["auto", "fixed"]) {
          const fixedCeiling = scaleMode === "fixed" ? 500_000 : undefined;
          const expected = referenceSortedColorRange({ values, threshold, scaleMode, fixedCeiling, contrast });
          const actualCopy = resolveHeatmapColorRange({ values, threshold, scaleMode, fixedCeiling, contrast, inPlace: false });
          assert.deepEqual(actualCopy, expected, `copy mismatch (${label}, ${contrast}, t=${threshold}, ${scaleMode})`);

          const f64 = Float64Array.from(values);
          const actualInPlace = resolveHeatmapColorRange({ values: f64, threshold, scaleMode, fixedCeiling, contrast, inPlace: true });
          assert.deepEqual(actualInPlace, expected, `inPlace mismatch (${label}, ${contrast}, t=${threshold}, ${scaleMode})`);
        }
      }
    }
  }
});

test("deterministic pan/zoom benchmark (15k x 60f and 40k x 30f) reports p50/p95 ms without regression", async () => {
  function percentileMs(samples, q) {
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
    return sorted[idx];
  }

  async function runScenario(label, barCount, cellsPerBar, frames, seed) {
    const totalBars = barCount + frames + 5;
    const series = makeSeries(totalBars);
    const view = new View();
    view.area = { left: 0, top: 0, width: 2000, height: 1000 };
    view.colWidth = 8;
    view.priceTop = 60_000;
    view.pricePerPx = 10;
    view.pixelRatio = 1;

    const rawValues = generateLogNormalValues(barCount * cellsPerBar, seed);
    const bars = Array.from({ length: totalBars }, (_, b) => {
      const cells = Array.from({ length: cellsPerBar }, (__, c) => {
        const val = rawValues[((b * cellsPerBar + c) % rawValues.length)];
        return [50_000 + c * 25, val, 0];
      });
      return { t: (1000 + b) * MINUTE, cells };
    });

    const scratchF64 = new Float64Array(rawValues.length);
    const naiveSamples = [];
    const quickAutoSamples = [];
    const fixedO1Samples = [];
    const prepareAutoSamples = [];
    const prepareFixedSamples = [];

    // Warmup
    for (let w = 0; w < 5; w++) {
      scratchF64.set(rawValues);
      resolveHeatmapColorRange({ values: scratchF64, threshold: 0, scaleMode: "auto", inPlace: true });
      resolveHeatmapColorRange({ values: scratchF64, threshold: 1_000_000, scaleMode: "fixed", fixedCeiling: 50_000_000, inPlace: true });
      referenceSortedColorRange({ values: rawValues, threshold: 0, scaleMode: "auto" });
    }

    for (let f = 0; f < frames; f++) {
      const t0 = performance.now();
      const rNaive = referenceSortedColorRange({ values: rawValues, threshold: 0, scaleMode: "auto" });
      naiveSamples.push(performance.now() - t0);

      scratchF64.set(rawValues);
      const t1 = performance.now();
      const rQuick = resolveHeatmapColorRange({ values: scratchF64, threshold: 0, scaleMode: "auto", inPlace: true });
      quickAutoSamples.push(performance.now() - t1);
      assert.deepEqual(rQuick, rNaive);

      const t2 = performance.now();
      const rFixed = resolveHeatmapColorRange({
        values: rawValues,
        threshold: 1_000_000,
        scaleMode: "fixed",
        fixedCeiling: 50_000_000,
      });
      fixedO1Samples.push(performance.now() - t2);
      assert.deepEqual(rFixed, { floor: 1_000_000, ceiling: 50_000_000 });
    }

    let currentScaleMode = "auto";
    let currentThreshold = 0;
    await withSettings(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      single: { usd: currentThreshold, btc: 0 },
      aggregated: { usd: currentThreshold, btc: 0 },
      scaleMode: currentScaleMode,
      fixedCeiling: { usd: 50_000_000, btc: 500 },
      contrast: "medium",
    }), async () => {
      const overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => ({
          schemaVersion: 1,
          generatedAt: 1000 * MINUTE,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars,
        }),
        invalidate: () => {},
        getMarket: () => MARKET,
        now: () => 1000 * MINUTE,
      });
      try {
        overlay.prepareGpuCells(view, series, [0, barCount - 1], () => ({ release() {} }));
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Warmup overlay prepare
        for (let w = 0; w < 3; w++) {
          overlay.prepareGpuCells(view, series, [w, w + barCount - 1], () => ({ release() {} }));
        }

        for (let f = 0; f < frames; f++) {
          view.offsetX = -f * view.colWidth;
          const t3 = performance.now();
          const frame = overlay.prepareGpuCells(view, series, [f, f + barCount - 1], () => ({ release() {} }));
          prepareAutoSamples.push(performance.now() - t3);
          assert.ok(frame && frame.main.length === barCount * cellsPerBar);
        }

        currentScaleMode = "fixed";
        // Use threshold=1 so fixed O(1) range skips percentile scanning while retaining the full 15k/40k log-normal load after #262 filtering.
        currentThreshold = 1;
        for (let f = 0; f < frames; f++) {
          view.offsetX = -f * view.colWidth;
          const t4 = performance.now();
          const frame = overlay.prepareGpuCells(view, series, [f, f + barCount - 1], () => ({ release() {} }));
          prepareFixedSamples.push(performance.now() - t4);
          assert.ok(frame && frame.main.length === barCount * cellsPerBar);
        }
      } finally {
        overlay.dispose();
      }
    });

    const stats = (arr) => ({ p50: percentileMs(arr, 0.5), p95: percentileMs(arr, 0.95) });
    const sNaive = stats(naiveSamples);
    const sQuick = stats(quickAutoSamples);
    const sFixed = stats(fixedO1Samples);
    const sPrepAuto = stats(prepareAutoSamples);
    const sPrepFixed = stats(prepareFixedSamples);

    console.log(
      `[HEATMAP_BENCH ${label}] naiveSort_p50=${sNaive.p50.toFixed(3)}ms p95=${sNaive.p95.toFixed(3)}ms | ` +
      `quickselect_p50=${sQuick.p50.toFixed(3)}ms p95=${sQuick.p95.toFixed(3)}ms | ` +
      `fixedO1_p50=${sFixed.p50.toFixed(3)}ms p95=${sFixed.p95.toFixed(3)}ms | ` +
      `prepareAuto_p50=${sPrepAuto.p50.toFixed(3)}ms p95=${sPrepAuto.p95.toFixed(3)}ms | ` +
      `prepareFixed_p50=${sPrepFixed.p50.toFixed(3)}ms p95=${sPrepFixed.p95.toFixed(3)}ms`,
    );
    assert.ok(sFixed.p50 < sNaive.p50, `${label}: O(1) fixed range must beat naiveSort p50`);
    assert.ok(sQuick.p95 < 250 && sPrepAuto.p95 < 500, `${label}: bounded latency check`);
  }

  await runScenario("15k_x_60f", 100, 150, 60, 4242);
  await runScenario("40k_x_30f", 200, 200, 30, 9001);
});


import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { resetGpuDiagnosticsForTest } from "../dist/core/gpu/gpuDiagnostics.js";
import { configureOrderbookHeatmapSettingsSource, orderbookHeatmapSettingsSource } from "../dist/features/orderbook/heatmapSettingsSource.js";
import { ChartHeatmapGpuCoordinator } from "../dist/features/chart/ChartHeatmapGpuCoordinator.js";
import { OrderbookHeatmapOverlay, HEATMAP_GPU_MOTION_SETTLE_MS } from "../dist/features/orderbook/heatmapOverlay.js";

// CE #364 follow-up: a WebGL2 pan re-prepared and re-uploaded the whole
// heatmap every frame because the visible bar range (and, with the price
// autoscale, priceTop/pricePerPx) is part of the prepare key. While the
// viewport moves, the overlay now prepares a wider motion window once and the
// shader maps it onto the current x/price axes (u_panOffsetX + u_panY).

const MARKET = "BINANCE_FUTURES:btcusdt";
const MINUTE = 60_000;
const BARS = 200;

function makeFakeGl() {
  let geomUploadBytes = 0;
  const uniforms = new Map();
  const gl = new Proxy({
    canvas: { ownerDocument: { defaultView: { devicePixelRatio: 1 } } },
    drawingBufferWidth: 800,
    drawingBufferHeight: 400,
    getParameter: () => 4096,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getAttribLocation: (_p, name) => ["a_rect", "a_run"].indexOf(name),
    getUniformLocation: (_p, name) => ({ name }),
    bufferData: (_t, data) => { if (typeof data === "object" && data) geomUploadBytes += data.byteLength; },
    bufferSubData: (_t, _o, view) => { geomUploadBytes += view.byteLength; },
    uniform1f: (loc, x) => uniforms.set(loc.name, [x]),
    uniform2f: (loc, x, y) => uniforms.set(loc.name, [x, y]),
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== "string") return undefined;
      return /^[A-Z0-9_]+$/.test(key) ? 0 : (() => ({}));
    },
  });
  return {
    gl,
    reset() { geomUploadBytes = 0; uniforms.clear(); },
    uploads: () => geomUploadBytes,
    uniform: (name) => uniforms.get(name),
  };
}

function makeSeries() {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  series.loadBars(Array.from({ length: BARS }, (_, i) => ({
    startTime: (1_000 + i) * MINUTE,
    open: 50_100, high: 50_500, low: 49_900, close: 50_200,
    volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true,
  })));
  return series;
}

function makeView(offsetX) {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 20;
  view.offsetX = offsetX;
  view.priceTop = 50_500;
  view.pricePerPx = 2;
  view.pixelRatio = 1;
  return view;
}

async function withSetup(work) {
  let prev = null;
  try { prev = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single", unit: "btc", bucketStep: 25, opacity: 0.85,
      scaleMode: "fixed", fixedCeiling: { usd: 100_000_000, btc: 200 },
      single: { usd: 1, btc: 10 }, aggregated: { usd: 1, btc: 10 },
    }),
    onChange: () => () => {},
  });
  resetGpuDiagnosticsForTest();
  const clock = { now: 1_300 * MINUTE };
  const invalidations = [];
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (req) => ({
      schemaVersion: 1, generatedAt: clock.now, base: "BTC", source: req.source,
      resolution: req.resolution, bucketStep: req.bucketStep, from: req.from, to: req.to,
      // Two stacked buckets per bar, so every column is one vertical run.
      bars: Array.from({ length: BARS }, (_, i) => ({
        t: (1_000 + i) * MINUTE,
        cells: [[50_000, 600_000, 600_000], [50_025, 700_000, 700_000]],
      })),
    }),
    invalidate: () => invalidations.push(clock.now),
    getMarket: () => MARKET,
    now: () => clock.now,
  });
  const fake = makeFakeGl();
  const coordinator = new ChartHeatmapGpuCoordinator({
    backendKind: "webgl2",
    orderbookHeatmap: overlay,
    renderCoordinator: { getAnnotationLayerOrder: () => ["orderbook-heatmap"] },
    renderer: {
      visibleRange: (v, len) => [
        Math.max(0, Math.floor(v.indexOfX(v.area.left))),
        Math.min(len, Math.ceil(v.indexOfX(v.area.left + v.area.width))),
      ],
    },
    invalidateSession: () => {},
  });
  coordinator.setHeatmapTexturePrototypeEnabled(true);
  try {
    const series = makeSeries();
    overlay.getPrepareCacheKey(makeView(-2_000), series, [0, BARS - 1]);
    await new Promise((r) => setTimeout(r, 20));
    await coordinator.whenHeatmapGpuRendererReady();
    coordinator.setGl(fake.gl);
    const frameAt = (view) => {
      fake.reset();
      coordinator.beginFrameAttempt();
      const frame = coordinator.prepareHeatmapGpuCells(view, series);
      assert.ok(frame, "GPU frame prepared");
      coordinator.renderHeatmapGpuCells(frame, view, series);
      return frame;
    };
    await work({ overlay, coordinator, fake, series, clock, frameAt, invalidations });
  } finally {
    coordinator.dispose();
    overlay.dispose();
    resetGpuDiagnosticsForTest();
    if (prev) configureOrderbookHeatmapSettingsSource(prev);
  }
}

// The first rect of each column, mapped through the frame's pan uniforms.
const screenRects = (frame) => frame.main.map((r) => ({
  x: r.x + (frame.panOffsetX ?? 0),
  y: r.yTop * (frame.panScaleY ?? 1) + (frame.panOffsetY ?? 0),
  h: r.height * (frame.panScaleY ?? 1),
}));

test("#364: a pan across bar boundaries reuses one motion window with 0 B upload, then settles to the exact frame", async () => {
  await withSetup(async ({ fake, clock, frameAt, invalidations }) => {
    const still = frameAt(makeView(-2_000));
    assert.ok(fake.uploads() > 0);
    const exactCells = still.main.length;
    assert.ok(exactCells > 0);

    // Motion starts: the visible bars change, so a wider window is prepared once.
    clock.now += 16;
    const first = frameAt(makeView(-1_960));
    assert.ok(first.main.length > exactCells, "motion window holds more columns than the viewport");
    assert.equal(first.panOffsetX, 0);

    // Further pan frames cross several bar boundaries but stay in the window.
    for (const offsetX of [-1_940, -1_910, -1_880, -1_850]) {
      clock.now += 16;
      const frame = frameAt(makeView(offsetX));
      assert.equal(frame.main, first.main, "same prepared window");
      assert.equal(fake.uploads(), 0, "no geometry upload while panning inside the window");
      assert.equal(frame.panOffsetX, offsetX + 1_960);
      assert.deepEqual(fake.uniform("u_panOffsetX"), [offsetX + 1_960]);
      assert.deepEqual(fake.uniform("u_panY"), [1, 0]);
    }
    assert.ok(invalidations.length > 0, "a settle re-render is scheduled");

    // Motion settles: the exact viewport frame replaces the window.
    clock.now += HEATMAP_GPU_MOTION_SETTLE_MS + 1;
    const settled = frameAt(makeView(-1_850));
    assert.notEqual(settled.main, first.main);
    assert.ok(settled.main.length < first.main.length, "exact frame holds only the viewport");
    assert.equal(settled.panOffsetX, 0);
  });
});

test("#364: the motion window maps price-axis changes in the shader and matches the exact rects", async () => {
  await withSetup(async ({ fake, clock, frameAt }) => {
    frameAt(makeView(-2_000));
    clock.now += 16;
    const anchor = frameAt(makeView(-1_960));

    // Autoscale moves and stretches the price axis during the pan.
    clock.now += 16;
    const moved = makeView(-1_930);
    moved.priceTop = 50_520;
    moved.pricePerPx = 1.6;
    const reused = frameAt(moved);
    assert.equal(reused.main, anchor.main, "price change inside the window reuses it");
    assert.equal(fake.uploads(), 0);
    assert.ok(Math.abs(reused.panScaleY - 2 / 1.6) < 1e-12);
    assert.deepEqual(fake.uniform("u_panY"), [reused.panScaleY, reused.panOffsetY]);

    // The exact prepare of the same viewport draws the same pixels.
    clock.now += HEATMAP_GPU_MOTION_SETTLE_MS + 1;
    const exact = frameAt(moved);
    const mapped = screenRects(reused);
    for (const rect of screenRects(exact)) {
      const twin = mapped.find((m) => Math.abs(m.x - rect.x) < 1e-6 && Math.abs(m.y - rect.y) < 1e-6);
      assert.ok(twin, `window has the exact rect at x=${rect.x} y=${rect.y}`);
      assert.ok(Math.abs(twin.h - rect.h) < 1e-6);
    }
  });
});

test("#364: leaving the window or zooming prepares a new one", async () => {
  await withSetup(async ({ fake, clock, frameAt }) => {
    frameAt(makeView(-2_000));
    clock.now += 16;
    const first = frameAt(makeView(-1_960));

    clock.now += 16;
    const far = frameAt(makeView(-1_200));
    assert.notEqual(far.main, first.main, "viewport outside the window re-prepares");
    assert.equal(far.panOffsetX, 0);

    clock.now += 16;
    const zoomed = makeView(-1_200);
    zoomed.colWidth = 21;
    const z = frameAt(zoomed);
    assert.notEqual(z.main, far.main, "a column-width change re-prepares");

    clock.now += 16;
    const scaled = makeView(-1_200);
    scaled.colWidth = 21;
    scaled.pricePerPx = 0.9; // more than 2x from the anchor
    assert.notEqual(frameAt(scaled).main, z.main, "a large price-scale change re-prepares");
  });
});

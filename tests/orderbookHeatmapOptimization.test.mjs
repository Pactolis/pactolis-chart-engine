import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import {
  getHeatmapColorLut,
  heatmapCellColor,
  heatmapCellRgba,
} from "../dist/features/orderbook/heatmapModel.js";
import {
  HEATMAP_CPU_RASTER_QUIET_MS,
  OrderbookHeatmapOverlay,
  getHeatmapCpuRasterModuleReservedBytes,
} from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import { makeHeatmapPanMarkdown } from "../scripts/heatmap-pan-benchmark.mjs";

const MINUTE = 60_000;
const MARKET = "BINANCE_FUTURES:btcusdt";
const CLI_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/heatmap-pan-benchmark.mjs");

function runCli(...args) {
  return spawnSync(process.execPath, [CLI_SCRIPT, ...args], { encoding: "utf8" });
}

async function withSettings(settingsFor, work) {
  let prev = null;
  try { prev = orderbookHeatmapSettingsSource(); } catch {}
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
    if (prev) configureOrderbookHeatmapSettingsSource(prev);
  }
}

function makeSeries(length = 20) {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  series.loadBars(Array.from({ length }, (_, i) => ({
    startTime: (1_000 + i) * MINUTE,
    open: 50_100,
    high: 50_500,
    low: 49_900,
    close: 50_200,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  })));
  return series;
}

function makeView({ dpr = 1, width = 800, height = 400 } = {}) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 50_500;
  view.pricePerPx = 2;
  view.pixelRatio = dpr;
  return view;
}

function makeHarness({ width = 800, height = 400, dpr = 1 } = {}) {
  let createCanvasCalls = 0;
  const offClearRects = [];
  const offFillRects = [];
  const mainFillRects = [];
  const mainDrawImages = [];
  let mainFillStyleWrites = 0;
  let offFillStyleWrites = 0;
  let currentMainFillStyle = "";
  let currentOffFillStyle = "";
  const offClips = [];
  const mainClips = [];
  let offLastRect = null;
  let mainLastRect = null;

  const offCtx = {
    get fillStyle() { return currentOffFillStyle; },
    set fillStyle(v) { currentOffFillStyle = v; offFillStyleWrites++; },
    save() {},
    restore() {},
    beginPath() { offLastRect = null; },
    rect(x, y, w, h) { offLastRect = { x, y, w, h }; },
    clip() { if (offLastRect) offClips.push(offLastRect); },
    setTransform() {},
    clearRect(x, y, w, h) { offClearRects.push({ x, y, w, h }); },
    fillRect(x, y, w, h) { offFillRects.push({ x, y, w, h, fillStyle: currentOffFillStyle }); },
  };

  const offscreenCanvas = {
    width: 0,
    height: 0,
    getContext(kind) { return kind === "2d" ? offCtx : null; },
  };

  const ctx = {
    canvas: {
      width,
      height,
      ownerDocument: {
        createElement() {
          createCanvasCalls++;
          return offscreenCanvas;
        },
      },
    },
    imageSmoothingEnabled: true,
    get fillStyle() { return currentMainFillStyle; },
    set fillStyle(v) { currentMainFillStyle = v; mainFillStyleWrites++; },
    save() {},
    restore() {},
    beginPath() { mainLastRect = null; },
    rect(x, y, w, h) { mainLastRect = { x, y, w, h }; },
    clip() { if (mainLastRect) mainClips.push(mainLastRect); },
    getTransform() { return { a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 }; },
    setTransform() {},
    drawImage(img, ...args) {
      mainDrawImages.push({
        img,
        args,
        smoothing: this.imageSmoothingEnabled,
        lastClip: mainClips.at(-1) ?? null,
      });
    },
    fillRect(x, y, w, h) {
      mainFillRects.push({ x, y, w, h, fillStyle: currentMainFillStyle, clip: mainClips.at(-1) ?? null });
    },
  };

  return {
    ctx,
    offscreenCanvas,
    offClearRects,
    offFillRects,
    mainFillRects,
    mainDrawImages,
    offClips,
    mainClips,
    stats: () => ({
      createCanvasCalls,
      mainFillStyleWrites,
      offFillStyleWrites,
    }),
    resetCounts() {
      offClearRects.length = 0;
      offFillRects.length = 0;
      mainFillRects.length = 0;
      mainDrawImages.length = 0;
      offClips.length = 0;
      mainClips.length = 0;
      mainFillStyleWrites = 0;
      offFillStyleWrites = 0;
    },
  };
}

test("#260 getHeatmapColorLut keeps 1.0/0.85 pre-warmed, matches heatmapCellRgba at 0.65 & 0.45, and evicts FIFO at 16", () => {
  const preWarmFull1 = getHeatmapColorLut(1, 1);
  const preWarmLive1 = getHeatmapColorLut(0.45, 1);
  const preWarmFull85 = getHeatmapColorLut(1, 0.85);
  const preWarmLive85 = getHeatmapColorLut(0.45, 0.85);

  // Verify exact string parity for 0.65 (main + live extension) across all 1001 quantized intensities
  const lut65Main = getHeatmapColorLut(1, 0.65);
  const lut65Live = getHeatmapColorLut(0.45, 0.65);
  assert.equal(lut65Main.length, 1001);
  assert.equal(lut65Live.length, 1001);
  assert.equal(getHeatmapColorLut(1, 0.65), lut65Main, "cached 0.65 main LUT reuses exact array");
  assert.equal(getHeatmapColorLut(0.45, 0.65), lut65Live, "cached 0.65 live LUT reuses exact array");

  for (let q = 0; q <= 1000; q++) {
    const k = q / 1000;
    const expectedMain = heatmapCellRgba(k, 1, 0.65);
    const expectedLive = heatmapCellRgba(k, 0.45, 0.65);
    assert.equal(lut65Main[q], `rgba(${expectedMain.r}, ${expectedMain.g}, ${expectedMain.b}, ${expectedMain.a.toFixed(3)})`);
    assert.equal(lut65Live[q], `rgba(${expectedLive.r}, ${expectedLive.g}, ${expectedLive.b}, ${expectedLive.a.toFixed(3)})`);
    assert.equal(heatmapCellColor(k, 1, 0.65), lut65Main[q]);
    assert.equal(heatmapCellColor(k, 0.45, 0.65), lut65Live[q]);
  }

  // Fill bounded 16-entry dynamic LUT cache and verify FIFO eviction on entry 17
  const firstCustom = getHeatmapColorLut(1, 0.11);
  const secondCustom = getHeatmapColorLut(1, 0.12);
  for (let i = 3; i <= 16; i++) {
    getHeatmapColorLut(1, Number((0.1 + i * 0.01).toFixed(2)));
  }
  assert.equal(getHeatmapColorLut(1, 0.12), secondCustom, "2nd entry stays cached at capacity 16");
  // Inserting 17th unique dynamic key evicts 1st entry (0.11)
  getHeatmapColorLut(1, 0.77);
  assert.equal(getHeatmapColorLut(1, 0.12), secondCustom, "2nd entry remains cached after 17th insert");
  assert.notEqual(getHeatmapColorLut(1, 0.11), firstCustom, "1st entry was FIFO-evicted when exceeding 16");

  // Pre-warmed 1.0 & 0.85 entries stay pinned/pre-warmed regardless of FIFO churn
  assert.equal(getHeatmapColorLut(1, 1), preWarmFull1);
  assert.equal(getHeatmapColorLut(0.45, 1), preWarmLive1);
  assert.equal(getHeatmapColorLut(1, 0.85), preWarmFull85);
  assert.equal(getHeatmapColorLut(0.45, 0.85), preWarmLive85);
});

test("#260 price-band pre-filter skips off-screen yOfPrice calls and paintCellsToContext deduplicates fillStyle writes", async () => {
  await withSettings(() => ({
    mode: "single",
    unit: "usd",
    bucketStep: 25,
    opacity: 0.65,
    single: { usd: 1, btc: 1 },
    aggregated: { usd: 1, btc: 1 },
  }), async () => {
    const series = makeSeries(2);
    const view = makeView({ dpr: 1, width: 800, height: 200 });
    view.priceTop = 50_200; // visible prices ~[49_800, 50_200]
    let yOfPriceCalls = 0;
    const origYOfPrice = view.yOfPrice.bind(view);
    view.yOfPrice = (price) => {
      yOfPriceCalls++;
      return origYOfPrice(price);
    };

    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: 1_002 * MINUTE,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: [{
          t: 1_000 * MINUTE,
          cells: [
            [40_000, 500_000, 500_000], // far below visible band
            [42_000, 500_000, 500_000], // far below visible band
            [50_000, 500_000, 500_000], // visible, identical value
            [50_050, 500_000, 500_000], // visible, identical value
            [50_100, 500_000, 500_000], // visible, identical value
            [70_000, 500_000, 500_000], // far above visible band
          ],
        }],
      }),
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => 1_002 * MINUTE,
    });

    try {
      const h = makeHarness({ width: 800, height: 200, dpr: 1 });
      overlay.setRasterCacheDisabledForTest(true);
      overlay.draw(h.ctx, view, series, [0, 0]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      yOfPriceCalls = 0;
      h.resetCounts();

      overlay.draw(h.ctx, view, series, [0, 0]);
      // 2 passes (range + paint) * 3 visible cells * 2 yOfPrice calls/cell = 12 (never calls yOfPrice for 40k/42k/70k)
      assert.equal(yOfPriceCalls, 12, "off-screen cells are filtered by price band before yOfPrice");
      assert.equal(h.mainFillRects.length, 3);
      assert.equal(h.stats().mainFillStyleWrites, 1, "identical quantized colors assign fillStyle only once");
    } finally {
      overlay.dispose();
    }
  });
});

test("#256 motion raster reuse blits historical overlap, pixel-aligns at fractional DPR, paints exposed strips + live bar, and preserves 1-canvas budget", async () => {
  const wasTelemetry = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  let overlay;
  try {
    await withSettings(() => ({
      mode: "single",
      unit: "btc",
      bucketStep: 25,
      opacity: 0.65,
      scaleMode: "auto",
      contrast: "medium",
      single: { usd: 1, btc: 10 },
      aggregated: { usd: 1, btc: 10 },
    }), async () => {
      const series = makeSeries(20); // bars 0..19; colWidth=20 -> bar 19 (live) at x=380
      let now = 1_020 * MINUTE;
      const view = makeView({ dpr: 2, width: 800, height: 400 });
      const h = makeHarness({ width: 1600, height: 800, dpr: 2 });

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
          bars: Array.from({ length: 20 }, (_, i) => ({
            t: (1_000 + i) * MINUTE,
            cells: [
              [50_000, 600_000, 600_000],
              [50_200, 1_200_000, 1_200_000],
            ],
          })),
        }),
        invalidate: () => {},
        getMarket: () => MARKET,
        now: () => now,
      });

      overlay.draw(h.ctx, view, series, [0, 19]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Build initial cache at quiet viewport
      overlay.draw(h.ctx, view, series, [0, 19]);
      assert.equal(h.stats().createCanvasCalls, 1);
      assert.equal(overlay.reservedRasterBytes(), 1600 * 800 * 4);

      // Pan horizontally by +10.25 CSS px (at dpr=2 -> 20.5 device px) while moving (< 150ms)
      h.resetCounts();
      const beforePan = snapshotPerformanceTelemetry().counters;
      now += 16;
      view.offsetX += 10.25;
      overlay.draw(h.ctx, view, series, [0, 19]);
      const afterPan = snapshotPerformanceTelemetry().counters;

      assert.equal(h.stats().createCanvasCalls, 1, "must NOT allocate a second offscreen canvas");
      assert.equal(overlay.reservedRasterBytes(), 1600 * 800 * 4);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 1600 * 800 * 4);
      assert.equal((afterPan["chart.cpu.heatmap.raster.skip"] ?? 0) - (beforePan["chart.cpu.heatmap.raster.skip"] ?? 0), 1);
      assert.equal((afterPan["chart.cpu.heatmap.raster.direct"] ?? 0) - (beforePan["chart.cpu.heatmap.raster.direct"] ?? 0), 1);
      assert.equal((afterPan["chart.cpu.heatmap.raster.motionReuse"] ?? 0) - (beforePan["chart.cpu.heatmap.raster.motionReuse"] ?? 0), 1);
      assert.equal((afterPan["chart.cpu.heatmap.raster.miss"] ?? 0) - (beforePan["chart.cpu.heatmap.raster.miss"] ?? 0), 0);
      assert.equal((afterPan["chart.cpu.heatmap.raster.hit"] ?? 0) - (beforePan["chart.cpu.heatmap.raster.hit"] ?? 0), 0);

      // Verify drawImage blit used imageSmoothingEnabled=false and whole device pixel destination rect
      assert.equal(h.mainDrawImages.length, 1);
      assert.equal(h.mainDrawImages[0].smoothing, false);
      const [, , , , dx, dy, dw, dh] = h.mainDrawImages[0].args;
      assert.ok(Number.isInteger(dx) && Number.isInteger(dy) && Number.isInteger(dw) && Number.isInteger(dh),
        "destination blit rect is aligned to whole device pixels");
      // Left strip [0, 10.5] and right strip [390, 800] (no live extension beyond last bar)
      assert.ok(h.mainFillRects.length <= 12, "only exposed strips + live bar are painted, not all 20 bars");
      assert.ok(!h.mainFillRects.some((r) => r.x >= 410), "no live bar extension painted in empty right space");

      // Zoom 1.25x within [0.5, 2.0] also uses motionReuse
      h.resetCounts();
      now += 16;
      view.colWidth = 25;
      view.pricePerPx = 1.6;
      overlay.draw(h.ctx, view, series, [0, 19]);
      const afterZoom = snapshotPerformanceTelemetry().counters;
      assert.equal((afterZoom["chart.cpu.heatmap.raster.motionReuse"] ?? 0) - (afterPan["chart.cpu.heatmap.raster.motionReuse"] ?? 0), 1);

      // Extreme zoom (> 2.0x) falls back to full direct paint without motionReuse
      h.resetCounts();
      now += 16;
      view.colWidth = 50; // 50 / 20 = 2.5x > 2.0
      overlay.draw(h.ctx, view, series, [0, 19]);
      const afterExtremeZoom = snapshotPerformanceTelemetry().counters;
      assert.equal((afterExtremeZoom["chart.cpu.heatmap.raster.motionReuse"] ?? 0) - (afterZoom["chart.cpu.heatmap.raster.motionReuse"] ?? 0), 0);
      assert.equal((afterExtremeZoom["chart.cpu.heatmap.raster.direct"] ?? 0) - (afterZoom["chart.cpu.heatmap.raster.direct"] ?? 0), 1);

      // Settle past quiet interval -> full raster cache rebuild (miss)
      now += HEATMAP_CPU_RASTER_QUIET_MS;
      overlay.draw(h.ctx, view, series, [0, 19]);
      const afterSettle = snapshotPerformanceTelemetry().counters;
      assert.equal((afterSettle["chart.cpu.heatmap.raster.miss"] ?? 0) - (afterExtremeZoom["chart.cpu.heatmap.raster.miss"] ?? 0), 1);
    });
  } finally {
    overlay?.dispose();
    configurePerformanceTelemetry({ enabled: wasTelemetry });
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
  }
});

test("#256 static live-tail patch clears only live slice when color range stays within 1e-6 and falls back to full rebuild on range shift", async () => {
  const wasTelemetry = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  let overlay;
  try {
    await withSettings(() => ({
      mode: "single",
      unit: "btc",
      bucketStep: 25,
      opacity: 0.65,
      scaleMode: "fixed",
      fixedCeiling: { usd: 100_000_000, btc: 200 },
      single: { usd: 1, btc: 10 },
      aggregated: { usd: 1, btc: 10 },
    }), async (notify) => {
      const series = makeSeries(5); // live bar index 4 at t = 1004 * MINUTE
      let now = 1_004 * MINUTE + 500;
      const view = makeView({ dpr: 2, width: 800, height: 400 });
      const h = makeHarness({ width: 1600, height: 800, dpr: 2 });
      const liveTime = 1_004 * MINUTE;

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
          bars: Array.from({ length: 5 }, (_, i) => ({
            t: (1_000 + i) * MINUTE,
            cells: [[50_000, 600_000, 600_000], [50_200, 1_200_000, 1_200_000]],
          })),
        }),
        invalidate: () => {},
        getMarket: () => MARKET,
        now: () => now,
      });

      overlay.draw(h.ctx, view, series, [0, 4]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      overlay.draw(h.ctx, view, series, [0, 4]); // warm cache miss

      // Push live-tail update ONLY on live bar (fixed ceiling -> range unchanged): triggers tailPatch!
      h.resetCounts();
      const beforePatch = snapshotPerformanceTelemetry().counters;
      overlay.applyLiveTailBars([{
        t: liveTime,
        cells: [[50_000, 700_000, 700_000], [50_200, 1_400_000, 1_400_000]],
      }]);
      overlay.draw(h.ctx, view, series, [0, 4]);
      const afterPatch = snapshotPerformanceTelemetry().counters;

      assert.equal((afterPatch["chart.cpu.heatmap.raster.tailPatch"] ?? 0) - (beforePatch["chart.cpu.heatmap.raster.tailPatch"] ?? 0), 1);
      assert.equal((afterPatch["chart.cpu.heatmap.raster.miss"] ?? 0) - (beforePatch["chart.cpu.heatmap.raster.miss"] ?? 0), 0);
      assert.equal(h.offClearRects.length, 1);
      // liveX = 4 * 20 = 80 -> clears only [80, 800], NOT [0, 800]
      assert.deepEqual(h.offClearRects[0], { x: 80, y: 0, w: 720, h: 400 });
      assert.equal(h.offFillRects.length, 2, "repaints only live bar (2 cells, no right extension)");
      assert.equal(h.mainDrawImages.length, 1);

      // Now switch to auto scaleMode and push a giant live wall that shifts P96 ceiling (> 1e-6) -> full rebuild!
      const autoSettings = {
        mode: "single",
        unit: "btc",
        bucketStep: 25,
        opacity: 0.65,
        scaleMode: "auto",
        contrast: "medium",
        single: { usd: 1, btc: 10 },
        aggregated: { usd: 1, btc: 10 },
      };
      configureOrderbookHeatmapSettingsSource({
        settingsFor: () => autoSettings,
        onChange: () => () => {},
      });
      notify();
      overlay.draw(h.ctx, view, series, [0, 4]); // rebuild under auto
      h.resetCounts();
      const beforeShift = snapshotPerformanceTelemetry().counters;
      overlay.applyLiveTailBars([{
        t: liveTime,
        cells: [[50_000, 10_000_000, 10_000_000], [50_200, 15_000_000, 15_000_000]],
      }]);
      overlay.draw(h.ctx, view, series, [0, 4]);
      const afterShift = snapshotPerformanceTelemetry().counters;
      assert.equal((afterShift["chart.cpu.heatmap.raster.tailPatch"] ?? 0) - (beforeShift["chart.cpu.heatmap.raster.tailPatch"] ?? 0), 0);
      assert.equal((afterShift["chart.cpu.heatmap.raster.miss"] ?? 0) - (beforeShift["chart.cpu.heatmap.raster.miss"] ?? 0), 1);
      assert.deepEqual(h.offClearRects[0], { x: 0, y: 0, w: 1600, h: 800 });
    });
  } finally {
    overlay?.dispose();
    configurePerformanceTelemetry({ enabled: wasTelemetry });
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
  }
});

test("heatmap-pan-benchmark CLI supports --help, --list, --dry-run, invalid flags, and hardware-invalid Markdown", () => {
  const help = runCli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--output-dir/);
  assert.match(help.stdout, /--list/);
  assert.match(help.stdout, /--dry-run/);

  const list = runCli("--list");
  assert.equal(list.status, 0);
  const lines = list.stdout.trim().split("\n");
  assert.equal(lines.length, 8);
  assert.ok(lines.some((l) => l.includes("65%") && l.includes("1 chart(s)")));
  assert.ok(lines.some((l) => l.includes("85%") && l.includes("2 chart(s)")));
  assert.ok(lines.some((l) => l.includes("fixed(")));

  const dry = runCli("--dry-run", "--output-dir", "gpu-rapor");
  assert.equal(dry.status, 0);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.measurementEnabled, false);
  assert.equal(plan.fixture.bucketStep, 25);
  assert.equal(plan.fixture.thresholdBtc, 10);
  assert.equal(plan.scenarios.length, 8);

  const bad = runCli("--unknown-flag");
  assert.equal(bad.status, 2);

  const md = makeHeatmapPanMarkdown({
    runId: "ci-swiftshader",
    hardwareValid: false,
    decision: "NOT_EVALUATED_HARDWARE_INVALID",
    invalidReason: "ci-non-hardware-mode",
    rendererProbe: { unmaskedVendor: "Google Inc.", unmaskedRenderer: "ANGLE (Google, SwiftShader)" },
    results: [{
      chartCount: 1,
      label: "65% auto",
      phase: "pan",
      heatmapMs: { count: 16, p50Ms: 0.4, p95Ms: 0.7, p99Ms: 0.9 },
      annotationMs: { p95Ms: 1.1 },
      frameMs: { p95Ms: 2.0 },
      counters: { hit: 0, skip: 16, miss: 0, motionReuse: 16, tailPatch: 0 },
      visibleCells: 9000,
      reservedRasterBytes: 1800 * 1000 * 4,
    }],
    colorParity: [{ opacity: 0.65, normalMatch: true, liveExtMatch: true, normalDeltaMax: 1, liveExtDeltaMax: 1 }],
  });
  assert.match(md, /NOT_EVALUATED_HARDWARE_INVALID/);
  assert.match(md, /65% auto/);
  assert.match(md, /SwiftShader/);
  assert.match(md, /PASS/);
});

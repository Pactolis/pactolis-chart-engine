import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTpoProfileGroups,
  calculateTpoProfile,
  effectiveTpoBracketMs,
  tpoBracketLabel,
  tpoSessionRange,
} from "../dist/core/analysis/tpoProfile.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { configurePerformanceTelemetry, snapshotPerformanceTelemetry } from "../dist/core/performanceTelemetry.js";
import { drawTpo } from "../dist/core/render/overlay/tpoPaintHelpers.js";
import { getTpoCacheBracketCount, updateTpoProfileCache } from "../dist/core/render/overlay/tpoProfileCache.js";
import { settings } from "../dist/core/settings.js";
import { DAY_MS } from "../dist/core/time.js";
import { tpoPalette } from "../dist/core/ui/seriesPalette.js";

function makeBar(startTime, low, high, open = low, close = high, volume = 1) {
  return {
    startTime,
    open,
    high,
    low,
    close,
    volume,
    delta: 0,
    count: 1,
    cells: new Map(),
    sources: ["history"],
    hasRef: true,
    completeness: "complete",
  };
}

function makeMockCtx() {
  const texts = [];
  const rects = [];
  const ctx = {
    font: "",
    textBaseline: "",
    textAlign: "",
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    setLineDash() {},
    measureText(text) {
      return { width: String(text).length * 7 };
    },
    fillText(text, x, y) {
      texts.push({ text: String(text), x, y, fillStyle: this.fillStyle });
    },
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, fillStyle: this.fillStyle });
    },
  };
  return { ctx, texts, rects };
}

test("#340: wide-range bars stay in profile up to 250k entries and truncate safely above budget", () => {
  const dayStart = Date.UTC(2026, 0, 1);
  const halfDay = 12 * 60 * 60_000;

  // Threshold reproduction: 200.00 -> 10,004 TPOs, 200.01 -> 10,005 TPOs (no silent drop).
  const series200 = new FootprintSeries({ intervalMs: halfDay, priceStep: 0.01, pricePrecision: 2 });
  series200.loadBars([
    makeBar(dayStart, 100, 200.00),
    makeBar(dayStart + halfDay, 150, 150.02),
  ]);
  const cache200 = updateTpoProfileCache(
    null,
    series200,
    [0, 2],
    { tpoProfilePeriod: "daily", tpoBracketSize: "auto" },
    0.7,
    new Set(),
  );
  assert.equal(cache200.groups.length, 1);
  assert.equal(cache200.groups[0].partial, false);
  assert.equal(cache200.groups[0].result.levels.length, 10_001);
  assert.equal(cache200.groups[0].result.totalCount, 10_004);
  assert.equal(cache200.groups[0].result.val, 100);
  assert.equal(cache200.groups[0].result.vah, 169.99);
  assert.equal(cache200.groups[0].result.truncated, false);

  const series20001 = new FootprintSeries({ intervalMs: halfDay, priceStep: 0.01, pricePrecision: 2 });
  series20001.loadBars([
    makeBar(dayStart, 100, 200.01),
    makeBar(dayStart + halfDay, 150, 150.02),
  ]);
  const cache20001 = updateTpoProfileCache(
    null,
    series20001,
    [0, 2],
    { tpoProfilePeriod: "daily", tpoBracketSize: "auto" },
    0.7,
    new Set(),
  );
  assert.equal(cache20001.groups[0].partial, false);
  assert.equal(cache20001.groups[0].result.levels.length, 10_002);
  assert.equal(cache20001.groups[0].result.totalCount, 10_005);
  assert.equal(cache20001.groups[0].result.poc, 150);
  assert.equal(cache20001.groups[0].result.truncated, false);

  // 1,000,000-bin extreme range: fast sweep-line, exact POC/VA, truncated=true, lazy paint + budget badge.
  const t0 = performance.now();
  const millionResult = calculateTpoProfile(
    [makeBar(dayStart, 100, 10_100), makeBar(dayStart + halfDay, 500, 502)],
    0.01,
    0.7,
  );
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 200, `1M-bin sweep-line took ${elapsedMs}ms`);
  assert.equal(millionResult.truncated, true);
  assert.equal(millionResult.levels.length, 0);
  assert.equal(millionResult.totalCount, 1_000_202);
  assert.equal(millionResult.poc, 500);
  assert.ok(millionResult.runs && millionResult.runs.length === 3);

  const seriesMillion = new FootprintSeries({ intervalMs: halfDay, priceStep: 0.01, pricePrecision: 2 });
  seriesMillion.loadBars([makeBar(dayStart, 100, 10_100), makeBar(dayStart + halfDay, 500, 502)]);
  const { ctx, texts, rects } = makeMockCtx();
  const view = new View();
  view.area = { left: 0, top: 0, width: 200, height: 100 };
  view.colWidth = 20;
  view.priceTop = 505;
  view.pricePerPx = 0.1;
  const host = {
    ctx,
    chartConfig: { ...settings, chartType: "tpo", tpoProfilePeriod: "daily", tpoBracketSize: "auto", tpoMode: "blocks" },
    tpoCache: null,
    tpoMergeLeftSessionStarts: new Set(),
    pushTpoProfileHitZone() {},
  };
  drawTpo(host, view, seriesMillion, [0, 2]);
  assert.ok(rects.length > 0 && rects.length < 500, `expected bounded lazy viewport rects, got ${rects.length}`);
  assert.ok(texts.some((t) => t.text.includes("Budget")), "expected budget indicator for truncated profile");
});

test("#341: letters and blocks cull to visible price/time viewport while preserving full-session POC/VA and labels", () => {
  const intervalMs = 60_000;
  const start = Date.UTC(2026, 0, 1);
  const bars = Array.from({ length: 1440 }, (_, i) =>
    makeBar(start + i * intervalMs, 50_000, 50_100, 50_020, i === 710 ? 50_050 : 50_010),
  );
  const series = new FootprintSeries({ intervalMs, priceStep: 1, pricePrecision: 0 });
  series.loadBars(bars);

  const view = new View();
  view.area = { left: 0, top: 0, width: 240, height: 100 };
  view.colWidth = 12;
  view.offsetX = -700 * 12;
  view.priceTop = 50_055;
  view.pricePerPx = 0.1; // 10 px per price step -> ~10 visible price rows

  const lettersMock = makeMockCtx();
  const lettersHost = {
    ctx: lettersMock.ctx,
    chartConfig: { ...settings, chartType: "tpo", tpoProfilePeriod: "daily", tpoBracketSize: "auto", tpoMode: "letters" },
    tpoCache: null,
    tpoMergeLeftSessionStarts: new Set(),
    pushTpoProfileHitZone() {},
  };
  drawTpo(lettersHost, view, series, [700, 720]);
  assert.ok(lettersMock.texts.length > 0 && lettersMock.texts.length < 400, `expected culled fillText calls, got ${lettersMock.texts.length}`);
  assert.ok(lettersMock.texts.some((t) => t.text === tpoBracketLabel(700)), "bracket label preserves full-session index");
  assert.equal(lettersHost.tpoCache.groups[0].result.poc, 50_000);

  // Blocks mode: 20 visible bars -> rawSquare <= 12, visible rows ~10 -> bounded fillRect calls.
  const blocksMock = makeMockCtx();
  const blocksHost = {
    ctx: blocksMock.ctx,
    chartConfig: { ...settings, chartType: "tpo", tpoProfilePeriod: "daily", tpoBracketSize: "auto", tpoMode: "blocks" },
    tpoCache: null,
    tpoMergeLeftSessionStarts: new Set(),
    pushTpoProfileHitZone() {},
  };
  drawTpo(blocksHost, view, series, [700, 720]);
  assert.ok(blocksMock.rects.length > 0 && blocksMock.rects.length < 2000, `expected culled fillRect calls, got ${blocksMock.rects.length}`);

  // Log scale + fractional step parity: visible culling produces non-empty output without throwing.
  const fracSeries = new FootprintSeries({ intervalMs, priceStep: 0.05, pricePrecision: 2 });
  fracSeries.loadBars(Array.from({ length: 40 }, (_, i) => makeBar(start + i * intervalMs, 100.0, 101.0, 100.2, 100.5)));
  const logView = new View();
  logView.area = { left: 0, top: 0, width: 320, height: 120 };
  logView.colWidth = 12;
  logView.setScaleMode("logarithmic");
  const sTop = logView.toScale(100.8);
  const sBot = logView.toScale(100.2);
  logView.priceTop = sTop;
  logView.pricePerPx = (sTop - sBot) / 120;
  const logMock = makeMockCtx();
  drawTpo({
    ctx: logMock.ctx,
    chartConfig: { ...settings, chartType: "tpo", tpoProfilePeriod: "daily", tpoBracketSize: "auto", tpoMode: "letters" },
    tpoCache: null,
    tpoMergeLeftSessionStarts: new Set(),
    pushTpoProfileHitZone() {},
  }, logView, fracSeries, [0, 40]);
  assert.ok(logMock.texts.length > 0);
  assert.ok(logMock.texts.some((t) => t.fillStyle === tpoPalette.latest), "latest close bin highlighted in letters mode");
});

test("#342: tpoSessionRange is O(log N) and cache pan inside same session bounds reuses O(1) without scanning", () => {
  const intervalMs = 60_000;
  const start = Date.UTC(2026, 0, 1);
  const bars = Array.from({ length: 44_640 }, (_, i) => makeBar(start + i * intervalMs, 100, 101));

  let startTimeReads = 0;
  const proxiedBars = bars.map((bar) => new Proxy(bar, {
    get(target, prop, receiver) {
      if (prop === "startTime") startTimeReads++;
      return Reflect.get(target, prop, receiver);
    },
  }));

  const [sFrom, sTo] = tpoSessionRange(proxiedBars, 20_000, 20_020, "monthly");
  assert.equal(sFrom, 0);
  assert.equal(sTo, 44_640);
  assert.ok(startTimeReads < 80, `expected O(log N) startTime reads, got ${startTimeReads}`);

  // MergeLeft connected daily sessions + gaps + visible period parity.
  const multiDay = Array.from({ length: 5 * 24 }, (_, i) => makeBar(start + i * 60 * 60_000, 100, 102));
  const mergeSet = new Set([start + DAY_MS, start + 2 * DAY_MS]);
  assert.deepEqual(tpoSessionRange(multiDay, 30, 35, "daily", mergeSet), [0, 72]);
  assert.deepEqual(tpoSessionRange(multiDay, 30, 35, "visible", mergeSet), [30, 35]);

  // Cache pan inside same monthly session bounds reads at most tailStartTime (O(1)).
  const series = new FootprintSeries({ intervalMs, priceStep: 1, pricePrecision: 0 });
  series.loadBars(bars);
  const cfg = { tpoProfilePeriod: "monthly", tpoBracketSize: "auto" };
  const initial = updateTpoProfileCache(null, series, [44_600, 44_620], cfg, 0.7, new Set());
  const panned = updateTpoProfileCache(initial, series, [44_599, 44_619], cfg, 0.7, new Set());
  assert.strictEqual(panned, initial);
});

test("#343: live ticks inside the same quantized price bin trigger 0 profile recomputations", () => {
  const intervalMs = 60_000;
  const start = Date.UTC(2026, 0, 1);
  const bars = Array.from({ length: 2 * 1440 }, (_, i) =>
    makeBar(start + i * intervalMs, 50_000, 50_025, 50_010, 50_020),
  );
  const series = new FootprintSeries({ intervalMs, priceStep: 10, pricePrecision: 2 });
  series.loadBars(bars);

  const { enabled } = snapshotPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const cfg = { tpoProfilePeriod: "daily", tpoBracketSize: "auto" };
    let cache = updateTpoProfileCache(null, series, [2860, 2880], cfg, 0.7, new Set());
    const initialResult = cache.groups[1].result;
    const baseCompute = snapshotPerformanceTelemetry().counters["chart.tpo.compute.groups"] ?? 0;

    const tailTime = bars[bars.length - 1].startTime;
    for (let i = 1; i <= 20; i++) {
      series.addTrade(tailTime + 1000, 50_025 + i * 0.01, 1, "buy");
      cache = updateTpoProfileCache(cache, series, [2860, 2880], cfg, 0.7, new Set());
      assert.strictEqual(cache.groups[1].result, initialResult);
    }
    assert.equal((snapshotPerformanceTelemetry().counters["chart.tpo.compute.groups"] ?? 0) - baseCompute, 0);

    // Crossing into the next quantized bin (50_120) triggers exactly 1 recompute.
    series.addTrade(tailTime + 2000, 50_120, 1, "buy");
    cache = updateTpoProfileCache(cache, series, [2860, 2880], cfg, 0.7, new Set());
    assert.equal((snapshotPerformanceTelemetry().counters["chart.tpo.compute.groups"] ?? 0) - baseCompute, 1);
    assert.notStrictEqual(cache.groups[1].result, initialResult);
  } finally {
    configurePerformanceTelemetry({ enabled });
  }
});

test("#344: metadata-only live ticks avoid O(N) bracket array copies while keeping snapshots immutable", () => {
  const intervalMs = 60_000;
  const start = Date.UTC(2026, 0, 1);
  const bars = Array.from({ length: 44_640 }, (_, i) => makeBar(start + i * intervalMs, 100, 101, 100, 100.5, 5));
  const series = new FootprintSeries({ intervalMs, priceStep: 1, pricePrecision: 0 });
  series.loadBars(bars);

  const cfg = { tpoProfilePeriod: "monthly", tpoBracketSize: "auto" };
  const prev = updateTpoProfileCache(null, series, [44_620, 44_640], cfg, 0.7, new Set());
  assert.equal(getTpoCacheBracketCount(prev), 44_640);

  // No-op update shares the exact same lazy brackets array identity.
  const noOp = updateTpoProfileCache(prev, series, [44_620, 44_640], cfg, 0.7, new Set());
  assert.strictEqual(noOp.brackets, prev.brackets);
  const prevLastVol = prev.brackets[44_639].bar.volume;

  // Live volume-only trade on the tail bar: drawTpo + cache update must not materialize O(N) flat arrays.
  const tailTime = bars[bars.length - 1].startTime;
  series.addTrade(tailTime + 500, 100.2, 7, "buy");
  const next = updateTpoProfileCache(prev, series, [44_620, 44_640], cfg, 0.7, new Set());

  const { ctx } = makeMockCtx();
  const view = new View();
  view.area = { left: 0, top: 0, width: 200, height: 100 };
  view.colWidth = 8;
  view.priceTop = 102;
  view.pricePerPx = 0.05;
  drawTpo({
    ctx,
    chartConfig: { ...settings, chartType: "tpo", tpoProfilePeriod: "monthly", tpoBracketSize: "auto", tpoMode: "blocks" },
    tpoCache: next,
    tpoMergeLeftSessionStarts: new Set(),
    pushTpoProfileHitZone() {},
  }, view, series, [44_620, 44_640]);

  // Previous snapshot remains immutable while next reflects updated tail volume.
  assert.equal(prev.brackets[44_639].bar.volume, prevLastVol);
  assert.equal(next.brackets[44_639].bar.volume, prevLastVol + 7);
});

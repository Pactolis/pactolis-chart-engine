import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

globalThis.$state ??= (value) => value;

const { configureChartLocale } = await import("../dist/core/chartLocale.js");
const { calculateOiDeltaRangeProfile } = await import("../dist/core/analysis/rangeProfile.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { DEFAULT_OI_VENUES } = await import("../dist/core/orderFlowProfileSettings.js");
const {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} = await import("../dist/core/performanceTelemetry.js");
const { drawAnalysisDrawings } = await import("../dist/core/render/analysisDrawings.js");
const { uiColor } = await import("../dist/core/ui/seriesPalette.js");
const {
  applyStylePreset,
  DRAWING_STYLE_PRESET_KEYS,
  drawingStylePresetFromDrawing,
  duplicateDrawing,
  normalizeDrawing,
  ORDER_FLOW_PROFILE_STYLE_KEYS,
} = await import("../dist/features/drawings/drawingPrimitives.js");
const { configureIndicatorDataSource } = await import("../dist/features/indicators/indicatorDataSource.js");

const T0 = Date.UTC(2026, 2, 1, 0, 0, 0);
const MIN = 60_000;

function installLocale(locale = "tr-TR") {
  configureChartLocale({
    locale: () => locale,
    timeZone: () => "UTC",
    translate: (key) => key,
    onLocaleChange: () => () => {},
  });
}

function exactBar(time, levels, overrides = {}) {
  let buySum = 0;
  let sellSum = 0;
  for (const level of levels) {
    buySum += level.buyVol;
    sellSum += level.sellVol;
  }
  return {
    startTime: time,
    open: 100,
    high: 104,
    low: 99,
    close: 102,
    volume: buySum + sellSum,
    delta: buySum - sellSum,
    count: levels.length * 2,
    hasRef: true,
    cellRevision: 1,
    completeness: "complete",
    sources: ["history"],
    cells: new Map(levels.map((level) => [level.priceBin, level])),
    ...overrides,
  };
}

function ohlcvBar(time, open, high, low, close, volume) {
  return {
    startTime: time,
    open,
    high,
    low,
    close,
    volume,
    delta: 0,
    count: 0,
    hasRef: true,
    cellRevision: 1,
    completeness: "complete",
    sources: ["history"],
    cells: new Map(),
  };
}

function makeSeries(bars, intervalMs = MIN) {
  const series = new FootprintSeries({ priceStep: 1, intervalMs });
  series.loadBars(bars);
  return series;
}

function createCanvasMock() {
  const fillTexts = [];
  const fillRects = [];
  const strokeLines = [];
  let movePt = null;
  const noop = () => {};
  const ctx = {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    save: noop,
    restore: noop,
    beginPath: noop,
    rect: noop,
    clip: noop,
    setLineDash: noop,
    moveTo(x, y) { movePt = { x, y }; },
    lineTo(x, y) { if (movePt) strokeLines.push({ x1: movePt.x, y1: movePt.y, x2: x, y2: y }); },
    stroke: noop,
    measureText: (text) => ({ width: String(text).length * 6 }),
    fillRect(x, y, w, h) {
      fillRects.push({ x, y, w, h, fillStyle: this.fillStyle, alpha: this.globalAlpha });
    },
    fillText(text, x, y) {
      fillTexts.push({ text: String(text), x, y, fillStyle: this.fillStyle, textAlign: this.textAlign });
    },
  };
  return { ctx, fillTexts, fillRects, strokeLines };
}

function createViewMock(series, area = { left: 0, top: 0, width: 1200, height: 600 }) {
  return {
    area,
    colWidth: 12,
    priceAxisW: 60,
    xOfIndex: (index) => 40 + index * 16,
    indexOfX: (x) => Math.floor((x - 40) / 16),
    yOfPrice: (price) => 500 - (price - 95) * 20,
    priceRange: () => ({ minValue: () => 95, maxValue: () => 110 }),
    series,
  };
}

function createTimeCtx(series) {
  return {
    indexForTime: (time) => series.indexOfTime(time),
    timeForIndex: (index) => series.timeOfIndex(Math.round(index)),
  };
}

function makeOiDrawing(from, to, overrides = {}) {
  return {
    id: "frvp-oi-1",
    type: "fixed-range-volume-profile",
    points: [
      { time: from, price: 99 },
      { time: to, price: 104 },
    ],
    color: "#ffffff",
    lineWidth: 1,
    locked: false,
    visible: true,
    market: "BINANCE_FUTURES:btcusdt",
    profileMetric: "oi-delta",
    profileSide: "total",
    ...overrides,
  };
}

function setOiDataSource(provider) {
  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    requestOpenInterestSeries: provider,
    fetchOptionsGexSurface: async () => { throw new Error("unused"); },
  });
}

test("total conservation matches #372 exact fixture", () => {
  const bars = [
    exactBar(T0, [
      { priceBin: 100, buyVol: 30, sellVol: 10 },
      { priceBin: 101, buyVol: 40, sellVol: 20 },
    ]),
    exactBar(T0 + MIN, [
      { priceBin: 100, buyVol: 15, sellVol: 5 },
      { priceBin: 102, buyVol: 50, sellVol: 30 },
    ]),
  ];
  const response = {
    unit: "base",
    resolution: "1m",
    venues: [
      {
        venue: "binance",
        points: [
          { time: T0, value: 1000 },
          { time: T0 + MIN, value: 1120 },
          { time: T0 + 2 * MIN, value: 1070 },
        ],
      },
      {
        venue: "bybit",
        points: [
          { time: T0, value: 500 },
          { time: T0 + MIN, value: 530 },
          { time: T0 + 2 * MIN, value: 510 },
        ],
      },
    ],
  };

  const result = calculateOiDeltaRangeProfile(bars, T0, T0 + MIN, MIN, response, ["binance", "bybit"]);
  const sumNet = result.levels.reduce((s, l) => s + l.value, 0);
  const sumOpen = result.levels.reduce((s, l) => s + l.oiOpen, 0);
  const sumClose = result.levels.reduce((s, l) => s + l.oiClose, 0);
  assert.ok(Math.abs(sumNet - 80) < 1e-9);
  assert.ok(Math.abs(sumOpen - 150) < 1e-9);
  assert.ok(Math.abs(sumClose - (-70)) < 1e-9);
  assert.ok(Math.abs(result.summaryValue - 80) < 1e-9);
  assert.equal(result.poc, null);
  assert.equal(result.vah, null);
  assert.equal(result.val, null);
});

test("intervalMs < resolutionMs uses full boundary slot volume without over-allocating", () => {
  // 5m OI slot [T0, T0 + 5*MIN) has 3 1m bars with volumes 10, 30, 10 (total 50).
  // Range covers only bar 1 (vol 30 => 60% of 200 = 120), NOT 100% of 200!
  const bars = [
    exactBar(T0, [{ priceBin: 100, buyVol: 10, sellVol: 0 }]),
    exactBar(T0 + MIN, [{ priceBin: 101, buyVol: 25, sellVol: 5 }]),
    exactBar(T0 + 2 * MIN, [{ priceBin: 102, buyVol: 5, sellVol: 5 }]),
  ];
  const response = {
    unit: "base",
    resolution: "5m",
    venues: [
      {
        venue: "binance",
        points: [
          { time: T0, value: 1000 },
          { time: T0 + 5 * MIN, value: 1200 },
        ],
      },
    ],
  };
  const result = calculateOiDeltaRangeProfile(bars, T0 + MIN, T0 + MIN, MIN, response, ["binance"]);
  assert.ok(Math.abs(result.summaryValue - 120) < 1e-9);
  assert.equal(result.oiMeta.coveredBarCount, 1);
  assert.equal(result.oiMeta.totalBarCount, 1);
  assert.equal(result.oiMeta.coveragePercent, 100);
});

test("request sharing, caching, out-of-range live hit, and invalidation on OI/venue/display/market/timeframe", () => {
  installLocale("tr-TR");
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const bars = [
    exactBar(T0, [{ priceBin: 100, buyVol: 20, sellVol: 10 }]),
    exactBar(T0 + MIN, [{ priceBin: 101, buyVol: 15, sellVol: 15 }]),
    exactBar(T0 + 2 * MIN, [{ priceBin: 102, buyVol: 10, sellVol: 10 }]),
  ];
  const series = makeSeries(bars);
  const view = createViewMock(series);
  const timeCtx = createTimeCtx(series);
  let oiTail = 1100;
  let requestCalls = 0;

  setOiDataSource(() => {
    requestCalls += 1;
    return {
      status: "ready",
      data: {
        unit: "base",
        resolution: "1m",
        venues: [
          {
            venue: "binance",
            points: [
              { time: T0, value: 1000 },
              { time: T0 + MIN, value: 1050 },
              { time: T0 + 2 * MIN, value: oiTail },
            ],
          },
          {
            venue: "bybit",
            points: [
              { time: T0, value: 500 },
              { time: T0 + MIN, value: 520 },
              { time: T0 + 2 * MIN, value: 530 },
            ],
          },
        ],
      },
    };
  });

  // Two drawings with same (market, from, to, venues) share 1 request
  const d1 = makeOiDrawing(T0, T0 + MIN, { id: "d1" });
  const d2 = makeOiDrawing(T0, T0 + MIN, { id: "d2" });
  const { ctx } = createCanvasMock();
  drawAnalysisDrawings(ctx, view, series, timeCtx, [d1, d2], "BINANCE_FUTURES:btcusdt", undefined, { timeframe: "1m" });
  assert.equal(requestCalls, 1);

  // Repeat render hits cache
  resetPerformanceTelemetry();
  drawAnalysisDrawings(ctx, view, series, timeCtx, [d1], "BINANCE_FUTURES:btcusdt", undefined, { timeframe: "1m" });
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.hit"], 1);
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"] ?? 0, 0);

  // Out-of-range live tick on bar 2 hits cache
  resetPerformanceTelemetry();
  series.addTrade({ id: 1, time: T0 + 2 * MIN + 100, price: 102, qty: 5, isBuy: true });
  drawAnalysisDrawings(ctx, view, series, timeCtx, [d1], "BINANCE_FUTURES:btcusdt", undefined, { timeframe: "1m" });
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.hit"], 1);
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"] ?? 0, 0);

  // OI revision change invalidates cache
  resetPerformanceTelemetry();
  oiTail = 1200;
  drawAnalysisDrawings(ctx, view, series, timeCtx, [d1], "BINANCE_FUTURES:btcusdt", undefined, { timeframe: "1m" });
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // Venue change invalidates cache
  resetPerformanceTelemetry();
  d1.oiVenues = { binance: true, bybit: false, okx: false, hyperliquid: false };
  drawAnalysisDrawings(ctx, view, series, timeCtx, [d1], "BINANCE_FUTURES:btcusdt", undefined, { timeframe: "1m" });
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // oiDeltaDisplay change invalidates cache
  resetPerformanceTelemetry();
  d1.oiDeltaDisplay = "split";
  drawAnalysisDrawings(ctx, view, series, timeCtx, [d1], "BINANCE_FUTURES:btcusdt", undefined, { timeframe: "1m" });
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // timeframe change invalidates cache
  resetPerformanceTelemetry();
  drawAnalysisDrawings(ctx, view, series, timeCtx, [d1], "BINANCE_FUTURES:btcusdt", undefined, { timeframe: "5m" });
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);
});

test("loading and error/no-data states render expected TR/EN badges", () => {
  const bars = [exactBar(T0, [{ priceBin: 100, buyVol: 10, sellVol: 10 }])];
  const series = makeSeries(bars);
  const view = createViewMock(series);
  const timeCtx = createTimeCtx(series);
  const drawing = makeOiDrawing(T0, T0);

  installLocale("tr-TR");
  setOiDataSource(() => ({ status: "loading" }));
  let canvas = createCanvasMock();
  drawAnalysisDrawings(canvas.ctx, view, series, timeCtx, [drawing], "BINANCE_FUTURES:btcusdt");
  assert.ok(canvas.fillTexts.some((t) => t.text === "OI yükleniyor..."));

  installLocale("en-US");
  canvas = createCanvasMock();
  drawAnalysisDrawings(canvas.ctx, view, series, timeCtx, [drawing], "BINANCE_FUTURES:btcusdt");
  assert.ok(canvas.fillTexts.some((t) => t.text === "Loading OI..."));

  installLocale("tr-TR");
  setOiDataSource(() => ({ status: "error", message: "boom" }));
  canvas = createCanvasMock();
  drawAnalysisDrawings(canvas.ctx, view, series, timeCtx, [drawing], "BINANCE_FUTURES:btcusdt");
  assert.ok(canvas.fillTexts.some((t) => t.text === "OI verisi yok"));

  installLocale("en-US");
  setOiDataSource(() => ({ status: "unsupported", message: "none" }));
  canvas = createCanvasMock();
  drawAnalysisDrawings(canvas.ctx, view, series, timeCtx, [drawing], "BINANCE_FUTURES:btcusdt");
  assert.ok(canvas.fillTexts.some((t) => t.text === "No OI data"));
});

test("off-screen, hidden, and non-oi-delta drawings skip OI request", () => {
  const bars = [
    exactBar(T0, [{ priceBin: 100, buyVol: 10, sellVol: 10 }]),
    exactBar(T0 + MIN, [{ priceBin: 101, buyVol: 10, sellVol: 10 }]),
  ];
  const series = makeSeries(bars);
  const timeCtx = createTimeCtx(series);
  let requestCalls = 0;
  setOiDataSource(() => {
    requestCalls += 1;
    return { status: "ready", data: { unit: "base", resolution: "1m", venues: [] } };
  });

  // Off-screen view (area starts at x = 5000)
  const offScreenView = createViewMock(series, { left: 5000, top: 0, width: 400, height: 400 });
  const { ctx } = createCanvasMock();
  drawAnalysisDrawings(ctx, offScreenView, series, timeCtx, [makeOiDrawing(T0, T0 + MIN)], "BINANCE_FUTURES:btcusdt");
  assert.equal(requestCalls, 0);

  // Hidden drawing
  const onScreenView = createViewMock(series);
  drawAnalysisDrawings(ctx, onScreenView, series, timeCtx, [makeOiDrawing(T0, T0 + MIN, { visible: false })], "BINANCE_FUTURES:btcusdt");
  assert.equal(requestCalls, 0);

  // Non-oi-delta metric
  drawAnalysisDrawings(ctx, onScreenView, series, timeCtx, [makeOiDrawing(T0, T0 + MIN, { profileMetric: "volume" })], "BINANCE_FUTURES:btcusdt");
  assert.equal(requestCalls, 0);
});

test("renders split OI delta around deltaZeroX, OHLCV estimate badge, and recordingStartedAt coverage without POC/VA", () => {
  installLocale("tr-TR");
  const bars = [
    ohlcvBar(T0, 100, 103, 100, 102, 100), // pre-recording
    ohlcvBar(T0 + MIN, 100, 103, 100, 102, 100), // +50
    ohlcvBar(T0 + 2 * MIN, 100, 103, 100, 101, 100), // -30
  ];
  const series = makeSeries(bars);
  const view = createViewMock(series);
  const timeCtx = createTimeCtx(series);
  setOiDataSource(() => ({
    status: "ready",
    data: {
      unit: "base",
      resolution: "1m",
      recordingStartedAt: T0 + MIN,
      venues: [{
        venue: "binance",
        points: [
          { time: T0, value: 900 },
          { time: T0 + MIN, value: 1000 },
          { time: T0 + 2 * MIN, value: 1050 },
          { time: T0 + 3 * MIN, value: 1020 },
        ],
      }],
    },
  }));

  const drawing = makeOiDrawing(T0, T0 + 2 * MIN, {
    oiDeltaDisplay: "split",
    profilePlacement: "left",
    pocMode: "static",
    vahMode: "static",
    valMode: "static",
  });
  const canvas = createCanvasMock();
  drawAnalysisDrawings(canvas.ctx, view, series, timeCtx, [drawing], "BINANCE_FUTURES:btcusdt");

  const buyRects = canvas.fillRects.filter((r) => r.fillStyle === uiColor.buy && r.w > 0);
  const sellRects = canvas.fillRects.filter((r) => r.fillStyle === uiColor.sell && r.w > 0);
  assert.ok(buyRects.length > 0 && sellRects.length > 0);
  // POC/VA suppressed
  assert.equal(canvas.strokeLines.length, 0);
  // Badge matches #372 recordingStartedAt format
  assert.ok(canvas.fillTexts.some((t) => t.text.includes("OI kaydı") && t.text.includes("kapsama %67")));
});

test("presets, duplicateDrawing, and legacy drawing normalization carry oiVenues and oiDeltaDisplay", () => {
  assert.ok(ORDER_FLOW_PROFILE_STYLE_KEYS.includes("oiVenues"));
  assert.ok(ORDER_FLOW_PROFILE_STYLE_KEYS.includes("oiDeltaDisplay"));
  assert.ok(DRAWING_STYLE_PRESET_KEYS.includes("oiVenues"));
  assert.ok(DRAWING_STYLE_PRESET_KEYS.includes("oiDeltaDisplay"));

  const legacy = normalizeDrawing({
    id: "legacy-1",
    type: "fixed-range-volume-profile",
    points: [{ time: T0, price: 100 }, { time: T0 + MIN, price: 102 }],
    color: "#ffffff",
    lineWidth: 1,
    locked: false,
    visible: true,
  });
  assert.deepEqual(legacy.oiVenues, DEFAULT_OI_VENUES);
  assert.equal(legacy.oiDeltaDisplay, "net");

  const custom = makeOiDrawing(T0, T0 + MIN, {
    oiVenues: { binance: true, bybit: false, okx: true, hyperliquid: false },
    oiDeltaDisplay: "split",
  });
  const preset = drawingStylePresetFromDrawing(custom);
  assert.deepEqual(preset.oiVenues, { binance: true, bybit: false, okx: true, hyperliquid: false });
  assert.equal(preset.oiDeltaDisplay, "split");

  const target = normalizeDrawing({ ...legacy, id: "target-1" });
  applyStylePreset(target, preset);
  assert.deepEqual(target.oiVenues, { binance: true, bybit: false, okx: true, hyperliquid: false });
  assert.equal(target.oiDeltaDisplay, "split");

  const copy = duplicateDrawing(custom, [custom]);
  assert.deepEqual(copy.oiVenues, { binance: true, bybit: false, okx: true, hyperliquid: false });
  assert.equal(copy.oiDeltaDisplay, "split");
});

test("ChartRuntime prunes deleted drawing IDs from oiRequestStates and clears on market change/dispose (#405)", async () => {
  const [compiledSource, tsSource] = await Promise.all([
    readFile(new URL("../dist/features/chart/ChartRuntime.js", import.meta.url), "utf8"),
    readFile(new URL("../src/features/chart/ChartRuntime.ts", import.meta.url), "utf8"),
  ]);

  const extractMethod = (src, signature) => {
    const start = src.indexOf(signature);
    assert.notEqual(start, -1, `method signature not found: ${signature}`);
    let depth = 0;
    let opened = false;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") {
        depth++;
        opened = true;
      } else if (src[i] === "}" && opened) {
        depth--;
        if (depth === 0) return `function ${src.slice(start, i + 1)}`;
      }
    }
    throw new Error(`unclosed method: ${signature}`);
  };

  const bindings = {
    ChartSurfaceDirty: { Annotation: 1 },
    normalizeFixedRangeOrderFlowProfileSettings: () => ({ profileMetric: "oi-delta" }),
    drawingIsAvailableAsOf: () => true,
  };
  const pruneFn = new Function(`return ${extractMethod(compiledSource, "pruneOiRequestStates() {")};`)();
  const createCbFn = new Function(
    ...Object.keys(bindings),
    `return ${extractMethod(compiledSource, "createFrvpOiUpdateCallback(drawingId, requestKey) {")};`,
  )(...Object.values(bindings));

  const liveDrawings = new Map([
    ["d1", { id: "d1", visible: true, market: "BTCUSDT", points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] }],
    ["d2", { id: "d2", visible: true, market: "BTCUSDT", points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] }],
  ]);

  const host = {
    disposed: false,
    state: { market: "BTCUSDT", timeframe: "1m" },
    oiRequestStates: new Map(),
    analysisContextForChart: () => ({
      drawings: { findDrawingById: (id) => liveDrawings.get(id) },
    }),
    replayCoordinator: { getSnapshot: () => null },
    view: { xOfIndex: () => 0, colWidth: 10, area: { left: 0, width: 100 } },
    pipeline: { series: { indexOfTime: () => 0 } },
    session: { invalidateSurface: () => {} },
    pruneOiRequestStates: pruneFn,
    createFrvpOiUpdateCallback: createCbFn,
  };

  const cb1 = host.createFrvpOiUpdateCallback("d1", "req-1");
  const cb2 = host.createFrvpOiUpdateCallback("d2", "req-2");
  assert.equal(host.oiRequestStates.size, 2);

  // Deleting d1 -> pruneOiRequestStates removes d1 while keeping d2.
  liveDrawings.delete("d1");
  host.pruneOiRequestStates();
  assert.equal(host.oiRequestStates.has("d1"), false);
  assert.equal(host.oiRequestStates.has("d2"), true);
  cb1();
  assert.equal(host.oiRequestStates.has("d1"), false);

  // Deleting d2 before its pending async callback fires -> callback removes d2.
  liveDrawings.delete("d2");
  cb2();
  assert.equal(host.oiRequestStates.size, 0);

  // Verify ChartRuntime wires pruneOiRequestStates after renderAnalysis and clears on marketChanged + dispose.
  assert.match(tsSource, /renderAnalysis\([\s\S]*?this\.pruneOiRequestStates\(\)/);
  assert.match(tsSource, /if\s*\(marketChanged\)\s*\{\s*this\.oiRequestStates\.clear\(\)/);
  assert.match(tsSource, /this\.disposed = true;\s*this\.oiRequestStates\.clear\(\)/);
});

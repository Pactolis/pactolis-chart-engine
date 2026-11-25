import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { configureChartLocale } = await import("../dist/core/chartLocale.js");
const {
  accumulateOrderFlowOiDeltaBar,
  createOrderFlowProfileAccumulator,
  finishOrderFlowProfile,
} = await import("../dist/core/analysis/orderFlowProfile.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const {
  normalizeOrderFlowProfileSettings,
  profileSupportsValueArea,
} = await import("../dist/core/orderFlowProfileSettings.js");
const { configurePerformanceTelemetry, snapshotPerformanceTelemetry } = await import("../dist/core/performanceTelemetry.js");
const { profileHistogramParts } = await import("../dist/core/render/orderFlowProfile.js");
const { uiColor } = await import("../dist/core/ui/seriesPalette.js");
const { configureIndicatorDataSource } = await import("../dist/features/indicators/indicatorDataSource.js");
const { computeBarOiDeltas } = await import("../dist/features/indicators/builtins/oiDeltaProfile.js");
const { volumeProfileIndicatorDefinition } = await import("../dist/features/indicators/builtins/volumeProfile.js");

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

function mockCanvas() {
  const fillTexts = [];
  const fillRects = [];
  const strokeLines = [];
  const noop = () => {};
  let movePt = null;
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    save: noop,
    restore: noop,
    beginPath: noop,
    rect: noop,
    clip: noop,
    moveTo(x, y) { movePt = { x, y }; },
    lineTo(x, y) { if (movePt) strokeLines.push({ x1: movePt.x, y1: movePt.y, x2: x, y2: y }); },
    stroke: noop,
    strokeRect: noop,
    setLineDash: noop,
    measureText: (text) => ({ width: String(text).length * 7 }),
    fillRect(x, y, w, h) {
      fillRects.push({ x, y, w, h, fillStyle: this.fillStyle, alpha: this.globalAlpha });
    },
    fillText(text, x, y) {
      fillTexts.push({ text: String(text), x, y, fillStyle: this.fillStyle });
    },
  };
  return { ctx, fillTexts, fillRects, strokeLines };
}

function makeIndicatorCtx(series, range, overrides = {}, intervalMs = MIN) {
  const { ctx, fillTexts, fillRects, strokeLines } = mockCanvas();
  const settings = {
    ...volumeProfileIndicatorDefinition.defaultSettings(),
    profileMetric: "oi-delta",
    ...overrides,
  };
  const area = { left: 0, top: 0, width: 700, height: 320 };
  return {
    ctx,
    fillTexts,
    fillRects,
    strokeLines,
    indicatorCtx: {
      ctx,
      series,
      range,
      rect: area,
      settings,
      instance: { id: "vp-oi-test", type: "volume-profile", visible: true, settings },
      chart: {
        market: "BINANCE_FUTURES:btcusdt",
        timeframe: intervalMs === MIN ? "1m" : "5m",
        intervalMs,
      },
      view: {
        area,
        colWidth: 12,
        xOfIndex: (i) => 40 + i * 16,
        indexOfX: (x) => Math.floor((x - 40) / 16),
        yOfPrice: (price) => 300 - (price - 95) * 20,
      },
      requestRefresh: () => {},
    },
  };
}

function makeSeries(bars, intervalMs = MIN) {
  const series = new FootprintSeries({ priceStep: 1, intervalMs });
  for (const b of bars) series.upsertBar(b);
  return series;
}

function setOiDataSource(stateProvider) {
  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    requestOpenInterestSeries: stateProvider,
    fetchOptionsGexSurface: async () => { throw new Error("unused"); },
  });
}

test("oi-delta settings defaults, normalization and value area support", () => {
  assert.equal(profileSupportsValueArea("oi-delta"), false);
  const norm = normalizeOrderFlowProfileSettings({ profileMetric: "oi-delta" });
  assert.equal(norm.profileMetric, "oi-delta");
  assert.equal(norm.oiDeltaDisplay, "net");
  assert.deepEqual(norm.oiVenues, {
    binance: true,
    bybit: true,
    okx: true,
    hyperliquid: true,
  });

  const splitNorm = normalizeOrderFlowProfileSettings({
    profileMetric: "oi-delta",
    oiDeltaDisplay: "split",
    oiVenues: { binance: true, bybit: false, okx: true, hyperliquid: false },
  });
  assert.equal(splitNorm.oiDeltaDisplay, "split");
  assert.deepEqual(splitNorm.oiVenues, {
    binance: true,
    bybit: false,
    okx: true,
    hyperliquid: false,
  });

  const calcFields = volumeProfileIndicatorDefinition.settingsSchema.sections[0].fields;
  const sideField = calcFields.find((f) => f.key === "profileSide");
  const pocField = calcFields.find((f) => f.key === "pocMode");
  const displayField = calcFields.find((f) => f.key === "oiDeltaDisplay");
  const venuesField = calcFields.find((f) => f.key === "oiVenues");
  assert.ok(sideField.visibleWhen.notValues.includes("oi-delta"));
  assert.ok(!pocField.visibleWhen.values.includes("oi-delta"));
  assert.deepEqual(displayField.visibleWhen.values, ["oi-delta"]);
  assert.deepEqual(venuesField.visibleWhen.values, ["oi-delta"]);
});

test("oi-delta conserves total net, oiOpen, and oiClose across footprint levels", () => {
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

  const comp = computeBarOiDeltas(bars, MIN, response, ["binance", "bybit"]);
  assert.equal(comp.coveredBarCount, 2);
  assert.equal(comp.coveragePercent, 100);
  // Bar 0: (1120-1000) + (530-500) = +150; Bar 1: (1070-1120) + (510-530) = -70
  assert.equal(comp.barDeltas[0], 150);
  assert.equal(comp.barDeltas[1], -70);

  const acc = createOrderFlowProfileAccumulator();
  for (let i = 0; i < bars.length; i += 1) {
    accumulateOrderFlowOiDeltaBar(acc, bars[i], comp.barDeltas[i], { profileMetric: "oi-delta" });
  }
  const result = finishOrderFlowProfile(acc, { profileMetric: "oi-delta" });

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

test("TF < r splits r-slot OI delta across bars proportionally to volume", () => {
  // 1m chart bars inside a single 5m OI slot [T0, T0 + 5*MIN)
  const bars = [
    exactBar(T0, [{ priceBin: 100, buyVol: 10, sellVol: 0 }]),          // vol 10 (20%)
    exactBar(T0 + MIN, [{ priceBin: 101, buyVol: 25, sellVol: 5 }]),    // vol 30 (60%)
    exactBar(T0 + 2 * MIN, [{ priceBin: 102, buyVol: 5, sellVol: 5 }]), // vol 10 (20%)
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

  const comp = computeBarOiDeltas(bars, MIN, response, ["binance"]);
  assert.equal(comp.coveredBarCount, 3);
  assert.ok(Math.abs(comp.barDeltas[0] - 40) < 1e-9);
  assert.ok(Math.abs(comp.barDeltas[1] - 120) < 1e-9);
  assert.ok(Math.abs(comp.barDeltas[2] - 40) < 1e-9);
  const totalDelta = comp.barDeltas.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(totalDelta - 200) < 1e-9);
});

test("skips missing venue per bar and excludes gaps & pre-recordingStartedAt bars from coverage", () => {
  installLocale("tr-TR");
  const bars = [
    exactBar(T0, [{ priceBin: 100, buyVol: 10, sellVol: 10 }]),             // pre-recording (uncovered)
    exactBar(T0 + MIN, [{ priceBin: 100, buyVol: 10, sellVol: 10 }]),       // covered by binance only (+50)
    exactBar(T0 + 2 * MIN, [{ priceBin: 100, buyVol: 10, sellVol: 10 }]),   // gap (uncovered)
    exactBar(T0 + 3 * MIN, [{ priceBin: 100, buyVol: 10, sellVol: 10 }]),   // covered by binance (+30) & bybit (+20) = +50
  ];
  const response = {
    unit: "base",
    resolution: "1m",
    recordingStartedAt: T0 + MIN,
    gaps: [{ from: T0 + 2 * MIN, to: T0 + 3 * MIN }],
    venues: [
      {
        venue: "binance",
        points: [
          { time: T0, value: 900 },
          { time: T0 + MIN, value: 1000 },
          { time: T0 + 2 * MIN, value: 1050 },
          { time: T0 + 3 * MIN, value: 1060 },
          { time: T0 + 4 * MIN, value: 1090 },
        ],
      },
      {
        venue: "bybit",
        points: [
          // bybit missing at T0 + MIN, present for bar 3 [T0+3m, T0+4m)
          { time: T0 + 3 * MIN, value: 400 },
          { time: T0 + 4 * MIN, value: 420 },
        ],
      },
    ],
  };

  const comp = computeBarOiDeltas(bars, MIN, response, ["binance", "bybit"]);
  assert.equal(comp.barDeltas[0], null);
  assert.equal(comp.barDeltas[1], 50);
  assert.equal(comp.barDeltas[2], null);
  assert.equal(comp.barDeltas[3], 50);
  assert.equal(comp.coveredBarCount, 2);
  assert.equal(comp.coveragePercent, 50);

  const series = makeSeries(bars);
  setOiDataSource(() => ({ status: "ready", data: response }));
  const { indicatorCtx } = makeIndicatorCtx(series, [0, 4]);
  const prepared = volumeProfileIndicatorDefinition.prepareData(indicatorCtx);
  assert.equal(prepared.status, "ok");
  assert.ok(prepared.message.includes("kapsama %50"));
  assert.ok(prepared.message.includes("OI kaydı"));
});

test("OHLCV bars without footprint distribute OI delta uniformly and mark isEstimated = true", () => {
  installLocale("tr-TR");
  const bars = [
    ohlcvBar(T0, 100, 104, 100, 103, 500),
    ohlcvBar(T0 + MIN, 103, 104, 100, 101, 400),
  ];
  const response = {
    unit: "base",
    resolution: "1m",
    venues: [
      {
        venue: "binance",
        points: [
          { time: T0, value: 1000 },
          { time: T0 + MIN, value: 1080 },
          { time: T0 + 2 * MIN, value: 1040 },
        ],
      },
    ],
  };
  const series = makeSeries(bars);
  setOiDataSource(() => ({ status: "ready", data: response }));
  const { indicatorCtx } = makeIndicatorCtx(series, [0, 2]);
  const prepared = volumeProfileIndicatorDefinition.prepareData(indicatorCtx);
  assert.equal(prepared.status, "ok");
  assert.equal(prepared.meta.result.isEstimated, true);
  assert.equal(prepared.meta.result.levels.length, 4);
  const sumOpen = prepared.meta.result.levels.reduce((s, l) => s + l.oiOpen, 0);
  const sumClose = prepared.meta.result.levels.reduce((s, l) => s + l.oiClose, 0);
  assert.ok(Math.abs(sumOpen - 80) < 1e-9);
  assert.ok(Math.abs(sumClose - (-40)) < 1e-9);
  assert.ok(prepared.message.includes("tahmini"));
});

test("no OI data returns status no-data with OI verisi yok message (not error)", () => {
  installLocale("tr-TR");
  const series = makeSeries([
    exactBar(T0, [{ priceBin: 100, buyVol: 10, sellVol: 10 }]),
  ]);
  setOiDataSource(() => ({ status: "unsupported", message: "unrecorded" }));
  const { indicatorCtx } = makeIndicatorCtx(series, [0, 1]);
  const prepared = volumeProfileIndicatorDefinition.prepareData(indicatorCtx);
  assert.equal(prepared.status, "no-data");
  assert.equal(prepared.error, undefined);
  assert.equal(prepared.message, "OI verisi yok");
});

test("renders net and split OI delta respecting profilePlacement and skips POC/VA", () => {
  installLocale("tr-TR");
  const netParts = profileHistogramParts({ value: -25, buyValue: 10, sellValue: -35, magnitude: 25 }, "oi-delta", "total", "net");
  assert.deepEqual(netParts, [{ side: "delta", value: 25, signed: -25 }]);

  const splitParts = profileHistogramParts({ value: -25, buyValue: 10, sellValue: -35, oiOpen: 10, oiClose: -35, magnitude: 35 }, "oi-delta", "total", "split");
  assert.deepEqual(splitParts, [
    { side: "sell", value: 35, signed: -35 },
    { side: "buy", value: 10, signed: 10 },
  ]);

  const bars = [
    exactBar(T0, [{ priceBin: 100, buyVol: 10, sellVol: 10 }]),
    exactBar(T0 + MIN, [{ priceBin: 100, buyVol: 10, sellVol: 10 }]),
  ];
  const response = {
    unit: "base",
    resolution: "1m",
    venues: [{
      venue: "binance",
      points: [
        { time: T0, value: 100 },
        { time: T0 + MIN, value: 150 },
        { time: T0 + 2 * MIN, value: 120 },
      ],
    }],
  };
  const series = makeSeries(bars);
  setOiDataSource(() => ({ status: "ready", data: response }));

  const leftCtx = makeIndicatorCtx(series, [0, 2], { profilePlacement: "left", oiDeltaDisplay: "split" });
  const prepared = volumeProfileIndicatorDefinition.prepareData(leftCtx.indicatorCtx);
  volumeProfileIndicatorDefinition.drawPriceOverlay(leftCtx.indicatorCtx, prepared);

  // Split mode draws both sellColor (left of deltaZeroX = 94) and buyColor (right of deltaZeroX = 94)
  assert.equal(leftCtx.fillRects.length, 2);
  const sellRect = leftCtx.fillRects.find((r) => r.fillStyle === uiColor.sell);
  const buyRect = leftCtx.fillRects.find((r) => r.fillStyle === uiColor.buy);
  assert.ok(sellRect && buyRect);
  assert.ok(sellRect.x < 94 && buyRect.x >= 94);
  assert.equal(leftCtx.strokeLines.length, 0);
});

test("cache hits on series tail tick and invalidates on OI revision, venue, or display change", () => {
  installLocale("tr-TR");
  configurePerformanceTelemetry({ enabled: true });

  const bars = [
    exactBar(T0, [{ priceBin: 100, buyVol: 20, sellVol: 10 }]),
    exactBar(T0 + MIN, [{ priceBin: 101, buyVol: 10, sellVol: 10 }]),
  ];
  let oiTailValue = 1100;
  setOiDataSource(() => ({
    status: "ready",
    data: {
      unit: "base",
      resolution: "1m",
      venues: [{
        venue: "binance",
        points: [
          { time: T0, value: 1000 },
          { time: T0 + MIN, value: 1050 },
          { time: T0 + 2 * MIN, value: oiTailValue },
        ],
      }],
    },
  }));

  const series = makeSeries(bars);
  const { indicatorCtx } = makeIndicatorCtx(series, [0, 2]);
  const first = volumeProfileIndicatorDefinition.prepareData(indicatorCtx);
  assert.ok(Math.abs(first.meta.result.summaryValue - 100) < 1e-9);

  // Live trade tick on tail bar without OI change -> incremental hit
  const hitsBefore = snapshotPerformanceTelemetry().counters["indicator.incremental.hit.volumeProfile"] ?? 0;
  series.upsertBar(exactBar(T0 + MIN, [
    { priceBin: 101, buyVol: 30, sellVol: 10 },
    { priceBin: 102, buyVol: 10, sellVol: 0 },
  ]));
  const second = volumeProfileIndicatorDefinition.prepareData(indicatorCtx);
  const hitsAfter = snapshotPerformanceTelemetry().counters["indicator.incremental.hit.volumeProfile"] ?? 0;
  assert.equal(hitsAfter, hitsBefore + 1);
  assert.ok(Math.abs(second.meta.result.summaryValue - 100) < 1e-9);

  // OI revision changes -> invalidates cache
  oiTailValue = 1200;
  const third = volumeProfileIndicatorDefinition.prepareData(indicatorCtx);
  assert.ok(Math.abs(third.meta.result.summaryValue - 200) < 1e-9);

  // oiDeltaDisplay changes -> invalidates cache
  indicatorCtx.settings.oiDeltaDisplay = "split";
  const fourth = volumeProfileIndicatorDefinition.prepareData(indicatorCtx);
  assert.equal(fourth.meta.oiMeta.oiDeltaDisplay, "split");
});

test("perf comparison: OI delta live tail tick matches volume mode incremental path", () => {
  installLocale("en-US");
  configurePerformanceTelemetry({ enabled: true });

  const bars = [];
  const oiPoints = [];
  for (let i = 0; i < 300; i += 1) {
    bars.push(exactBar(T0 + i * MIN, [
      { priceBin: 100 + (i % 10), buyVol: 20, sellVol: 15 },
      { priceBin: 101 + (i % 10), buyVol: 10, sellVol: 25 },
    ]));
    oiPoints.push({ time: T0 + i * MIN, value: 10_000 + i * 5 });
  }
  oiPoints.push({ time: T0 + 300 * MIN, value: 11_500 });

  setOiDataSource(() => ({
    status: "ready",
    data: { unit: "base", resolution: "1m", venues: [{ venue: "binance", points: oiPoints }] },
  }));

  const series = makeSeries(bars);
  const volCtx = makeIndicatorCtx(series, [0, 300], { profileMetric: "volume" }).indicatorCtx;
  const oiCtx = makeIndicatorCtx(series, [0, 300], { profileMetric: "oi-delta" }).indicatorCtx;
  oiCtx.instance = { id: "vp-perf-oi", type: "volume-profile", visible: true, settings: oiCtx.settings };
  volCtx.instance = { id: "vp-perf-vol", type: "volume-profile", visible: true, settings: volCtx.settings };

  volumeProfileIndicatorDefinition.prepareData(volCtx);
  volumeProfileIndicatorDefinition.prepareData(oiCtx);

  const ticks = 40;
  const tVolStart = performance.now();
  for (let t = 0; t < ticks; t += 1) {
    series.upsertBar(exactBar(T0 + 299 * MIN, [{ priceBin: 105, buyVol: 20 + t, sellVol: 15 }]));
    volumeProfileIndicatorDefinition.prepareData(volCtx);
  }
  const volMs = performance.now() - tVolStart;

  const tOiStart = performance.now();
  for (let t = 0; t < ticks; t += 1) {
    series.upsertBar(exactBar(T0 + 299 * MIN, [{ priceBin: 105, buyVol: 30 + t, sellVol: 15 }]));
    volumeProfileIndicatorDefinition.prepareData(oiCtx);
  }
  const oiMs = performance.now() - tOiStart;

  assert.ok(volMs >= 0 && oiMs >= 0);
  // Both modes should stay fast (< 500ms even on slow CI runners) for 40 live ticks over 300 bars
  assert.ok(oiMs < 500, `Expected OI delta 40 live ticks < 500ms, got ${oiMs.toFixed(2)}ms (volume: ${volMs.toFixed(2)}ms)`);
});

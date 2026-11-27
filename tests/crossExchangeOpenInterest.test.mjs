import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { chartLocale, configureChartLocale } = await import("../dist/core/chartLocale.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { View } = await import("../dist/core/engine/view.js");
const { configureIndicatorDataSource, indicatorDataSource } = await import(
  "../dist/features/indicators/indicatorDataSource.js"
);
const {
  crossExchangeOpenInterestIndicatorDefinition,
  normalizeCrossExchangeOpenInterestSettings,
  OPEN_INTEREST_VENUES,
} = await import("../dist/features/indicators/builtins/crossExchangeOpenInterest.js");

const MIN = 60_000;
const T0 = Date.UTC(2026, 3, 1, 0, 0, 0);

function buildSeries(closes) {
  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  series.loadBars(
    closes.map((close, index) => ({
      startTime: T0 + index * MIN,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
      delta: 0,
      count: 1,
      cells: new Map(),
      hasRef: true,
      cellRevision: 0,
    })),
  );
  return series;
}

function makeCtx(series, settingsOverrides = {}, extra = {}) {
  const settings = {
    ...crossExchangeOpenInterestIndicatorDefinition.defaultSettings(),
    ...settingsOverrides,
  };
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 200 };
  view.colWidth = 10;
  view.offsetX = 0;

  return {
    ctx: extra.ctx ?? {},
    view,
    series,
    rect: { top: 0, height: 120 },
    range: extra.range ?? [0, series.length],
    instance: {
      id: extra.id ?? "ce-oi-test",
      type: "cross-exchange-open-interest",
      title: "Cross-Exchange OI",
      visible: true,
      paneId: "pane-ce-oi",
      order: 0,
      settings,
    },
    settings,
    chart: {
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1m",
      intervalMs: MIN,
    },
    requestRefresh: () => {},
  };
}

function withMockDataSource(mock, fn) {
  let prev = null;
  try {
    prev = indicatorDataSource();
  } catch {
    prev = null;
  }
  configureIndicatorDataSource(mock);
  try {
    return fn();
  } finally {
    if (prev !== null) configureIndicatorDataSource(prev);
  }
}

function createCanvasRecorder() {
  const ops = [];
  const texts = [];
  const dashes = [];
  let currentDash = [];
  const ctx = {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "round",
    lineCap: "round",
    globalAlpha: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    save() {},
    restore() {},
    setLineDash(d) {
      currentDash = [...d];
      dashes.push(currentDash);
    },
    beginPath() {
      ops.push({ op: "beginPath", dash: [...currentDash] });
    },
    moveTo(x, y) {
      ops.push({ op: "moveTo", x, y });
    },
    lineTo(x, y) {
      ops.push({ op: "lineTo", x, y });
    },
    stroke() {
      ops.push({ op: "stroke", dash: [...currentDash] });
    },
    fillRect(x, y, w, h) {
      ops.push({ op: "fillRect", x, y, w, h });
    },
    strokeRect() {},
    roundRect() {},
    fill() {},
    measureText(text) {
      return { width: String(text).length * 6 };
    },
    fillText(text, x, y) {
      texts.push({ text: String(text), x, y });
    },
  };
  return { ctx, ops, texts, dashes };
}

test("settings migration maps 9 legacy Coinalyze keys to 4 direct venues, drops marketTypes, and preserves mode", () => {
  const legacyAll = {
    mode: "openInterestUsd",
    marketTypes: { spot: false, futuresUsdPerp: true, futuresCoinPerp: true },
    exchanges: {
      binancef: true,
      "binancef-inverse": true,
      bitmexf: true,
      "bitmex-inverse": true,
      bybitf: false,
      "bybitf-inverse": true,
      coinbasef: true,
      hyperliquid: true,
      okxf: false,
    },
  };

  const normalized = normalizeCrossExchangeOpenInterestSettings(legacyAll);
  assert.equal(normalized.mode, "openInterestUsd");
  assert.equal(normalized.unit, "usd");
  assert.equal(Object.hasOwn(normalized, "marketTypes"), false);
  assert.deepEqual(Object.keys(normalized.exchanges).sort(), [...OPEN_INTEREST_VENUES].sort());
  assert.deepEqual(normalized.exchanges, {
    binance: true,
    bybit: false,
    okx: false,
    hyperliquid: true,
  });

  // If only dropped legacy keys were enabled, fall back to enabling all 4 venues.
  const onlyDropped = normalizeCrossExchangeOpenInterestSettings({
    mode: "openInterestDeltaUsd",
    exchanges: {
      bitmexf: true,
      coinbasef: true,
      "binancef-inverse": true,
    },
  });
  assert.equal(onlyDropped.mode, "openInterestDeltaUsd");
  assert.deepEqual(onlyDropped.exchanges, {
    binance: true,
    bybit: true,
    okx: true,
    hyperliquid: true,
  });
});

test("multi-venue summation and late-starting venue exclusion prevent step-jump in delta OI", () => {
  const series = buildSeries([100, 100, 100, 100]);
  const response = {
    status: "ok",
    unit: "base",
    resolution: "1m",
    venues: [
      {
        venue: "binance",
        points: [
          { time: T0 + 0 * MIN, value: 1000 },
          { time: T0 + 1 * MIN, value: 1020 },
          { time: T0 + 2 * MIN, value: 1030 },
          { time: T0 + 3 * MIN, value: 1035 },
        ],
      },
      {
        venue: "bybit",
        points: [
          { time: T0 + 0 * MIN, value: 500 },
          { time: T0 + 1 * MIN, value: 490 },
          { time: T0 + 2 * MIN, value: 505 },
          { time: T0 + 3 * MIN, value: 500 },
        ],
      },
      {
        // Starts mid-series at bar 2 with 300 coins!
        venue: "okx",
        recordingStartedAt: T0 + 2 * MIN,
        points: [
          { time: T0 + 2 * MIN, value: 300 },
          { time: T0 + 3 * MIN, value: 315 },
        ],
      },
    ],
  };

  const prepared = withMockDataSource(
    { requestOpenInterestSeries: () => ({ status: "ready", data: response }) },
    () => crossExchangeOpenInterestIndicatorDefinition.prepareData(makeCtx(series, { mode: "openInterestDeltaUsd", unit: "base" }, { id: "late-venue" })),
  );

  assert.equal(prepared.status, "ok");
  assert.equal(prepared.points.length, 4);
  // Bar 0: total=1500, delta=0
  assert.equal(prepared.points[0].openInterestBase, 1500);
  assert.equal(prepared.points[0].openInterestDeltaBase, 0);
  // Bar 1: total=1510, delta=(1020-1000)+(490-500)=+10
  assert.equal(prepared.points[1].openInterestBase, 1510);
  assert.equal(prepared.points[1].openInterestDeltaBase, 10);
  // Bar 2: okx joins at 300 -> total=1030+505+300=1835, but delta ONLY sums binance (+10) + bybit (+15) = +25 (NO +300 jump!)
  assert.equal(prepared.points[2].openInterestBase, 1835);
  assert.equal(prepared.points[2].openInterestDeltaBase, 25);
  // Bar 3: okx has data on both bar 2 and bar 3 -> delta=(1035-1030)+(500-505)+(315-300)=+15
  assert.equal(prepared.points[3].openInterestBase, 1850);
  assert.equal(prepared.points[3].openInterestDeltaBase, 15);
});

test("USD mode computes OI = totalCoin * close and deltaUsd = coinDelta * close without price distortion", () => {
  // Price jumps from 100 to 150 on bar 1 while coin OI stays flat at 1000 -> deltaUsd must be 0!
  // On bar 2, coin OI increases by +10 at close 200 -> deltaUsd = 10 * 200 = 2000.
  const series = buildSeries([100, 150, 200]);
  const response = {
    status: "ok",
    unit: "base",
    resolution: "1m",
    venues: [
      {
        venue: "binance",
        points: [
          { time: T0 + 0 * MIN, value: 1000 },
          { time: T0 + 1 * MIN, value: 1000 },
          { time: T0 + 2 * MIN, value: 1010 },
        ],
      },
    ],
  };

  const prepared = withMockDataSource(
    { requestOpenInterestSeries: () => ({ status: "ready", data: response }) },
    () => crossExchangeOpenInterestIndicatorDefinition.prepareData(makeCtx(series, { mode: "openInterestDeltaUsd", unit: "usd" }, { id: "usd-coin-diff" })),
  );

  assert.equal(prepared.status, "ok");
  assert.equal(prepared.points[0].openInterestUsd, 100_000);
  assert.equal(prepared.points[0].openInterestDeltaUsd, 0);
  assert.equal(prepared.points[1].openInterestUsd, 150_000);
  assert.equal(prepared.points[1].openInterestDeltaUsd, 0);
  assert.equal(prepared.points[2].openInterestUsd, 202_000);
  assert.equal(prepared.points[2].openInterestDeltaUsd, 2_000);
});

test("recordingStartedAt boundary, gaps non-interpolation, and HL instant-only badge", () => {
  const series = buildSeries([100, 100, 100, 100, 100, 100]);
  const response = {
    status: "ok",
    unit: "base",
    resolution: "1m",
    recordingStartedAt: T0 + 2 * MIN,
    gaps: [{ from: T0 + 4 * MIN, to: T0 + 5 * MIN }],
    venues: [
      {
        venue: "binance",
        historyStartedAt: T0 + 2 * MIN,
        points: [
          { time: T0 + 0 * MIN, value: 999 }, // before recordingStartedAt -> must not be drawn
          { time: T0 + 2 * MIN, value: 100 },
          { time: T0 + 3 * MIN, value: 110 },
          { time: T0 + 5 * MIN, value: 130 },
        ],
        source: "backend",
      },
      {
        venue: "hyperliquid",
        points: [{ time: T0 + 5 * MIN, value: 50 }],
        source: "instant-only",
      },
    ],
  };

  const recorder = createCanvasRecorder();
  const ctx = makeCtx(series, { mode: "openInterestUsd", unit: "base" }, { id: "gaps-hl", ctx: recorder.ctx });

  const prepared = withMockDataSource(
    { requestOpenInterestSeries: () => ({ status: "ready", data: response }) },
    () => crossExchangeOpenInterestIndicatorDefinition.prepareData(ctx),
  );

  assert.equal(prepared.status, "ok");
  // Bars 0,1 are before recordingStartedAt (T0+2m); bar 4 is inside gap [T0+4m, T0+5m)
  assert.deepEqual(
    prepared.points.map((p) => p.index),
    [2, 3, 5],
  );
  assert.equal(prepared.meta.hasInstantOnlyVenue, true);

  // Header & readout include HL instant-only indicator
  const header = crossExchangeOpenInterestIndicatorDefinition.getHeaderLabel({
    instance: ctx.instance,
    settings: ctx.settings,
    chart: ctx.chart,
    prepared,
  });
  assert.match(header, /HL instant-only/);

  const readout = crossExchangeOpenInterestIndicatorDefinition.getReadout(ctx, prepared, null);
  assert.ok(readout.items.some((item) => item.label === "HL" && item.value === "instant-only"));

  // Draw subpane: verify vertical dashed boundary line and non-interpolation across gap (2 moveTo calls in series stroke)
  crossExchangeOpenInterestIndicatorDefinition.drawSubPane(ctx, prepared);
  assert.ok(recorder.dashes.some((d) => d[0] === 4 && d[1] === 4), "draws dashed recordingStartedAt boundary line");
  // After the boundary line stroke, the series line path should have 2 moveTo calls (bar 2 and bar 5 after gap)
  const moveTos = recorder.ops.filter((o) => o.op === "moveTo");
  assert.ok(moveTos.length >= 3, "boundary line moveTo + 2 disconnected line segments across gap");
});

test("unrecorded / unsupported market shows clear explanatory message", () => {
  const series = buildSeries([100, 100]);
  const ctx = makeCtx(series, {}, { id: "unrecorded" });

  const prepared = withMockDataSource(
    { requestOpenInterestSeries: () => ({ status: "unsupported", message: "OI kaydı yok (bu market kaydedilmiyor)" }) },
    () => crossExchangeOpenInterestIndicatorDefinition.prepareData(ctx),
  );

  assert.equal(prepared.status, "no-data");
  assert.equal(prepared.message, "OI kaydı yok (bu market kaydedilmiyor)");
});

function withLocale(localeTag, fn) {
  let prev = null;
  try {
    prev = chartLocale();
  } catch {}
  configureChartLocale({
    locale: () => localeTag,
    timeZone: () => "UTC",
    translate: (key) => key,
    onLocaleChange: () => () => {},
  });
  try {
    return fn();
  } finally {
    if (prev) configureChartLocale(prev);
  }
}

test("supported market with empty historical range shows range-empty message + start date and recovers on live range (#401)", () => {
  const series = buildSeries([100, 100, 100, 100, 100, 100, 100]);
  const recordingStart = T0 + 4 * MIN;
  const response = {
    status: "ok",
    unit: "base",
    resolution: "1m",
    recordingStartedAt: recordingStart,
    venues: [
      {
        venue: "binance",
        recordingStartedAt: recordingStart,
        points: [
          { time: T0 + 4 * MIN, value: 1000 },
          { time: T0 + 5 * MIN, value: 1020 },
          { time: T0 + 6 * MIN, value: 1030 },
        ],
      },
      {
        venue: "bybit",
        recordingStartedAt: recordingStart,
        points: [
          { time: T0 + 4 * MIN, value: 500 },
          { time: T0 + 5 * MIN, value: 510 },
          { time: T0 + 6 * MIN, value: 520 },
        ],
      },
    ],
  };

  withLocale("tr-TR", () => {
    const emptyCtx = makeCtx(series, { mode: "openInterestDeltaUsd", unit: "base" }, { id: "btc-empty-tr", range: [0, 3] });
    const emptyPrepared = withMockDataSource(
      { requestOpenInterestSeries: () => ({ status: "ready", data: response }) },
      () => crossExchangeOpenInterestIndicatorDefinition.prepareData(emptyCtx),
    );
    assert.equal(emptyPrepared.status, "no-data");
    assert.equal(emptyPrepared.points.length, 0);
    assert.match(emptyPrepared.message ?? "", /Bu aralıkta OI verisi yok/);
    assert.match(emptyPrepared.message ?? "", /Kayıt başlangıcı:/);
    assert.equal(/kaydedilmiyor/i.test(emptyPrepared.message ?? ""), false);

    // Returning to live bars restores all data without fabricating missing bars.
    const liveCtx = makeCtx(series, { mode: "openInterestDeltaUsd", unit: "base" }, { id: "btc-empty-tr", range: [4, 7] });
    const livePrepared = withMockDataSource(
      { requestOpenInterestSeries: () => ({ status: "ready", data: response }) },
      () => crossExchangeOpenInterestIndicatorDefinition.prepareData(liveCtx),
    );
    assert.equal(livePrepared.status, "ok");
    assert.deepEqual(livePrepared.points.map((p) => p.index), [4, 5, 6]);
  });

  withLocale("en-US", () => {
    const emptyCtx = makeCtx(series, { mode: "openInterestDeltaUsd", unit: "base" }, { id: "btc-empty-en", range: [0, 3] });
    const emptyPrepared = withMockDataSource(
      { requestOpenInterestSeries: () => ({ status: "ready", data: response }) },
      () => crossExchangeOpenInterestIndicatorDefinition.prepareData(emptyCtx),
    );
    assert.equal(emptyPrepared.status, "no-data");
    assert.match(emptyPrepared.message ?? "", /No OI data in this range/);
    assert.match(emptyPrepared.message ?? "", /Recording started:/);
    assert.equal(/not recorded/i.test(emptyPrepared.message ?? ""), false);
  });
});

test("response no-data without unsupported flag does not claim market is unrecorded, while response.status=unsupported does (#401)", () => {
  const series = buildSeries([100, 100]);

  withLocale("tr-TR", () => {
    const emptyNoData = withMockDataSource(
      {
        requestOpenInterestSeries: () => ({
          status: "ready",
          data: { status: "no-data", unit: "base", resolution: "15m", venues: [] },
        }),
      },
      () => crossExchangeOpenInterestIndicatorDefinition.prepareData(makeCtx(series, {}, { id: "no-data-tr" })),
    );
    assert.equal(emptyNoData.status, "no-data");
    assert.equal(emptyNoData.message, "Bu aralıkta OI verisi yok");

    const unsupportedResp = withMockDataSource(
      {
        requestOpenInterestSeries: () => ({
          status: "ready",
          data: { status: "unsupported", unit: "base", resolution: "15m", venues: [] },
        }),
      },
      () => crossExchangeOpenInterestIndicatorDefinition.prepareData(makeCtx(series, {}, { id: "unsupported-tr" })),
    );
    assert.equal(unsupportedResp.status, "no-data");
    assert.equal(unsupportedResp.message, "OI kaydı yok (bu market kaydedilmiyor)");
  });

  withLocale("en-US", () => {
    const emptyNoDataEn = withMockDataSource(
      {
        requestOpenInterestSeries: () => ({
          status: "ready",
          data: { status: "no-data", unit: "base", resolution: "15m", venues: [] },
        }),
      },
      () => crossExchangeOpenInterestIndicatorDefinition.prepareData(makeCtx(series, {}, { id: "no-data-en" })),
    );
    assert.equal(emptyNoDataEn.status, "no-data");
    assert.equal(emptyNoDataEn.message, "No OI data in this range");

    const unsupportedEn = withMockDataSource(
      {
        requestOpenInterestSeries: () => ({
          status: "ready",
          data: { status: "unsupported", unit: "base", resolution: "15m", venues: [] },
        }),
      },
      () => crossExchangeOpenInterestIndicatorDefinition.prepareData(makeCtx(series, {}, { id: "unsupported-en" })),
    );
    assert.equal(unsupportedEn.status, "no-data");
    assert.equal(unsupportedEn.message, "No OI record (this market is not recorded)");
  });
});

import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { View } = await import("../dist/core/engine/view.js");
const { configureIndicatorDataSource } = await import("../dist/features/indicators/indicatorDataSource.js");
const {
  alignVenueSeriesToHourEnd,
  buildHourlyFundingTimeline,
  fundingRegimeIndicatorDefinition,
  getFundingRegimeNativeCacheStats,
  migrateFundingExchanges,
  resetFundingRegimeCachesForTests,
} = await import("../dist/features/indicators/builtins/fundingRegime.js");

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeSeries(startTime, count, intervalMs = HOUR_MS) {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(
    Array.from({ length: count }, (_, i) => ({
      startTime: startTime + i * intervalMs,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
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

function makeCanvasMock() {
  const fillTexts = [];
  const dashedLines = [];
  let currentDash = [];
  let path = [];
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
    },
    beginPath() {
      path = [];
    },
    moveTo(x, y) {
      path.push({ op: "moveTo", x, y });
    },
    lineTo(x, y) {
      path.push({ op: "lineTo", x, y });
    },
    stroke() {
      if (currentDash.length === 2 && path.length === 2 && path[0].y === path[1].y) {
        dashedLines.push({ y: path[0].y, dash: [...currentDash] });
      }
    },
    fillRect() {},
    strokeRect() {},
    roundRect() {},
    fill() {},
    measureText(text) {
      return { width: String(text).length * 4 };
    },
    fillText(text, x, y) {
      fillTexts.push({ text: String(text), x, y });
    },
  };
  return { ctx, fillTexts, dashedLines };
}

function makeDrawContext(series, settingsOverrides = {}, range = [0, series.length], canvasMock = makeCanvasMock()) {
  const settings = { ...fundingRegimeIndicatorDefinition.defaultSettings(), ...settingsOverrides };
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 120 };
  view.colWidth = 10;
  view.offsetX = 0;
  return {
    ctx: canvasMock.ctx,
    view,
    series,
    rect: { top: 0, height: 120 },
    range,
    instance: {
      id: `fr-test-${Math.random()}`,
      type: "funding-regime",
      title: "Funding Regime",
      visible: true,
      paneId: "p-fr",
      order: 0,
      settings,
    },
    settings,
    chart: {
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1h",
      intervalMs: series.config.intervalMs,
    },
    requestRefresh() {},
  };
}

test("migrateFundingExchanges keeps known 4 venues, drops legacy keys, and falls back to all 4 if none left", () => {
  const partial = migrateFundingExchanges({
    binancef: true,
    "binancef-inverse": true,
    bitmexf: true,
    bybitf: false,
    okxf: true,
    hyperliquid: false,
  });
  assert.deepEqual(partial, { binancef: true, bybitf: false, okxf: true, hyperliquid: false });

  const noneKnownLeft = migrateFundingExchanges({
    "binancef-inverse": true,
    bitmexf: true,
    coinbasef: true,
  });
  assert.deepEqual(noneKnownLeft, { binancef: true, bybitf: true, okxf: true, hyperliquid: true });

  const allFalse = migrateFundingExchanges({
    binancef: false,
    bybitf: false,
    okxf: false,
    hyperliquid: false,
    bitmexf: true,
  });
  assert.deepEqual(allFalse, { binancef: true, bybitf: true, okxf: true, hyperliquid: true });
});

test("hourly alignment maps mixed 1h, 4h, and 8h periods to settled rate8h and fills open period with current", () => {
  // 8h period ending at 08:00 covers 00:00..08:00; 08:00..09:00 is open -> current
  const binance8h = {
    venue: "binancef",
    intervalHours: 8,
    settled: [{ t: T0 + 8 * HOUR_MS, rate: 0.0008, intervalHours: 8, rate8h: 0.0008 }],
    current: { t: T0 + 8 * HOUR_MS + 1800_000, rate: 0.0012, rate8h: 0.0012 },
  };
  const h1 = alignVenueSeriesToHourEnd(binance8h, T0 + 1 * HOUR_MS);
  const h8 = alignVenueSeriesToHourEnd(binance8h, T0 + 8 * HOUR_MS);
  const h9Open = alignVenueSeriesToHourEnd(binance8h, T0 + 9 * HOUR_MS);
  assert.equal(h1?.rate8h, 0.0008);
  assert.equal(h1?.isCurrent, false);
  assert.equal(h8?.rate8h, 0.0008);
  assert.equal(h9Open?.rate8h, 0.0012);
  assert.equal(h9Open?.isCurrent, true);

  // Mixed 1h (hyperliquid), 4h (bybitf), 8h (binancef) over 00:00..08:00
  const response = {
    market: "BTCUSDT",
    from: T0,
    to: T0 + 9 * HOUR_MS,
    venues: ["binancef", "bybitf", "hyperliquid"],
    series: [
      binance8h,
      {
        venue: "bybitf",
        intervalHours: 4,
        settled: [
          { t: T0 + 4 * HOUR_MS, rate: 0.0002, intervalHours: 4, rate8h: 0.0004 },
          { t: T0 + 8 * HOUR_MS, rate: 0.0003, intervalHours: 4, rate8h: 0.0006 },
        ],
        current: { t: T0 + 8 * HOUR_MS + 1800_000, rate: 0.0006, rate8h: 0.0012 },
      },
      {
        venue: "hyperliquid",
        intervalHours: 1,
        settled: Array.from({ length: 8 }, (_, k) => ({
          t: T0 + (k + 1) * HOUR_MS,
          rate: 0.00015,
          intervalHours: 1,
          rate8h: 0.0012,
        })),
        current: { t: T0 + 8 * HOUR_MS + 1800_000, rate: 0.00015, rate8h: 0.0012 },
      },
    ],
  };

  const timeline = buildHourlyFundingTimeline(
    response,
    ["binancef", "bybitf", "hyperliquid"],
    "venues",
    T0,
    T0 + 9 * HOUR_MS,
  );
  // Hour ending at 01:00: mean(0.0008, 0.0004, 0.0012) = 0.0008
  assert.ok(Math.abs(timeline[0].fundingRate - 0.0008) < 1e-12);
  // Hour ending at 05:00: mean(0.0008, 0.0006, 0.0012) = 0.0026 / 3
  assert.ok(Math.abs(timeline[4].fundingRate - 0.0026 / 3) < 1e-12);
  // Open hour ending at 09:00: mean(0.0012, 0.0012, 0.0012) = 0.0012
  assert.ok(Math.abs(timeline[8].fundingRate - 0.0012) < 1e-12);
});

test("fundingRegime requests from - zWindowDays warmup, computes zScore before slicing, draws threshold lines & readout", () => {
  const visibleStart = T0 + 30 * DAY_MS;
  const visibleBars = makeSeries(visibleStart, 24, HOUR_MS); // 24 visible 1h bars
  const requests = [];

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => {
      throw new Error("unused");
    },
    requestVenueFundingSeries: (input) => {
      requests.push(input);
      const points = [];
      for (let t = input.from + HOUR_MS; t <= input.to; t += HOUR_MS) {
        const hourIndex = Math.round((t - input.from) / HOUR_MS);
        points.push({
          t,
          rate8h: 0.0001 + Math.sin(hourIndex / 8) * 0.00004 + (t > visibleStart ? 0.00015 : 0),
          venues: input.venues,
        });
      }
      return {
        status: "ready",
        data: {
          market: input.market,
          from: input.from,
          to: input.to,
          venues: input.venues,
          series: [],
          aggregate: {
            points,
            current: { t: input.to, rate8h: 0.00025, venues: input.venues },
            excludedVenues: ["okxf"],
            source: "backend-oi",
          },
        },
      };
    },
  });

  const canvasMock = makeCanvasMock();
  const ctx = makeDrawContext(
    visibleBars,
    { mode: "zScore", zWindowDays: 30, zThreshold: 2, showAxisTicks: false },
    [0, 24],
    canvasMock,
  );
  const prepared = fundingRegimeIndicatorDefinition.prepareData(ctx);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].from, visibleStart - 30 * DAY_MS, "must request 30-day warmup before visible from");
  assert.equal(prepared.status, "ok");
  assert.equal(prepared.meta.insufficientData, false);
  assert.ok(prepared.points.every((p) => Number.isFinite(p.value)), "all visible bars must have finite z-score from warmup");

  fundingRegimeIndicatorDefinition.drawSubPane(ctx, prepared);
  assert.equal(canvasMock.dashedLines.length, 2, "must draw +zThreshold and -zThreshold dashed lines");

  const readout = fundingRegimeIndicatorDefinition.getReadout(ctx, prepared, null);
  assert.ok(readout);
  const labels = readout.items.map((item) => item.label);
  assert.ok(labels.includes("Z"));
  assert.ok(labels.includes("rate8h"));
  assert.ok(labels.includes("ort"));
  assert.ok(labels.includes("borsa"));
  assert.ok(labels.includes("haric"));
  assert.ok(labels.includes("src"));
});

test("fundingRegime hides line and shows yetersiz veri badge when < 7 days of data", () => {
  const visibleStart = T0 + 3 * DAY_MS;
  const visibleBars = makeSeries(visibleStart, 10, HOUR_MS);

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => {
      throw new Error("unused");
    },
    requestVenueFundingSeries: (input) => ({
      status: "ready",
      data: {
        market: input.market,
        from: input.from,
        to: input.to,
        venues: input.venues,
        series: [
          {
            venue: "binancef",
            intervalHours: 8,
            settled: [
              { t: visibleStart + 8 * HOUR_MS, rate: 0.0001, intervalHours: 8, rate8h: 0.0001 },
            ],
            current: { t: visibleStart + 9 * HOUR_MS, rate: 0.0002, rate8h: 0.0002 },
          },
        ],
      },
    }),
  });

  const canvasMock = makeCanvasMock();
  const ctx = makeDrawContext(visibleBars, { mode: "zScore", zWindowDays: 30 }, [0, 10], canvasMock);
  const prepared = fundingRegimeIndicatorDefinition.prepareData(ctx);
  assert.equal(prepared.status, "ok");
  assert.equal(prepared.meta.insufficientData, true);

  fundingRegimeIndicatorDefinition.drawSubPane(ctx, prepared);
  assert.ok(
    canvasMock.fillTexts.some((entry) => entry.text.includes("yetersiz veri")),
    "must show yetersiz veri badge when span < 7 days",
  );
  assert.equal(canvasMock.dashedLines.length, 0, "must not draw threshold/z-score plot when insufficient data");
});

test("fundingRegime settingsSchema exposes expected mode labels", () => {
  const dataSection = fundingRegimeIndicatorDefinition.settingsSchema.sections.find((s) => s.title === "Data");
  const modeField = dataSection?.fields.find((f) => f.key === "mode");
  assert.ok(modeField && modeField.kind === "select");
  const labels = modeField.options.map((o) => o.label);
  assert.deepEqual(labels, ["Z-Score", "Ödenmiş", "Anlık tahmin", "Anlık − Son ödenen"]);
});

function buildFourVenueSettledSeries(fromMs, toMs, rateFn) {
  const venues = [
    { venue: "binancef", intervalHours: 8 },
    { venue: "bybitf", intervalHours: 4 },
    { venue: "okxf", intervalHours: 8 },
    { venue: "hyperliquid", intervalHours: 1 },
  ];
  return venues.map(({ venue, intervalHours }) => {
    const stepMs = intervalHours * HOUR_MS;
    const settled = [];
    for (let t = fromMs + stepMs; t <= toMs; t += stepMs) {
      const hourIndex = Math.round((t - fromMs) / HOUR_MS);
      const rate8h = rateFn(hourIndex, t);
      settled.push({
        t,
        rate: rate8h * (intervalHours / 8),
        intervalHours,
        rate8h,
      });
    }
    const lastRate8h = settled[settled.length - 1]?.rate8h ?? 0.0001;
    return {
      venue,
      intervalHours,
      settled,
      current: { t: toMs, rate: lastRate8h * (intervalHours / 8), rate8h: lastRate8h },
    };
  });
}

test("fundingRegime falls back to 30-day 4-venue settled series when aggregate covers < 7 days (CE #402)", () => {
  const visibleStart = T0 + 30 * DAY_MS;
  const visibleBars = makeSeries(visibleStart, 24, HOUR_MS);

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => {
      throw new Error("unused");
    },
    requestVenueFundingSeries: (input) => {
      const aggPoints = [];
      for (let t = input.to - 2 * HOUR_MS; t <= input.to; t += HOUR_MS) {
        aggPoints.push({ t, rate8h: 0.0002, venues: input.venues });
      }
      return {
        status: "ready",
        data: {
          market: input.market,
          from: input.from,
          to: input.to,
          venues: input.venues,
          series: buildFourVenueSettledSeries(
            input.from,
            input.to,
            (hourIndex, t) => 0.0001 + Math.sin(hourIndex / 8) * 0.00004 + (t > visibleStart ? 0.00015 : 0),
          ),
          aggregate: {
            points: aggPoints,
            current: { t: input.to, rate8h: 0.00025, venues: input.venues },
            excludedVenues: [],
            source: "backend-oi",
          },
        },
      };
    },
  });

  const canvasMock = makeCanvasMock();
  const ctx = makeDrawContext(
    visibleBars,
    { mode: "zScore", zSource: "aggregate", zWindowDays: 30, zThreshold: 2, showAxisTicks: false },
    [0, 24],
    canvasMock,
  );
  const prepared = fundingRegimeIndicatorDefinition.prepareData(ctx);

  assert.equal(prepared.status, "ok");
  assert.equal(prepared.meta.insufficientData, false);
  assert.equal(prepared.points.length, 24);
  assert.ok(prepared.points.every((p) => Number.isFinite(p.zScore) && !p.insufficientData));

  fundingRegimeIndicatorDefinition.drawSubPane(ctx, prepared);
  assert.equal(canvasMock.dashedLines.length, 2);
});

test("fundingRegime keeps aggregate path when aggregate covers >= 7 days (CE #402)", () => {
  const fromMs = T0;
  const toMs = T0 + 10 * DAY_MS;
  const aggPoints = [];
  for (let t = fromMs + HOUR_MS; t <= toMs; t += HOUR_MS) {
    aggPoints.push({ t, rate8h: 0.0005, venues: ["binancef", "bybitf", "okxf", "hyperliquid"] });
  }

  const response = {
    market: "BTCUSDT",
    from: fromMs,
    to: toMs,
    venues: ["binancef", "bybitf", "okxf", "hyperliquid"],
    series: buildFourVenueSettledSeries(fromMs, toMs, () => 0.0001),
    aggregate: {
      points: aggPoints,
      current: { t: toMs, rate8h: 0.0005, venues: ["binancef", "bybitf", "okxf", "hyperliquid"] },
      excludedVenues: [],
      source: "backend-oi",
    },
  };

  const timeline = buildHourlyFundingTimeline(
    response,
    ["binancef", "bybitf", "okxf", "hyperliquid"],
    "aggregate",
    fromMs,
    toMs,
  );

  assert.ok(timeline.length > 0);
  assert.ok(timeline.every((pt) => Math.abs(pt.fundingRate - 0.0005) < 1e-12));
});

test("CE #419: fundingRegime computes native hourly z-series only once across 100 revision/range changes", () => {
  resetFundingRegimeCachesForTests();
  const series = makeSeries(T0 + 30 * DAY_MS, 120, HOUR_MS);
  const fromMs = T0;
  const toMs = T0 + 35 * DAY_MS;
  const aggPoints = [];
  for (let t = fromMs + HOUR_MS; t <= toMs; t += HOUR_MS) {
    aggPoints.push({
      t,
      rate8h: 0.0001 + Math.sin(t / HOUR_MS * 0.1) * 0.00005,
      venues: ["binancef", "bybitf", "okxf", "hyperliquid"],
    });
  }

  const response = {
    market: "BTCUSDT",
    from: fromMs,
    to: toMs,
    venues: ["binancef", "bybitf", "okxf", "hyperliquid"],
    series: buildFourVenueSettledSeries(fromMs, toMs, (t) => 0.0001 + Math.sin(t / HOUR_MS * 0.1) * 0.00005),
    aggregate: {
      points: aggPoints,
      current: { t: toMs, rate8h: 0.00012, venues: ["binancef", "bybitf", "okxf", "hyperliquid"] },
      excludedVenues: [],
      source: "backend-oi",
    },
  };

  configureIndicatorDataSource({
    requestVenueFundingSeries: () => ({ status: "ready", data: response }),
  });

  const baseline = fundingRegimeIndicatorDefinition.prepareData(
    makeDrawContext(series, { mode: "zScore" }, [20, 100]),
  );
  assert.equal(baseline.status, "ok");
  assert.equal(getFundingRegimeNativeCacheStats().computes, 1);

  for (let i = 0; i < 100; i += 1) {
    series.addTrade({
      id: `fr-live-${i}`,
      time: T0 + 30 * DAY_MS + 119 * HOUR_MS + i * 1_000,
      price: 100 + (i % 5),
      qty: 1,
      isBuy: i % 2 === 0,
    });
    const from = 10 + (i % 15);
    const to = from + 60;
    const prepared = fundingRegimeIndicatorDefinition.prepareData(
      makeDrawContext(series, { mode: "zScore" }, [from, to]),
    );
    assert.equal(prepared.status, "ok");
    if (from === 20 && to === 80) {
      const baseByIdx = new Map(baseline.points.map((p) => [p.index, p.zScore]));
      for (const pt of prepared.points) {
        assert.equal(pt.zScore, baseByIdx.get(pt.index));
      }
    }
  }

  const stats = getFundingRegimeNativeCacheStats();
  assert.equal(stats.computes, 1);
  assert.equal(stats.hits, 100);
});

test("CE #419: fundingRegime WeakMap cache never collides across different-market responses with identical t grids", () => {
  resetFundingRegimeCachesForTests();
  const series = makeSeries(T0 + 30 * DAY_MS, 120, HOUR_MS);
  const fromMs = T0;
  const toMs = T0 + 35 * DAY_MS;

  const makeAgg = (rateFn) => {
    const pts = [];
    for (let t = fromMs + HOUR_MS; t <= toMs; t += HOUR_MS) {
      pts.push({
        t,
        rate8h: rateFn(t),
        venues: ["binancef", "bybitf", "okxf", "hyperliquid"],
      });
    }
    return pts;
  };

  const rateA = (t) => 0.0001 + Math.sin(t / HOUR_MS * 0.1) * 0.00005;
  const rateB = (t) => -0.0003 + Math.cos(t / HOUR_MS * 0.23) * 0.00018;

  const responseA = {
    market: "BTCUSDT",
    from: fromMs,
    to: toMs,
    venues: ["binancef", "bybitf", "okxf", "hyperliquid"],
    series: buildFourVenueSettledSeries(fromMs, toMs, rateA),
    aggregate: {
      points: makeAgg(rateA),
      current: { t: toMs, rate8h: 0.00012, venues: ["binancef", "bybitf", "okxf", "hyperliquid"] },
      excludedVenues: [],
      source: "backend-oi",
    },
  };
  const responseB = {
    market: "ETHUSDT",
    from: fromMs,
    to: toMs,
    venues: ["binancef", "bybitf", "okxf", "hyperliquid"],
    series: buildFourVenueSettledSeries(fromMs, toMs, rateB),
    aggregate: {
      points: makeAgg(rateB),
      current: { t: toMs, rate8h: -0.00045, venues: ["binancef", "bybitf", "okxf", "hyperliquid"] },
      excludedVenues: [],
      source: "backend-oi",
    },
  };

  let activeResponse = responseB;
  configureIndicatorDataSource({
    requestVenueFundingSeries: () => ({ status: "ready", data: activeResponse }),
  });

  const ctx = makeDrawContext(series, { mode: "zScore" }, [20, 100]);
  const uncachedB = fundingRegimeIndicatorDefinition.prepareData(ctx);
  assert.equal(uncachedB.status, "ok");

  resetFundingRegimeCachesForTests();
  activeResponse = responseA;
  const preparedA = fundingRegimeIndicatorDefinition.prepareData(ctx);
  assert.equal(preparedA.status, "ok");

  activeResponse = responseB;
  const cachedPathB = fundingRegimeIndicatorDefinition.prepareData(ctx);
  assert.equal(cachedPathB.status, "ok");
  assert.deepEqual(
    cachedPathB.points.map((p) => p.zScore),
    uncachedB.points.map((p) => p.zScore),
  );
  assert.equal(getFundingRegimeNativeCacheStats().computes, 2);
});

test("CE #419: fundingRegime updates z-score immediately when current.rate8h changes with the same t", () => {
  resetFundingRegimeCachesForTests();
  const series = makeSeries(T0 + 30 * DAY_MS, 120, HOUR_MS);
  const fromMs = T0;
  const toMs = T0 + 35 * DAY_MS;
  const aggPoints = [];
  for (let t = fromMs + HOUR_MS; t <= toMs; t += HOUR_MS) {
    aggPoints.push({
      t,
      rate8h: 0.0001 + Math.sin(t / HOUR_MS * 0.1) * 0.00005,
      venues: ["binancef", "bybitf", "okxf", "hyperliquid"],
    });
  }

  const response = {
    market: "BTCUSDT",
    from: fromMs,
    to: toMs,
    venues: ["binancef", "bybitf", "okxf", "hyperliquid"],
    series: buildFourVenueSettledSeries(fromMs, toMs, (t) => 0.0001 + Math.sin(t / HOUR_MS * 0.1) * 0.00005),
    aggregate: {
      points: aggPoints,
      current: { t: toMs, rate8h: 0.0001, venues: ["binancef", "bybitf", "okxf", "hyperliquid"] },
      excludedVenues: [],
      source: "backend-oi",
    },
  };

  configureIndicatorDataSource({
    requestVenueFundingSeries: () => ({ status: "ready", data: response }),
  });

  const ctx = makeDrawContext(series, { mode: "zScore", zSource: "venues" }, [20, 120]);
  const first = fundingRegimeIndicatorDefinition.prepareData(ctx);
  assert.equal(first.status, "ok");
  const lastFirst = first.points.filter((p) => Number.isFinite(p.zScore)).at(-1);
  assert.ok(lastFirst);

  // Mutate current.rate8h on binancef with the exact same timestamp t.
  response.series[0].current = { t: response.series[0].current.t, rate8h: 0.0015 };
  const updated = fundingRegimeIndicatorDefinition.prepareData(ctx);
  assert.equal(updated.status, "ok");
  const lastUpdated = updated.points.filter((p) => Number.isFinite(p.zScore)).at(-1);
  assert.ok(lastUpdated);
  assert.notEqual(lastUpdated.zScore, lastFirst.zScore);
  assert.equal(getFundingRegimeNativeCacheStats().computes, 2);
});

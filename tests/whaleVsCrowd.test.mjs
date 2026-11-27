import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { View } = await import("../dist/core/engine/view.js");
const { rollingZScore, DAY_MS, DEFAULT_ZSCORE_MIN_SPAN_MS } = await import("../dist/core/analysis/rollingZScore.js");
const { chartLocale, configureChartLocale } = await import("../dist/core/chartLocale.js");
const { configureIndicatorDataSource } = await import("../dist/features/indicators/indicatorDataSource.js");
const {
  computeWhaleCrowdSpread,
  computeVenueNativeZSeries,
  getWhaleCrowdNativeCacheStats,
  resetWhaleCrowdCachesForTests,
  whaleVsCrowdIndicatorDefinition,
} = await import("../dist/features/indicators/builtins/whaleVsCrowd.js");
const { fundingRegimeIndicatorDefinition } = await import("../dist/features/indicators/builtins/fundingRegime.js");
const { liquidationProfileIndicatorDefinition } = await import("../dist/features/indicators/builtins/liquidationProfile.js");
const { liveTradeBubblesIndicatorDefinition } = await import("../dist/features/indicators/builtins/liveTradeBubbles.js");

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeSeries(startTime, count, intervalMs = HOUR_MS) {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(
    Array.from({ length: count }, (_, i) => ({
      startTime: startTime + i * intervalMs,
      open: 90_000,
      high: 90_100,
      low: 89_900,
      close: 90_050,
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
  const strokes = [];
  let currentDash = [];
  let currentStrokeStyle = "";
  let path = [];
  const ctx = {
    font: "",
    fillStyle: "",
    get strokeStyle() {
      return currentStrokeStyle;
    },
    set strokeStyle(v) {
      currentStrokeStyle = String(v);
    },
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
        dashedLines.push({ y: path[0].y, dash: [...currentDash], color: currentStrokeStyle });
      } else if (path.length > 0) {
        strokes.push({ color: currentStrokeStyle, ops: path.map((p) => ({ ...p })) });
      }
    },
    fillRect() {},
    strokeRect() {},
    roundRect() {},
    fill() {},
    measureText(text) {
      return { width: String(text).length * 5 };
    },
    fillText(text, x, y) {
      fillTexts.push({ text: String(text), x, y });
    },
  };
  return { ctx, fillTexts, dashedLines, strokes };
}

function makeDrawContext(series, settingsOverrides = {}, range = [0, series.length], canvasMock = makeCanvasMock()) {
  const settings = { ...whaleVsCrowdIndicatorDefinition.defaultSettings(), ...settingsOverrides };
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 132 };
  view.colWidth = 10;
  view.offsetX = 0;
  return {
    ctx: canvasMock.ctx,
    view,
    series,
    rect: { top: 0, height: 132 },
    range,
    instance: {
      id: `wc-test-${Math.random()}`,
      type: "whale-vs-crowd",
      title: "Whale vs Crowd",
      visible: true,
      paneId: "p-wc",
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

function buildVenuePoints({ startMs, count, stepMs, whaleFn, crowdFn, resolution }) {
  return Array.from({ length: count }, (_, i) => {
    const t = startMs + (i + 1) * stepMs;
    return {
      t,
      whaleRatio: whaleFn(i, t),
      crowdRatio: crowdFn(i, t),
      resolution,
      source: "backend",
    };
  });
}

test("whaleVsCrowd settings schema and defaults match specification", () => {
  assert.equal(whaleVsCrowdIndicatorDefinition.type, "whale-vs-crowd");
  assert.equal(whaleVsCrowdIndicatorDefinition.defaultPane, "separate");
  assert.equal(whaleVsCrowdIndicatorDefinition.paneHeight, 132);
  assert.equal(whaleVsCrowdIndicatorDefinition.category, "derivatives");

  const defaults = whaleVsCrowdIndicatorDefinition.defaultSettings();
  assert.equal(defaults.mode, "zScore");
  assert.equal(defaults.zWindowDays, 30);
  assert.equal(defaults.zThreshold, 2);
  assert.equal(defaults.venueBinance, true);
  assert.equal(defaults.venueOkx, true);
  assert.equal(defaults.venueHyperliquid, true);
  assert.notEqual(defaults.binanceColor, defaults.okxColor);
  assert.notEqual(defaults.binanceColor, defaults.hyperliquidColor);
  assert.notEqual(defaults.okxColor, defaults.hyperliquidColor);

  const fields = whaleVsCrowdIndicatorDefinition.settingsSchema.sections.flatMap((s) => s.fields);
  const modeField = fields.find((f) => f.key === "mode");
  assert.deepEqual(modeField?.options?.map((o) => o.value), ["zScore", "spread", "ratios"]);
  const zWindowField = fields.find((f) => f.key === "zWindowDays");
  assert.deepEqual({ min: zWindowField?.min, max: zWindowField?.max }, { min: 7, max: 90 });
});

test("computeWhaleCrowdSpread computes ln(whaleRatio) - ln(crowdRatio) and honors precomputed spread", () => {
  const computed = computeWhaleCrowdSpread({ whaleRatio: Math.E * Math.E, crowdRatio: Math.E });
  assert.ok(Math.abs(computed - 1) < 1e-12);

  const precomputed = computeWhaleCrowdSpread({ whaleRatio: 2, crowdRatio: 1, spread: 0.42 });
  assert.equal(precomputed, 0.42);

  assert.ok(Number.isNaN(computeWhaleCrowdSpread({ whaleRatio: 0, crowdRatio: 1 })));
  assert.ok(Number.isNaN(computeWhaleCrowdSpread({ whaleRatio: 1.2, crowdRatio: null })));
});

test("rollingZScore runs at each venue native cadence (5m/15m) before mapping bar-end values to 1h candles", () => {
  // 10 days of 5m Binance + 15m Hyperliquid data
  const totalDays = 10;
  const startMs = T0;
  const binance5m = buildVenuePoints({
    startMs,
    count: (totalDays * DAY_MS) / (5 * MIN_MS),
    stepMs: 5 * MIN_MS,
    resolution: "5m",
    whaleFn: (i) => 1.5 + 0.3 * Math.sin(i / 12),
    crowdFn: (i) => 1.0 + 0.1 * Math.cos(i / 17),
  });
  const hl15m = buildVenuePoints({
    startMs,
    count: (totalDays * DAY_MS) / (15 * MIN_MS),
    stepMs: 15 * MIN_MS,
    resolution: "15m",
    whaleFn: (i) => 1.2 + 0.2 * Math.sin(i / 7),
    crowdFn: (i) => 0.9 + 0.08 * Math.cos(i / 9),
  });

  // Verify parity with direct rollingZScore at native cadence
  const directBinance = rollingZScore(
    binance5m.map((p) => ({ t: p.t, value: Math.log(p.whaleRatio) - Math.log(p.crowdRatio) })),
    { windowMs: 30 * DAY_MS, minSpanMs: DEFAULT_ZSCORE_MIN_SPAN_MS },
  );
  const nativeBinance = computeVenueNativeZSeries(
    { venue: "binance", status: "ready", points: binance5m },
    30,
  );
  assert.equal(nativeBinance.points.length, directBinance.length);
  const lastIdx = directBinance.length - 1;
  assert.ok(Math.abs(nativeBinance.points[lastIdx].zScore - directBinance[lastIdx].zScore) < 1e-12);

  // Map onto 1h chart candles covering day 9..10
  const chartStart = startMs + 9 * DAY_MS;
  const series = makeSeries(chartStart, 24, HOUR_MS);
  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => { throw new Error("unused"); },
    requestWhaleCrowdSeries: () => ({
      status: "ready",
      data: {
        status: "ready",
        source: "backend",
        venues: [
          { venue: "binance", status: "ready", definition: "Top 20% accounts", points: binance5m },
          { venue: "okx", status: "unavailable", points: [] },
          { venue: "hyperliquid", status: "ready", definition: "Notional >= $100k", thresholdUsd: 100_000, points: hl15m },
        ],
      },
    }),
  });

  const ctx = makeDrawContext(series, { showAxisTicks: false });
  const prepared = whaleVsCrowdIndicatorDefinition.prepareData(ctx);
  assert.equal(prepared.status, "ok");

  const bnPoints = prepared.meta.venues.binance.points;
  const hlPoints = prepared.meta.venues.hyperliquid.points;
  assert.equal(bnPoints.length, 24);
  assert.equal(hlPoints.length, 24);

  // Each 1h candle must match the bar-end native point (candleEnd) rather than summing venues
  const firstCandleEnd = chartStart + HOUR_MS;
  const expectedBnFirst = nativeBinance.points.find((p) => p.t === firstCandleEnd);
  assert.ok(expectedBnFirst);
  assert.ok(Math.abs(bnPoints[0].zScore - expectedBnFirst.zScore) < 1e-12);
  assert.notEqual(bnPoints[0].zScore, hlPoints[0].zScore);
});

test("warming (< 7 days) suppresses z-score line and emits warming badge; unsupported/unavailable emit per-venue badges", () => {
  const startMs = T0;
  // Only 3 days of Binance data -> warming
  const binance3d = buildVenuePoints({
    startMs,
    count: (3 * DAY_MS) / HOUR_MS,
    stepMs: HOUR_MS,
    resolution: "1H",
    whaleFn: (i) => 1.3 + (i % 5) * 0.05,
    crowdFn: () => 1.0,
  });

  const series = makeSeries(startMs + 2 * DAY_MS, 24, HOUR_MS);
  const canvasMock = makeCanvasMock();

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => { throw new Error("unused"); },
    requestWhaleCrowdSeries: () => ({
      status: "ready",
      data: {
        status: "ready",
        source: "browser",
        venues: [
          { venue: "binance", status: "warming", historyStartedAt: startMs, points: binance3d },
          { venue: "okx", status: "unsupported", points: [] },
          { venue: "hyperliquid", status: "unavailable", points: [] },
        ],
      },
    }),
  });

  const ctx = makeDrawContext(series, { showAxisTicks: false }, [0, 24], canvasMock);
  const prepared = whaleVsCrowdIndicatorDefinition.prepareData(ctx);
  assert.equal(prepared.status, "ok");
  assert.equal(prepared.meta.venues.binance.isWarming, true);
  assert.equal(prepared.meta.venues.binance.points.every((p) => Number.isNaN(p.zScore)), true);

  const badgeTexts = prepared.meta.badges.map((b) => b.text);
  assert.ok(
    badgeTexts.some((t) => /(?:ısınıyor \(3\/30 gün\)|warming \(3\/30d\))/.test(t)),
    `Expected warming badge in: ${badgeTexts.join(" | ")}`,
  );
  assert.ok(
    badgeTexts.some((t) => /OKX: (?:desteklenmiyor|unsupported)/.test(t)),
    `Expected OKX unsupported badge in: ${badgeTexts.join(" | ")}`,
  );
  assert.ok(
    badgeTexts.some((t) => /Hyperliquid (?:kalabalık verisi yok|crowd data unavailable)/.test(t)),
    `Expected HL unavailable badge in: ${badgeTexts.join(" | ")}`,
  );

  whaleVsCrowdIndicatorDefinition.drawSubPane(ctx, prepared);
  // Only baseline + +/-2 threshold lines should be drawn (no venue z-score polylines)
  assert.equal(canvasMock.dashedLines.length, 2);
  const renderedTexts = canvasMock.fillTexts.map((f) => f.text);
  assert.ok(renderedTexts.some((t) => /(?:ısınıyor|warming)/.test(t)));
  assert.ok(renderedTexts.some((t) => /Hyperliquid/.test(t)));
});

test("gaps break lines without interpolation and readout surfaces backend definition & thresholdUsd", () => {
  const startMs = T0;
  const totalDays = 10;
  const binancePoints = buildVenuePoints({
    startMs,
    count: (totalDays * DAY_MS) / HOUR_MS,
    stepMs: HOUR_MS,
    resolution: "1H",
    whaleFn: (i) => 1.4 + 0.25 * Math.sin(i / 6),
    crowdFn: (i) => 1.0 + 0.08 * Math.cos(i / 5),
  });

  const viewStart = startMs + 9 * DAY_MS;
  const gapFrom = viewStart + 8 * HOUR_MS;
  const gapTo = viewStart + 12 * HOUR_MS;
  const series = makeSeries(viewStart, 24, HOUR_MS);
  const canvasMock = makeCanvasMock();

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => { throw new Error("unused"); },
    requestWhaleCrowdSeries: () => ({
      status: "ready",
      data: {
        status: "ready",
        source: "backend",
        venues: [
          {
            venue: "binance",
            status: "ready",
            definition: "Top 20% trader margin balance",
            gaps: [{ from: gapFrom, to: gapTo }],
            points: binancePoints,
          },
          {
            venue: "okx",
            status: "ready",
            definition: "OKX elite L/S account ratio",
            points: binancePoints,
          },
          {
            venue: "hyperliquid",
            status: "ready",
            definition: "Address equity >= $250k",
            thresholdUsd: 250_000,
            points: binancePoints,
          },
        ],
      },
    }),
  });

  const ctx = makeDrawContext(series, { showAxisTicks: false }, [0, 24], canvasMock);
  const prepared = whaleVsCrowdIndicatorDefinition.prepareData(ctx);
  assert.equal(prepared.status, "ok");

  // Binance points inside [gapFrom, gapTo] must be omitted
  const bnTimes = prepared.meta.venues.binance.points.map((p) => p.candleEnd);
  assert.equal(bnTimes.some((t) => t > gapFrom && t <= gapTo), false);

  whaleVsCrowdIndicatorDefinition.drawSubPane(ctx, prepared);
  const binanceColor = ctx.settings.binanceColor;
  const bnStroke = canvasMock.strokes.find((s) => s.color === binanceColor);
  assert.ok(bnStroke, "Expected Binance stroke");
  const moveTos = bnStroke.ops.filter((op) => op.op === "moveTo");
  assert.ok(moveTos.length >= 2, `Expected line break (moveTo >= 2) across gap, got ${moveTos.length}`);

  const readout = whaleVsCrowdIndicatorDefinition.getReadout(ctx, prepared, 20);
  assert.ok(readout);
  const bnItem = readout.items.find((i) => i.label === "BN");
  const hlItem = readout.items.find((i) => i.label === "HL");
  assert.ok(bnItem?.value.includes("Top 20% trader margin balance"));
  assert.ok(hlItem?.value.includes("Address equity >= $250k"));
  assert.ok(hlItem?.value.includes("$250.0K"));
});

test("all number schema fields in recent indicators match defaultSettings min/max/step constraints (FE #1213)", () => {
  const definitions = [
    whaleVsCrowdIndicatorDefinition,
    fundingRegimeIndicatorDefinition,
    liquidationProfileIndicatorDefinition,
    liveTradeBubblesIndicatorDefinition,
  ];

  for (const def of definitions) {
    const defaults = def.defaultSettings();
    const numberFields = def.settingsSchema.sections
      .flatMap((section) => section.fields)
      .filter((field) => field.kind === "number");

    for (const field of numberFields) {
      const value = defaults[field.key];
      assert.equal(
        typeof value === "number" && Number.isFinite(value),
        true,
        `${def.type}.${field.key} default must be a finite number`,
      );
      if (field.min !== undefined) {
        assert.ok(value >= field.min, `${def.type}.${field.key} default ${value} < min ${field.min}`);
      }
      if (field.max !== undefined) {
        assert.ok(value <= field.max, `${def.type}.${field.key} default ${value} > max ${field.max}`);
      }
      if (field.step !== undefined && field.step > 0) {
        const base = field.min ?? 0;
        const steps = (value - base) / field.step;
        assert.ok(
          Math.abs(steps - Math.round(steps)) < 1e-9,
          `${def.type}.${field.key} default ${value} is not aligned with min ${base} and step ${field.step}`,
        );
      }
    }
  }
});

test("whaleVsCrowd renders localized TR/EN disabled venue badge (FE #1210)", () => {
  const startMs = T0;
  const binancePoints = buildVenuePoints({
    startMs,
    count: (10 * DAY_MS) / HOUR_MS,
    stepMs: HOUR_MS,
    resolution: "1H",
    whaleFn: (i) => 1.4 + 0.2 * Math.sin(i / 6),
    crowdFn: () => 1.0,
  });
  const series = makeSeries(startMs + 9 * DAY_MS, 24, HOUR_MS);

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => { throw new Error("unused"); },
    requestWhaleCrowdSeries: () => ({
      status: "ready",
      data: {
        status: "ready",
        source: "backend",
        venues: [
          { venue: "binance", status: "ready", points: binancePoints },
          { venue: "okx", status: "ready", points: binancePoints },
          { venue: "hyperliquid", status: "disabled", points: [] },
        ],
      },
    }),
  });

  let prevLocale = null;
  try {
    prevLocale = chartLocale();
  } catch {}

  try {
    configureChartLocale({
      locale: () => "tr-TR",
      timeZone: () => "UTC",
      translate: (key) => key,
      onLocaleChange: () => () => {},
    });
    const trPrepared = whaleVsCrowdIndicatorDefinition.prepareData(makeDrawContext(series, { showAxisTicks: false }));
    assert.equal(trPrepared.status, "ok");
    const trDisabled = trPrepared.meta.badges.find((b) => b.venue === "hyperliquid" && b.kind === "disabled");
    assert.equal(trDisabled?.text, "Hyperliquid: devre dışı");

    configureChartLocale({
      locale: () => "en-US",
      timeZone: () => "UTC",
      translate: (key) => key,
      onLocaleChange: () => () => {},
    });
    const enPrepared = whaleVsCrowdIndicatorDefinition.prepareData(makeDrawContext(series, { showAxisTicks: false }));
    assert.equal(enPrepared.status, "ok");
    const enDisabled = enPrepared.meta.badges.find((b) => b.venue === "hyperliquid" && b.kind === "disabled");
    assert.equal(enDisabled?.text, "Hyperliquid: disabled");
  } finally {
    if (prevLocale) configureChartLocale(prevLocale);
  }
});

test("CE #419: whaleVsCrowd computes native z-series only once across 100 revision/range changes", () => {
  resetWhaleCrowdCachesForTests();
  const series = makeSeries(T0, 120, HOUR_MS);
  const points = buildVenuePoints({
    startMs: T0 - 30 * DAY_MS,
    count: 30 * 24 + 120,
    stepMs: HOUR_MS,
    whaleFn: (i) => 1.2 + Math.sin(i * 0.15) * 0.3,
    crowdFn: (i) => 0.9 + Math.cos(i * 0.1) * 0.2,
    resolution: "1h",
  });
  const response = {
    status: "ready",
    source: "coinalyze",
    venues: [
      { venue: "binance", status: "ready", points },
      { venue: "okx", status: "ready", points },
      { venue: "hyperliquid", status: "disabled", points: [] },
    ],
  };

  configureIndicatorDataSource({
    requestWhaleCrowdSeries: () => ({ status: "ready", data: response }),
  });

  const baseline = whaleVsCrowdIndicatorDefinition.prepareData(
    makeDrawContext(series, { mode: "zScore", venueHyperliquid: false }, [20, 100]),
  );
  assert.equal(baseline.status, "ok");
  const statsAfterFirst = getWhaleCrowdNativeCacheStats();
  assert.equal(statsAfterFirst.computes, 2); // binance + okx computed once

  // Run 100 prepareData calls with changing series.revision and changing visible range.
  for (let i = 0; i < 100; i += 1) {
    series.updateLastTrade(90_050 + (i % 7), 0.1);
    const from = 10 + (i % 15);
    const to = from + 60;
    const prepared = whaleVsCrowdIndicatorDefinition.prepareData(
      makeDrawContext(series, { mode: "zScore", venueHyperliquid: false }, [from, to]),
    );
    assert.equal(prepared.status, "ok");
    if (from === 20 && to === 80) {
      // Same visible bars must produce identical z-scores.
      const baseByIdx = new Map(baseline.meta.venues.binance.points.map((p) => [p.index, p.zScore]));
      for (const pt of prepared.meta.venues.binance.points) {
        assert.equal(pt.zScore, baseByIdx.get(pt.index));
      }
    }
  }

  const statsAfter100 = getWhaleCrowdNativeCacheStats();
  assert.equal(statsAfter100.computes, 2);
  assert.equal(statsAfter100.hits, 200);
});

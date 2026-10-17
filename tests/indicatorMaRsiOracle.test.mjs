// T06-A (issue #317): MA/RSI independent math oracle and dependency mask.
//
// Given hand-calculated SMA, EMA and Wilder RSI fixtures (literal fractions worked
// out on paper, not produced by the code under test), When the real indicator
// prepareData runs through its full, tail, non-tail, append, reset, metadata
// (footprint-only) and settings paths, Then every plotted value equals the literal
// oracle and the telemetry counters show which path ran: price-only changes reuse
// incremental state, footprint-only changes recompute nothing, and unsupported
// cases (RSI tail before the Wilder seed, higher-timeframe MA) fall back to a full
// rebuild. A later sentinel bar never changes an earlier plotted value (no
// look-ahead). Full-vs-incremental parity lives in indicatorIncrementalPrepare.test.mjs
// and is extra evidence only; it is not the oracle here.
import test from "node:test";
import assert from "node:assert/strict";
// Some dist modules read Svelte runes at import time; stub them so this file also
// runs on its own and not only after another test file installed the stub.
globalThis.$state ??= (value) => value;
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { movingAverageIndicatorDefinition } = await import("../dist/features/indicators/builtins/movingAverage.js");
const { rsiIndicatorDefinition } = await import("../dist/features/indicators/builtins/rsi.js");
const { indicatorPriceSeriesMutation, indicatorSeriesMutation } = await import("../dist/features/indicators/seriesMutationSummary.js");
const {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} = await import("../dist/core/performanceTelemetry.js");

const T0 = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const DAY = 86_400_000;
const EPS = 1e-9;
// Fixtures are written in small units and placed at OFFSET so a few-unit move stays
// inside FootprintSeries' 0.3 % reference-outlier guard. RSI only sees differences,
// so its oracle is unchanged; SMA/EMA weights sum to 1, so their oracle shifts by OFFSET.
const OFFSET = 10_000;
const P = (x) => OFFSET + x;
const shifted = (values) => values.map((value) => value === null ? null : P(value));

// closes          10   11   10   12   11   13
// diff                 +1   -1   +2   -1   +2
const BASE_CLOSES = [10, 11, 10, 12, 11, 13];

function bars(closes, intervalMs = MINUTE) {
  return closes.map((unit, index) => {
    const close = P(unit);
    return {
    startTime: T0 + index * intervalMs,
    open: close, high: close + 1, low: close - 1, close,
    volume: 10, delta: 0, count: 1,
    cells: new Map(), hasRef: true, cellRevision: 0,
    };
  });
}

function loadSeries(closes, intervalMs = MINUTE) {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(bars(closes, intervalMs));
  assert.deepEqual(series.listReadonly().map((bar) => bar.close), closes.map(P));
  return series;
}

let instanceSeq = 0;
function makeContext(series, definition, overrides) {
  const settings = { ...definition.defaultSettings(), ...overrides };
  return {
    ctx: {}, view: {}, series, rect: { top: 0, height: 100 }, range: [0, series.length],
    instance: { id: `${definition.type}-oracle`, type: definition.type, title: definition.type, visible: true, paneId: "p", order: 0, settings, seq: ++instanceSeq },
    settings, requestRefresh() {},
  };
}

/** Mirrors IndicatorManager.updateSettings: a settings edit yields a new instance object. */
function withSettings(ctx, overrides) {
  const settings = { ...ctx.settings, ...overrides };
  ctx.settings = settings;
  ctx.instance = { ...ctx.instance, settings, seq: ++instanceSeq };
}

function smaLine(id, period, extra = {}) {
  return { id, method: "sma", period, timeframe: "chart", color: "#44aaff", enabled: true, ...extra };
}

function emaLine(id, period, extra = {}) {
  return { id, method: "ema", period, timeframe: "chart", color: "#ffaa44", enabled: true, ...extra };
}

function assertValues(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === null) {
      assert.equal(actual[i], null, `${label}[${i}] must be null`);
    } else {
      assert.ok(Number.isFinite(actual[i]) && Math.abs(actual[i] - expected[i]) < EPS,
        `${label}[${i}]: expected ${expected[i]}, got ${actual[i]}`);
    }
  }
}

function plotValues(prepared, plotIndex = 0) {
  assert.equal(prepared.status, "ok");
  return prepared.meta.series[plotIndex].points.map((point) => point.value);
}

/** Runs `work` with telemetry on and returns the counters it bumped. */
function countersDuring(work) {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const before = snapshotPerformanceTelemetry().counters;
    const result = work();
    const after = snapshotPerformanceTelemetry().counters;
    const delta = {};
    for (const [name, value] of Object.entries(after)) {
      const diff = value - (before[name] ?? 0);
      if (diff !== 0 && name.startsWith("indicator.incremental.")) delta[name] = diff;
    }
    return { result, counters: delta };
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
}

function enrichedBars(closes) {
  return bars(closes).map((bar) => ({
    ...bar,
    delta: 3,
    count: 7,
    sources: ["history-enriched"],
    cells: new Map([[bar.close, { priceBin: bar.close, buyVol: 6, sellVol: 4, count: 7, buyCount: 4, sellCount: 3, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
    cellRevision: 1,
  }));
}

// --- Oracles (hand-calculated) ------------------------------------------------------
//
// SMA(3) of 10 11 10 12 11 13: -, -, 31/3, 33/3, 33/3, 36/3.
const SMA3_BASE = [null, null, 31 / 3, 11, 11, 12];
// EMA(2), alpha 2/3, seeded with the SMA of the first two closes:
//   e1 = 21/2, e2 = 10*2/3 + e1/3 = 61/6, e3 = 12*2/3 + e2/3 = 205/18,
//   e4 = 11*2/3 + e3/3 = 601/54, e5 = 13*2/3 + e4/3 = 2005/162.
const EMA2_BASE = [null, 21 / 2, 61 / 6, 205 / 18, 601 / 54, 2005 / 162];
// Wilder RSI(3): gains 1 0 2 0 2, losses 0 1 0 1 0.
//   i3 seed: G = 3/3 = 1, L = 1/3, RS 3 -> 75
//   i4: G = (1*2 + 0)/3 = 2/3, L = (1/3*2 + 1)/3 = 5/9, RS 6/5 -> 600/11
//   i5: G = (2/3*2 + 2)/3 = 10/9, L = (5/9*2 + 0)/3 = 10/27, RS 3 -> 75
const RSI3_BASE = [null, null, null, 75, 600 / 11, 75];

// --- SMA / EMA ---------------------------------------------------------------------

test("T06-A MA full: SMA(3) and EMA(2) match hand-calculated values", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, movingAverageIndicatorDefinition, { lines: [smaLine("sma3", 3), emaLine("ema2", 2)] });
  const { result, counters } = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result, 0), shifted(SMA3_BASE), "SMA3");
  assertValues(plotValues(result, 1), shifted(EMA2_BASE), "EMA2");
  assert.deepEqual(counters, {
    "indicator.incremental.fallback.moving-average.initial": 1,
    "indicator.incremental.full.moving-average": 1,
  });
});

test("T06-A MA tail tick: incremental SMA/EMA tail equals the hand-calculated value", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, movingAverageIndicatorDefinition, { lines: [smaLine("sma3", 3), emaLine("ema2", 2)] });
  movingAverageIndicatorDefinition.prepareData(ctx);
  const structureRevision = series.structureRevision;

  // Live trade moves the last close 13 -> 9.
  series.addTrade({ time: T0 + 5 * MINUTE + 1, price: P(9), qty: 1, isBuy: false });
  assert.equal(series.structureRevision, structureRevision);
  assert.equal(indicatorPriceSeriesMutation(series).kind, "tail");

  const { result, counters } = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  // SMA3 tail: (12 + 11 + 9)/3 = 32/3. EMA2 tail: 9*2/3 + (601/54)/3 = 1573/162.
  assertValues(plotValues(result, 0), shifted([null, null, 31 / 3, 11, 11, 32 / 3]), "SMA3");
  assertValues(plotValues(result, 1), shifted([null, 21 / 2, 61 / 6, 205 / 18, 601 / 54, 1573 / 162]), "EMA2");
  assert.deepEqual(counters, { "indicator.incremental.hit.moving-average": 1 });
});

test("T06-A MA non-tail tick: a middle close change rebuilds the whole SMA/EMA history", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, movingAverageIndicatorDefinition, { lines: [smaLine("sma3", 3), emaLine("ema2", 2)] });
  movingAverageIndicatorDefinition.prepareData(ctx);

  // Late trade moves bar 1 close 11 -> 12: closes 10 12 10 12 11 13.
  series.addTrade({ time: T0 + MINUTE + 1, price: P(12), qty: 1, isBuy: true });
  assert.equal(indicatorPriceSeriesMutation(series).kind, "non-tail");

  const { result, counters } = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  // SMA3: 32/3, 34/3, 33/3, 36/3.
  // EMA2: e1 = 11, e2 = 20/3 + 11/3 = 31/3, e3 = 8 + 31/9 = 103/9,
  //       e4 = 22/3 + 103/27 = 301/27, e5 = 26/3 + 301/81 = 1003/81.
  assertValues(plotValues(result, 0), shifted([null, null, 32 / 3, 34 / 3, 11, 12]), "SMA3");
  assertValues(plotValues(result, 1), shifted([null, 11, 31 / 3, 103 / 9, 301 / 27, 1003 / 81]), "EMA2");
  assert.deepEqual(counters, {
    "indicator.incremental.fallback.moving-average.mutation-non-tail": 1,
    "indicator.incremental.full.moving-average": 1,
  });
});

test("T06-A MA append: a new bar falls back to full and extends with the hand-calculated value", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, movingAverageIndicatorDefinition, { lines: [smaLine("sma3", 3), emaLine("ema2", 2)] });
  movingAverageIndicatorDefinition.prepareData(ctx);

  series.addTrade({ time: T0 + 6 * MINUTE + 1, price: P(15), qty: 1, isBuy: true });
  assert.equal(series.length, 7);
  ctx.range = [0, series.length];

  const { result, counters } = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  // SMA3 tail: (11 + 13 + 15)/3 = 13. EMA2 tail: 15*2/3 + (2005/162)/3 = 6865/486.
  assertValues(plotValues(result, 0), shifted([...SMA3_BASE, 13]), "SMA3");
  assertValues(plotValues(result, 1), shifted([...EMA2_BASE, 6865 / 486]), "EMA2");
  assert.equal(counters["indicator.incremental.full.moving-average"], 1);
  assert.equal(counters["indicator.incremental.hit.moving-average"], undefined);
});

test("T06-A MA reset: clear then reload with new closes recomputes from scratch", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, movingAverageIndicatorDefinition, { lines: [smaLine("sma3", 3)] });
  movingAverageIndicatorDefinition.prepareData(ctx);

  series.clear();
  ctx.range = [0, 0];
  assert.equal(movingAverageIndicatorDefinition.prepareData(ctx).status, "no-data");

  series.loadBars(bars([20, 23, 26, 20]));
  ctx.range = [0, series.length];
  const { result, counters } = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result), shifted([null, null, 23, 23]), "SMA3");
  assert.equal(counters["indicator.incremental.full.moving-average"], 1);
});

test("T06-A MA footprint-only change: enrichment with identical OHLCV recomputes nothing", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, movingAverageIndicatorDefinition, { lines: [smaLine("sma3", 3), emaLine("ema2", 2)] });
  movingAverageIndicatorDefinition.prepareData(ctx);
  const structureRevision = series.structureRevision;

  assert.equal(indicatorSeriesMutation(series).kind, "initial");
  series.replaceRange(T0, T0 + BASE_CLOSES.length * MINUTE, enrichedBars(BASE_CLOSES));
  assert.equal(indicatorSeriesMutation(series).kind, "structure", "footprint-sensitive summary sees the cell change");
  assert.equal(series.structureRevision, structureRevision + 1, "enrichment is a structural footprint change");
  assert.equal(indicatorPriceSeriesMutation(series).kind, "metadata", "price inputs did not change");

  const { result, counters } = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result, 0), shifted(SMA3_BASE), "SMA3");
  assertValues(plotValues(result, 1), shifted(EMA2_BASE), "EMA2");
  assert.deepEqual(counters, { "indicator.incremental.hit.moving-average": 1 });
});

test("T06-A MA settings: a period edit recomputes, a colour-only edit keeps values and repaints", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, movingAverageIndicatorDefinition, { lines: [smaLine("sma", 3)] });
  movingAverageIndicatorDefinition.prepareData(ctx);

  withSettings(ctx, { lines: [smaLine("sma", 2)] });
  const periodEdit = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  // SMA2: 21/2, 21/2, 22/2, 23/2, 24/2.
  assertValues(plotValues(periodEdit.result), shifted([null, 10.5, 10.5, 11, 11.5, 12]), "SMA2");
  assert.deepEqual(periodEdit.counters, {
    "indicator.incremental.fallback.moving-average.settings": 1,
    "indicator.incremental.full.moving-average": 1,
  });

  withSettings(ctx, { lines: [smaLine("sma", 2, { color: "#ff0000" })] });
  const colourEdit = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(colourEdit.result), shifted([null, 10.5, 10.5, 11, 11.5, 12]), "SMA2");
  assert.equal(colourEdit.result.meta.series[0].color, "#ff0000");
});

test("T06-A MA unsupported: a daily-timeframe line never takes the incremental path", () => {
  // Daily bars; a daily SMA(2) is plotted on each bar from completed daily candles
  // that ended at or before that bar opened: bar2 = (10 + 11)/2, bar3 = (11 + 10)/2.
  const series = loadSeries([10, 11, 10, 12], DAY);
  const ctx = makeContext(series, movingAverageIndicatorDefinition, { lines: [smaLine("d2", 2, { timeframe: "daily" })] });
  assertValues(plotValues(movingAverageIndicatorDefinition.prepareData(ctx)), shifted([null, null, 10.5, 10.5]), "daily SMA2");

  series.addTrade({ time: T0 + 3 * DAY + 1, price: P(30), qty: 1, isBuy: true });
  assert.equal(indicatorPriceSeriesMutation(series).kind, "tail");
  const { result, counters } = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result), shifted([null, null, 10.5, 10.5]), "daily SMA2");
  assert.deepEqual(counters, {
    "indicator.incremental.fallback.moving-average.ineligible": 1,
    "indicator.incremental.full.moving-average": 1,
  });
});

// --- Wilder RSI --------------------------------------------------------------------

test("T06-A RSI full: Wilder RSI(3) matches hand-calculated values", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  const { result, counters } = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result), RSI3_BASE, "RSI3");
  assert.deepEqual(counters, {
    "indicator.incremental.fallback.rsi.initial": 1,
    "indicator.incremental.full.rsi": 1,
  });
});

test("T06-A RSI tail tick: incremental Wilder step equals the hand-calculated value", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  rsiIndicatorDefinition.prepareData(ctx);

  // Last close 13 -> 10, so the last change is -1 instead of +2:
  //   G = (2/3*2 + 0)/3 = 4/9, L = (5/9*2 + 1)/3 = 19/27, RS 12/19 -> 1200/31.
  series.addTrade({ time: T0 + 5 * MINUTE + 1, price: P(10), qty: 1, isBuy: false });
  assert.equal(indicatorPriceSeriesMutation(series).kind, "tail");
  const first = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(first.result), [null, null, null, 75, 600 / 11, 1200 / 31], "RSI3");
  assert.deepEqual(first.counters, { "indicator.incremental.hit.rsi": 1 });

  // A second tick on the same bar must restart from bar 4's state, not chain onto
  // the first tick: back to 13 gives the original 75.
  series.addTrade({ time: T0 + 5 * MINUTE + 2, price: P(13), qty: 1, isBuy: true });
  const second = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(second.result), RSI3_BASE, "RSI3");
  assert.deepEqual(second.counters, { "indicator.incremental.hit.rsi": 1 });
});

test("T06-A RSI tail tick with no losses in the window stays at 100 on the incremental path", () => {
  // Rising closes leave the Wilder average loss at exactly 0, so RS is undefined
  // and RSI is 100 by definition; the tail step must not divide by zero.
  const series = loadSeries([10, 11, 12, 13, 14]);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  assertValues(plotValues(rsiIndicatorDefinition.prepareData(ctx)), [null, null, null, 100, 100], "RSI3");

  series.addTrade({ time: T0 + 4 * MINUTE + 1, price: P(16), qty: 1, isBuy: true });
  const { result, counters } = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result), [null, null, null, 100, 100], "RSI3");
  assert.deepEqual(counters, { "indicator.incremental.hit.rsi": 1 });
});

test("T06-A RSI non-tail tick: a middle close change rebuilds the Wilder history", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  rsiIndicatorDefinition.prepareData(ctx);

  // Bar 1 close 11 -> 12: gains 2 0 2 0 2, losses 0 2 0 1 0.
  //   i3 seed: G = 4/3, L = 2/3, RS 2 -> 200/3
  //   i4: G = 8/9, L = 7/9, RS 8/7 -> 160/3
  //   i5: G = 34/27, L = 14/27, RS 17/7 -> 425/6
  series.addTrade({ time: T0 + MINUTE + 1, price: P(12), qty: 1, isBuy: true });
  assert.equal(indicatorPriceSeriesMutation(series).kind, "non-tail");
  const { result, counters } = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result), [null, null, null, 200 / 3, 160 / 3, 425 / 6], "RSI3");
  assert.deepEqual(counters, {
    "indicator.incremental.fallback.rsi.mutation-non-tail": 1,
    "indicator.incremental.full.rsi": 1,
  });
});

test("T06-A RSI append: a new bar falls back to full and extends with the hand-calculated value", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  rsiIndicatorDefinition.prepareData(ctx);

  // New bar closes at 12 (change -1): G = 20/27, L = 47/81, RS 60/47 -> 6000/107.
  series.addTrade({ time: T0 + 6 * MINUTE + 1, price: P(12), qty: 1, isBuy: false });
  assert.equal(series.length, 7);
  ctx.range = [0, series.length];
  const { result, counters } = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result), [...RSI3_BASE, 6000 / 107], "RSI3");
  assert.equal(counters["indicator.incremental.full.rsi"], 1);
  assert.equal(counters["indicator.incremental.hit.rsi"], undefined);
});

test("T06-A RSI reset: clear then reload with new closes recomputes from scratch", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  rsiIndicatorDefinition.prepareData(ctx);

  series.clear();
  series.loadBars(bars([10, 11, 10, 12, 13]));
  ctx.range = [0, series.length];
  // seed i3: G = 1, L = 1/3 -> 75; i4 (+1): G = 1, L = 2/9, RS 9/2 -> 900/11.
  const { result, counters } = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result), [null, null, null, 75, 900 / 11], "RSI3");
  assert.equal(counters["indicator.incremental.full.rsi"], 1);
});

test("T06-A RSI footprint-only change: enrichment with identical OHLCV recomputes nothing", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  rsiIndicatorDefinition.prepareData(ctx);

  assert.equal(indicatorSeriesMutation(series).kind, "initial");
  series.replaceRange(T0, T0 + BASE_CLOSES.length * MINUTE, enrichedBars(BASE_CLOSES));
  assert.equal(indicatorSeriesMutation(series).kind, "structure", "footprint-sensitive summary sees the cell change");
  assert.equal(indicatorPriceSeriesMutation(series).kind, "metadata");

  const { result, counters } = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result), RSI3_BASE, "RSI3");
  assert.deepEqual(counters, { "indicator.incremental.hit.rsi": 1 });
});

test("T06-A RSI settings: a period edit recomputes with the new hand-calculated values", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  rsiIndicatorDefinition.prepareData(ctx);

  // RSI(2): seed i2 G = 1/2, L = 1/2 -> 50; i3 G = 5/4, L = 1/4 -> 250/3;
  //         i4 G = 5/8, L = 5/8 -> 50; i5 G = 21/16, L = 5/16 -> 1050/13.
  withSettings(ctx, { period: 2 });
  const periodEdit = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(periodEdit.result), [null, null, 50, 250 / 3, 50, 1050 / 13], "RSI2");
  assert.deepEqual(periodEdit.counters, {
    "indicator.incremental.fallback.rsi.settings": 1,
    "indicator.incremental.full.rsi": 1,
  });

  withSettings(ctx, { overbought: 80, color: "#ff0000" });
  const styleEdit = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(styleEdit.result), [null, null, 50, 250 / 3, 50, 1050 / 13], "RSI2");
  assert.equal(styleEdit.result.meta.series[0].color, "#ff0000");
});

test("T06-A RSI unsupported: a tail tick on the seed bar falls back to full", () => {
  // Four closes with period 3: bar 3 is the Wilder seed, so there is no previous
  // smoothed state to step from.
  const series = loadSeries([10, 11, 10, 12]);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  assertValues(plotValues(rsiIndicatorDefinition.prepareData(ctx)), [null, null, null, 75], "RSI3");

  // Seed bar close 12 -> 13: gains 1 0 3, losses 0 1 0 -> G = 4/3, L = 1/3, RS 4 -> 80.
  series.addTrade({ time: T0 + 3 * MINUTE + 1, price: P(13), qty: 1, isBuy: true });
  assert.equal(indicatorPriceSeriesMutation(series).kind, "tail");
  const { result, counters } = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(result), [null, null, null, 80], "RSI3");
  assert.deepEqual(counters, {
    "indicator.incremental.fallback.rsi.seed": 1,
    "indicator.incremental.full.rsi": 1,
  });
});

// --- No look-ahead -----------------------------------------------------------------
//
// A value plotted on bar i may only depend on closes 0..i. The prefix is first
// computed with no later bar in the series, then a far-off sentinel bar is appended
// and its close moved by a live tick. Each prefix value must still equal the
// hand-calculated oracle and be bit-identical to the value plotted before the
// sentinel existed; only the sentinel bar itself may carry the sentinel close.
// Sentinel closes stay within FootprintSeries' 0.3 % tick guard around OFFSET.
const SENTINEL = 35;
const SENTINEL_TICK = 40;

function assertPrefixUnchanged(actual, before, label) {
  for (let i = 0; i < before.length; i++) {
    assert.ok(Object.is(actual[i], before[i]), `${label}[${i}] changed after a later bar: ${before[i]} -> ${actual[i]}`);
  }
}

test("T06-A MA no look-ahead: a later sentinel bar leaves every earlier SMA/EMA value untouched", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, movingAverageIndicatorDefinition, { lines: [smaLine("sma3", 3), emaLine("ema2", 2)] });
  const prefix = movingAverageIndicatorDefinition.prepareData(ctx);
  const smaPrefix = plotValues(prefix, 0);
  const emaPrefix = plotValues(prefix, 1);
  assertValues(smaPrefix, shifted(SMA3_BASE), "SMA3 prefix");
  assertValues(emaPrefix, shifted(EMA2_BASE), "EMA2 prefix");

  // Append: closes 10 11 10 12 11 13 | 35.
  //   SMA3 = (11 + 13 + 35)/3 = 59/3. EMA2 = 35*2/3 + (2005/162)/3 = 13345/486.
  series.addTrade({ time: T0 + 6 * MINUTE + 1, price: P(SENTINEL), qty: 1, isBuy: true });
  assert.equal(series.length, BASE_CLOSES.length + 1);
  ctx.range = [0, series.length];
  const appended = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(appended.result, 0), shifted([...SMA3_BASE, 59 / 3]), "SMA3 after sentinel");
  assertValues(plotValues(appended.result, 1), shifted([...EMA2_BASE, 13345 / 486]), "EMA2 after sentinel");
  assertPrefixUnchanged(plotValues(appended.result, 0), smaPrefix, "SMA3");
  assertPrefixUnchanged(plotValues(appended.result, 1), emaPrefix, "EMA2");
  assert.equal(appended.counters["indicator.incremental.full.moving-average"], 1);

  // Tail tick on the sentinel bar 35 -> 40, on the incremental path:
  //   SMA3 = (11 + 13 + 40)/3 = 64/3. EMA2 = 40*2/3 + (2005/162)/3 = 14965/486.
  series.addTrade({ time: T0 + 6 * MINUTE + 2, price: P(SENTINEL_TICK), qty: 1, isBuy: true });
  assert.equal(indicatorPriceSeriesMutation(series).kind, "tail");
  const ticked = countersDuring(() => movingAverageIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(ticked.result, 0), shifted([...SMA3_BASE, 64 / 3]), "SMA3 after tick");
  assertValues(plotValues(ticked.result, 1), shifted([...EMA2_BASE, 14965 / 486]), "EMA2 after tick");
  assertPrefixUnchanged(plotValues(ticked.result, 0), smaPrefix, "SMA3");
  assertPrefixUnchanged(plotValues(ticked.result, 1), emaPrefix, "EMA2");
  assert.deepEqual(ticked.counters, { "indicator.incremental.hit.moving-average": 1 });
});

test("T06-A RSI no look-ahead: a later sentinel bar leaves every earlier Wilder RSI value untouched", () => {
  const series = loadSeries(BASE_CLOSES);
  const ctx = makeContext(series, rsiIndicatorDefinition, { period: 3 });
  const rsiPrefix = plotValues(rsiIndicatorDefinition.prepareData(ctx));
  assertValues(rsiPrefix, RSI3_BASE, "RSI3 prefix");

  // Append 35 (change +22): G = (10/9*2 + 22)/3 = 218/27, L = (10/27*2 + 0)/3 = 20/81,
  //   RS 327/10 -> 32700/337.
  series.addTrade({ time: T0 + 6 * MINUTE + 1, price: P(SENTINEL), qty: 1, isBuy: true });
  assert.equal(series.length, BASE_CLOSES.length + 1);
  ctx.range = [0, series.length];
  const appended = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(appended.result), [...RSI3_BASE, 32700 / 337], "RSI3 after sentinel");
  assertPrefixUnchanged(plotValues(appended.result), rsiPrefix, "RSI3");
  assert.equal(appended.counters["indicator.incremental.full.rsi"], 1);

  // Tail tick 35 -> 40 (change +27): G = (20/9 + 27)/3 = 263/27, L = 20/81,
  //   RS 789/20 -> 78900/809.
  series.addTrade({ time: T0 + 6 * MINUTE + 2, price: P(SENTINEL_TICK), qty: 1, isBuy: true });
  assert.equal(indicatorPriceSeriesMutation(series).kind, "tail");
  const ticked = countersDuring(() => rsiIndicatorDefinition.prepareData(ctx));
  assertValues(plotValues(ticked.result), [...RSI3_BASE, 78900 / 809], "RSI3 after tick");
  assertPrefixUnchanged(plotValues(ticked.result), rsiPrefix, "RSI3");
  assert.deepEqual(ticked.counters, { "indicator.incremental.hit.rsi": 1 });
});

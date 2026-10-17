import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { buildIndicatorAnalysisSnapshot } from "../dist/features/indicators/analysisSnapshot.js";
import { IndicatorPrepareCache } from "../dist/features/indicators/prepareCache.js";

globalThis.$state ??= (value) => value;
const { vwapIndicatorDefinition } = await import("../dist/features/indicators/builtins/vwapIndicator.js");
const { configurePerformanceTelemetry, isPerformanceTelemetryEnabled, snapshotPerformanceTelemetry } = await import("../dist/core/performanceTelemetry.js");

/** Runs `work` with telemetry on and returns the VWAP counters it bumped. */
function vwapCountersDuring(work) {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const before = snapshotPerformanceTelemetry().counters;
    const result = work();
    const delta = {};
    for (const [name, value] of Object.entries(snapshotPerformanceTelemetry().counters)) {
      if (name.includes(".vwap") && value !== (before[name] ?? 0)) delta[name] = value - (before[name] ?? 0);
    }
    return { result, counters: delta };
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
}

// #396: analysis reads and pans must not rebuild whole-series data they then
// throw away, and their output must stay exactly what it was.

const chart = { market: "BINANCE_FUTURES:btcusdt", timeframe: "1m", intervalMs: 60_000 };

function series(length) {
  const value = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  value.loadBars(Array.from({ length }, (_, index) => ({
    startTime: index * 60_000,
    open: 100 + (index % 7),
    high: 108 + (index % 5),
    low: 95 - (index % 3),
    close: 101 + (index % 4),
    volume: 10 + (index % 9),
    delta: 0,
    count: 0,
    cells: new Map(),
    hasRef: true,
  })));
  return value;
}

function instance(id, type) {
  return { id, type, title: type, visible: true, order: 0, placement: "separate-pane", paneHeight: 100, collapsed: false, settings: {} };
}

// The pre-#396 sampling: map every point, drop invalid ones, keep the tail.
function referenceSamples(points, limit) {
  const all = points.flatMap((point) => {
    if (!point || typeof point !== "object") return [];
    const { value, time, sourceTime } = point;
    if (typeof value !== "number" || !Number.isFinite(value) || typeof time !== "number" || !Number.isFinite(time)) return [];
    return [{ time, value, ...(typeof sourceTime === "number" && Number.isFinite(sourceTime) ? { sourceTime } : {}) }];
  });
  return all.length <= limit ? all : all.slice(-limit);
}

test("analysis samples of a long series are the last valid points, as before", () => {
  const points = Array.from({ length: 2_000 }, (_, index) => ({
    index,
    time: index * 60_000,
    value: index % 5 === 0 ? null : index % 11 === 0 ? Number.NaN : index * 0.5,
    ...(index % 3 === 0 ? { sourceTime: index * 60_000 + 1 } : {}),
  }));
  points.push(null, { time: "bad", value: 1 }, { time: 1, value: Infinity });
  const definition = {
    name: "Long",
    prepareData: () => ({ status: "ok", meta: { series: [{ key: "a", label: "A", points }, { key: "b", label: "B", points: points.slice(0, 7) }] } }),
  };
  for (const limit of [1, 3, 128]) {
    const snapshot = buildIndicatorAnalysisSnapshot(instance(`long-${limit}`, "long"), definition, series(10), chart, [0, 10], limit);
    assert.equal(snapshot.status, "ok");
    assert.deepEqual(snapshot.series.map((item) => item.samples), [referenceSamples(points, limit), referenceSamples(points.slice(0, 7), limit)]);
  }
});

test("point-adapter samples keep key order, candle alignment and source times", () => {
  const points = Array.from({ length: 500 }, (_, index) => ({
    index,
    time: index * 60_000 + (index % 2 ? 15_000 : 0),
    candleStart: index % 4 === 0 ? undefined : index * 60_000,
    hasData: true,
    sellUsd: index % 6 === 0 ? null : index,
    buyUsd: index * 2,
    ...(index > 490 ? { lateKey: index } : {}),
  }));
  const definition = { name: "Liquidations", prepareData: () => ({ status: "ok", points }) };
  const snapshot = buildIndicatorAnalysisSnapshot(instance("liq", "liquidations"), definition, series(10), chart, [0, 10], 4);

  const expected = (key) => points.flatMap((point) => {
    const aligned = typeof point.candleStart === "number" ? point.candleStart : point.time;
    const value = point[key];
    if (typeof value !== "number") return [];
    return [{ time: aligned, value, ...(point.time !== aligned ? { sourceTime: point.time } : {}) }];
  }).slice(-4);
  // Keys follow their first numeric appearance: the first point has no sellUsd.
  assert.deepEqual(snapshot.series.map((item) => item.key), ["buyUsd", "sellUsd", "lateKey"]);
  assert.deepEqual(snapshot.series.map((item) => item.samples), [expected("buyUsd"), expected("sellUsd"), expected("lateKey")]);
});

test("analysis reads alternating two ranges of the same data compute each range once", () => {
  let computes = 0;
  const definition = {
    name: "Cached",
    prepareCache: "series-range",
    prepareData: (context) => {
      computes++;
      return { status: "ok", meta: { series: [{ key: "v", label: "V", points: [{ time: context.series.at(context.range[1] - 1).startTime, value: context.range[0] }] }] } };
    },
  };
  const data = series(50);
  const cached = instance("cached", "cached");
  const read = (range) => buildIndicatorAnalysisSnapshot(cached, definition, data, chart, range, 1).series[0].samples[0].value;

  for (let round = 0; round < 3; round++) {
    assert.equal(read([0, 24]), 0);
    assert.equal(read([26, 50]), 26);
  }
  assert.equal(computes, 2);

  // A third range pushes out the oldest; new data drops every older entry.
  read([10, 20]);
  read([0, 24]);
  assert.equal(computes, 4);
  data.upsertBar({ ...data.at(49), close: 104 });
  read([26, 50]);
  read([0, 24]);
  assert.equal(computes, 6);

  // Another chart's series never answers from this one's entries.
  assert.equal(buildIndicatorAnalysisSnapshot(cached, definition, series(50), chart, [0, 24], 1).series[0].samples[0].value, 0);
  assert.equal(computes, 7);
});

test("prepare cache keeps one range per instance unless asked for more", () => {
  const key = (rangeFrom, revision = 1) => ({
    definitionType: "rsi", instance: shared, series: data, rangeFrom, rangeTo: rangeFrom + 10,
    market: chart.market, timeframe: chart.timeframe, intervalMs: chart.intervalMs,
  });
  const shared = {};
  const data = { revision: 1 };
  let computes = 0;
  const compute = () => ++computes;

  const single = new IndicatorPrepareCache();
  single.resolve("a", key(0), compute);
  single.resolve("a", key(5), compute);
  single.resolve("a", key(0), compute);
  assert.equal(computes, 3);

  computes = 0;
  const pair = new IndicatorPrepareCache(2);
  pair.resolve("a", key(0), compute);
  pair.resolve("a", key(5), compute);
  assert.equal(pair.resolve("a", key(0), compute), 1);
  assert.equal(pair.resolve("a", key(5), compute), 2);
  data.revision = 2;
  pair.resolve("a", key(0), compute);
  data.revision = 1;
  // The revision-1 entries were dropped when revision 2 was stored.
  pair.resolve("a", key(5), compute);
  assert.equal(computes, 4);
});

test("VWAP rebuilds only the plotted slice when the range moves, with the same output as a full compute", () => {
  const data = series(3 * 1_440);
  const settings = vwapIndicatorDefinition.defaultSettings();
  settings.lines = [
    { ...settings.lines[0], id: "daily" },
    { ...settings.lines[0], id: "weekly", period: "weekly", color: "#123456" },
  ];
  const shared = { id: "vwap-pan", visible: true };
  const prepare = (target, range) => vwapIndicatorDefinition.prepareData({ series: data, range, instance: target, settings });
  const fresh = (range) => prepare({ id: `vwap-fresh-${range.join("-")}`, visible: true }, range);

  assert.deepEqual(prepare(shared, [0, 200]), fresh([0, 200]));
  for (const range of [[1_300, 1_700], [4_000, 4_320], [0, 200]]) {
    const { result, counters } = vwapCountersDuring(() => prepare(shared, range));
    assert.deepEqual(counters, { "indicator.incremental.hit.vwap": 1 }, `range ${range}`);
    assert.deepEqual(result, fresh(range));
  }

  // After a pan the next live tail update still takes the incremental path.
  prepare(shared, [4_000, 4_320]);
  data.upsertBar({ ...data.at(data.length - 1), close: 120, high: 121, volume: 40 });
  const tail = vwapCountersDuring(() => prepare(shared, [4_000, 4_320]));
  assert.equal(tail.counters["indicator.incremental.full.vwap"], undefined);
  assert.deepEqual(tail.result, fresh([4_000, 4_320]));
});

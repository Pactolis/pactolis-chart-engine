import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { buildChartAnalysisSnapshot, fitAnalysisSnapshotToBytes } from "../dist/features/chart/analysisSnapshot.js";

function bar(startTime, close, cells = new Map()) {
  return { startTime, open: close - 1, high: close + 1, low: close - 2, close, volume: 10, delta: 0, count: 0, cells, hasRef: true };
}
function analysis(market, drawings = []) {
  return {
    market,
    profileSettings: { enabled: false, mode: "visible", valueAreaPercent: .7, showPoc: true, showVah: true, showVal: true },
    previousWeekStrategySettings: { enabled: true, visible: { "pw-high": true }, groups: [], levels: [], labelFormat: "label", presets: [] },
    previousWeekStrategyLevels: [{ id: "pw-high", group: "high-low", kind: "line", label: "PW High", color: "#fff", sourceStart: 1, sourceEnd: 2, price: 100 }],
    mondayRangeSettings: { enabled: false, visible: {}, groups: [], levels: [], labelFormat: "label", presets: [] },
    mondayRangeLevels: [], nakedPocs: [], referenceLevels: [],
    drawings: { listForMarket: (target) => structuredClone(drawings.filter((item) => item.market === target)) },
  };
}
const revision = { revision: 1, market: "BTCUSDT", canonical: { status: "complete", market: "BTCUSDT", runKey: "x", generation: 1, revision: 1, failedPeriods: [] } };

test("open candle is excluded and missing footprint delta/count are not serialized as zero", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([bar(0, 100), bar(60_000, 101)]);
  const snapshot = buildChartAnalysisSnapshot({ panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1, series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators: [], options: { now: 90_000 } });
  assert.equal(snapshot.candles.length, 1);
  assert.equal("delta" in snapshot.candles[0], false);
  assert.equal("count" in snapshot.candles[0], false);
});

test("visible viewport selects intersecting candles and visible price levels", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars(Array.from({ length: 10 }, (_, index) => bar(index * 60_000, 100 + index)));
  const snapshot = buildChartAnalysisSnapshot({
    panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1,
    series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators: [],
    options: {
      now: 700_000,
      visibleTimeRange: { from: 150_000, to: 330_000 },
      visiblePriceRange: { low: 99, high: 105 },
    },
  });
  assert.deepEqual(snapshot.viewport, { timeFrom: 150_000, timeTo: 330_000, priceLow: 99, priceHigh: 105 });
  assert.deepEqual(snapshot.candles.map((item) => item.time), [120_000, 180_000, 240_000, 300_000]);
  assert.deepEqual(snapshot.levels.map((item) => item.id), ["pw-high"]);

  const offscreen = buildChartAnalysisSnapshot({
    panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1,
    series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators: [],
    options: {
      now: 700_000,
      visibleTimeRange: { from: 150_000, to: 330_000 },
      visiblePriceRange: { low: 150, high: 200 },
    },
  });
  assert.deepEqual(offscreen.levels, [], "off-screen automatic levels must not be presented as visible chart levels");
});

test("detailed footprint uses the latest 24 contiguous candles", () => {
  const base = Date.UTC(2024, 0, 1);
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars(Array.from({ length: 30 }, (_, index) => bar(base + index * 60_000, 100 + index, new Map([
    [100 + index, { priceBin: 100 + index, buyVol: 3, sellVol: 2, count: 2, buyCount: 1, sellCount: 1 }],
  ]))));
  const snapshot = buildChartAnalysisSnapshot({
    panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1,
    series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators: [],
    options: {
      now: base + 31 * 60_000,
      visibleTimeRange: { from: base, to: base + 30 * 60_000 },
      visiblePriceRange: { low: 50, high: 200 },
    },
  });
  const detailed = snapshot.candles.filter((item) => item.footprint?.length);
  assert.equal(detailed.length, 24);
  assert.equal(detailed[0].time, base + 6 * 60_000);
  assert.equal(detailed.at(-1).time, base + 29 * 60_000);
  assert.ok(snapshot.warnings.some((warning) => warning.includes("latest 24 contiguous candles")));
});

test("market-scoped hidden drawings do not leak into provider input but remain inspectable in scope", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([bar(0, 100)]);
  const drawings = [
    { id: "btc", type: "horizontal", points: [{ time: 1, price: 99 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BTCUSDT" },
    { id: "eth", type: "horizontal", points: [{ time: 1, price: 199 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "ETHUSDT" },
    { id: "hidden", type: "horizontal", points: [{ time: 1, price: 98 }], color: "#fff", lineWidth: 1, locked: false, visible: false, market: "BTCUSDT" },
  ];
  const provider = buildChartAnalysisSnapshot({ panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1, series, analysis: analysis("BTCUSDT", drawings), analysisRevision: revision, indicators: [], options: { now: 120_000 } });
  const scope = buildChartAnalysisSnapshot({ panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1, series, analysis: analysis("BTCUSDT", drawings), analysisRevision: revision, indicators: [], options: { now: 120_000, includeHiddenSources: true } });
  assert.deepEqual(provider.drawings.map((item) => item.id), ["btc"]);
  assert.deepEqual(scope.drawings.map((item) => [item.id, item.status]), [["btc", "ok"], ["hidden", "hidden"]]);
});

test("hidden indicators are excluded from analysis input by default and visible to scope inspection", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([bar(0, 100)]);
  const visible = { instanceId: "rsi-14", type: "rsi", name: "RSI", parameters: { period: 14 }, status: "ok", scope: "closed-bars", series: [], summary: {}, warnings: [] };
  const hidden = { instanceId: "rsi-7", type: "rsi", name: "RSI", parameters: { period: 7 }, status: "hidden", scope: "closed-bars", series: [], summary: {}, warnings: [] };
  const provider = buildChartAnalysisSnapshot({ panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1, series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators: [visible, hidden], options: { now: 120_000 } });
  const scope = buildChartAnalysisSnapshot({ panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1, series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators: [visible, hidden], options: { now: 120_000, includeHiddenSources: true } });
  assert.deepEqual(provider.indicators.map((item) => item.instanceId), ["rsi-14"]);
  assert.deepEqual(scope.indicators.map((item) => [item.instanceId, item.status]), [["rsi-14", "ok"], ["rsi-7", "hidden"]]);
});

test("position drawing never fabricates a missing target", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([bar(0, 100)]);
  const drawings = [{ id: "position", type: "long-position", points: [{ time: 1, price: 100 }, { time: 2, price: 95 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BTCUSDT" }];
  const snapshot = buildChartAnalysisSnapshot({ panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1, series, analysis: analysis("BTCUSDT", drawings), analysisRevision: revision, indicators: [], options: { now: 120_000 } });
  assert.equal(snapshot.drawings[0].entry, 100);
  assert.equal(snapshot.drawings[0].stop, 95);
  assert.equal("target" in snapshot.drawings[0], false);
});

test("provider snapshot retains exact viewport metadata under the configured byte cap", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars(Array.from({ length: 100 }, (_, index) => bar(index * 60_000, 100 + index)));
  const indicators = Array.from({ length: 12 }, (_, indicatorIndex) => ({
    instanceId: `heavy-${indicatorIndex}`,
    type: "fixture",
    name: `Fixture ${indicatorIndex}`,
    parameters: { note: "x".repeat(500) },
    status: "ok",
    scope: "closed-bars",
    series: [{ key: "value", label: "Value", unit: "value", samples: Array.from({ length: 20 }, (_, sampleIndex) => ({ time: sampleIndex, value: sampleIndex })) }],
    summary: {},
    warnings: [],
  }));
  const maxBytes = 8 * 1024;
  const snapshot = buildChartAnalysisSnapshot({
    panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1,
    series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators,
    options: {
      now: 6_100_000,
      maxBytes,
      visibleTimeRange: { from: 0, to: 6_000_000 },
      visiblePriceRange: { low: 90, high: 210 },
    },
  });
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  assert.ok(bytes <= maxBytes, `${bytes} exceeds ${maxBytes}`);
  assert.ok(snapshot.warnings.some((warning) => warning.includes("oldest rich detail") || warning.includes("byte limit")));
  assert.deepEqual(snapshot.viewport, { timeFrom: 0, timeTo: 6_000_000, priceLow: 90, priceHigh: 210 });
});

test("large footprint byte fitting uses at most three full encodes and keeps the legacy detail bars", () => {
  const makeSnapshot = () => ({
    schemaVersion: 1,
    panelId: "p",
    market: "BTCUSDT",
    timeframe: "3M",
    intervalMs: 60_000,
    selectionGeneration: 1,
    capturedAt: 1,
    lastClosedBarEnd: 24,
    historyStatus: "ready",
    automaticAnalysisStatus: "complete",
    candles: Array.from({ length: 24 }, (_, candleIndex) => ({
      time: candleIndex,
      endTime: candleIndex + 1,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
      footprint: Array.from({ length: 5_000 }, (_, cellIndex) => ({
        price: cellIndex,
        buyVolume: 1,
        sellVolume: 0.5,
        totalVolume: 1.5,
        delta: 0.5,
        tradeCount: 2,
        buyTradeCount: 1,
        sellTradeCount: 1,
      })),
    })),
    levels: [],
    drawings: [],
    indicators: [],
    warnings: [],
  });
  const byteSize = (snapshot) => new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  const legacy = makeSnapshot();
  const maxBytes = Math.floor(byteSize(legacy) / 4);
  legacy.warnings.push(`Analysis input exceeded ${maxBytes} bytes; oldest rich detail was reduced first`);
  while (byteSize(legacy) > maxBytes) {
    const oldest = legacy.candles.find((candle) => candle.footprint?.length);
    assert.ok(oldest, "the test cap leaves room for the base candle context");
    delete oldest.footprint;
  }
  const expectedTimes = legacy.candles.filter((candle) => candle.footprint?.length).map((candle) => candle.time);

  const snapshot = makeSnapshot();
  const originalEncode = TextEncoder.prototype.encode;
  let fullEncodes = 0;
  TextEncoder.prototype.encode = function (value) {
    fullEncodes++;
    return originalEncode.call(this, value);
  };
  try {
    fitAnalysisSnapshotToBytes(snapshot, maxBytes);
  } finally {
    TextEncoder.prototype.encode = originalEncode;
  }

  assert.ok(fullEncodes <= 3, `expected at most three full encodes, got ${fullEncodes}`);
  assert.ok(byteSize(snapshot) <= maxBytes, "the final snapshot must respect its byte limit");
  assert.deepEqual(snapshot.candles.filter((candle) => candle.footprint?.length).map((candle) => candle.time), expectedTimes);
});

test("snapshot builder prefilters oversized footprint cells before materializing old candle detail", () => {
  const base = Date.UTC(2024, 0, 1);
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars(Array.from({ length: 24 }, (_, index) => bar(base + index * 60_000, 100 + index, new Map(
    Array.from({ length: 5_000 }, (_, cellIndex) => [cellIndex + 1, {
      priceBin: cellIndex + 1,
      buyVol: 1,
      sellVol: 0.5,
      count: 2,
      buyCount: 1,
      sellCount: 1,
    }]),
  ))));
  const options = { now: base + 25 * 60_000, maxBytes: Number.POSITIVE_INFINITY };
  const full = buildChartAnalysisSnapshot({
    panelId: "p", market: "BTCUSDT", timeframe: "3M", intervalMs: 60_000, selectionGeneration: 1,
    series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators: [], options,
  });
  const byteSize = (snapshot) => new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  const maxBytes = Math.floor(byteSize(full) / 4);
  const legacy = structuredClone(full);
  legacy.warnings.push(`Analysis input exceeded ${maxBytes} bytes; oldest rich detail was reduced first`);
  while (byteSize(legacy) > maxBytes) {
    const oldest = legacy.candles.find((candle) => candle.footprint?.length);
    assert.ok(oldest);
    delete oldest.footprint;
  }
  const expectedTimes = legacy.candles.filter((candle) => candle.footprint?.length).map((candle) => candle.time);

  let fullEncodes = 0;
  const originalEncode = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = function (value) {
    fullEncodes++;
    return originalEncode.call(this, value);
  };
  let snapshot;
  try {
    snapshot = buildChartAnalysisSnapshot({
      panelId: "p", market: "BTCUSDT", timeframe: "3M", intervalMs: 60_000, selectionGeneration: 1,
      series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators: [],
      options: { ...options, maxBytes },
    });
  } finally {
    TextEncoder.prototype.encode = originalEncode;
  }

  assert.ok(fullEncodes <= 3, `expected at most three full encodes, got ${fullEncodes}`);
  assert.ok(byteSize(snapshot) <= maxBytes);
  assert.deepEqual(snapshot.candles.filter((candle) => candle.footprint?.length).map((candle) => candle.time), expectedTimes);
});

test("analysis snapshot exposes partial TPO coverage and omits a label for complete sessions", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([bar(0, 100), bar(60_000, 101)]);
  const snapshot = buildChartAnalysisSnapshot({
    panelId: "p", market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000, selectionGeneration: 1,
    series, analysis: analysis("BTCUSDT"), analysisRevision: revision, indicators: [],
    tpoProfiles: [
      { sessionStarts: [0], status: "partial", label: "Kısmi", poc: 100, vah: 101, val: 100 },
      { sessionStarts: [86_400_000], status: "complete", poc: 101, vah: 102, val: 100 },
    ],
    options: { now: 120_000 },
  });
  assert.deepEqual(snapshot.tpoProfiles, [
    { sessionStarts: [0], status: "partial", label: "Kısmi", poc: 100, vah: 101, val: 100 },
    { sessionStarts: [86_400_000], status: "complete", poc: 101, vah: 102, val: 100 },
  ]);
});

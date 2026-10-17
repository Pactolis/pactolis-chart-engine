import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { buildChartAnalysisSnapshot } from "../dist/features/chart/analysisSnapshot.js";

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

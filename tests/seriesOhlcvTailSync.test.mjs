// #128 group (c): seriesOhlcv re-syncs only the tail row while structureRevision and
// nonTailRevision are unchanged. After every kind of mutation the rows must equal a
// from-scratch conversion exactly, and the tail path must actually run for tail ticks.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { seriesOhlcv, barsToOhlcv } = await import("../dist/core/analysis/calc/ta.js");
const { configurePerformanceTelemetry, snapshotPerformanceTelemetry } = await import("../dist/core/performanceTelemetry.js");

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const mkBar = (i) => { const close = 10_000 + (i % 9); return { startTime: T0 + i * MIN, open: close - 1, high: close + 2, low: close - 2, close, volume: 5 + (i % 4), delta: (i % 3) - 1, count: 2, cells: new Map(), hasRef: true, cellRevision: 0 }; };
const mkSeries = (n) => { const s = new FootprintSeries({ intervalMs: MIN, priceStep: 1 }); s.loadBars(Array.from({ length: n }, (_, i) => mkBar(i))); return s; };
const counter = (name) => snapshotPerformanceTelemetry().counters[name] ?? 0;
const trade = (series, time, price, id) => series.addTrades([{ time, price, qty: 0.7, isBuy: id % 2 === 0, id: `o${id}` }]);

test("seriesOhlcv rows equal a full conversion after tail trades, old-bar changes, new bars and reloads", () => {
  configurePerformanceTelemetry({ enabled: true });
  const series = mkSeries(400);
  const same = (what) => assert.deepStrictEqual(seriesOhlcv(series), barsToOhlcv(series.listReadonly()), what);
  same("initial");
  const tailBefore = counter("ohlcv.sync.tail");
  for (let k = 0; k < 10; k++) { trade(series, series.listReadonly().at(-1).startTime + 1000 + k, 10_000 + k, k); same(`tail trade ${k}`); }
  assert.ok(counter("ohlcv.sync.tail") - tailBefore >= 10, "tail-only sync must run for tail ticks");
  const fullBefore = counter("ohlcv.sync.full");
  trade(series, series.listReadonly()[100].startTime + 5, 10_004, 50); same("trade into an old bar");
  assert.ok(counter("ohlcv.sync.full") > fullBefore, "an old-bar change must fall back to the full sync");
  series.reassertOHLC(series.listReadonly()[200].startTime, 9_990, 10_020, 9_980); same("reassertOHLC on an old bar");
  series.upsertBar({ ...mkBar(250), high: 10_050, volume: 99 }); same("upsertBar on an old bar");
  trade(series, series.listReadonly().at(-1).startTime + 2 * MIN, 10_003, 60); same("new bar");
  trade(series, series.listReadonly().at(-1).startTime + 5, 10_002, 61); same("trade on the new bar");
  series.loadBars(Array.from({ length: 150 }, (_, i) => mkBar(i + 7))); same("history change");
  trade(series, series.listReadonly().at(-1).startTime + 5, 10_001, 62); same("trade after reload");
});

test("seriesOhlcv without nonTailRevision (duck-typed source) still syncs every row", () => {
  const bars = Array.from({ length: 20 }, (_, i) => mkBar(i));
  const source = { revision: 1, structureRevision: 1, listReadonly: () => bars };
  assert.deepStrictEqual(seriesOhlcv(source), barsToOhlcv(bars));
  bars[3] = { ...bars[3], close: 12_345 }; source.revision = 2;
  assert.deepStrictEqual(seriesOhlcv(source), barsToOhlcv(bars));
});

// #128 group (b3): Ichimoku tail/pan incremental paths vs full recompute.
// The reference is the same indicator under a fresh instance id (no cache, so the full ta.*
// path). Everything is compared with deepStrictEqual (the stepper repeats the same float
// operations in the same order), and the hit counter must rise on every tail tick.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { ichimokuIndicatorDefinition } = await import("../dist/features/indicators/builtins/ichimoku.js");
const { configurePerformanceTelemetry, snapshotPerformanceTelemetry } = await import("../dist/core/performanceTelemetry.js");

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
function mkBars(n, from = 0) {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const close = 10_000 + Math.round(Math.sin(i / 4) * 8 + Math.cos(i / 11) * 5 + (i % 40 < 20 ? i % 20 : 20 - (i % 20)));
    return { startTime: T0 + i * MIN, open: close - 1, high: close + 2 + (i % 3), low: close - 2 - (i % 4), close, volume: 5 + (i % 7), delta: 0, count: 3, cells: new Map(), hasRef: true, cellRevision: 0 };
  });
}
function mkSeries(n) { const s = new FootprintSeries({ intervalMs: MIN, priceStep: 1 }); s.loadBars(mkBars(n)); return s; }
let seq = 0;
function ctxFor(series, def, range, id, overrides) {
  const settings = { ...def.defaultSettings(), ...overrides };
  return { ctx: {}, view: {}, series, rect: { top: 0, height: 100 }, range, instance: { id, type: def.type, title: def.type, visible: true, paneId: "p", order: 0, settings, seq: ++seq }, settings, requestRefresh() {} };
}
const trade = (series, offsetMs, price, id) => series.addTrades([{ time: series.listReadonly().at(-1).startTime + offsetMs, price, qty: 0.5 + (id % 3), isBuy: id % 2 === 0, id: `t${id}` }]);
const plots = (prepared) => prepared.meta.series.map((s) => [s.key, s.points]);
const counters = () => snapshotPerformanceTelemetry().counters;
const keyOf = { ichimoku: "ichimoku" };

const cases = [
  [ichimokuIndicatorDefinition, [
    { tenkanPeriod: 1, kijunPeriod: 1, senkouBPeriod: 1, displacement: 0 },
    { tenkanPeriod: 3, kijunPeriod: 5, senkouBPeriod: 7, displacement: 1 },
    { tenkanPeriod: 9, kijunPeriod: 26, senkouBPeriod: 52, displacement: 26 },
    { tenkanPeriod: 9, kijunPeriod: 26, senkouBPeriod: 52, displacement: 0 },
    { tenkanPeriod: 200, kijunPeriod: 300, senkouBPeriod: 500, displacement: 200 },
  ]],
];

for (const [def, variants] of cases) {
  test(`${def.type}: tail trades, pan, new bar and history change equal a full recompute`, () => {
    configurePerformanceTelemetry({ enabled: true });
    const kind = keyOf[def.type];
    for (const overrides of variants) {
      const label = `${def.type} ${JSON.stringify(overrides)}`;
      const series = mkSeries(300);
      const live = ctxFor(series, def, [100, 300], "live", overrides);
      const check = (what) => {
        const actual = def.prepareData(live);
        const expected = def.prepareData(ctxFor(series, def, live.range, `ref-${++seq}`, overrides));
        assert.deepStrictEqual(plots(actual), plots(expected), `${label}: ${what}`);
      };
      check("initial");
      const before = counters()[`indicator.incremental.hit.${kind}`] ?? 0;
      for (let k = 0; k < 10; k++) { trade(series, 1000 + k, 10_000 + ((k * 7) % 25) - 12, 10 + k); check(`tail trade ${k}`); }
      assert.ok((counters()[`indicator.incremental.hit.${kind}`] ?? 0) - before >= 10, `${label}: tail path must run for each tick`);
      live.range = [101, 300]; check("pan by one");
      live.range = [0, 150]; check("pan to history");
      trade(series, 77, 10_003, 90); check("tail trade while panned back");
      live.range = [100, 300];
      trade(series, 3 * MIN, 10_002, 91); live.range = [103, 301]; check("new bar");
      trade(series, 9, 10_005, 92); check("trade on new bar");
      series.loadBars(mkBars(180, 5)); live.range = [0, 180]; check("history change");
      trade(series, 4, 10_001, 93); check("trade after history change");
    }
  });
}

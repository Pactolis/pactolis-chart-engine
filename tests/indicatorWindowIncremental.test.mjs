// #128 group (b1): Bollinger, CCI, MFI and KDJ tail/pan incremental paths vs full recompute.
//
// The reference is the same indicator prepared under a fresh instance id, which has no
// cache and therefore runs the full ta.* computation. Compared exactly (deepStrictEqual),
// except Bollinger's upper/lower bands: they depend on the standard deviation, whose full
// path may use rolling sums (#129) that cannot be bit-identical to the windowed tail
// recompute, so those two are compared at relative 1e-12; Bollinger's middle is exact.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { bollingerIndicatorDefinition } = await import("../dist/features/indicators/builtins/bollinger.js");
const { cciIndicatorDefinition } = await import("../dist/features/indicators/builtins/cci.js");
const { mfiIndicatorDefinition } = await import("../dist/features/indicators/builtins/mfi.js");
const { kdjIndicatorDefinition } = await import("../dist/features/indicators/builtins/kdj.js");
const { configurePerformanceTelemetry, snapshotPerformanceTelemetry } = await import("../dist/core/performanceTelemetry.js");

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
function mkBars(n, from = 0) {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const close = 10_000 + Math.round(Math.sin(i / 4) * 8 + Math.cos(i / 11) * 5);
    return { startTime: T0 + i * MIN, open: close - 1, high: close + 2 + (i % 3), low: close - 2 - (i % 4), close, volume: i % 13 === 0 ? 0 : 5 + (i % 7), delta: 0, count: 3, cells: new Map(), hasRef: true, cellRevision: 0 };
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

function relClose(a, b) { return a === b || (a !== null && b !== null && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b))); }
function assertSame(def, actual, expected, label) {
  if (def.type !== "bollinger-bands") return assert.deepStrictEqual(plots(actual), plots(expected), label);
  const [a, e] = [plots(actual), plots(expected)];
  assert.equal(a.length, e.length, label);
  for (let s = 0; s < a.length; s++) {
    assert.equal(a[s][0], e[s][0]);
    assert.equal(a[s][1].length, e[s][1].length, label);
    for (let p = 0; p < a[s][1].length; p++) {
      const [x, y] = [a[s][1][p], e[s][1][p]];
      assert.deepStrictEqual({ ...x, value: 0 }, { ...y, value: 0 }, label);
      assert.ok(a[s][0] === "middle" ? Object.is(x.value, y.value) : relClose(x.value, y.value), `${label} ${a[s][0]}[${x.index}]: ${x.value} vs ${y.value}`);
    }
  }
}

const cases = [
  [bollingerIndicatorDefinition, [{ period: 1 }, { period: 3, multiplier: 1.5 }, { period: 20 }, { period: 500 }]],
  [cciIndicatorDefinition, [{ period: 1 }, { period: 3 }, { period: 20 }, { period: 300 }]],
  [mfiIndicatorDefinition, [{ period: 1 }, { period: 3 }, { period: 14 }, { period: 200 }]],
  [kdjIndicatorDefinition, [{ period: 1, kSmoothing: 1, dSmoothing: 1 }, { period: 3 }, { period: 9 }, { period: 200, kSmoothing: 5, dSmoothing: 4 }]],
];

for (const [def, variants] of cases) {
  test(`${def.type}: tail trades, pan, new bar and history change equal a full recompute`, () => {
    configurePerformanceTelemetry({ enabled: true });
    for (const overrides of variants) {
      const label = `${def.type} ${JSON.stringify(overrides)}`;
      const series = mkSeries(300);
      const live = ctxFor(series, def, [100, 300], "live", overrides);
      const check = (what) => {
        const actual = def.prepareData(live);
        const expected = def.prepareData(ctxFor(series, def, live.range, `ref-${++seq}`, overrides));
        assertSame(def, actual, expected, `${label}: ${what}`);
      };
      check("initial");
      const before = counters();
      for (let k = 0; k < 8; k++) { trade(series, 1000 + k, 10_000 + ((k * 5) % 9) - 4, 10 + k); check(`tail trade ${k}`); }
      const afterTail = counters();
      assert.equal((afterTail[`indicator.incremental.hit.${shortKey(def)}`] ?? 0) - (before[`indicator.incremental.hit.${shortKey(def)}`] ?? 0) >= 8, true, `${label}: tail path must run for each tick`);
      // the live instance never rebuilt during the tail ticks (reference instances do, so count by delta of hits only)
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
function shortKey(def) { return { "bollinger-bands": "bollinger", cci: "cci", mfi: "mfi", kdj: "kdj" }[def.type]; }

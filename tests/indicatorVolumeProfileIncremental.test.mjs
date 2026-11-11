// #128 group (a): Volume MA and Volume Profile tail updates must equal a full recompute
// exactly (strict deepEqual, no tolerance): cloned-prefix + tail bar repeats the same
// float additions in the same order, and the SMA tail step resumes the saved compensated state.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { volumeIndicatorDefinition } = await import("../dist/features/indicators/builtins/volume.js");
const vpMod = await import("../dist/features/indicators/builtins/volumeProfile.js");
const vpDef = Object.values(vpMod).find((v) => v && typeof v.prepareData === "function");
const { calculateOrderFlowProfile } = await import("../dist/core/analysis/orderFlowProfile.js");
const { sessionBars } = await import("../dist/core/analysis/volumeProfile.js");
const { simpleMovingAverage, simpleMovingAverageWithState, simpleMovingAverageAdvance } = await import("../dist/core/analysis/calc/ta.js");
const { snapshotPerformanceTelemetry, configurePerformanceTelemetry } = await import("../dist/core/performanceTelemetry.js");

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;

function mkBars(n, from = 0) {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const base = 10_000 + Math.round(Math.sin(i / 5) * 6);
    const cells = new Map();
    for (let c = 0; c < 7; c++) {
      const b = base - 3 + c;
      cells.set(b, { priceBin: b, buyVol: 0.1 * (1 + ((i + c) % 3)), sellVol: 0.1 * (1 + ((i * c) % 5)), count: 2, buyCount: 1, sellCount: 1 });
    }
    return { startTime: T0 + i * MIN, open: base, high: base + 3, low: base - 3, close: base + 1, volume: 7 + (i % 4) * 0.1, delta: 0, count: 14, cells, hasRef: true, cellRevision: 1, completeness: "complete", sources: ["history"] };
  });
}
function mkSeries(n) {
  const s = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  s.loadBars(mkBars(n));
  return s;
}
let seq = 0;
function ctxFor(series, def, range, overrides = {}) {
  const settings = { ...def.defaultSettings(), ...overrides };
  const instance = { id: `${def.type}-inc`, type: def.type, title: def.type, visible: true, paneId: "p", order: 0, settings, seq: ++seq };
  return { ctx: {}, view: { colWidth: 6, xOfIndex: (i) => i * 6, indexOfX: (x) => x / 6 }, series, rect: { top: 0, height: 100 }, range, instance, settings, requestRefresh() {} };
}
const trade = (series, offsetMs, price, id) => series.addTrades([{ time: series.listReadonly().at(-1).startTime + offsetMs, price, qty: 0.37, isBuy: id % 2 === 0, id: `t${id}` }]);

// --- SMA tail step ------------------------------------------------------------------
test("simpleMovingAverageAdvance equals the full computation after each tail change", () => {
  const values = Array.from({ length: 400 }, (_, i) => 1e5 + Math.sin(i) * 1e3 + i * 0.001);
  values[100] = NaN;
  for (const period of [1, 5, 20, 399, 400, 500]) {
    for (let tick = 0; tick < 5; tick++) {
      values[values.length - 1] += 0.123 * (tick + 1);
      const { out, beforeLast } = simpleMovingAverageWithState(values.slice(0, -1).concat([values.at(-1) - 1]), period);
      assert.deepStrictEqual(out.slice(0, -1), simpleMovingAverage(values, period).slice(0, -1));
      assert.deepStrictEqual(simpleMovingAverageAdvance(values, period, beforeLast), simpleMovingAverage(values, period).at(-1), `p=${period} tick=${tick}`);
    }
  }
});

// --- Volume MA ----------------------------------------------------------------------
test("Volume MA: tail trades, new bar, pan and history change equal full recompute", () => {
  const maPoints = (prepared) => prepared.meta.series.find((s) => s.key === "ma").points;
  const fullMa = (series, period, range) => {
    const bars = series.listReadonly();
    const ma = simpleMovingAverage(bars.map((b) => b.volume), period);
    const out = [];
    for (let i = Math.max(0, range[0]); i < Math.min(bars.length, range[1]); i++) out.push({ index: i, time: bars[i].startTime, value: ma[i] === null ? null : ma[i] });
    return out;
  };
  for (const period of [1, 20, 500]) {
    const series = mkSeries(300);
    const ctx = ctxFor(series, volumeIndicatorDefinition, [100, 300], { showMa: true, maPeriod: period });
    assert.deepStrictEqual(maPoints(volumeIndicatorDefinition.prepareData(ctx)), fullMa(series, period, ctx.range));
    for (let k = 0; k < 6; k++) { // append-trade
      trade(series, 1000 + k, 10_001, k);
      assert.deepStrictEqual(maPoints(volumeIndicatorDefinition.prepareData(ctx)), fullMa(series, period, ctx.range), `p=${period} trade ${k}`);
    }
    ctx.range = [101, 300]; // pan
    assert.deepStrictEqual(maPoints(volumeIndicatorDefinition.prepareData(ctx)), fullMa(series, period, ctx.range));
    trade(series, 2 * MIN, 10_002, 50); // new bar
    ctx.range = [102, 301];
    assert.deepStrictEqual(maPoints(volumeIndicatorDefinition.prepareData(ctx)), fullMa(series, period, ctx.range));
    trade(series, 5, 10_002, 51);
    assert.deepStrictEqual(maPoints(volumeIndicatorDefinition.prepareData(ctx)), fullMa(series, period, ctx.range));
    series.loadBars(mkBars(150, 7)); // history change
    ctx.range = [0, 150];
    assert.deepStrictEqual(maPoints(volumeIndicatorDefinition.prepareData(ctx)), fullMa(series, period, ctx.range));
    trade(series, 9, 10_000, 52);
    assert.deepStrictEqual(maPoints(volumeIndicatorDefinition.prepareData(ctx)), fullMa(series, period, ctx.range));
  }
});

// --- Volume Profile -----------------------------------------------------------------
function referenceProfile(series, ctx) {
  const all = series.listReadonly();
  const [from, to] = ctx.range;
  const visible = all.slice(Math.max(0, from), Math.min(all.length, to));
  const s = ctx.settings;
  let bars = visible;
  if (s.mode === "session") bars = sessionBars(all, visible.at(-1)?.startTime ?? all.at(-1).startTime);
  else if (s.mode === "lookback") {
    const end = visible.at(-1)?.startTime ?? all.at(-1).startTime;
    const idx = all.findIndex((b) => b.startTime === end);
    const last = idx >= 0 ? idx + 1 : all.length;
    bars = all.slice(Math.max(0, last - s.lookbackBars), last);
  }
  return calculateOrderFlowProfile(bars, { profileMetric: s.profileMetric ?? "volume", profileSide: s.profileSide ?? "total", valueAreaPercent: (s.valueAreaPercent ?? 70) / 100, developing: ["both", "developing"].includes(s.pocMode) || ["both", "developing"].includes(s.vahMode) || ["both", "developing"].includes(s.valMode) });
}

test("Volume Profile: tail trades, new bar, pan and history change equal full calculateOrderFlowProfile", () => {
  configurePerformanceTelemetry({ enabled: true });
  const configs = [
    { mode: "visible" }, { mode: "lookback", lookbackBars: 120 }, { mode: "session" },
    { mode: "visible", pocMode: "both", vahMode: "developing", valMode: "both" },
    { mode: "lookback", lookbackBars: 50, profileMetric: "trade-count", profileSide: "buy" },
    { mode: "visible", profileMetric: "delta" }, { mode: "visible", profileMetric: "average-trade-size" },
  ];
  for (const overrides of configs) {
    const label = JSON.stringify(overrides);
    const series = mkSeries(300);
    const ctx = ctxFor(series, vpDef, [100, 300], overrides);
    const check = (what) => {
      const prepared = vpDef.prepareData(ctx);
      const expected = referenceProfile(series, ctx);
      if (prepared.status === "ok") assert.deepStrictEqual(prepared.meta.result, expected, `${label}: ${what}`);
      else assert.equal(expected.levels.filter((l) => l.value !== null).length, 0, `${label}: ${what} (no-data)`);
    };
    check("initial");
    for (let k = 0; k < 5; k++) { trade(series, 1000 + k, 10_000 + (k % 4), 100 + k); check(`trade ${k}`); }
    ctx.range = [101, 300]; check("pan");
    ctx.range = [0, 250]; check("pan to history (window excludes tail)");
    trade(series, 77, 10_001, 200); check("tail trade while panned back");
    ctx.range = [100, 300];
    trade(series, 3 * MIN, 10_003, 201); ctx.range = [103, 301]; check("new bar");
    trade(series, 9, 10_002, 202); check("trade on new bar");
    series.loadBars(mkBars(150, 11)); ctx.range = [0, 150]; check("history change");
    trade(series, 4, 10_001, 203); check("trade after history change");
  }
  const counters = snapshotPerformanceTelemetry().counters;
  assert.ok((counters["indicator.incremental.hit.volumeProfile"] ?? 0) > 0, "tail path must actually run");
});

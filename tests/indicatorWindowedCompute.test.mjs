// Issue #128 (step 1) and #129: windowed Volume/Delta/Trade Count and the O(n)
// rollingStdDev / cci rewrites must reproduce the previous full-series computation.
//
// Volume/Delta/Trade Count, cci: exact equality (strict deepEqual, no tolerance).
// rollingStdDev: rolling sums cannot be bit-identical to the old two-pass algorithm, so
// parity is asserted at relative error <= 1e-9 (observed ~1e-15), as stated in #129.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { volumeIndicatorDefinition } = await import("../dist/features/indicators/builtins/volume.js");
const { deltaIndicatorDefinition } = await import("../dist/features/indicators/builtins/delta.js");
const { tradeCountIndicatorDefinition } = await import("../dist/features/indicators/builtins/tradeCount.js");
const { volumeSeries, deltaSeries, rollingStdDev, cci, simpleMovingAverage } = await import("../dist/core/analysis/calc/ta.js");

const { cellTradeCounts } = await import("../dist/core/model/footprintCellMetrics.js");

const T0 = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

function makeBar(i) {
  const close = 10_000 + ((i * 7) % 13);
  const volume = i % 11 === 0 ? 0 : 5 + (i % 9);
  return { startTime: T0 + i * MINUTE, open: close, high: close + 1, low: close - 1, close, volume, delta: (i % 5) - 2, count: i % 7, cells: new Map(), hasRef: true, cellRevision: 0 };
}
function makeSeries(n) {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  series.loadBars(Array.from({ length: n }, (_, i) => makeBar(i)));
  return series;
}
let seq = 0;
function ctxFor(series, definition, range, overrides = {}) {
  const settings = { ...definition.defaultSettings(), ...overrides };
  return {
    ctx: {}, view: {}, series, rect: { top: 0, height: 100 }, range,
    instance: { id: `${definition.type}-w`, type: definition.type, title: definition.type, visible: true, paneId: "p", order: 0, settings, seq: ++seq },
    settings, requestRefresh() {},
  };
}
const plot = (prepared, key) => (prepared.meta.series.find((s) => s.key === key)?.points ?? []).map((p) => [p.index, p.time, p.value]);

/** The pre-change algorithm: full-series values, then slice the visible window. */
function legacyPoints(bars, values, start, end) {
  const out = [];
  for (let i = start; i < end; i++) {
    const v = values[i]?.value;
    out.push([i, bars[i].startTime, v === null || v === undefined || !Number.isFinite(v) ? null : v]);
  }
  return out;
}
const legacyVolume = (bars) => volumeSeries(bars.map((b) => ({ time: b.startTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })));
const legacyDelta = (bars, percent) => deltaSeries(bars.map((b) => ({ time: b.startTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, delta: b.delta })), percent);

// Scenarios: initial window, pan (range shifts, data unchanged), append a trade to the
// tail bar, a new bar, and a history change (loadBars replaces everything).
function* scenarios() {
  const series = makeSeries(300);
  yield ["initial", series, [100, 300]];
  yield ["pan", series, [101, 300]];
  yield ["pan-left", series, [0, 200]];
  yield ["range beyond length", series, [250, 400]];
  const tail = series.listReadonly().at(-1);
  series.addTrade({ time: tail.startTime + 1000, price: tail.close, qty: 3, isBuyerMaker: false, id: 1 });
  yield ["append-trade", series, [101, 300]];
  series.addTrade({ time: T0 + 300 * MINUTE + 5, price: 10_003, qty: 2, isBuyerMaker: true, id: 2 });
  yield ["new-bar", series, [102, 301]];
  const rebuilt = makeSeries(120);
  yield ["history-change", rebuilt, [0, 120]];
  yield ["empty window", rebuilt, [50, 50]];
}

test("Volume: windowed points equal full-series computation", () => {
  for (const [name, series, range] of scenarios()) {
    const bars = series.listReadonly();
    const [start, end] = [Math.max(0, range[0]), Math.min(bars.length, range[1])];
    const got = plot(volumeIndicatorDefinition.prepareData(ctxFor(series, volumeIndicatorDefinition, range)), "volume");
    assert.deepStrictEqual(got, legacyPoints(bars, legacyVolume(bars), start, end), name);
  }
});

test("Delta (raw and percent): windowed points equal full-series computation", () => {
  for (const percent of [false, true]) {
    for (const [name, series, range] of scenarios()) {
      const bars = series.listReadonly();
      const [start, end] = [Math.max(0, range[0]), Math.min(bars.length, range[1])];
      const got = plot(deltaIndicatorDefinition.prepareData(ctxFor(series, deltaIndicatorDefinition, range, { mode: percent ? "percent" : "delta" })), "delta");
      assert.deepStrictEqual(got, legacyPoints(bars, legacyDelta(bars, percent), start, end), `${name} percent=${percent}`);
    }
  }
});

test("Trade Count: count and avg-size (plain and directional) equal full-series computation", () => {
  for (const mode of ["count", "avg-size"]) {
    for (const directional of [false, true]) {
      for (const [name, series, range] of scenarios()) {
        const bars = series.listReadonly();
        const [start, end] = [Math.max(0, range[0]), Math.min(bars.length, range[1])];
        const prepared = tradeCountIndicatorDefinition.prepareData(ctxFor(series, tradeCountIndicatorDefinition, range, { mode, directional }));
        const avg = mode === "avg-size";
        const label = `${name} ${mode} directional=${directional}`;
        if (!directional) {
          const full = bars.map((b) => ({ value: avg ? (b.count > 0 ? (b.volume / b.count) * b.close : 0) : b.count }));
          assert.deepStrictEqual(plot(prepared, "count"), legacyPoints(bars, full, start, end), label);
        } else {
          // Cell-backed bars aggregate their cells; others use the kline-derived split
          // (same two branches as barBuySell).
          const split = (b) => {
            if (b.cells.size > 0) {
              let buyCount = 0, sellCount = 0, buyVol = 0, sellVol = 0;
              for (const cell of b.cells.values()) { const c = cellTradeCounts(cell); buyCount += c.buy; sellCount += c.sell; buyVol += cell.buyVol; sellVol += cell.sellVol; }
              return { buyCount, sellCount, buyVol, sellVol };
            }
            const buyVol = Math.max(0, (b.volume + b.delta) / 2), sellVol = Math.max(0, (b.volume - b.delta) / 2);
            const buyCount = b.volume > 0 ? Math.round(b.count * (buyVol / b.volume)) : 0;
            return { buyVol, sellVol, buyCount, sellCount: Math.max(0, b.count - buyCount) };
          };
          const buy = bars.map((b) => { const a = split(b); return { value: avg ? (a.buyCount > 0 ? (a.buyVol / a.buyCount) * b.close : 0) : a.buyCount }; });
          const sell = bars.map((b) => { const a = split(b); const v = avg ? (a.sellCount > 0 ? (a.sellVol / a.sellCount) * b.close : 0) : a.sellCount; return { value: v > 0 ? -v : 0 }; });
          assert.deepStrictEqual(plot(prepared, "buy"), legacyPoints(bars, buy, start, end), `${label} buy`);
          assert.deepStrictEqual(plot(prepared, "sell"), legacyPoints(bars, sell, start, end), `${label} sell`);
        }
      }
    }
  }
});

// --- #129 -------------------------------------------------------------------------

function naiveStdDev(values, period) {
  const window = [];
  const out = [];
  for (const raw of values) {
    window.push(Number.isFinite(raw) ? raw : NaN);
    if (window.length > period) window.shift();
    if (window.length === period && window.every(Number.isFinite)) {
      const mean = window.reduce((s, x) => s + x, 0) / period;
      out.push(Math.sqrt(window.reduce((s, x) => s + (x - mean) ** 2, 0) / period));
    } else out.push(null);
  }
  return out;
}
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
function assertClose(actual, expected, label, tol = 1e-9) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === null) { assert.equal(actual[i], null, `${label}[${i}] null`); continue; }
    assert.notEqual(actual[i], null, `${label}[${i}] not null`);
    const scale = Math.max(Math.abs(expected[i]), 1e-12);
    assert.ok(Math.abs(actual[i] - expected[i]) / scale <= tol || Math.abs(actual[i] - expected[i]) <= 1e-12, `${label}[${i}]: ${actual[i]} vs ${expected[i]}`);
  }
}

test("rollingStdDev matches the naive oracle (random, trending 100 -> 100000, NaN gaps)", () => {
  const rnd = lcg(42);
  const random = Array.from({ length: 2000 }, () => 50_000 + rnd() * 100);
  const trending = Array.from({ length: 3000 }, (_, i) => 100 * Math.pow(1000, i / 2999) + rnd());
  const constant = Array.from({ length: 200 }, () => 123.456);
  const gaps = random.map((v, i) => (i % 97 === 5 || (i > 800 && i < 830) ? NaN : v));
  gaps[0] = NaN; gaps[1] = Infinity;
  for (const [name, values] of Object.entries({ random, trending, constant, gaps, short: [1, 2, 3] })) {
    for (const period of [1, 2, 20, 500, 5000]) {
      assertClose(rollingStdDev(values, period), naiveStdDev(values, period), `${name} p=${period}`);
    }
  }
  assert.deepStrictEqual(rollingStdDev([], 5), []);
});

test("cci is bit-identical to the previous slice/reduce implementation", () => {
  const rnd = lcg(7);
  const bars = Array.from({ length: 1500 }, (_, i) => { const c = 100 + rnd() * 5 + i * 0.1; return { time: i, open: c, high: c + rnd(), low: c - rnd(), close: c, volume: 1 }; });
  bars[40] = { time: 40, open: 5, high: 5, low: 5, close: 5, volume: 1 };
  bars.splice(600, 30, ...Array.from({ length: 30 }, (_, k) => ({ time: 600 + k, open: 9, high: 9, low: 9, close: 9, volume: 1 })));
  const reference = (period) => {
    const typical = bars.map((b) => (b.high + b.low + b.close) / 3);
    const sma = simpleMovingAverage(typical, period);
    return bars.map((b, index) => {
      const middle = sma[index];
      if (middle === null || index + 1 < period) return { time: b.time, value: null };
      const w = typical.slice(index + 1 - period, index + 1);
      const md = w.reduce((s, v) => s + Math.abs(v - middle), 0) / period;
      return { time: b.time, value: md > 0 ? (typical[index] - middle) / (0.015 * md) : null };
    });
  };
  for (const period of [1, 2, 20, 300, 2000]) assert.deepStrictEqual(cci(bars, period), reference(period), `p=${period}`);
});

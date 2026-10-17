import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateVwapSeries,
  calendarPeriodStart,
} from "../dist/core/analysis/vwap.js";

globalThis.$state = (value) => value;
const {
  normalizeVwapLines,
  vwapIndicatorDefinition,
} = await import("../dist/features/indicators/builtins/vwapIndicator.js");

function bar(time, price, volume = 1) {
  return {
    startTime: time, open: price, high: price, low: price, close: price,
    volume, delta: 0, count: 1, cells: new Map(), hasRef: true,
  };
}

function definition(id) {
  const DEFS = {
    "current-daily": { id: "current-daily", label: "D-VWAP", family: "current", color: "#66bb6a", period: "daily" },
    "previous-monthly": { id: "previous-monthly", label: "PM-VWAP", family: "previous", color: "#8e24aa", period: "monthly" },
  };
  return DEFS[id];
}

test("calendar periods use UTC and Monday week starts", () => {
  const time = Date.UTC(2026, 6, 17, 14);
  assert.equal(calendarPeriodStart(time, "daily"), Date.UTC(2026, 6, 17));
  assert.equal(calendarPeriodStart(time, "weekly"), Date.UTC(2026, 6, 13));
  assert.equal(calendarPeriodStart(time, "quarterly"), Date.UTC(2026, 6, 1));
  assert.equal(calendarPeriodStart(time, "half-yearly"), Date.UTC(2026, 6, 1));
  assert.equal(calendarPeriodStart(time, "yearly"), Date.UTC(2026, 0, 1));
});

test("current daily VWAP resets at midnight UTC", () => {
  const day = Date.UTC(2026, 5, 19);
  const [series] = calculateVwapSeries([
    bar(day, 100, 1),
    bar(day + 60_000, 200, 3),
    bar(day + 86_400_000, 300, 1),
  ], [definition("current-daily")]);
  assert.equal(series.points[1].value, 175);
  assert.equal(series.points[2].value, 300);
});

test("previous month VWAP is constant through the following month", () => {
  const [series] = calculateVwapSeries([
    bar(Date.UTC(2026, 0, 1), 100, 1),
    bar(Date.UTC(2026, 0, 2), 200, 1),
    bar(Date.UTC(2026, 1, 1), 300, 1),
    bar(Date.UTC(2026, 1, 2), 400, 1),
  ], [definition("previous-monthly")]);
  assert.equal(series.points[2].value, 150);
  assert.equal(series.points[3].value, 150);
});

test("rolling VWAP stays unavailable until the full window is covered", () => {
  const day = 86_400_000;
  const [series] = calculateVwapSeries([
    bar(0, 100), bar(day, 200), bar(2 * day, 300),
  ], [{ id: "rolling-24h", label: "R24H", family: "rolling", color: "#fff", windowMs: day }]);
  assert.equal(series.points[0].value, null);
  assert.equal(series.points[1].value, 150);
  assert.equal(series.points[2].value, 250);
});

// (26) rollingSeries' pv/volume accumulators add a bar in and, once it leaves the trailing
// window, subtract it back out -- pv sits around typicalPrice * volume (~1e9 for a liquid
// market), where a plain float `+=`/`-=` running total drifts measurably after thousands of
// slides. This series is built so the analytically correct VWAP is exactly `price` at every
// complete point regardless of window position: typicalPrice is a constant integer (so pv is
// always price * volume, no float noise from averaging high/low/close), and volume
// alternates +1/-1 around 20000 so any even-length window's perturbations cancel exactly.
// Any measured deviation from `price` is therefore pure accumulation error, which
// addCompensated (Kahan-Neumaier) must keep bounded even after ~7000 add/subtract cycles.
test("rolling VWAP pv/volume accumulation drift is bounded over a long adversarial series", () => {
  const barMs = 60_000;
  const windowBars = 1000; // even, so the alternating volume perturbation cancels exactly
  const totalBars = 8_000; // window slides ~7000 times
  const price = 45231;
  const bars = [];
  for (let i = 0; i < totalBars; i++) {
    const volume = 20_000 + (i % 2 === 0 ? 1 : -1);
    bars.push({
      startTime: i * barMs, open: price, high: price, low: price, close: price,
      volume, delta: 0, count: 1, cells: new Map(), hasRef: true,
    });
  }
  const [series] = calculateVwapSeries(bars, [
    { id: "rolling-test", label: "test", family: "rolling", color: "#fff", windowMs: windowBars * barMs },
  ]);
  for (const i of [windowBars, 2_000, 5_000, totalBars - 1]) {
    assert.ok(series.points[i].value !== null, `point ${i} should be a complete window`);
    assert.ok(
      Math.abs(series.points[i].value - price) < 1e-6,
      `drift at index ${i}: expected ${price}, got ${series.points[i].value}`
    );
  }
});

test("legacy VWAP settings normalize to one enabled line", () => {
  assert.deepEqual(normalizeVwapLines({
    family: "previous",
    period: "weekly",
    rollingWindowDays: 7,
    color: "#123456",
    showBands: true,
    bandSigma: 2,
    bandColor: "#abcdef",
  }), [{
    id: "legacy-0",
    enabled: true,
    family: "previous",
    period: "weekly",
    rollingWindowDays: 7,
    color: "#123456",
    showBands: true,
    bandSigma: 2,
    bandColor: "#abcdef",
  }]);
});

test("VWAP indicator skips disabled lines and emits stable keys for each enabled line", () => {
  const bars = [bar(0, 100), bar(86_400_000, 200)];
  const settings = {
    lines: [
      { id: "disabled", enabled: false, family: "current", period: "daily", rollingWindowDays: 1, color: "#111111", showBands: false, bandSigma: 1, bandColor: "#aaaaaa" },
      { id: "daily", enabled: true, family: "current", period: "daily", rollingWindowDays: 1, color: "#222222", showBands: true, bandSigma: 2, bandColor: "#bbbbbb" },
      { id: "rolling", enabled: true, family: "rolling", period: "daily", rollingWindowDays: 1, color: "#333333", showBands: false, bandSigma: 1, bandColor: "#cccccc" },
    ],
    lineWidth: 1.5,
    showLastValueLabel: true,
    showPlotLabel: true,
    showChartLabels: true,
  };
  const prepared = vwapIndicatorDefinition.prepareData({
    range: [0, bars.length],
    series: {
      length: bars.length,
      revision: 1,
      structureRevision: 1,
      list: () => [...bars],
      listReadonly: () => bars,
    },
    instance: { id: "vwap-test", visible: true },
    settings,
  });

  assert.equal(prepared.status, "ok");
  assert.deepEqual(prepared.meta.series.map((series) => series.key), [
    "vwap-daily",
    "vwap-daily-upper",
    "vwap-daily-lower",
    "vwap-rolling",
  ]);
  assert.equal(prepared.meta.series[0].chartLabel, "Current Daily VWAP");
  assert.equal(prepared.meta.series[3].chartLabel, "Rolling 1D VWAP");
});

test("VWAP price overlay clips drawing and chart labels to the main plot", () => {
  const events = [];
  const canvas = {
    save() { events.push(["save"]); },
    restore() { events.push(["restore"]); },
    beginPath() { events.push(["beginPath"]); },
    rect(x, y, width, height) { events.push(["rect", x, y, width, height]); },
    clip() { events.push(["clip"]); },
    moveTo() {}, lineTo() {}, stroke() {}, fillText() {},
    measureText() { return { width: 40 }; },
    set lineJoin(_) {}, set lineCap(_) {}, set strokeStyle(_) {}, set lineWidth(_) {},
    set font(_) {}, set fillStyle(_) {},
  };
  const view = {
    area: { left: 5, top: 10, width: 300, height: 120 },
    colWidth: 8,
    xOfIndex(index) { return 20 + index * 8; },
    yOfPrice(price) { return price === 50 ? 180 : 60; },
  };
  const prepared = {
    status: "ok",
    points: [],
    range: { min: 50, max: 100 },
    meta: {
      series: [{
        key: "vwap-current-monthly",
        label: "C Monthly",
        chartLabel: "Current Monthly VWAP",
        color: "#55cc77",
        points: [{ index: 0, time: 0, value: 100 }, { index: 1, time: 1, value: 50 }],
      }],
    },
  };

  vwapIndicatorDefinition.drawPriceOverlay({
    ctx: canvas,
    view,
    settings: { lineWidth: 1.5, showLastValueLabel: false, showChartLabels: true },
    instance: { id: "vwap-pane-clip", visible: true },
  }, prepared);

  const rectIndex = events.findIndex((event) => event[0] === "rect");
  assert.deepEqual(events[rectIndex], ["rect", 5, 10, 300, 120]);
  assert.equal(events[rectIndex + 1][0], "clip");
});

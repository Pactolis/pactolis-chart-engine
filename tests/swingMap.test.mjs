import test from "node:test";
import assert from "node:assert/strict";
import { detectSwings, IncrementalSwingDetector } from "../dist/core/analysis/swings.js";
import { swingMapIndicatorDefinition as definition } from "../dist/features/indicators/builtins/swingMap.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { createIndicatorInstance } from "../dist/features/indicators/registry.js";

// Hand-authored alternating extrema; price changes exercise HH/HL/LH/LL.
const prices = [5, 10, 6, 12, 7, 9, 4, 8, 3, 7, 5];
const bars = prices.map((price, i) => ({ startTime: i * 60_000, open: price, high: price + 1, low: price - 1,
  close: price, volume: 1, delta: 0, count: 1, cells: new Map(), hasRef: true }));
const expected = [
  { index: 1, price: 11, kind: "high", confirmedAtIndex: 2 },
  { index: 2, price: 5, kind: "low", confirmedAtIndex: 3 },
  { index: 3, price: 13, kind: "high", confirmedAtIndex: 4 },
  { index: 4, price: 6, kind: "low", confirmedAtIndex: 5 },
  { index: 5, price: 10, kind: "high", confirmedAtIndex: 6 },
  { index: 6, price: 3, kind: "low", confirmedAtIndex: 7 },
  { index: 7, price: 9, kind: "high", confirmedAtIndex: 8 },
  { index: 8, price: 2, kind: "low", confirmedAtIndex: 9 },
  { index: 9, price: 8, kind: "high", confirmedAtIndex: 10 },
];
function context(data = bars, settings = {}) {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars(structuredClone(data));
  const instance = createIndicatorInstance("swing-map", 0);
  instance.settings = { ...instance.settings, left: 1, right: 1, ...settings };
  return { ctx: {}, view: {}, rect: { top: 0, height: 300 }, range: [0, data.length], series, instance, settings: instance.settings, requestRefresh() {} };
}

test("pure swing detector matches hand-authored pivots and confirmation indices", () => {
  assert.deepEqual(detectSwings(bars, 1, 1), expected);
  assert.deepEqual(detectSwings([], 5, 5), []);
  assert.deepEqual(detectSwings([{ high: 10, low: 5 }], 1, 1), []);
  const plateau = [{ high: 1, low: 0 }, { high: 3, low: 1 }, { high: 3, low: 2 }, { high: 2, low: 1 }];
  assert.deepEqual(detectSwings(plateau, 1, 1).filter((pivot) => pivot.kind === "high").map((pivot) => pivot.index), [1]);
});

test("bar-by-bar growth never exposes a pivot before confirmation or changes a confirmed pivot", () => {
  let previous = [];
  for (let length = 1; length <= bars.length; length++) {
    const result = detectSwings(bars.slice(0, length), 1, 1);
    assert.ok(result.every((pivot) => pivot.confirmedAtIndex < length));
    for (const pivot of previous) assert.ok(result.some((item) => JSON.stringify(item) === JSON.stringify(pivot)));
    assert.deepEqual(result, expected.filter((pivot) => pivot.confirmedAtIndex < length));
    previous = result;
  }
});

test("incremental append and mutable-tail results exactly equal full scan with bounded windows", () => {
  const detector = new IncrementalSwingDetector();
  const stream = [];
  for (const bar of bars) {
    stream.push({ ...bar });
    assert.deepEqual(detector.update(stream, 1, 1, "append"), detectSwings(stream, 1, 1));
    const before = detector.evaluatedWindows;
    const saved = stream.at(-1).high;
    stream.at(-1).high += 2;
    assert.deepEqual(detector.update(stream, 1, 1, "tail"), detectSwings(stream, 1, 1));
    assert.ok(detector.evaluatedWindows - before <= 1, "one final left+right window per tail tick");
    stream.at(-1).high = saved;
    assert.deepEqual(detector.update(stream, 1, 1, "tail"), detectSwings(stream, 1, 1));
  }
});

test("Swing Map labels use earlier same-kind pivots, retain offscreen history and apply step tolerance", () => {
  const ctx = context();
  assert.deepEqual(definition.prepareData(ctx).points.map((point) => point.label), ["H", "L", "HH", "HL", "LH", "LL", "LH", "LL"]);
  ctx.range = [5, bars.length];
  assert.equal(definition.prepareData(ctx).points[0].label, "LH", "classification retains offscreen previous high");
  const equal = context(bars.map((bar, i) => i === 3 ? { ...bar, high: 11.5, open: 11.25, close: 11.25 } : bar), { equalityToleranceSteps: 1 });
  assert.ok(!definition.prepareData(equal).points.some((point) => point.index === 3), "same-price marker within one priceStep is not repeated");
});

test("replay as-of excludes future bars and includes only completed confirmation bars", () => {
  const ctx = context();
  for (let closed = 0; closed <= bars.length; closed++) {
    ctx.chart = { market: "BINANCE_FUTURES:btcusdt", timeframe: "1m", intervalMs: 60_000, asOfTime: closed * 60_000 };
    const result = definition.prepareData(ctx).points;
    assert.deepEqual(result.map(({ label, ...pivot }) => pivot), expected.filter((pivot) => pivot.confirmedAtIndex < closed));
  }
  ctx.chart.asOfTime = 4 * 60_000;
  assert.deepEqual(definition.prepareData(ctx).points.map((point) => point.index), [1, 2], "backward seek discards future pivots");
});

test("live open-bar ticks cannot confirm or repaint existing pivots and do not rescan history", () => {
  const ctx = context();
  const before = definition.prepareData(ctx);
  for (let i = 0; i < 5; i++) {
    ctx.series.addTrades([{ time: 10 * 60_000 + i + 1, price: 100 + i, qty: 1, isBuy: true, id: `live-${i}` }]);
    const after = definition.prepareData(ctx);
    assert.deepEqual(after.points, before.points);
    assert.equal(after.meta.evaluatedWindows, before.meta.evaluatedWindows);
  }
});

test("unconfirmed candidates are opt-in, faint and explicitly labeled; visible pivots alone paint", () => {
  const ctx = context(bars.slice(0, 4));
  assert.equal(definition.defaultSettings().showUnconfirmed, false);
  assert.ok(definition.prepareData(ctx).points.every((point) => !point.unconfirmed));
  ctx.settings.showUnconfirmed = true;
  const prepared = definition.prepareData(ctx);
  assert.ok(prepared.points.some((point) => point.unconfirmed && point.label.includes("unconfirmed")));
  const marks = [];
  const labels = [];
  ctx.view = { area: { left: 0, top: 0, width: 800, height: 400 }, colWidth: 10, xOfIndex: (i) => i * 10, yOfPrice: (p) => 400 - p };
  ctx.ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, globalAlpha: 1,
    fillRect(...args) { marks.push({ alpha: this.globalAlpha, args }); }, fillText(text) { labels.push(text); } };
  definition.drawPriceOverlay(ctx, prepared);
  assert.equal(marks.length, prepared.points.length);
  assert.ok(marks.some((mark) => mark.alpha === 0.35));
  assert.ok(labels.includes("H? (unconfirmed)"));
});

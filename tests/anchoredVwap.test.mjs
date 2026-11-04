import test from "node:test";
import assert from "node:assert/strict";
import { calculateAnchoredVwap } from "../dist/core/analysis/anchoredVwap.js";
import { drawAnalysisDrawings } from "../dist/core/render/analysisDrawings.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";

test("anchored vwap ignores candles before the anchor", () => {
  const bars = [
    { startTime: 0, open: 1, high: 2, low: 1, close: 2, volume: 10, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 1000, open: 2, high: 4, low: 2, close: 4, volume: 20, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 2000, open: 3, high: 5, low: 3, close: 5, volume: 30, delta: 0, count: 1, hasRef: true, cells: new Map() },
  ];
  const result = calculateAnchoredVwap(bars, 1000);
  assert.equal(result.points.length, 2);
  assert.equal(result.points[0].time, 1000);
  assert.ok(result.points[1].value > result.points[0].value);
});

test("anchored vwap binary search lower-bound handles between-bars and boundary anchors", () => {
  const bars = [
    { startTime: 1000, open: 1, high: 2, low: 1, close: 2, volume: 10, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 2000, open: 2, high: 4, low: 2, close: 4, volume: 20, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 3000, open: 3, high: 5, low: 3, close: 5, volume: 30, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 4000, open: 4, high: 6, low: 4, close: 6, volume: 40, delta: 0, count: 1, hasRef: true, cells: new Map() },
  ];

  // Anchor between bar 0 and bar 1: starts at bar 1 (startTime 2000)
  const resultMid = calculateAnchoredVwap(bars, 1500);
  assert.equal(resultMid.points.length, 3);
  assert.equal(resultMid.points[0].time, 2000);

  // Anchor before all bars: includes all 4 bars
  const resultBefore = calculateAnchoredVwap(bars, 500);
  assert.equal(resultBefore.points.length, 4);
  assert.equal(resultBefore.points[0].time, 1000);

  // Anchor after all bars: empty points
  const resultAfter = calculateAnchoredVwap(bars, 5000);
  assert.equal(resultAfter.points.length, 0);
  assert.equal(resultAfter.available, false);

  // endTime parameter stops iteration early
  const resultEnd = calculateAnchoredVwap(bars, 1000, 2500);
  assert.equal(resultEnd.points.length, 2);
  assert.equal(resultEnd.points[0].time, 1000);
  assert.equal(resultEnd.points[1].time, 2000);
});

test("Issue #56: nonTailRevision invalidates AVWAP prefix cache on past bar mutation", () => {
  const series = new FootprintSeries({ intervalMs: 60000, priceStep: 1 });
  series.loadBars([
    { startTime: 0, open: 100, high: 100, low: 100, close: 100, volume: 10, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 60000, open: 200, high: 200, low: 200, close: 200, volume: 10, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 120000, open: 300, high: 300, low: 300, close: 300, volume: 10, delta: 0, count: 1, hasRef: true, cells: new Map() },
  ]);

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 1000;
  view.pricePerPx = 1;

  const time = {
    indexForTime: (t) => series.indexOfTime(t),
    timeForIndex: (idx) => series.timeOfIndex(idx),
  };

  const dummyCtx = {
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    setLineDash() {},
  };

  const drawing = {
    id: "avwap-test",
    type: "anchored-vwap",
    points: [{ time: 0, price: 100 }],
    market: "BTC",
    visible: true,
    color: "#ffffff",
    showPriceLabel: true,
  };

  let renderedAvwap = null;
  const onLineObject = (price) => {
    renderedAvwap = price;
  };

  // 1. Initial draw: (100*10 + 200*10 + 300*10) / 30 = 6000 / 30 = 200
  drawAnalysisDrawings(dummyCtx, view, series, time, [drawing], "BTC", onLineObject);
  assert.equal(renderedAvwap, 200);

  // 2. Modify first bar via upsertBar (OHLC = 400)
  series.upsertBar({
    startTime: 0,
    open: 400,
    high: 400,
    low: 400,
    close: 400,
    volume: 10,
    delta: 0,
    count: 1,
    hasRef: true,
    cells: new Map(),
  });
  // AVWAP should now be: (400*10 + 200*10 + 300*10) / 30 = 9000 / 30 = 300
  drawAnalysisDrawings(dummyCtx, view, series, time, [drawing], "BTC", onLineObject);
  assert.equal(renderedAvwap, 300);

  // 3. Modify first bar via replaceRange (OHLC = 500)
  series.replaceRange(0, 60000, [{
    startTime: 0,
    open: 500,
    high: 500,
    low: 500,
    close: 500,
    volume: 10,
    delta: 0,
    count: 1,
    hasRef: true,
    cells: new Map(),
  }]);
  // AVWAP should now be: (500*10 + 200*10 + 300*10) / 30 = 10000 / 30 = 333.3333333333333
  drawAnalysisDrawings(dummyCtx, view, series, time, [drawing], "BTC", onLineObject);
  assert.equal(renderedAvwap, 10000 / 30);

  // 4. Tail update on last candle (startTime = 120000)
  // Non-tail revision must not change, and O(1) tail update matches calculateAnchoredVwap oracle
  const nonTailBefore = series.nonTailRevision;
  series.upsertBar({
    startTime: 120000,
    open: 300,
    high: 370,
    low: 250,
    close: 360,
    volume: 20,
    delta: 0,
    count: 2,
    hasRef: true,
    cells: new Map(),
  });
  assert.equal(series.nonTailRevision, nonTailBefore, "tail bar update must not bump nonTailRevision");

  drawAnalysisDrawings(dummyCtx, view, series, time, [drawing], "BTC", onLineObject);
  const oracle = calculateAnchoredVwap(series.listReadonly(), 0);
  const oracleLastValue = oracle.points[oracle.points.length - 1].value;
  assert.equal(renderedAvwap, oracleLastValue, "O(1) tail update matches full calculation oracle");
});

test("Issue #76: appending one bar only reads the new tail after priming AVWAP cache", () => {
  const series = new FootprintSeries({ intervalMs: 60000, priceStep: 1 });
  const makeBar = (index) => ({
    startTime: index * 60000, open: 100, high: 101, low: 99, close: 100,
    volume: 10, delta: 0, count: 1, hasRef: true, cells: new Map(),
  });
  series.loadBars(Array.from({ length: 1000 }, (_, index) => makeBar(index)));
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.priceTop = 1000;
  view.pricePerPx = 1;
  const time = {
    indexForTime: (t) => series.indexOfTime(t),
    timeForIndex: (idx) => series.timeOfIndex(idx),
  };
  const ctx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {} };
  const drawing = { id: "append-cache", type: "anchored-vwap", points: [{ time: 0, price: 100 }], market: "BTC", visible: true, color: "#fff", showPriceLabel: true };
  const originalListReadonly = series.listReadonly.bind(series);
  let reads = 0;
  series.listReadonly = () => new Proxy(originalListReadonly(), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  drawAnalysisDrawings(ctx, view, series, time, [drawing], "BTC");
  reads = 0;
  series.upsertBar({ ...makeBar(1000), open: 120, high: 120, low: 120, close: 120 });
  let renderedValue = null;
  drawAnalysisDrawings(ctx, view, series, time, [drawing], "BTC", (price) => { renderedValue = price; });
  assert.ok(reads <= 4, `append should inspect only the current tail, observed ${reads} indexed reads`);
  assert.equal(renderedValue, (1000 * 100 + 120) / 1001, "incremental result matches the direct weighted-price invariant");
});

test("Issue #76: cached AVWAP append keeps every plotted point equal to full oracle", () => {
  const series = new FootprintSeries({ intervalMs: 60000, priceStep: 1 });
  const makeBar = (index, price, volume) => ({
    startTime: index * 60000, open: price, high: price, low: price, close: price,
    volume, delta: 0, count: 1, hasRef: true, cells: new Map(),
  });
  series.loadBars([makeBar(0, 10, 2), makeBar(1, 20, 3), makeBar(2, 30, 0)]);
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.priceTop = 1000;
  view.pricePerPx = 1;
  const time = { indexForTime: (t) => series.indexOfTime(t), timeForIndex: (i) => series.timeOfIndex(i) };
  let path = [];
  const ctx = {
    save() {}, restore() {}, beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); },
    stroke() {}, setLineDash() {},
  };
  const drawing = { id: "append-oracle", type: "anchored-vwap", points: [{ time: 0, price: 10 }], market: "BTC", visible: true, color: "#fff" };
  const renderAndCheck = () => {
    drawAnalysisDrawings(ctx, view, series, time, [drawing], "BTC");
    const oracle = calculateAnchoredVwap(series.listReadonly(), drawing.points[0].time);
    const expected = oracle.points.filter((point) => point.value !== null).map((point) => [
      view.xOfIndex(series.indexOfTime(point.time)) + view.colWidth / 2,
      view.yOfPrice(point.value),
    ]);
    assert.deepEqual(path, expected, "complete rendered segment must match full AVWAP oracle");
  };
  renderAndCheck();
  series.upsertBar(makeBar(3, 40, 4));
  renderAndCheck();
  // Correct the completed tail without a redraw, then append; prefix must include correction.
  series.upsertBar(makeBar(3, 50, 5));
  series.upsertBar(makeBar(4, 60, 0));
  renderAndCheck();
  series.upsertBar(makeBar(1, 25, 3));
  series.upsertBar(makeBar(5, 70, 7));
  renderAndCheck();
  // Changing anchor drawing identity/time invalidates cached prefix; zero-volume boundary stays null.
  drawing.points[0].time = 6 * 60000;
  series.upsertBar(makeBar(6, 80, 0));
  renderAndCheck();
  series.upsertBar(makeBar(7, 90, 9));
  renderAndCheck();
});
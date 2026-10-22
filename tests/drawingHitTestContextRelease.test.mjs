import test from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { View } from "../dist/core/engine/view.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";

// The host shares one DrawingManager between all charts. It remembers the view and the time
// mapping of the chart that drew or hit-tested last, and the time mapping reaches that chart's
// series. releaseHitTestContext is how a disposed chart lets go of them.

const MARKET = "BINANCE_FUTURES:btcusdt";
const LINE_PRICE = 150;
// A data-space point nowhere near the line's two anchors, so only the screen mapping can hit it.
const FAR_POINT = { time: 5_000, price: LINE_PRICE };

// gc() without a command-line flag; the reachability test needs a real collection.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

function chart() {
  const view = new View();
  view.area = { left: 0, top: 0, width: 400, height: 300 };
  view.priceTop = 200;
  view.pricePerPx = 1;
  // Stands in for the chart's series: reachable only through the time mapping the manager keeps.
  const series = { bars: new Float64Array(1 << 16) };
  const time = {
    indexForTime: (value) => Math.min(value, series.bars.length),
    timeForIndex: (index) => index,
  };
  return { view, series, time };
}

function managerWithLine() {
  const manager = new DrawingManager(() => {});
  manager.replace([{
    id: "line",
    type: "horizontal",
    points: [{ time: 0, price: LINE_PRICE }, { time: 10_000, price: LINE_PRICE }],
    color: "#fff",
    lineWidth: 1,
    locked: false,
    visible: true,
    market: MARKET,
  }]);
  manager.setMarket(MARKET);
  return manager;
}

// A pointer three pixels off the line, in the given chart's screen space.
function nearLine(view) {
  return { x: 100, y: view.yOfPrice(LINE_PRICE) + 3 };
}

test("releasing a chart's hit-test context stops hit tests from using its mapping", () => {
  const manager = managerWithLine();
  const a = chart();
  manager.setHitTestContext(a.view, a.time);
  assert.equal(manager.hitTestAt(FAR_POINT, nearLine(a.view))?.id, "line");

  manager.releaseHitTestContext(a.view);
  assert.equal(manager.lastView, null);
  assert.equal(manager.lastTime, null);
  // Without a mapping the hit test compares data-space points, which are far apart here.
  assert.equal(manager.hitTestAt(FAR_POINT, nearLine(a.view)), null);
});

test("releasing also drops the context that render captured", () => {
  const manager = new DrawingManager(() => {});
  const a = chart();
  manager.render({ save() {}, restore() {} }, a.view, a.time);
  assert.equal(manager.lastView, a.view);
  assert.equal(manager.lastTime, a.time);

  manager.releaseHitTestContext(a.view);
  assert.equal(manager.lastView, null);
  assert.equal(manager.lastTime, null);
});

test("releasing a chart keeps the context of the chart that drew after it", () => {
  const manager = managerWithLine();
  const a = chart();
  const b = chart();
  manager.setHitTestContext(a.view, a.time);
  manager.setHitTestContext(b.view, b.time);

  manager.releaseHitTestContext(a.view);
  assert.equal(manager.lastView, b.view);
  assert.equal(manager.lastTime, b.time);
  assert.equal(manager.hitTestAt(FAR_POINT, nearLine(b.view))?.id, "line");

  manager.releaseHitTestContext(b.view);
  assert.equal(manager.lastView, null);
  assert.equal(manager.lastTime, null);
});

test("releasing before any chart drew does nothing", () => {
  const manager = new DrawingManager(() => {});
  manager.releaseHitTestContext(chart().view);
  assert.equal(manager.lastView, null);
  assert.equal(manager.lastTime, null);
});

// Reachability is read through a FinalizationRegistry after forced collections.
function tracker() {
  const finalized = new Set();
  const registry = new FinalizationRegistry((label) => finalized.add(label));
  return {
    track: (target, label) => registry.register(target, label),
    async collected(label, attempts) {
      for (let attempt = 0; attempt < attempts && !finalized.has(label); attempt++) {
        gc();
        // Finalization callbacks run in a task after the collection that found the object dead.
        await delay(10);
      }
      return finalized.has(label);
    },
  };
}

// Once this returns, the series is reachable only through the manager. The caller keeps the
// view, as a chart keeps its own view until it is disposed.
function drawOnce(manager, objects) {
  const { view, series, time } = chart();
  objects.track(series, "series");
  manager.setHitTestContext(view, time);
  return view;
}

test("a chart's series is collectable once its context is released, and not before", async () => {
  const manager = new DrawingManager(() => {});
  const objects = tracker();
  const view = drawOnce(manager, objects);

  // Control: the manager still holds the mapping, so the series must survive collections.
  // It shows that the check after the release can tell a held series from a released one.
  assert.equal(await objects.collected("series", 5), false, "the series was collected while the manager held it");

  manager.releaseHitTestContext(view);
  assert.equal(await objects.collected("series", 50), true, "the series is still reachable after the release");
});

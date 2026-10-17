import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";

const INTERVAL_MS = 60_000;
const T0 = Date.UTC(2024, 0, 1);

function makeBar(startTime) {
  return {
    startTime,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  };
}

test("repair barriers never remove candles from the visible order", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL_MS, priceStep: 1 });
  const starts = Array.from({ length: 4 }, (_, index) => T0 + index * INTERVAL_MS);
  series.loadBars(starts.map(makeBar));

  const baseOrder = series.visibleOrder();
  series.beginRepairBarrier([starts[1]]);

  assert.equal(series.visibleOrder(), baseOrder,
    "a footprint repair barrier must not rebuild or filter candle order");
  assert.equal(series.length, 4);
  assert.deepEqual(series.listReadonly().map((bar) => bar.startTime), starts);

  series.beginRepairBarrier([starts[2]]);
  assert.equal(series.visibleOrder(), baseOrder,
    "additional footprint barriers must leave candle visibility unchanged");
  assert.equal(series.length, 4);

  series.releaseRepairBarriers([starts[1]]);
  assert.equal(series.visibleOrder(), baseOrder);
  assert.equal(series.length, 4);

  series.releaseRepairBarriers();
  assert.equal(series.visibleOrder(), series.order);
  assert.equal(series.length, 4);
});

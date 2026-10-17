import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { levelStartX } from "../dist/core/render/levelAnchor.js";

function bar(startTime) {
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
  };
}

test("automatic level anchors use the series time index across chunk gaps", () => {
  const intervalMs = 60_000;
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars([bar(0), bar(intervalMs), bar(intervalMs * 10)]);
  const view = new View({ barSpacing: 20 });
  view.area = { left: 0, top: 0, width: 500, height: 300 };

  assert.equal(series.indexOfTime(intervalMs * 10), 2);
  assert.equal(levelStartX(view, series, intervalMs * 10), view.xOfIndex(2));
  assert.notEqual(levelStartX(view, series, intervalMs * 10), view.xOfIndex(10));
});

import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state = (value) => value;
const { tradeCountIndicatorDefinition } = await import("../dist/features/indicators/builtins/tradeCount.js");

function prepare(bar) {
  const bars = [bar];
  return tradeCountIndicatorDefinition.prepareData({
    range: [0, 1],
    series: { length: bars.length, list: () => [...bars], listReadonly: () => bars },
    instance: { visible: true },
    settings: {
      ...tradeCountIndicatorDefinition.defaultSettings(),
      mode: "avg-size",
      directional: true,
    },
  });
}

test("directional average trade size fills bars without footprint cells", () => {
  const prepared = prepare({
    startTime: 1, open: 100, high: 100, low: 100, close: 100,
    volume: 12, delta: 6, count: 6, cells: new Map(), hasRef: true,
  });
  const [buy, sell] = prepared.meta.series;
  assert.equal(buy.points[0].value, 180);
  assert.equal(sell.points[0].value, -300);
});

test("directional average trade size keeps exact footprint-side counts", () => {
  const prepared = prepare({
    startTime: 1, open: 100, high: 100, low: 100, close: 100,
    volume: 12, delta: 6, count: 6,
    cells: new Map([[100, { priceBin: 100, buyVol: 9, sellVol: 3, count: 6, buyCount: 3, sellCount: 3 }]]),
    hasRef: true,
  });
  const [buy, sell] = prepared.meta.series;
  assert.equal(buy.points[0].value, 300);
  assert.equal(sell.points[0].value, -100);
});

test("directional average trade size safely emits zero for an empty bar", () => {
  const prepared = prepare({
    startTime: 1, open: 100, high: 100, low: 100, close: 100,
    volume: 0, delta: 0, count: 0, cells: new Map(), hasRef: true,
  });
  const [buy, sell] = prepared.meta.series;
  assert.equal(buy.points[0].value, 0);
  assert.equal(sell.points[0].value, 0);
});

import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state = (value) => value;
const { barStatsIndicatorDefinition } = await import("../dist/features/indicators/builtins/barStats.js");

function bar(overrides) {
  return {
    startTime: 1, open: 100, high: 101, low: 99, close: 100,
    volume: 10, delta: 2, count: 5,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map(), hasRef: true,
    ...overrides,
  };
}

function prepare(bars) {
  return barStatsIndicatorDefinition.prepareData({
    range: [0, bars.length],
    series: { length: bars.length, list: () => [...bars], listReadonly: () => bars },
    instance: { visible: true },
    settings: { ...barStatsIndicatorDefinition.defaultSettings(), mode: "visible-sum" },
    view: { indexOfX: () => 0 },
  });
}

// Binance Vision's aggTrades archive has no liquidation flag, so a store-loaded bar's
// zero means "not measured" — reporting it as 0 / 0 claims more than the data supports.
test("history-only bars report liquidations as unmeasured", () => {
  const prepared = prepare([bar({ sources: ["history"] })]);
  assert.equal(prepared.meta.liquidationsMeasured, false);
});

test("a live bar in the range makes liquidations measured", () => {
  const prepared = prepare([bar({ sources: ["history"] }), bar({ startTime: 2, sources: ["live"] })]);
  assert.equal(prepared.meta.liquidationsMeasured, true);
});

test("live liquidation volumes still sum", () => {
  const prepared = prepare([
    bar({ sources: ["live"], liquidationBuyVol: 3, liquidationSellVol: 4 }),
  ]);
  assert.equal(prepared.meta.liquidationsMeasured, true);
  assert.equal(prepared.meta.liquidationBuyVol, 3);
  assert.equal(prepared.meta.liquidationSellVol, 4);
});

test("a bar with no sources is not treated as measured", () => {
  const prepared = prepare([bar({})]);
  assert.equal(prepared.meta.liquidationsMeasured, false);
});

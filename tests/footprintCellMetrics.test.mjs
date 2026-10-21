import test from "node:test";
import assert from "node:assert/strict";
import {
  cellAverageTradeSize,
  cellAverageTradeSizes,
  cellDeltaPercent,
  cellTradeCounts,
  quoteVolumeForBar,
} from "../dist/core/model/footprintCellMetrics.js";

test("cell trade counts prefer exact bid/ask counts", () => {
  const cell = { priceBin: 100, buyVol: 12, sellVol: 8, count: 99, buyCount: 7, sellCount: 3 };

  assert.deepEqual(cellTradeCounts(cell), { buy: 7, sell: 3, total: 10 });
  assert.equal(cellAverageTradeSize(cell), 2);
  assert.deepEqual(cellAverageTradeSizes(cell), { buy: 12 / 7, sell: 8 / 3, total: 2 });
  assert.equal(cellDeltaPercent(cell), 20);
});

test("cell trade counts split old total-only caches by volume ratio", () => {
  const cell = { priceBin: 100, buyVol: 75, sellVol: 25, count: 20 };

  assert.deepEqual(cellTradeCounts(cell), { buy: 15, sell: 5, total: 20 });
  assert.deepEqual(cellAverageTradeSizes(cell), { buy: 5, sell: 5, total: 5 });
});

test("quoteVolumeForBar handles full cells, partial cells, and liquidation-only cells", () => {
  const fullBar = {
    close: 105,
    volume: 3,
    cells: new Map([[100, { priceBin: 100, buyVol: 1, sellVol: 2 }]]),
  };
  assert.equal(quoteVolumeForBar(fullBar), 300);

  const partialBar = {
    close: 105,
    volume: 5,
    cells: new Map([[100, { priceBin: 100, buyVol: 1, sellVol: 2 }]]),
  };
  assert.equal(quoteVolumeForBar(partialBar), 510);

  const liquidationOnlyBar = {
    close: 105,
    volume: 3,
    cells: new Map([[100, { priceBin: 100, buyVol: 0, sellVol: 0, liquidationBuyVol: 4 }]]),
  };
  assert.equal(quoteVolumeForBar(liquidationOnlyBar), 315);
});

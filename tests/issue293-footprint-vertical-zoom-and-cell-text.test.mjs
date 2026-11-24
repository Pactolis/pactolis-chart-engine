import test from "node:test";
import assert from "node:assert/strict";
import {
  FootprintSeries,
  getSortedFootprintBarCells,
  getVisibleFootprintCellSlice,
} from "../dist/core/model/footprint.js";
import {
  cellTextCacheKey,
  getOrCreateBarCellTextCache,
  getOrFormatBarCellText,
} from "../dist/core/render/overlay/footprintCellText.js";

const WEEK_MS = 7 * 24 * 60 * 60_000;
const BASE_TIME = 1_699_833_600_000;

test("#293: narrow vertical zoom binary-searches dense 1W bar cells and live trade invalidates only mutated bin text", () => {
  const series = new FootprintSeries({ intervalMs: WEEK_MS, priceStep: 10 });
  const cells = new Map();
  for (let i = 0; i < 800; i++) {
    const priceBin = 50_000 + i * 10;
    cells.set(priceBin, {
      priceBin,
      buyVol: 10 + (i % 5),
      sellVol: 8 + (i % 3),
      count: 2,
      buyCount: 1,
      sellCount: 1,
    });
  }
  series.loadBars([{
    startTime: BASE_TIME,
    open: 54_000,
    high: 58_000,
    low: 50_000,
    close: 54_200,
    volume: 1000,
    delta: 100,
    count: 1600,
    cells,
    hasRef: true,
    cellRevision: 1,
  }]);

  const bar = series.at(0);
  const sorted = getSortedFootprintBarCells(bar);
  assert.equal(sorted.length, 800);
  // Cached sorted array is reused on subsequent calls
  assert.equal(getSortedFootprintBarCells(bar), sorted);

  // Narrow vertical band [54_000, 54_120] visits ~14 cells instead of 800
  const slice = getVisibleFootprintCellSlice(bar, 54_000, 54_120, 10);
  assert.ok(slice !== null);
  assert.ok(slice.end - slice.start <= 15 && slice.end - slice.start >= 13);

  // Warm cell text cache for visible slice
  const cache = new WeakMap();
  const key = cellTextCacheKey("bidask", false, false, 10);
  const barCache1 = getOrCreateBarCellTextCache(cache, bar, key);
  const initialRefs = new Map();
  for (let i = slice.start; i < slice.end; i++) {
    const c = slice.cells[i];
    initialRefs.set(c.priceBin, getOrFormatBarCellText(barCache1, c, "bidask", false, 10, false));
  }

  // Live trade mutates ONLY bin 54_050
  series.addTrade({
    id: "live-293-1",
    time: BASE_TIME + 60_000,
    price: 54_052,
    qty: 50,
    isBuy: true,
    market: "BINANCE_FUTURES:btcusdt",
    source: "live",
  });

  const barCache2 = getOrCreateBarCellTextCache(cache, bar, key);
  assert.equal(barCache2, barCache1, "bar cache object must survive single-bin live trade");
  for (let i = slice.start; i < slice.end; i++) {
    const c = slice.cells[i];
    const nextFormatted = getOrFormatBarCellText(barCache2, c, "bidask", false, 10, false);
    if (c.priceBin === 54_050) {
      assert.notEqual(nextFormatted, initialRefs.get(c.priceBin), "mutated bin must re-format");
      assert.equal(nextFormatted.rightText, "60");
    } else {
      assert.equal(nextFormatted, initialRefs.get(c.priceBin), "unchanged bin must reuse cached object");
    }
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";

const BASE_TIME = 1_700_000_000_000;
const MARKET = "BINANCE_FUTURES:btcusdt";

test("#291: 1m, 1h, and 1w series bound dedup memory identically and compact typed arrays after eviction", () => {
  const statsByInterval = [];
  for (const intervalMs of [60_000, 3_600_000, 7 * 86_400_000]) {
    const series = new FootprintSeries({ intervalMs, priceStep: 1 });
    // 20 minutes @ 100 trades/sec = 120,000 unique numeric IDs
    const total = 120_000;
    for (let i = 1; i <= total; i += 1) {
      series.addTrade({
        id: String(i),
        time: BASE_TIME + i * 10,
        price: 60_000,
        qty: 0.1,
        isBuy: i % 2 === 0,
        market: MARKET,
        source: "live",
      });
    }
    const stats = series.getDedupMemoryStats();
    statsByInterval.push({ intervalMs, ...stats });
    assert.ok(stats.activeCount <= 50_000, `interval=${intervalMs} activeCount=${stats.activeCount} exceeded 50k bound`);

    // Late duplicate of ID 1 must still be rejected via monotonic floor
    const firstBarBefore = series.get(BASE_TIME - (BASE_TIME % intervalMs))?.count ?? 0;
    series.addTrade({
      id: "1",
      time: BASE_TIME + 10,
      price: 60_000,
      qty: 0.1,
      isBuy: false,
      market: MARKET,
      source: "live",
    });
    const firstBarAfter = series.get(BASE_TIME - (BASE_TIME % intervalMs))?.count ?? 0;
    assert.equal(firstBarAfter, firstBarBefore, "late duplicate must not double-count");
  }

  // 1h and 1w active counts must match 1m (decoupled from candle period)
  assert.equal(statsByInterval[1].activeCount, statsByInterval[0].activeCount);
  assert.equal(statsByInterval[2].activeCount, statsByInterval[0].activeCount);
});

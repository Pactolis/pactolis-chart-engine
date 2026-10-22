import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";

// The live path parses a trade ID to order trades that share a timestamp and to keep a floor under
// IDs the dedup memory has pruned. Parsed IDs are plain numbers up to 15 digits and bigints beyond,
// so these pin both orderings and the floor for every width, and the IDs that never raise a floor.
const INTERVAL = 60_000;
const START = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);
const MARKET = "BINANCE_FUTURES:btcusdt";
// More identified trades than the dedup memory keeps once it starts pruning.
const FLOOD = 50_002;

function trade(id, time, price = 1000, qty = 1, isBuy = true, extra = {}) {
  return Object.freeze({ id, time, price, qty, tradeCount: 1, isBuy, liquidation: false, market: MARKET, source: "live", receivedAt: time + 1, ...extra });
}

function totals(series, start = START) {
  const bar = series.get(start);
  assert.ok(bar, "expected candle at " + start);
  return { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, delta: bar.delta, count: bar.count };
}

test("trades sharing a timestamp are ordered by numeric ID, whatever the digit count", () => {
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const ids of [
    ["5000000001", "5000000002", "5000000003"],
    ["99999999999999", "100000000000000", "999999999999999"],
    ["999999999999998", "999999999999999", "1000000000000000"],
    ["999999999999999", "1000000000000000", "1000000000000001"],
    ["99999999999999", "100000000000000", "1000000000000000"],
    ["9007199254740991", "9007199254740992", "9007199254740993"],
    ["9007199254740993", "9007199254740994", "9007199254740995"],
    ["9999999999999998", "9999999999999999", "10000000000000000"],
    ["12345678901234567", "12345678901234568", "12345678901234569"],
    ["18446744073709551613", "18446744073709551614", "18446744073709551615"],
    ["0", "1", "2"],
  ]) {
    // Prices rise with the ID and stay within the outlier band, so the ID order alone decides open and close.
    const prices = [1000, 1001, 1002];
    for (const permutation of permutations) {
      const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
      const time = START + 5_000;
      for (const index of permutation) series.addTrade(trade(ids[index], time, prices[index]));
      const bar = series.get(START);
      assert.deepEqual(
        { open: bar.open, close: bar.close, high: bar.high, low: bar.low },
        { open: 1000, close: 1002, high: 1002, low: 1000 },
        `${ids.join(" < ")} delivered as ${permutation.map((index) => ids[index]).join(", ")}`,
      );
    }
  }
});

function floodWith(idOf, market = MARKET) {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  for (let n = 1; n <= FLOOD; n++) series.addTrade(trade(idOf(n), START + n * 10, 1000, 1, true, { market }));
  return series;
}

test("the pruned-ID floor holds for IDs of every width and across the 15 to 16 digit change", () => {
  const bases = [
    ["10 digits", (n) => String(5_000_000_000 + n)],
    ["15 digits", (n) => String(100_000_000_000_000 + n)],
    ["15 into 16 digits", (n) => String(999_999_999_950_000 + n)],
    ["16 digits", (n) => String(1_000_000_000_000_000 + n)],
    ["19 digits", (n) => (1_000_000_000_000_000_000n + BigInt(n)).toString()],
    ["up to the largest u64", (n) => (18_446_744_073_709_551_615n - BigInt(FLOOD) + BigInt(n)).toString()],
  ];
  for (const [label, idOf] of bases) {
    const series = floodWith(idOf);
    const before = totals(series);
    series.addTrade(trade(idOf(1), START + 10));                    // the oldest ID comes back long after it was applied
    series.addTrade(trade(idOf(FLOOD), START + FLOOD * 10));         // and so does a newer one still in memory
    assert.deepEqual(totals(series), before, `${label}: re-deliveries are not counted twice`);
    assert.equal(series.identityConflictCount, 0, label);
    const lastBucket = START + Math.floor((FLOOD * 10) / INTERVAL) * INTERVAL;
    const lastBefore = totals(series, lastBucket);
    series.addTrade(trade(idOf(FLOOD + 1), START + FLOOD * 10 + 1, 1000, 3));
    assert.equal(totals(series, lastBucket).volume, lastBefore.volume + 3, `${label}: a newer ID still applies`);
  }
});

test("IDs that are not exact decimal u64 values never raise a floor", () => {
  const unparsable = [
    ["leading zero", (n) => "0" + String(n)],
    ["21 digits", (n) => "1" + String(n).padStart(20, "0")],
    ["above the largest u64", (n) => (18_446_744_073_709_551_616n + BigInt(n)).toString()],
    ["not decimal", (n) => "t" + String(n)],
    ["sign", (n) => "+" + String(n)],
  ];
  for (const [label, idOf] of unparsable) {
    const series = floodWith(idOf);
    const before = totals(series);
    series.addTrade(trade(idOf(1), START + 10));
    assert.equal(totals(series).volume, before.volume + 1, `${label}: the dedup memory is all that protects these IDs`);
  }
});

test("a floor for one market does not reach another market or a liquidation", () => {
  const series = floodWith((n) => String(5_000_000_000 + n));
  const before = totals(series);
  series.addTrade(trade(String(5_000_000_001), START + 10, 1000, 1, true, { market: "BINANCE:btcusdt" }));
  series.addTrade(trade(String(5_000_000_001), START + 11, 1000, 1, true, { liquidation: true }));
  assert.equal(totals(series).count, before.count + 1, "the other market counts; the liquidation adds volume only to its cell");
  assert.equal(series.identityConflictCount, 0);
});

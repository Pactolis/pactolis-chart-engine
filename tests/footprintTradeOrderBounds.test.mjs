import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";

// A bucket's open and close follow the order of the reference prints, not the order they arrive in:
// time first, then source sequence, then trade ID, and a print that ties on all three goes after the
// one it ties with. The bounds that remember the earliest and the latest print are updated in place,
// so these pin the outcome for every delivery order and across series, buckets and history seeds.
const INTERVAL = 60_000;
const START = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);
const MARKET = "BINANCE_FUTURES:btcusdt";

function trade(price, extra = {}) {
  return Object.freeze({ time: START + 5_000, price, qty: 1, tradeCount: 1, isBuy: true, liquidation: false, market: MARKET, source: "live", receivedAt: START + 5_001, ...extra });
}

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

function run(trades, start = START) {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
  for (const t of trades) series.addTrade(t);
  const bar = series.get(start);
  return { open: bar.open, close: bar.close, high: bar.high, low: bar.low, volume: bar.volume };
}

function everyDeliveryOrder(trades, expected, label) {
  for (const order of permutations(trades)) {
    assert.deepEqual(run(order), expected, `${label}: delivered as ${order.map((t) => t.price).join(", ")}`);
  }
}

test("prints sharing a timestamp are ordered by source sequence, ahead of the trade ID", () => {
  // Sequence 11 -> 1001 opens, sequence 13 -> 1002 closes; the IDs run the other way.
  everyDeliveryOrder([
    trade(1001, { sourceSequence: 11, id: "300" }),
    trade(1003, { sourceSequence: 12, id: "200" }),
    trade(1002, { sourceSequence: 13, id: "100" }),
  ], { open: 1001, close: 1002, high: 1003, low: 1001, volume: 3 }, "sequence");
});

test("without sequences, prints sharing a timestamp are ordered by trade ID", () => {
  everyDeliveryOrder([
    trade(1001, { id: "5000000001" }),
    trade(1003, { id: "5000000002" }),
    trade(1002, { id: "5000000003" }),
  ], { open: 1001, close: 1002, high: 1003, low: 1001, volume: 3 }, "id");
});

test("a sequence that only one print has does not order it; the IDs decide", () => {
  const withSequence = trade(1001, { sourceSequence: 9, id: "10" });
  const withoutSequence = trade(1002, { id: "20" });
  everyDeliveryOrder([withSequence, withoutSequence], { open: 1001, close: 1002, high: 1002, low: 1001, volume: 2 }, "one sequence");
  // Equal sequences fall through to the IDs as well.
  everyDeliveryOrder([
    trade(1001, { sourceSequence: 4, id: "10" }),
    trade(1002, { sourceSequence: 4, id: "20" }),
  ], { open: 1001, close: 1002, high: 1002, low: 1001, volume: 2 }, "equal sequences");
});

test("time outranks sequence and ID", () => {
  everyDeliveryOrder([
    trade(1002, { time: START + 1_000, sourceSequence: 50, id: "900" }),
    trade(1001, { time: START + 2_000, sourceSequence: 20, id: "800" }),
    trade(1003, { time: START + 3_000, sourceSequence: 10, id: "700" }),
  ], { open: 1002, close: 1003, high: 1003, low: 1001, volume: 3 }, "time");
});

test("prints that tie on everything keep the first delivery as the open and the last as the close", () => {
  const a = trade(1001);
  const b = trade(1002);
  const c = trade(1003);
  for (const order of permutations([a, b, c])) {
    const got = run(order);
    assert.equal(got.open, order[0].price, "the first delivery opens");
    assert.equal(got.close, order[2].price, "the last delivery closes");
  }
});

test("a delayed print can move the open without moving the close, and the other way round", () => {
  // Arrival order: middle, then earlier (moves the open only), then later (moves the close only).
  assert.deepEqual(
    run([trade(1002, { time: START + 2_000, id: "2" }), trade(1001, { time: START + 1_000, id: "1" }), trade(1003, { time: START + 3_000, id: "3" })]),
    { open: 1001, close: 1003, high: 1003, low: 1001, volume: 3 },
  );
  // Arrival order: middle, then later, then earlier (moves the open only, close stays on the later one).
  assert.deepEqual(
    run([trade(1002, { time: START + 2_000, id: "2" }), trade(1003, { time: START + 3_000, id: "3" }), trade(1001, { time: START + 1_000, id: "1" })]),
    { open: 1001, close: 1003, high: 1003, low: 1001, volume: 3 },
  );
});

test("a history-seeded bar keeps its open and orders the live prints that follow", () => {
  // Every price stays within the outlier tolerance of the seed's close (1001), so no print is held back.
  for (const order of permutations([
    trade(1002, { time: START + 1_000, id: "1" }),
    trade(1003, { time: START + 3_000, id: "3" }),
    trade(1001, { time: START + 2_000, id: "2" }),
  ])) {
    const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
    series.replaceRange(START, START + INTERVAL, [{
      startTime: START, open: 1000, high: 1003, low: 999, close: 1001, volume: 5, delta: 0, count: 5, cells: new Map(), hasRef: true,
    }]);
    for (const t of order) series.addTrade(t);
    const bar = series.get(START);
    assert.equal(bar.open, 1000, `the seeded open stays authoritative (delivered as ${order.map((t) => t.price).join(", ")})`);
    assert.equal(bar.close, 1003, `the latest live print closes whatever the delivery order (delivered as ${order.map((t) => t.price).join(", ")})`);
    assert.equal(bar.high, 1003);
    assert.equal(bar.low, 999);
  }
});

test("each bucket orders its own prints, and a late print for an older bucket does not disturb the newer one", () => {
  const next = START + INTERVAL;
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
  // Prices sit near 10_000 so the jump from one bucket to the other stays inside the outlier tolerance.
  series.addTrade(trade(10_002, { time: START + 20_000, id: "20" }));
  series.addTrade(trade(10_012, { time: next + 20_000, id: "120" }));
  series.addTrade(trade(10_001, { time: START + 10_000, id: "10" }));
  series.addTrade(trade(10_011, { time: next + 10_000, id: "110" }));
  series.addTrade(trade(10_003, { time: START + 30_000, id: "30" }));
  series.addTrade(trade(10_013, { time: next + 30_000, id: "130" }));
  const first = series.get(START);
  const second = series.get(next);
  assert.deepEqual([first.open, first.close, first.high, first.low], [10_001, 10_003, 10_003, 10_001]);
  assert.deepEqual([second.open, second.close, second.high, second.low], [10_011, 10_013, 10_013, 10_011]);
});

test("two series fed in turn order their prints as if each were fed alone", () => {
  const a = [trade(1002, { time: START + 2_000, id: "2" }), trade(1001, { time: START + 1_000, id: "1" }), trade(1003, { time: START + 3_000, id: "3" })];
  const b = [trade(2002, { time: START + 2_000, id: "2" }), trade(2003, { time: START + 3_000, id: "3" }), trade(2001, { time: START + 1_000, id: "1" })];
  const x = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
  const y = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
  for (let i = 0; i < 3; i++) {
    x.addTrade(a[i]);
    y.addTrade(b[i]);
  }
  assert.deepEqual([x.get(START).open, x.get(START).close], [1001, 1003]);
  assert.deepEqual([y.get(START).open, y.get(START).close], [2001, 2003]);
});

test("prints from another market do not move the open or the close", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
  series.addTrade(trade(1001, { time: START + 1_000, id: "1" }));
  series.addTrade(trade(1002, { time: START + 3_000, id: "3" }));
  series.addTrade(trade(1500, { time: START + 4_000, id: "4", market: "COINBASE:btc-usd" }));
  series.addTrade(trade(1400, { time: START + 500, id: "5", market: "COINBASE:btc-usd" }));
  const bar = series.get(START);
  assert.deepEqual([bar.open, bar.close], [1001, 1002]);
});

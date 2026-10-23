import assert from "node:assert/strict";
import test from "node:test";
import { RecentTradeIds, payloadFlags } from "../dist/core/model/recentTradeIds.js";

// The memory a footprint series keeps for trades with a plain numeric ID: IDs per market, the first
// payload each was delivered with, and the forgetting of what is older than a cutoff.
const FUTURES = "BINANCE_FUTURES:btcusdt";
const OTHER = "COINBASE:btc-usd";

function trade(extra = {}) {
  return { time: 1_700_000_000_000, price: 1000.25, qty: 0.5, tradeCount: 1, isBuy: true, liquidation: false, ...extra };
}

function memory() {
  return new RecentTradeIds((market) => market.startsWith("BINANCE"));
}

test("payload flags are the side and the liquidation bit", () => {
  assert.equal(payloadFlags({ isBuy: false }), 0);
  assert.equal(payloadFlags({ isBuy: true }), 1);
  assert.equal(payloadFlags({ isBuy: false, liquidation: true }), 2);
  assert.equal(payloadFlags({ isBuy: true, liquidation: true }), 3);
  assert.equal(payloadFlags({ isBuy: true, liquidation: false }), 1);
});

test("a market has one set of IDs; a market with a bar in its name has none", () => {
  const ids = memory();
  const futures = ids.idsFor(FUTURES);
  assert.equal(futures.market, FUTURES);
  assert.equal(futures.monotonic, true);
  const other = ids.idsFor(OTHER);
  assert.equal(other.monotonic, false);
  assert.notEqual(other, futures);
  // Asking in turns, and asking again after other markets, finds the same sets.
  for (let i = 0; i < 4; i++) {
    assert.equal(ids.idsFor(FUTURES), futures);
    assert.equal(ids.idsFor(OTHER), other);
    assert.equal(ids.idsFor(FUTURES), futures);
  }
  assert.equal(ids.idsFor(""), ids.idsFor(""));
  assert.equal(ids.idsFor("").market, "");
  for (let i = 0; i < 2; i++) {
    assert.equal(ids.idsFor("X|Y"), null);
    assert.equal(ids.idsFor("X"), ids.idsFor("X"));
    assert.equal(ids.idsFor("|"), null);
    assert.equal(ids.idsFor("X|Y"), null);
  }
  assert.equal(ids.idsFor(5), null, "a market that is not a string keeps fingerprints too");
  assert.equal(ids.idsFor(undefined), null);
  assert.equal(ids.idsFor(FUTURES), futures);
});

test("a remembered trade matches only a delivery with the same payload", () => {
  const ids = memory();
  const futures = ids.idsFor(FUTURES);
  ids.add(futures, 42, trade());
  const row = futures.rows.get(42);
  assert.equal(typeof row, "number");
  assert.equal(ids.size, 1);
  assert.equal(futures.rows.get(43), undefined);
  assert.equal(ids.matches(row, trade()), true);
  assert.equal(ids.matches(row, trade({ source: "repair", receivedAt: 7 })), true, "fields outside the payload do not count");
  assert.equal(ids.matches(row, { ...trade(), tradeCount: undefined }), true, "an absent count is a count of one");
  for (const [label, delivery] of [
    ["time", trade({ time: 1_700_000_000_001 })],
    ["price", trade({ price: 1000.2500000000001 })],
    ["quantity", trade({ qty: 0.5000000000000001 })],
    ["trade count", trade({ tradeCount: 2 })],
    ["side", trade({ isBuy: false })],
    ["liquidation", trade({ liquidation: true })],
  ]) {
    assert.equal(ids.matches(row, delivery), false, label);
  }
  const counted = ids.idsFor(OTHER);
  ids.add(counted, 7, trade({ tradeCount: 9_007_199_254_740_991, isBuy: false, liquidation: true }));
  const countedRow = counted.rows.get(7);
  assert.equal(ids.matches(countedRow, trade({ tradeCount: 9_007_199_254_740_991, isBuy: false, liquidation: true })), true, "the largest safe count is kept exactly");
  assert.equal(ids.matches(countedRow, trade({ tradeCount: 9_007_199_254_740_990, isBuy: false, liquidation: true })), false);
  assert.equal(ids.matches(row, trade()), true, "another row is left alone");
});

test("the arrays grow without losing a payload, and IDs of any size are keys", () => {
  const ids = memory();
  const futures = ids.idsFor(FUTURES);
  const other = ids.idsFor(OTHER);
  const total = 5_000;
  const idOf = (n) => (n % 2 === 0 ? 5_000_000_000 + n : 999_999_999_000_000 + n);
  const payloadOf = (n) => trade({ time: 1_700_000_000_000 + n, price: 1000 + n / 8, qty: 1 + (n % 7), tradeCount: 1 + (n % 3), isBuy: n % 3 === 0, liquidation: n % 5 === 0 });
  for (let n = 0; n < total; n++) ids.add(n % 4 < 2 ? futures : other, idOf(n), payloadOf(n));
  assert.equal(ids.size, total);
  for (let n = 0; n < total; n++) {
    const row = (n % 4 < 2 ? futures : other).rows.get(idOf(n));
    assert.equal(ids.matches(row, payloadOf(n)), true, `payload of ${n}`);
    assert.equal(ids.matches(row, payloadOf(n + 1)), false, `payload of ${n} is not that of ${n + 1}`);
    assert.equal((n % 4 < 2 ? other : futures).rows.get(idOf(n)), undefined, `${n} is not in the other market`);
  }
  assert.equal(new Set([...futures.rows.values(), ...other.rows.values()]).size, total, "every trade has a row of its own");
});

test("forgetting drops what is older than the cutoff, wherever it sits, and keeps what is at it", () => {
  const ids = memory();
  const other = ids.idsFor(OTHER);
  const times = [500, 100, 400, 99, 300, 101, 200, 100, 600, 98];
  times.forEach((time, n) => ids.add(other, n + 1, trade({ time })));
  const forgotten = [];
  ids.evictBefore(100, (market, id) => forgotten.push([market, id]));
  assert.deepEqual([...other.rows.keys()].sort((a, b) => a - b), [1, 2, 3, 5, 6, 7, 8, 9], "only the ones at 99 and 98 went");
  assert.equal(ids.size, 8);
  assert.deepEqual(forgotten, [], "a market whose IDs do not only grow sets no floor");
  ids.evictBefore(501, () => {});
  assert.deepEqual([...other.rows.keys()], [9]);
  assert.equal(ids.size, 1);
  ids.evictBefore(Infinity, () => {});
  assert.equal(ids.size, 0);
  assert.equal(other.rows.size, 0);
});

test("a forgotten row is reused and the payloads around it stay put", () => {
  const ids = memory();
  const futures = ids.idsFor(FUTURES);
  for (let n = 0; n < 3_000; n++) ids.add(futures, n, trade({ time: n, qty: n + 1 }));
  ids.evictBefore(2_000, () => {});
  assert.equal(ids.size, 1_000);
  for (let n = 3_000; n < 5_000; n++) ids.add(futures, n, trade({ time: n, qty: n + 1 }));
  assert.equal(ids.size, 3_000);
  const rows = [...futures.rows.values()];
  assert.equal(new Set(rows).size, 3_000, "no two IDs share a row");
  assert.equal(Math.max(...rows), 2_999, "the 2_000 new trades took the 2_000 rows that were forgotten");
  for (let n = 2_000; n < 5_000; n++) {
    assert.equal(ids.matches(futures.rows.get(n), trade({ time: n, qty: n + 1 })), true, `trade ${n}`);
  }
  assert.equal(futures.rows.get(1_999), undefined);
});

test("the floor is the highest normal ID forgotten from a market whose IDs only grow", () => {
  const ids = memory();
  const futures = ids.idsFor(FUTURES);
  const spot = ids.idsFor("BINANCE:btcusdt");
  const other = ids.idsFor(OTHER);
  ids.add(futures, 900, trade({ time: 10 }));
  ids.add(futures, 500, trade({ time: 10 }));
  ids.add(futures, 950, trade({ time: 10, liquidation: true }));
  ids.add(futures, 2_000, trade({ time: 5_000 }));
  ids.add(spot, 0, trade({ time: 10 }));
  ids.add(other, 1_000_000, trade({ time: 10 }));
  const raised = [];
  ids.evictBefore(100, (market, id) => raised.push([market, id]));
  assert.deepEqual(raised.sort(), [[FUTURES, 900], ["BINANCE:btcusdt", 0]].sort(), "the liquidation and the other venue raise nothing, and ID 0 is an ID");
  assert.deepEqual([...futures.rows.keys()], [2_000]);
  raised.length = 0;
  ids.evictBefore(100, (market, id) => raised.push([market, id]));
  assert.deepEqual(raised, [], "nothing left to forget, nothing to report");
});

test("clear forgets everything and starts over", () => {
  const ids = memory();
  const futures = ids.idsFor(FUTURES);
  for (let n = 0; n < 2_000; n++) ids.add(futures, n, trade({ time: n }));
  ids.clear();
  assert.equal(ids.size, 0);
  const fresh = ids.idsFor(FUTURES);
  assert.notEqual(fresh, futures);
  assert.equal(fresh.rows.size, 0);
  ids.add(fresh, 5, trade({ time: 3, qty: 9 }));
  assert.equal(ids.matches(fresh.rows.get(5), trade({ time: 3, qty: 9 })), true);
  assert.equal(ids.size, 1);
  ids.evictBefore(Infinity, () => {});
  assert.equal(ids.size, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";

// A series remembers the identity of every trade it applied, so a repeat is dropped, and counts a
// repeat whose payload differs as a conflict. The memory keeps a trade with a plain numeric ID in a
// different shape than any other, so these pin the one rule they share: what counts as the same
// trade, what a repeat does, and how long and how far the memory reaches.
const INTERVAL = 60_000;
const START = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);
const FUTURES = "BINANCE_FUTURES:btcusdt";
const SPOT = "BINANCE:btcusdt";
const OTHER = "COINBASE:btc-usd";

function trade(id, extra = {}) {
  const base = { time: START + 1_000, price: 1000, qty: 1, tradeCount: 1, isBuy: true, liquidation: false, market: FUTURES, source: "live", receivedAt: START + 1_001, ...extra };
  return Object.freeze(id === undefined ? base : { id, ...base });
}

function newSeries(config = {}) {
  return new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, ...config });
}

const bucketOf = (time) => time - (time % INTERVAL);

function applied(series, start = START) {
  const bar = series.get(start);
  return bar ? { volume: bar.volume, count: bar.count, liquidationBuy: bar.liquidationBuyVol ?? 0, liquidationSell: bar.liquidationSellVol ?? 0 } : null;
}

test("the same numeric ID on another market is another trade, in any order of markets", () => {
  const series = newSeries();
  for (const market of [FUTURES, SPOT, FUTURES, SPOT, OTHER, OTHER, FUTURES, OTHER, SPOT, "", undefined, "", undefined]) {
    series.addTrade(trade("1000", { market }));
  }
  assert.equal(applied(series).count, 4, "futures, spot, the other venue and the one without a market (named or not), once each");
  assert.equal(series.identityConflictCount, 0);
});

test("a liquidation and a normal trade with the same ID are one identity, whichever comes first", () => {
  const normalFirst = newSeries();
  normalFirst.addTrade(trade("100", { qty: 2 }));
  normalFirst.addTrade(trade("100", { qty: 2, liquidation: true }));
  assert.deepEqual(applied(normalFirst), { volume: 2, count: 1, liquidationBuy: 0, liquidationSell: 0 }, "the liquidation repeat adds nothing");
  assert.equal(normalFirst.identityConflictCount, 1, "and differs from the normal trade, so it is a conflict");

  const liquidationFirst = newSeries();
  liquidationFirst.addTrade(trade("100", { qty: 2, liquidation: true }));
  liquidationFirst.addTrade(trade("100", { qty: 2 }));
  assert.deepEqual(applied(liquidationFirst), { volume: 0, count: 0, liquidationBuy: 2, liquidationSell: 0 }, "the normal repeat adds nothing");
  assert.equal(liquidationFirst.identityConflictCount, 1);

  const twice = newSeries();
  twice.addTrade(trade("100", { qty: 2, liquidation: true }));
  twice.addTrade(trade("100", { qty: 2, liquidation: true }));
  assert.equal(applied(twice).liquidationBuy, 2);
  assert.equal(twice.identityConflictCount, 0, "a liquidation repeated as it came is no conflict");
});

test("ID spellings that are not plain numbers are identities of their own", () => {
  const spellings = ["7", "07", "007", "+7", "7.0", "0x7", " 7", "7 ", "7e0", "٧", "0", "00", "-0", "t7"];
  const series = newSeries();
  for (const id of spellings) {
    series.addTrade(trade(id));
    series.addTrade(trade(id));
  }
  assert.equal(applied(series).count, spellings.length, "each spelling applies once and its repeat is dropped");
  assert.equal(series.identityConflictCount, 0);
});

test("IDs on both sides of the 15 digit change and beyond the largest u64 are remembered", () => {
  const ids = [
    "999999999999998", "999999999999999", "1000000000000000", "1000000000000001", "9007199254740992", "9007199254740993", "9007199254740994",
    "18446744073709551615", "18446744073709551616", "123456789012345678901",
  ];
  const series = newSeries();
  for (const id of ids) {
    series.addTrade(trade(id));
    series.addTrade(trade(id));
    series.addTrade(trade(id, { qty: 3 }));
  }
  assert.equal(applied(series).count, ids.length);
  assert.equal(series.identityConflictCount, ids.length, "every third delivery differs from the first");
});

test("a market name with a bar in it shares fingerprints with the market and ID it spells", () => {
  const series = newSeries();
  series.addTrade(trade("1", { market: "X|Y" }));
  series.addTrade(trade("Y|1", { market: "X", qty: 2 }));
  assert.equal(applied(series).count, 1, "both spell the fingerprint X|Y|1, so the second is a repeat");
  assert.equal(series.identityConflictCount, 1, "with another payload");
  series.addTrade(trade("1", { market: "X|Y" }));
  series.addTrade(trade("2", { market: "X|Y" }));
  series.addTrade(trade("2", { market: "X|Y" }));
  assert.equal(applied(series).count, 2);
  assert.equal(series.identityConflictCount, 1);
});

test("trades without an ID are remembered by their whole payload", () => {
  const series = newSeries();
  const base = { time: START + 2_000 };
  for (const extra of [{}, {}, { qty: 2 }, { price: 1001 }, { isBuy: false }, { tradeCount: 2 }, { time: START + 2_001 }, { liquidation: true }, { market: SPOT }, { id: "" }, { id: "" }]) {
    series.addTrade(trade(undefined, { ...base, ...extra }));
  }
  // Applied: the plain one, then one trade for each field that differs; an empty ID is no ID, so it
  // repeats the plain one. The liquidation is told apart from the plain trade and counts as liquidation volume.
  assert.deepEqual(applied(series), { volume: 1 + 2 + 1 + 1 + 1 + 1 + 1, count: 1 + 1 + 1 + 1 + 2 + 1 + 1, liquidationBuy: 1, liquidationSell: 0 });
  assert.equal(series.identityConflictCount, 0, "an id-less repeat has no payload to disagree with");
});

test("a trade the repair filter drops is not remembered, and a repeat is still counted before the filter", () => {
  const series = newSeries({ referenceMarket: FUTURES });
  series.commitRepairOwnership([START], 100n, []);
  series.addTrade(trade("50"));                                          // at or below the watermark: dropped
  assert.equal(series.get(START), undefined);
  series.addTrade(trade("50", { time: START + INTERVAL + 1_000 }));      // another, unowned bucket
  assert.equal(applied(series, START + INTERVAL).count, 1, "the dropped delivery left no memory behind");

  series.addTrade(trade("150"));
  series.addTrade(trade("150", { qty: 5 }));
  assert.deepEqual(applied(series), { volume: 1, count: 1, liquidationBuy: 0, liquidationSell: 0 }, "the repeat adds nothing");
  assert.equal(series.identityConflictCount, 1, "it differs from the first, and the filter that dropped it runs after the count");
});

test("loads without dedup neither read nor write the memory", () => {
  const series = newSeries();
  series.addFootprintTrades([trade("10")]);
  series.addTrade(trade("10"));
  assert.equal(applied(series).count, 1, "the footprint-only load left nothing for addTrade to find");
  series.addTrades([trade("11"), trade("11")], { dedupe: false });
  assert.equal(applied(series).count, 3, "both deliveries apply, and nothing is remembered");
  series.addTrades([trade("11")]);
  assert.equal(applied(series).count, 4, "so a deduplicating delivery applies");
  series.addTrades([trade("11")]);
  assert.equal(applied(series).count, 4, "and is remembered from then on");
});

test("clear forgets every kind of identity", () => {
  const series = newSeries();
  const kinds = [trade("5"), trade("5", { market: SPOT }), trade("abc"), trade("12345678901234567"), trade(undefined, { time: START + 3_000 })];
  for (const t of kinds) series.addTrade(t);
  assert.equal(applied(series).count, 5);
  for (const t of kinds) series.addTrade(t);
  assert.equal(applied(series).count, 5);
  series.clear();
  assert.equal(series.get(START), undefined);
  for (const t of kinds) series.addTrade(t);
  assert.equal(applied(series).count, 5, "the same trades apply again");
  for (const t of kinds) series.addTrade(t);
  assert.equal(applied(series).count, 5);
});

test("the progress report counts the identities of every kind", () => {
  const series = newSeries();
  const seen = [];
  series.addTrades([
    trade("1"), trade("1"), trade("2"), trade("1", { market: SPOT }), trade("x1"), trade("x1"), trade("12345678901234567"),
    trade(undefined, { time: START + 4_000 }), trade(undefined, { time: START + 4_000 }), trade("3", { liquidation: true }),
  ], { progressEvery: 1, onProgress: (progress) => seen.push(progress.recentTrades) });
  assert.deepEqual(seen, [1, 1, 2, 3, 4, 4, 5, 6, 6, 7]);
});

test("generated deliveries apply once per identity and count a conflict for each repeat that differs", () => {
  let state = 20261023;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const pick = (values) => values[Math.floor(random() * values.length)];
  const markets = [FUTURES, SPOT, OTHER, undefined, "X|Y", "X"];
  const ids = ["1", "2", "3", "40", "4000000000", "999999999999999", "1000000000000000", "00", "a", "Y|1", "18446744073709551615", undefined, ""];
  // The memory as the contract describes it: identified trades by `market|id`, the others by their payload.
  const model = new Map();
  let conflicts = 0;
  let volume = 0;
  let count = 0;
  const series = newSeries();
  for (let i = 0; i < 6_000; i++) {
    const t = {
      time: START + int(0, 5) * 1_000,
      price: pick([1000, 1000.5]),
      qty: pick([1, 2]),
      tradeCount: pick([undefined, 1, 2]),
      isBuy: random() < 0.5,
      liquidation: pick([undefined, false, true]),
      market: pick(markets),
    };
    const id = pick(ids);
    if (id !== undefined) t.id = id;
    const payload = `${t.time}|${t.price}|${t.qty}|${t.tradeCount ?? 1}|${t.isBuy ? 1 : 0}|${t.liquidation ? 1 : 0}`;
    const fingerprint = id ? `${t.market ?? ""}|${id}` : `${t.market ?? ""}|${payload}`;
    const first = model.get(fingerprint);
    if (first === undefined) {
      model.set(fingerprint, id ? payload : null);
      if (t.liquidation !== true) {
        volume += t.qty;
        count += t.tradeCount ?? 1;
      }
    } else if (first !== null && first !== payload) {
      conflicts++;
    }
    series.addTrade(Object.freeze(t));
  }
  const bar = series.get(START);
  assert.deepEqual({ volume: bar.volume, count: bar.count, conflicts: series.identityConflictCount }, { volume, count, conflicts });
  assert.ok(conflicts > 100 && model.size > 100 && volume > 100, `the stream mixes repeats, conflicts (${conflicts}) and identities (${model.size})`);
});

// Pruning: once the memory holds more than 50_000 identities it forgets the ones older than twice the
// interval (at least a minute), looking at all of them, and not more often than every quarter window.
const FLOOD = 50_002;

test("pruning forgets every trade older than the window, wherever it sits, and keeps the one at its edge", () => {
  const series = newSeries();
  const at = (n) => START + n * 10;
  for (let n = 1; n <= FLOOD; n++) {
    series.addTrade(trade(String(n), { time: at(n), market: OTHER }));
    // Old from the day it arrived, and stored after the trades that outlive it.
    if (n === 45_000) series.addTrade(trade("900001", { time: START + 5, market: OTHER }));
  }
  const volume = (time) => series.get(bucketOf(time)).volume;
  const redeliver = (id, time) => {
    const before = volume(time);
    series.addTrade(trade(id, { time, market: OTHER }));
    return volume(time) - before;
  };
  // The first prune ran when the 50_001st identity arrived, at n = 50_000: window 120_000 ms.
  assert.equal(redeliver("37999", at(37_999)), 1, "just before the edge: forgotten, so it applies again");
  assert.equal(redeliver("38000", at(38_000)), 0, "exactly at the edge: still remembered");
  assert.equal(redeliver("900001", START + 5), 1, "the old trade stored late was forgotten as well");
  assert.equal(redeliver(String(FLOOD), at(FLOOD)), 0, "a recent trade is remembered");
  assert.equal(redeliver("1", at(1)), 1, "and so is the oldest forgotten one");
  assert.equal(series.identityConflictCount, 0);
});

test("pruning runs at most once per quarter window", () => {
  const series = newSeries();
  // One trade a millisecond: the memory crosses 50_000 after 50 s, a prune is due every 30 s from
  // then on, and only the one at n = 140_001 finds anything older than the 120 s window.
  const total = 150_000;
  const redeliver = (n) => {
    const time = START + n;
    const before = series.get(bucketOf(time)).volume;
    series.addTrade(trade(String(n), { time, market: OTHER }));
    return series.get(bucketOf(time)).volume - before;
  };
  for (let n = 1; n <= total; n++) {
    series.addTrade(trade(String(n), { time: START + n, market: OTHER }));
    if (n === 135_000) {
      assert.equal(redeliver(1), 0, "the prunes so far found nothing old enough");
      assert.equal(redeliver(5_000), 0);
    }
  }
  assert.equal(redeliver(20_000), 1, "forgotten by the prune at 140_001");
  assert.equal(redeliver(20_001), 0, "the edge of that prune: kept");
  assert.equal(redeliver(25_000), 0, "older than the window now, but the next prune is not due yet");
  assert.equal(redeliver(total), 0);
});

// The floor: on markets whose IDs only grow, the highest ID the memory forgot from among the normal
// trades keeps every ID at or below it out, since all of those were applied.
test("a floor raised by IDs of one width holds the IDs of another", () => {
  const series = newSeries();
  const at = (n) => START + n * 10;
  const idOf = (n) => String(1_000_000_000_000_000 + n);
  for (let n = 1; n <= FLOOD; n++) series.addTrade(trade(idOf(n), { time: at(n) }));
  // The memory forgot IDs 1 to 38_000 (the prune at n = 50_001 looks 120 s back); 38_000 is the floor.
  const bucket = bucketOf(at(100));
  const count = () => series.get(bucket).count;
  const before = count();
  series.addTrade(trade("999999999999999", { time: at(100) }));
  series.addTrade(trade("5", { time: at(100) }));
  series.addTrade(trade(idOf(38_000), { time: at(100) }));
  assert.equal(count(), before, "IDs of 15 digits and fewer, and the floor itself, are at or below a floor of 16 digits");
  series.addTrade(trade(idOf(FLOOD + 1), { time: at(100) }));
  assert.equal(count(), before + 1, "an ID above every one seen applies");
  series.addTrade(trade("999999999999999", { time: at(100), market: OTHER }));
  assert.equal(count(), before + 2, "another market has no floor");
  const liquidated = () => applied(series, bucket).liquidationBuy;
  const liquidatedBefore = liquidated();
  series.addTrade(trade("5", { time: at(100), liquidation: true, qty: 2 }));
  assert.equal(liquidated(), liquidatedBefore + 2, "a liquidation is not held back by a floor");
});

test("the floor is the highest ID forgotten, wherever it sat, and liquidations raise none", () => {
  const at = (n) => START + n * 10;
  const series = newSeries();
  for (let n = 1; n <= FLOOD; n++) {
    series.addTrade(trade(String(5_000_000_000 + n), { time: at(n) }));
    if (n === 10) series.addTrade(trade("9000000001", { time: at(10) }));
  }
  const bucket = bucketOf(at(FLOOD));
  const before = series.get(bucket).count;
  series.addTrade(trade(String(5_000_000_000 + FLOOD + 1), { time: at(FLOOD) }));
  assert.equal(series.get(bucket).count, before, "below the early, higher ID that was forgotten with the rest");
  series.addTrade(trade("9000000001", { time: at(FLOOD) }));
  assert.equal(series.get(bucket).count, before, "the forgotten ID itself");
  series.addTrade(trade("9000000002", { time: at(FLOOD) }));
  assert.equal(series.get(bucket).count, before + 1, "above it");

  const liquidations = newSeries();
  for (let n = 1; n <= FLOOD; n++) liquidations.addTrade(trade(String(5_000_000_000 + n), { time: at(n), liquidation: true }));
  const first = bucketOf(at(1));
  const liquidationBefore = liquidations.get(first).count;
  liquidations.addTrade(trade(String(5_000_000_000 + 1), { time: at(1) }));
  assert.equal(liquidations.get(first).count, liquidationBefore + 1, "forgotten liquidations leave no floor behind");
});

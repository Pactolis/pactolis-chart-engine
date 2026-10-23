import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries, identifiedPayload } from "../dist/core/model/footprint.js";

// A repeat of an already applied trade ID is dropped, and counted as a conflict when its payload
// differs from the first delivery. These pin which payloads count as the same, field by field,
// against the string `identifiedPayload` spells out.
const INTERVAL = 60_000;
const START = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);
const MARKET = "BINANCE_FUTURES:btcusdt";

function trade(id, time, price = 1000, qty = 1, isBuy = true, extra = {}) {
  return Object.freeze({ id, time, price, qty, tradeCount: 1, isBuy, liquidation: false, market: MARKET, source: "live", receivedAt: time + 1, ...extra });
}

function without(source, key) {
  const copy = { ...source };
  delete copy[key];
  return Object.freeze(copy);
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function totals(series, start = START) {
  const bar = series.get(start);
  assert.ok(bar, "expected candle at " + start);
  return { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, delta: bar.delta, count: bar.count };
}

test("a repeated identity is a conflict exactly when a payload field differs", () => {
  const original = trade("701", START + 1_000, 1000.5, 2.25);
  const sameAsOriginal = [
    ["identical", { ...original }],
    ["another source and receipt time", { ...original, source: "repair", receivedAt: original.receivedAt + 9 }],
    ["implicit count of one", without(original, "tradeCount")],
    ["liquidation flag left out", without(original, "liquidation")],
  ];
  const differentFromOriginal = [
    ["price", { ...original, price: 1000.5000000000001 }],
    ["quantity", { ...original, qty: 2.2500000000000004 }],
    ["time", { ...original, time: original.time + 1 }],
    ["trade count", { ...original, tradeCount: 2 }],
    ["side", { ...original, isBuy: false }],
    ["liquidation", { ...original, liquidation: true }],
  ];
  for (const [label, repeat] of [...sameAsOriginal, ...differentFromOriginal]) {
    const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
    series.addTrade(original);
    const before = totals(series);
    series.addTrade(repeat);
    const conflict = identifiedPayload(original) !== identifiedPayload(repeat);
    assert.equal(series.identityConflictCount, conflict ? 1 : 0, label);
    assert.deepEqual(totals(series), before, `${label}: the first delivery is the one that stays`);
  }
  assert.deepEqual(sameAsOriginal.filter(([, repeat]) => identifiedPayload(original) !== identifiedPayload(repeat)), []);
  assert.deepEqual(differentFromOriginal.filter(([, repeat]) => identifiedPayload(original) === identifiedPayload(repeat)), []);
});

test("conflict counting agrees with the identifiedPayload string for generated pairs", () => {
  const random = lcg(20261022);
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const pick = (values) => values[Math.floor(random() * values.length)];
  const randomTrade = () => {
    const base = {
      id: String(int(1, 1_000_000)),
      time: START + int(0, 30_000),
      price: pick([1000, 1000.1, 999.95, 1001.0000000000001, 1000 + int(0, 20) / 8]),
      qty: pick([1, 0.001, 2.5, 1e-8, 123456.789, int(1, 400) / 16]),
      isBuy: random() < 0.5,
      market: MARKET,
    };
    if (random() < 0.7) base.tradeCount = int(1, 4);
    const liquidation = pick([undefined, false, true]);
    if (liquidation !== undefined) base.liquidation = liquidation;
    return Object.freeze(base);
  };
  const perturb = (source) => {
    const next = { ...source };
    for (let i = int(1, 2); i > 0; i--) {
      switch (int(0, 8)) {
        case 0: next.price = source.price * (1 + 1e-15); break;
        case 1: next.price = source.price + 0.05; break;
        case 2: next.qty = source.qty * (1 + 1e-15); break;
        case 3: next.qty = source.qty + 0.001; break;
        case 4: next.time = source.time + 1; break;
        case 5: next.tradeCount = (source.tradeCount ?? 1) === 1 ? undefined : (source.tradeCount ?? 1) + 1; break;
        case 6: next.isBuy = !source.isBuy; break;
        case 7: next.liquidation = source.liquidation ? undefined : true; break;
        default: next.liquidation = source.liquidation === undefined ? false : undefined; break;
      }
    }
    return Object.freeze(next);
  };
  let conflicts = 0;
  for (let i = 0; i < 3_000; i++) {
    const first = randomTrade();
    const second = random() < 0.35 ? Object.freeze({ ...first }) : perturb(first);
    const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
    series.addTrade(first);
    series.addTrade(second);
    const expected = identifiedPayload(first) === identifiedPayload(second) ? 0 : 1;
    conflicts += expected;
    assert.equal(series.identityConflictCount, expected, `${identifiedPayload(first)} vs ${identifiedPayload(second)}`);
  }
  assert.ok(conflicts > 1_000 && conflicts < 2_500, `the generated pairs mix conflicts (${conflicts}) and plain repeats`);
});

test("an id-less delivery whose fingerprint equals an identified trade's is still counted as a conflict", () => {
  const time = START + 2_000;
  const anonymous = Object.freeze({ time, price: 1000, qty: 1, tradeCount: 1, isBuy: true, market: MARKET, source: "live", receivedAt: time + 1 });
  // The fingerprint of an id-less trade is `market|time|price|qty|count|side|liquidation`; an ID that
  // spells the same text makes the two collide.
  const identified = trade(`${time}|1000|1|1|1|0`, time, 1000, 1);
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
  series.addTrade(identified);
  series.addTrade(anonymous);
  assert.equal(series.identityConflictCount, 1);
  assert.equal(totals(series).volume, 1, "the colliding delivery is dropped as a repeat");
});

import test from "node:test";
import assert from "node:assert/strict";
import { getFootprintSupport, normalizeMarket, recordFootprintSupport, resetFootprintSupport } from "../dist/core/syncAllowlist.js";

// Stated differently from the implementation: the exchange part upper case, the symbol part lower case.
function canonical(market) {
  const trimmed = market.trim();
  return /:/.test(trimmed)
    ? trimmed.replace(/^([^:]*):([\s\S]*)$/, (_, exchange, symbol) => `${exchange.toUpperCase()}:${symbol.toLowerCase()}`)
    : trimmed.toLowerCase();
}

// Built at run time so equal inputs are distinct string objects.
const fresh = (...parts) => parts.join("");
const MARKETS = [
  "BINANCE_FUTURES:btcusdt", "binance_futures:BTCUSDT", "Binance_Futures:BtcUsdt", " BINANCE:ethusdt ", "\tbybit:SOLUSDT\n",
  "OKX:btc-usdt", "okx:BTC-USDT-SWAP", "btcusdt", "BTCUSDT", "  ", "", "a:b:c", "A:B:C", ":", ":X", "X:", "İSTANBUL:İzmir", "straße:STRASSE",
];

test("normalizeMarket returns the canonical form for any call order", () => {
  for (let round = 0; round < 3; round++) {
    for (const market of MARKETS) assert.equal(normalizeMarket(fresh(market)), canonical(market), JSON.stringify(market));
  }
  // Repeats, with the memo hit and missed in between.
  for (const market of [...MARKETS, ...MARKETS].reverse()) {
    assert.equal(normalizeMarket(fresh(market)), canonical(market));
    assert.equal(normalizeMarket(fresh(market)), canonical(market));
    assert.equal(normalizeMarket(fresh(MARKETS[0])), canonical(MARKETS[0]));
  }
});

test("normalizeMarket still rejects what is not a string, even right after the empty string", () => {
  assert.equal(normalizeMarket(""), "");
  assert.throws(() => normalizeMarket(undefined), TypeError);
  assert.throws(() => normalizeMarket(null), TypeError);
  assert.throws(() => normalizeMarket(5), TypeError);
});

test("what the server reported is read live, not remembered with the normalized market", () => {
  resetFootprintSupport();
  try {
    assert.equal(getFootprintSupport("BINANCE_FUTURES:BTCUSDT"), undefined);
    recordFootprintSupport("binance_futures:btcusdt", false);
    assert.equal(getFootprintSupport("BINANCE_FUTURES:BTCUSDT"), false);
    assert.equal(getFootprintSupport(fresh("BINANCE_FUTURES:BTCUSDT")), false);
    recordFootprintSupport("BINANCE_FUTURES:BTCUSDT", true);
    assert.equal(getFootprintSupport("BINANCE_FUTURES:BTCUSDT"), true);
    assert.equal(getFootprintSupport("binance_futures:btcusdt"), true);
    resetFootprintSupport();
    assert.equal(getFootprintSupport("BINANCE_FUTURES:BTCUSDT"), undefined);
  } finally {
    resetFootprintSupport();
  }
});

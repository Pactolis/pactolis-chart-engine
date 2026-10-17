import test from "node:test";
import assert from "node:assert/strict";
import { DataContractError, tradeFingerprint, validateBar, validateTrade } from "../dist/core/dataContracts.js";

test("trade contract rejects non-positive values", () => {
  assert.throws(
    () => validateTrade({ time: 1, price: 0, qty: 1, isBuy: true }),
    DataContractError
  );
  assert.throws(
    () => validateTrade({ time: 1, price: 1, qty: 1, tradeCount: 0, isBuy: true }),
    (error) => error instanceof DataContractError && error.code === "INVALID_TRADE_COUNT"
  );
});

test("stable trade ids take precedence in fingerprints", () => {
  const base = { time: 1, price: 100, qty: 1, isBuy: true, market: "X:Y", id: "42" };
  assert.equal(tradeFingerprint(base), tradeFingerprint({ ...base, price: 999 }));
});

test("bar contract validates aligned OHLC invariants", () => {
  const bar = {
    startTime: 0, open: 100, high: 110, low: 90, close: 105,
    volume: 2, delta: 0, count: 2, cells: new Map(), hasRef: true,
  };
  assert.equal(validateBar(bar, 60_000), bar);
  assert.throws(() => validateBar({ ...bar, high: 80 }, 60_000), DataContractError);
});

test("bar contract accepts calendar and legacy fixed month-token buckets", () => {
  const base = {
    open: 100, high: 110, low: 90, close: 105,
    volume: 1, delta: 0, count: 1, cells: new Map(), hasRef: true,
  };
  const twoMonths = 60 * 24 * 60 * 60 * 1000;
  const calendarStart = Date.UTC(2022, 4, 1);
  const legacyStart = 1_653_696_000_000;
  assert.equal(validateBar({ ...base, startTime: calendarStart }, twoMonths).startTime, calendarStart);
  assert.equal(validateBar({ ...base, startTime: legacyStart }, twoMonths).startTime, legacyStart);
  assert.throws(() => validateBar({ ...base, startTime: Date.UTC(2022, 4, 2) }, twoMonths), DataContractError);
});

test("bar contract accepts Monday and legacy fixed week-token buckets", () => {
  const base = {
    open: 100, high: 110, low: 90, close: 105,
    volume: 1, delta: 0, count: 1, cells: new Map(), hasRef: true,
  };
  const twoWeeks = 14 * 24 * 60 * 60 * 1000;
  const mondayStart = Date.UTC(2025, 6, 21);
  const legacyStart = 1_753_920_000_000;
  assert.equal(validateBar({ ...base, startTime: mondayStart }, twoWeeks).startTime, mondayStart);
  assert.equal(validateBar({ ...base, startTime: legacyStart }, twoWeeks).startTime, legacyStart);
  assert.throws(() => validateBar({ ...base, startTime: Date.UTC(2025, 6, 22) }, twoWeeks), DataContractError);
});

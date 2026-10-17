/**
 * resolvePriceStepFallback — pure helper extracted from
 * ApplicationServices.fetchPriceStep's failure path (bulgu #5). Locks in that
 * a hardcoded `10` fallback no longer leaks: the last known good step for the
 * market is preferred, and niceStepForPrice's own fallback is used only when
 * nothing is known yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolvePriceStepFallback } from "../dist/core/priceStep.js";

test("resolvePriceStepFallback returns the last known step for the market", () => {
  const lastKnown = new Map([["BINANCE:ETHUSDT", 0.5]]);
  assert.equal(resolvePriceStepFallback("BINANCE:ETHUSDT", lastKnown), 0.5);
});

test("resolvePriceStepFallback falls back to niceStepForPrice's own default when unknown", () => {
  const lastKnown = new Map();
  assert.equal(resolvePriceStepFallback("BINANCE:ETHUSDT", lastKnown), 10);
});

test("resolvePriceStepFallback ignores other markets' known steps", () => {
  const lastKnown = new Map([["BINANCE:BTCUSDT", 50]]);
  assert.equal(resolvePriceStepFallback("BINANCE:ETHUSDT", lastKnown), 10);
});

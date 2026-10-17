import test from "node:test";
import assert from "node:assert/strict";
import { profileHistogramParts, stepSegments } from "../dist/core/render/orderFlowProfile.js";

test("volume total renders stacked sell and buy parts", () => {
  assert.deepEqual(profileHistogramParts({
    value: 10, buyValue: 6, sellValue: 4, magnitude: 10,
  }, "volume", "total"), [
    { side: "sell", value: 4, signed: 4 },
    { side: "buy", value: 6, signed: 6 },
  ]);
});

test("trade count total falls back to one total part when side counts are unknown", () => {
  assert.deepEqual(profileHistogramParts({
    value: 7, buyValue: null, sellValue: null, magnitude: 7,
  }, "trade-count", "total"), [
    { side: "total", value: 7, signed: 7 },
  ]);
});

test("delta keeps sign while width uses magnitude", () => {
  assert.deepEqual(profileHistogramParts({
    value: -12, buyValue: null, sellValue: null, magnitude: 12,
  }, "delta", "total"), [
    { side: "delta", value: 12, signed: -12 },
  ]);
});

test("average total is never represented as stacked side averages", () => {
  assert.deepEqual(profileHistogramParts({
    value: 2.5, buyValue: null, sellValue: null, magnitude: 2.5,
  }, "average-trade-size", "total"), [
    { side: "total", value: 2.5, signed: 2.5 },
  ]);
});

test("invalid level values have no histogram parts", () => {
  assert.deepEqual(profileHistogramParts({
    value: null, buyValue: null, sellValue: null, magnitude: null,
  }, "trade-count", "buy"), []);
});

test("developing points become horizontal then vertical step segments and retain a single point", () => {
  assert.deepEqual(stepSegments([
    { x: 10, y: 20 },
    { x: 30, y: 25 },
    { x: 50, y: 15 },
  ]), [
    [10, 20, 30, 20],
    [30, 20, 30, 25],
    [30, 25, 50, 25],
    [50, 25, 50, 15],
  ]);
  assert.deepEqual(stepSegments([{ x: 10, y: 20 }]), [[10, 20, 11, 20]]);
});

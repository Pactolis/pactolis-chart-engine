import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { TimeScaleModel } from "../dist/core/model/timeScale.js";

function makeBar(startTime, close = 100) {
  return {
    startTime,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  };
}

test("time scale model is reused across same-bar live mutations", () => {
  const intervalMs = 60_000;
  const start = Date.UTC(2026, 0, 1);
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars([makeBar(start), makeBar(start + intervalMs)]);

  const first = TimeScaleModel.fromSeries(series);
  const structureRevision = series.structureRevision;
  series.addTrade({ time: start + intervalMs + 1_000, price: 101, qty: 1, isBuy: true });
  const second = TimeScaleModel.fromSeries(series);

  assert.equal(series.structureRevision, structureRevision);
  assert.equal(second, first, "same-bar mutations must not rebuild the O(N) time model");
});

test("time scale model rebuilds after a logical bar append", () => {
  const intervalMs = 60_000;
  const start = Date.UTC(2026, 0, 1);
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars([makeBar(start)]);

  const first = TimeScaleModel.fromSeries(series);
  series.addTrade({ time: start + intervalMs + 1_000, price: 101, qty: 1, isBuy: true });
  const second = TimeScaleModel.fromSeries(series);

  assert.notEqual(second, first);
  assert.equal(second.length, 2);
});

test("gap-aware timestamp mapping keeps logical indexes contiguous", () => {
  const intervalMs = 60_000;
  const start = Date.UTC(2026, 0, 1);
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars([
    makeBar(start),
    makeBar(start + intervalMs),
    makeBar(start + intervalMs * 10),
  ]);

  assert.equal(series.indexOfTime(start + intervalMs), 1);
  assert.equal(series.indexOfTime(start + intervalMs * 10), 2);
  const inGap = series.indexOfTime(start + intervalMs * 5);
  assert.ok(inGap > 1 && inGap < 2, "timestamps inside a history gap interpolate within one logical column span");
});

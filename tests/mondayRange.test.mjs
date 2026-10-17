import test from "node:test";
import assert from "node:assert/strict";
import { calculateMondayRangeLevels, normalizeMondayRangeSettings } from "../dist/core/analysis/mondayRange.js";

const DAY = 86_400_000;

function bar(day, open, high, low, close) {
  return {
    startTime: day,
    open,
    high,
    low,
    close,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
    completeness: "complete",
  };
}

test("monday range maps Monday high to 0 and Monday low to 1", () => {
  const monday = Date.UTC(2026, 5, 22);
  const bars = [
    bar(monday, 100, 120, 80, 100),
    bar(monday + DAY, 100, 140, 70, 110),
    bar(monday + 2 * DAY, 100, 130, 60, 90),
  ];
  const levels = calculateMondayRangeLevels(bars, monday + 4 * DAY);
  assert.equal(levels.find((item) => item.id === "mr-high")?.price, 120);
  assert.equal(levels.find((item) => item.id === "mr-low")?.price, 80);
  assert.equal(levels.find((item) => item.id === "mr-eq")?.price, 100);
  assert.equal(levels.find((item) => item.id === "mr-invalid-upper")?.price, 144.72);
  assert.equal(levels.find((item) => item.id === "mr-invalid-lower")?.price, 55.28);
});

test("monday range ignores incomplete current Monday", () => {
  const monday = Date.UTC(2026, 5, 22);
  const bars = [bar(monday, 100, 120, 80, 100)];
  assert.equal(calculateMondayRangeLevels(bars, monday + 12 * 60 * 60 * 1000).length, 0);
});

test("monday range settings normalize missing ids to visible", () => {
  const settings = normalizeMondayRangeSettings({ visible: { "mr-eq": false } });
  assert.equal(settings.visible["mr-eq"], false);
  assert.equal(settings.visible["mr-high"], true);
});

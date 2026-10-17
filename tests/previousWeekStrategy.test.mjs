import test from "node:test";
import assert from "node:assert/strict";
import { calculatePreviousWeekStrategyLevels, normalizePreviousWeekStrategySettings } from "../dist/core/analysis/previousWeekStrategy.js";

const DAY = 86_400_000;

function bar(day, open, high, low, close, completeness = "complete") {
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
    completeness,
  };
}

test("previous week strategy maps high to 0 and low to 1", () => {
  const monday = Date.UTC(2026, 5, 15);
  const bars = [];
  for (let i = 0; i < 7; i++) bars.push(bar(monday + i * DAY, 100, 110, 90, 100));
  const levels = calculatePreviousWeekStrategyLevels(bars, monday + 7 * DAY);
  assert.equal(levels.find((item) => item.id === "pw-high")?.price, 110);
  assert.equal(levels.find((item) => item.id === "pw-low")?.price, 90);
  assert.equal(levels.find((item) => item.id === "pw-eq")?.price, 100);
  assert.equal(levels.find((item) => item.id === "pw-ext-upper-1272")?.price, 115.44);
  assert.equal(levels.find((item) => item.id === "pw-ext-lower-1272")?.price, 84.56);
});

test("previous week strategy settings normalize missing ids to visible", () => {
  const settings = normalizePreviousWeekStrategySettings({ visible: { "pw-eq": false } });
  assert.equal(settings.visible["pw-eq"], false);
  assert.equal(settings.visible["pw-high"], true);
});


test("previous week strategy accepts closed OHLC when footprint completeness is partial", () => {
  const monday = Date.UTC(2026, 5, 15);
  const bars = [];
  for (let i = 0; i < 7; i++) bars.push(bar(monday + i * DAY, 100, 112, 88, 101, "partial"));
  const levels = calculatePreviousWeekStrategyLevels(bars, monday + 7 * DAY);
  assert.equal(levels.find((item) => item.id === "pw-high")?.price, 112);
  assert.equal(levels.find((item) => item.id === "pw-low")?.price, 88);
  assert.equal(levels.find((item) => item.id === "pw-eq")?.price, 100);
});


test("previous week strategy ignores current-week bars and selects the exact prior UTC week", () => {
  const previousMonday = Date.UTC(2026, 6, 20);
  const currentMonday = Date.UTC(2026, 6, 27);
  const bars = [
    ...Array.from({ length: 7 }, (_, i) => bar(previousMonday + i * DAY, 100, 115, 85, 100)),
    bar(currentMonday, 200, 240, 180, 220, "provisional"),
  ];
  const levels = calculatePreviousWeekStrategyLevels(bars, currentMonday + 18 * 60 * 60_000, undefined, DAY);
  assert.equal(levels.find((item) => item.id === "pw-high")?.price, 115);
  assert.equal(levels.find((item) => item.id === "pw-low")?.price, 85);
  assert.equal(levels.find((item) => item.id === "pw-eq")?.price, 100);
  assert.equal(levels.find((item) => item.id === "pw-high")?.sourceStart, previousMonday);
});

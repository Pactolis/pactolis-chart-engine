import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateEqLevels,
  calculateOpenLevels,
  calculateUntouchedLevels,
  calculateValueAreaLevels,
} from "../dist/core/analysis/referenceLevels.js";
import { PERIOD_INTERVAL, previousAnalysisPeriodStart } from "../dist/core/analysis/periods.js";

const DAY = 86_400_000;

function bar(time, open, high, low, close, completeness = "complete") {
  return {
    startTime: time, open, high, low, close,
    volume: 1, delta: 0, count: 1, cells: new Map(), hasRef: true, completeness,
  };
}

function footprintBar(time, levels, completeness = "complete", volumeOverride) {
  const cells = new Map(levels.map(([price, volume]) => [
    price,
    { priceBin: price, buyVol: volume, sellVol: 0 },
  ]));
  const volume = volumeOverride ?? levels.reduce((sum, [, itemVolume]) => sum + itemVolume, 0);
  const prices = levels.map(([price]) => price);
  return {
    startTime: time,
    open: prices[0] ?? 100,
    high: Math.max(...prices, 100),
    low: Math.min(...prices, 100),
    close: prices.at(-1) ?? 100,
    volume,
    delta: volume,
    count: 1,
    cells,
    hasRef: true,
    completeness,
  };
}

function month(start, days, open, high, low, close) {
  return Array.from({ length: days }, (_, index) =>
    bar(start + index * DAY, index ? close : open, high, low, close)
  );
}

test("previous monthly EQ uses the completed period high-low midpoint", () => {
  const january = Date.UTC(2026, 0, 1);
  const bars = [
    ...month(january, 31, 100, 140, 80, 120),
    bar(Date.UTC(2026, 1, 1), 125, 130, 120, 128, "provisional"),
  ];
  const levels = calculateEqLevels(bars, "X:Y", Date.UTC(2026, 1, 2));
  const monthly = levels.find((level) => level.period === "monthly");
  assert.equal(monthly?.price, 110);
  assert.equal(monthly?.sourceStart, january);
});

test("daily and weekly EQ use the immediately previous UTC calendar period", () => {
  const monday = Date.UTC(2026, 6, 6);
  const now = monday + 7 * DAY + 12 * 60 * 60_000;
  const bars = Array.from({ length: 8 }, (_, index) =>
    bar(monday + index * DAY, 100 + index, 120 + index, 80 + index, 110 + index)
  );
  const levels = calculateEqLevels(bars, "X:Y", now, DAY, ["daily", "weekly"]);
  const daily = levels.find((level) => level.period === "daily");
  const weekly = levels.find((level) => level.period === "weekly");
  assert.equal(daily?.sourceStart, monday + 6 * DAY);
  assert.equal(weekly?.sourceStart, monday);
  assert.equal(weekly?.price, (126 + 80) / 2);
});

test("current monthly open comes from the exact period-start candle", () => {
  const february = Date.UTC(2026, 1, 1);
  const levels = calculateOpenLevels([
    bar(february, 125, 130, 120, 128, "provisional"),
    bar(february + DAY, 128, 135, 127, 132, "provisional"),
  ], "X:Y", february + DAY + 1);
  assert.equal(levels.find((level) => level.period === "monthly")?.price, 125);
});

test("daily and weekly OPEN use current UTC period starts", () => {
  const monday = Date.UTC(2026, 6, 6);
  const wednesday = monday + 2 * DAY;
  const levels = calculateOpenLevels([
    bar(monday, 200, 210, 190, 205, "partial"),
    bar(monday + DAY, 205, 215, 195, 210, "partial"),
    bar(wednesday, 220, 230, 210, 225, "provisional"),
  ], "X:Y", wednesday + 12 * 60 * 60_000, DAY, ["daily", "weekly"]);
  assert.equal(levels.find((level) => level.period === "daily")?.price, 220);
  assert.equal(levels.find((level) => level.period === "weekly")?.price, 200);
});

test("OPEN never substitutes a later candle when the period start is missing", () => {
  const monday = Date.UTC(2026, 6, 6);
  const levels = calculateOpenLevels([
    bar(monday + DAY, 205, 215, 195, 210, "partial"),
  ], "X:Y", monday + 2 * DAY, DAY, ["weekly"]);
  assert.deepEqual(levels, []);
});

test("previous period EQ keeps valid OHLC when footprint completeness is partial", () => {
  const january = Date.UTC(2026, 0, 1);
  const bars = [
    ...Array.from({ length: 31 }, (_, index) =>
      bar(january + index * DAY, index ? 120 : 100, 140, 80, 120, "partial")
    ),
    bar(Date.UTC(2026, 1, 1), 125, 130, 120, 128, "provisional"),
  ];
  const levels = calculateEqLevels(bars, "X:Y", Date.UTC(2026, 1, 2));
  assert.equal(levels.find((level) => level.period === "monthly")?.price, 110);
});

test("current period OPEN accepts a valid partial OHLC period-start candle", () => {
  const february = Date.UTC(2026, 1, 1);
  const levels = calculateOpenLevels([
    bar(february, 125, 130, 120, 128, "partial"),
    bar(february + DAY, 128, 135, 127, 132, "partial"),
  ], "X:Y", february + DAY + 1);
  assert.equal(levels.find((level) => level.period === "monthly")?.price, 125);
});

test("value area uses the previous closed period footprint and the default 70 percent profile", () => {
  const start = Date.UTC(2026, 6, 8);
  const levels = calculateValueAreaLevels([
    footprintBar(start, [[100, 60], [101, 30], [102, 10]]),
  ], "X:Y", start + DAY + 12 * 60 * 60_000, DAY, ["daily"]);
  assert.deepEqual(levels.map((level) => [level.valueAreaKind, level.price]), [
    ["val", 100],
    ["vah", 101],
  ]);
  assert.ok(levels.every((level) => level.sourceStart === start && level.sourceEnd === start + DAY));
});

test("VAL and VAH keep distinct identities when both resolve to the same price", () => {
  const start = Date.UTC(2026, 6, 8);
  const levels = calculateValueAreaLevels([
    footprintBar(start, [[100, 100]]),
  ], "X:Y", start + DAY + 1, DAY, ["daily"]);
  assert.equal(levels.length, 2);
  assert.equal(levels[0].price, 100);
  assert.equal(levels[1].price, 100);
  assert.notEqual(levels[0].id, levels[1].id);
  assert.match(levels[0].id, /\|val$/);
  assert.match(levels[1].id, /\|vah$/);
});

test("value area rejects partial, zero-volume, gapped and OHLC-only data", () => {
  const start = Date.UTC(2026, 6, 8);
  const now = start + DAY + 1;
  assert.deepEqual(calculateValueAreaLevels([
    footprintBar(start, [[100, 10]], "partial"),
  ], "X:Y", now, DAY, ["daily"]), []);
  assert.deepEqual(calculateValueAreaLevels([
    footprintBar(start, [[100, 0]], "complete", 0),
  ], "X:Y", now, DAY, ["daily"]), []);
  assert.deepEqual(calculateValueAreaLevels([
    bar(start, 100, 110, 90, 105),
  ], "X:Y", now, DAY, ["daily"]), []);

  const weekStart = Date.UTC(2026, 6, 6);
  const gapped = [
    footprintBar(weekStart, [[100, 10]]),
    footprintBar(weekStart + 2 * DAY, [[101, 10]]),
  ];
  assert.deepEqual(calculateValueAreaLevels(
    gapped, "X:Y", weekStart + 7 * DAY + 1, DAY, ["weekly"]
  ), []);
});

test("value area never falls back to an older valid period", () => {
  const older = Date.UTC(2026, 6, 7);
  const now = Date.UTC(2026, 6, 9, 12);
  const levels = calculateValueAreaLevels([
    footprintBar(older, [[100, 10]]),
  ], "X:Y", now, DAY, ["daily"]);
  assert.deepEqual(levels, []);
});

test("value area supports all six UTC periods including Monday weeks and leap-year yearly ranges", () => {
  const now = Date.UTC(2026, 6, 8, 12);
  for (const period of ["daily", "weekly", "monthly", "quarterly", "half-yearly", "yearly"]) {
    const start = previousAnalysisPeriodStart(now, period);
    const levels = calculateValueAreaLevels([
      footprintBar(start, [[100, 75], [101, 25]]),
    ], "X:Y", now, PERIOD_INTERVAL[period], [period]);
    assert.equal(levels.length, 2, period);
    assert.ok(levels.every((level) => level.sourceStart === start), period);
  }

  const leapBoundary = Date.UTC(2025, 0, 1);
  const leapStart = Date.UTC(2024, 0, 1);
  const yearly = calculateValueAreaLevels([
    footprintBar(leapStart, [[100, 100]]),
  ], "X:Y", leapBoundary, PERIOD_INTERVAL.yearly, ["yearly"]);
  assert.equal(yearly.length, 2);
  assert.equal(yearly[0].sourceStart, leapStart);
  assert.equal(yearly[0].sourceEnd, leapBoundary);
});

test("untouched levels require opposite candles and ignore open-period touches", () => {
  const start = Date.UTC(2026, 0, 1);
  const pair = [
    bar(start, 100, 111, 99, 110),
    bar(start + DAY, 110, 111, 99, 100),
  ];
  const beforeTouchClose = calculateUntouchedLevels([
    ...pair,
    bar(start + 2 * DAY, 105, 112, 98, 106, "provisional"),
  ], "X:Y", 1, start + 2 * DAY + 12 * 60 * 60_000);
  assert.ok(beforeTouchClose.some((level) => level.period === "daily" && level.price === 100));

  const afterTouchClose = calculateUntouchedLevels([
    ...pair,
    bar(start + 2 * DAY, 105, 112, 98, 106),
  ], "X:Y", 1, start + 3 * DAY);
  assert.ok(!afterTouchClose.some((level) => level.period === "daily"));
});

test("level matching accepts one price-step and excludes dojis", () => {
  const start = Date.UTC(2026, 0, 1);
  const levels = calculateUntouchedLevels([
    bar(start, 100, 111, 99, 110),
    bar(start + DAY, 110.8, 112, 99, 100.8),
  ], "X:Y", 1, start + 2 * DAY);
  // Precise midpoint of the matched open/close pair (100 & 100.8), not snapped
  // to the price step.
  assert.ok(levels.some((level) => level.price === 100.4));

  const doji = calculateUntouchedLevels([
    bar(start, 100, 101, 99, 100),
    bar(start + DAY, 100, 101, 90, 91),
  ], "X:Y", 1, start + 2 * DAY);
  assert.equal(doji.length, 0);
});

test("EQ selects the exact previous calendar period even when current-period OHLC is present", () => {
  const june = Date.UTC(2026, 5, 1);
  const july = Date.UTC(2026, 6, 1);
  const now = Date.UTC(2026, 6, 27, 18);
  const bars = [
    ...month(june, 30, 100, 140, 80, 120),
    ...month(july, 27, 200, 250, 190, 220).map((item, index) => ({
      ...item, completeness: index === 26 ? "provisional" : "complete",
    })),
  ];
  const monthly = calculateEqLevels(bars, "X:Y", now, DAY, ["monthly"])[0];
  assert.equal(monthly?.price, 110);
  assert.equal(monthly?.sourceStart, june);
});

test("OPEN selects the current calendar period's first daily open", () => {
  const july = Date.UTC(2026, 6, 1);
  const now = Date.UTC(2026, 6, 27, 18);
  const levels = calculateOpenLevels([
    ...month(july, 27, 200, 250, 190, 220),
  ], "X:Y", now, DAY, ["monthly"]);
  assert.equal(levels[0]?.price, 200);
  assert.equal(levels[0]?.sourceStart, july);
});

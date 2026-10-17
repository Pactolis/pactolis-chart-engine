import test from "node:test";
import assert from "node:assert/strict";
import { calculateNakedPocs } from "../dist/core/analysis/nakedPoc.js";

const DAY = 86_400_000;

function bar(day, low, high, price, volume = 10, completeness = "complete") {
  return {
    startTime: day,
    open: low,
    high,
    low,
    close: high,
    volume,
    delta: 0,
    count: 1,
    cells: new Map([[price, { priceBin: price, buyVol: volume, sellVol: 0 }]]),
    hasRef: true,
    completeness,
  };
}

test("daily naked POC is removed only by a later completed period touch", () => {
  const bars = [
    bar(Date.UTC(2026, 0, 1), 95, 105, 100),
    bar(Date.UTC(2026, 0, 2), 90, 99, 95),
    bar(Date.UTC(2026, 0, 3), 99, 101, 100),
  ];
  const beforeThirdClose = calculateNakedPocs(
    bars, "BINANCE_FUTURES:btcusdt", "daily", Date.UTC(2026, 0, 3, 12)
  );
  assert.ok(beforeThirdClose.some((item) => item.periodStart === Date.UTC(2026, 0, 1)));
  const afterThirdClose = calculateNakedPocs(
    bars, "BINANCE_FUTURES:btcusdt", "daily", Date.UTC(2026, 0, 4)
  );
  assert.ok(!afterThirdClose.some((item) => item.periodStart === Date.UTC(2026, 0, 1)));
});



test("latest completed period POC is not naked until one newer period closes", () => {
  const start = Date.UTC(2026, 5, 24);
  const levels = calculateNakedPocs(
    [
      bar(start, 90, 110, 100),
      bar(start + DAY, 120, 140, 130),
    ],
    "BINANCE_FUTURES:btcusdt",
    "daily",
    Date.UTC(2026, 5, 26)
  );
  assert.ok(levels.some((item) => item.periodStart === start));
  assert.ok(!levels.some((item) => item.periodStart === start + DAY));
});

test("touches from the current incomplete day do not clear an older naked POC until close", () => {
  const start = Date.UTC(2026, 5, 24);
  const levels = calculateNakedPocs(
    [
      bar(start, 90, 110, 100),
      bar(start + DAY, 120, 140, 130),
      bar(start + 2 * DAY, 95, 105, 100),
    ],
    "BINANCE_FUTURES:btcusdt",
    "daily",
    Date.UTC(2026, 5, 26, 12)
  );
  assert.ok(levels.some((item) => item.periodStart === start));
});


test("weekly profiles use UTC Monday boundaries and report completed-week age", () => {
  const monday = Date.UTC(2026, 0, 5);
  const bars = [];
  for (let i = 0; i < 14; i++) {
    bars.push(i < 7
      ? bar(monday + i * DAY, 80, 90, 100)
      : bar(monday + i * DAY, 110, 130, 120));
  }
  const levels = calculateNakedPocs(
    bars, "BINANCE_FUTURES:btcusdt", "weekly", monday + 14 * DAY
  );
  const first = levels.find((item) => item.periodStart === monday);
  assert.equal(first?.age, 1);
});

test("incomplete footprint periods do not produce naked POCs", () => {
  const start = Date.UTC(2026, 0, 1);
  const levels = calculateNakedPocs(
    [bar(start, 90, 110, 100, 10, "partial")],
    "BINANCE_FUTURES:btcusdt",
    "daily",
    start + DAY
  );
  assert.deepEqual(levels, []);
});

test("current daily, weekly and monthly periods never produce naked POCs", () => {
  const monthStart = Date.UTC(2026, 0, 1);
  const now = Date.UTC(2026, 0, 20, 12);
  const bars = [];
  for (let i = 0; i < 20; i++) {
    bars.push(bar(monthStart + i * DAY, 90, 110, 100));
  }
  const market = "BINANCE_FUTURES:btcusdt";
  const daily = calculateNakedPocs(bars, market, "daily", now);
  const weekly = calculateNakedPocs(bars, market, "weekly", now);
  const monthly = calculateNakedPocs(bars, market, "monthly", now);
  assert.ok(!daily.some((item) => item.periodStart === Date.UTC(2026, 0, 20)));
  assert.ok(!weekly.some((item) => item.periodStart === Date.UTC(2026, 0, 19)));
  assert.ok(!monthly.some((item) => item.periodStart === monthStart));
});

test("quarterly, half-yearly and yearly POCs use calendar periods after a newer period closes", () => {
  const start = Date.UTC(2025, 0, 1);
  const bars = [];
  for (let i = 0; i < 730; i++) {
    const date = new Date(start + i * DAY);
    const yearOffset = date.getUTCFullYear() - 2025;
    const quarter = Math.floor(date.getUTCMonth() / 3);
    const price = 100 + yearOffset * 500 + quarter * 100;
    bars.push(bar(start + i * DAY, price - 10, price + 10, price));
  }
  const now = Date.UTC(2027, 0, 1);
  for (const period of ["quarterly", "half-yearly", "yearly"]) {
    const levels = calculateNakedPocs(bars, "X:Y", period, now);
    assert.ok(levels.some((level) => level.periodStart === start), period);
  }
});

test("optimized suffix touch index matches a brute-force daily oracle", () => {
  const start = Date.UTC(2024, 0, 1);
  const bars = Array.from({ length: 500 }, (_, index) => {
    const price = 80 + (index * 37) % 211;
    const spread = 2 + (index * 13) % 17;
    return bar(start + index * DAY, price - spread, price + spread, price);
  });
  const actual = calculateNakedPocs(bars, "X:Y", "daily", start + 500 * DAY);
  const expectedStarts = [];
  for (let index = 0; index < bars.length - 1; index++) {
    const price = [...bars[index].cells.values()][0].priceBin;
    const touched = bars.slice(index + 1).some((later) => later.low <= price && later.high >= price);
    if (!touched) expectedStarts.push(bars[index].startTime);
  }
  assert.deepEqual(actual.map((level) => level.periodStart), expectedStarts);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasCompleteFootprint, hasCompleteFootprintCoverage } from "../dist/core/analysis/footprintIntegrity.js";
import { calculateValueAreaLevels } from "../dist/core/analysis/referenceLevels.js";
import { calculateNakedPocs } from "../dist/core/analysis/nakedPoc.js";

const DAY = 86_400_000;
const MINUTE = 60_000;
const market = "BINANCE_FUTURES:btcusdt";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/binance-btcusdt-2026-11-10-1m.json", import.meta.url)));
const start = fixture.rows[0][0];
function realBars() {
  return fixture.rows.map(([time, volume, count, buy, sell]) => ({
    startTime: time, open: 100, high: 101, low: 99, close: 100,
    volume: Number(volume), delta: Number(buy) - Number(sell), count,
    cells: new Map([[100, { priceBin: 100, buyVol: Number(buy), sellVol: Number(sell) }]]),
    hasRef: true, completeness: "complete",
  }));
}
function levels(bars) {
  // nPOC requires one newer closed period with no touch of the original POC.
  const nextDay = realBars().map((bar) => ({ ...bar, startTime: bar.startTime + DAY,
    open: 200, high: 201, low: 199, close: 200,
    cells: new Map([[200, { ...bar.cells.get(100), priceBin: 200 }]]),
  }));
  return {
    valueArea: calculateValueAreaLevels(bars, market, start + DAY, MINUTE, ["daily"]),
    npoc: calculateNakedPocs([...bars, ...nextDay], market, "daily", start + 2 * DAY, MINUTE)
      .filter((level) => level.periodStart === start),
  };
}

test("real Binance minute shifts conserve the day and retain previous VAL/VAH and nPOC", () => {
  const bars = realBars();
  assert.equal(bars.length, 1440);
  for (const minute of [11 * 60 + 25, 18 * 60 + 12, 20 * 60 + 55]) {
    const bar = bars[minute];
    const cell = bar.cells.get(100);
    assert.ok((cell.buyVol + cell.sellVol) / bar.volume < 0.98);
    assert.equal(hasCompleteFootprint(bar), true);
  }
  assert.equal(hasCompleteFootprintCoverage(bars, start, start + DAY, MINUTE), true);
  const result = levels(bars);
  assert.deepEqual(result.valueArea.map((level) => level.valueAreaKind).sort(), ["vah", "val"]);
  assert.equal(result.npoc.length, 1);
});

test("a real period deficit or surplus suppresses both footprint level families", () => {
  for (const factor of [0.5, 1.5]) {
    const bars = realBars();
    const cell = bars[600].cells.get(100);
    cell.buyVol *= factor;
    cell.sellVol *= factor;
    assert.equal(hasCompleteFootprintCoverage(bars, start, start + DAY, MINUTE), false);
    assert.deepEqual(levels(bars), { valueArea: [], npoc: [] });
  }
});

test("period balance cannot override partial, provisional, absent or invalid cells", () => {
  for (const invalidate of [
    (bar) => { bar.completeness = "partial"; },
    (bar) => { bar.completeness = "provisional"; },
    (bar) => { bar.cells.clear(); },
    (bar) => { bar.cells.get(100).buyVol = NaN; },
    (bar) => { bar.cells.get(100).sellVol = -1; },
    (bar) => { bar.volume = Infinity; },
  ]) {
    const bars = realBars();
    invalidate(bars[600]);
    assert.equal(hasCompleteFootprintCoverage(bars, start, start + DAY, MINUTE), false);
    assert.deepEqual(levels(bars), { valueArea: [], npoc: [] });
  }
  const gapped = realBars();
  gapped.splice(600, 1);
  assert.equal(hasCompleteFootprintCoverage(gapped, start, start + DAY, MINUTE), false);
});

test("period tolerance is relative and symmetric, including daily-source fallback", () => {
  const bar = realBars()[0];
  const cell = bar.cells.get(100);
  bar.volume = cell.buyVol + cell.sellVol;
  bar.startTime = start;
  for (const difference of [-0.5e-6, 0.5e-6]) {
    const shifted = { ...bar, volume: bar.volume * (1 + difference) };
    assert.equal(hasCompleteFootprintCoverage([shifted], start, start + DAY), true);
  }
  for (const difference of [-2e-6, 2e-6]) {
    const shifted = { ...bar, volume: bar.volume * (1 + difference) };
    assert.equal(hasCompleteFootprintCoverage([shifted], start, start + DAY), false);
  }
});

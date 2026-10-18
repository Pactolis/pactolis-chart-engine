import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePeriodCandles } from "../dist/core/analysis/periods.js";
import { simpleMovingAverage } from "../dist/core/analysis/calc/ta.js";

// TASK-149: the legacy `src/core/analysis/movingAverages.ts` hattı (and its
// thin `calculateMovingAverageSeries` wrapper) was retired; the daily/weekly
// HTF MA calc accuracy guarantee it used to cover now lives on the calc
// primitives directly (`aggregatePeriodCandles` + `simpleMovingAverage`),
// which is exactly what the MA/EMA indicator's `sourceTimeframe` path
// (`node_modules/@pactolis/chart-engine/src/features/indicators/builtins/movingAverage.ts`) composes at runtime.

const DAY = 86_400_000;

function bar(day, close) {
  return {
    startTime: day,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
    completeness: "complete",
  };
}

test("50 day moving average uses completed daily closes", () => {
  const start = Date.UTC(2026, 0, 1);
  const bars = Array.from({ length: 60 }, (_, i) => bar(start + i * DAY, i + 1));
  const candles = aggregatePeriodCandles(bars, "daily", start + 61 * DAY)
    .filter((item) => item.complete && Number.isFinite(item.close));
  const values = simpleMovingAverage(candles.map((item) => item.close), 50);
  assert.equal(values.at(-1), (11 + 60) / 2);
});

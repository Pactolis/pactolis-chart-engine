import test from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (id) => clearInterval(id),
};
globalThis.performance ??= { now: () => Date.now() };

const { ReplayController, cloneFootprintBarForReplay } = await import("../dist/features/replay/replayController.js");

function createSyntheticBar(startTime, cellCount = 60) {
  const cells = new Map();
  for (let i = 0; i < cellCount; i++) {
    const price = 50000 + i * 10;
    cells.set(price, {
      priceBin: price,
      buyVol: 10 + (i % 7),
      sellVol: 8 + (i % 5),
      count: 4,
      buyCount: 2,
      sellCount: 2,
    });
  }
  return {
    startTime,
    open: 50000,
    high: 50600,
    low: 49950,
    close: 50300,
    volume: 1080,
    delta: 120,
    count: 240,
    cells,
    hasRef: true,
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

test("cloneFootprintBarForReplay provides complete deep cell isolation", () => {
  const original = createSyntheticBar(1000, 10);
  const cloned = cloneFootprintBarForReplay(original);

  assert.notEqual(cloned, original, "bar reference must be distinct");
  assert.notEqual(cloned.cells, original.cells, "cells Map must be distinct");
  assert.equal(cloned.cells.size, original.cells.size);

  const priceKey = 50000;
  const originalCell = original.cells.get(priceKey);
  const clonedCell = cloned.cells.get(priceKey);
  assert.ok(originalCell && clonedCell);
  assert.notEqual(clonedCell, originalCell, "cell object reference must be distinct");
  assert.equal(clonedCell.buyVol, originalCell.buyVol);

  // Mutation of original bar cell does not bleed into clone
  originalCell.buyVol = 999999;
  assert.notEqual(clonedCell.buyVol, 999999, "clone must not observe original cell mutation");
  assert.equal(clonedCell.buyVol, 10);

  // Adding new cell to original does not bleed
  original.cells.set(99990, { priceBin: 99990, buyVol: 1, sellVol: 1 });
  assert.equal(cloned.cells.has(99990), false, "clone must not observe new cell additions");
});

test("Replay zero future-data leakage: seek never leaks bars beyond virtualTime", () => {
  const INTERVAL = 60_000;
  const BARS_COUNT = 100;
  const bars = Array.from({ length: BARS_COUNT }, (_, i) => createSyntheticBar(i * INTERVAL, 10));
  const isolated = bars.map(cloneFootprintBarForReplay);

  const controller = new ReplayController(() => {}, () => {});
  controller.loadForSelection(isolated, INTERVAL);

  // Seek to halfway: 40 bars completed
  const targetTime = 40 * INTERVAL;
  const visible = controller.seek(targetTime);

  assert.equal(visible.length, 40, "only completed bars returned");
  for (const b of visible) {
    assert.ok(
      b.startTime + INTERVAL <= targetTime,
      `bar at ${b.startTime} must complete before target ${targetTime}`,
    );
  }

  // Future bars past targetTime must not have been returned
  const futureIndices = visible.filter((b) => b.startTime >= targetTime);
  assert.equal(futureIndices.length, 0, "zero future data leakage");
});

test("Benchmark: cloneFootprintBarForReplay vs structuredClone on 1, 4, 8 multi-chart topologies", () => {
  const INTERVAL = 60_000;
  const BARS_PER_CHART = 500;
  const CELLS_PER_BAR = 60;
  const ITERATIONS = 5;

  const topologies = [1, 4, 8];
  const results = [];

  for (const chartCount of topologies) {
    // Generate datasets for `chartCount` concurrent charts
    const datasets = Array.from({ length: chartCount }, () =>
      Array.from({ length: BARS_PER_CHART }, (_, i) =>
        createSyntheticBar(i * INTERVAL, CELLS_PER_BAR)
      )
    );

    const oldStartTimes = [];
    const newStartTimes = [];
    const oldScrubTimes = [];
    const newScrubTimes = [];

    for (let iter = 0; iter < ITERATIONS; iter++) {
      // 1. OLD Approach: double structuredClone on start + scrub
      const t0OldStart = performance.now();
      const oldSnapshots = datasets.map((chartBars) =>
        chartBars.map((bar) => structuredClone(bar))
      );
      const oldControllers = oldSnapshots.map((bars) => {
        const c = new ReplayController(() => {}, () => {});
        c.loadForSelection(bars, INTERVAL);
        return c;
      });
      oldStartTimes.push(performance.now() - t0OldStart);

      const t0OldScrub = performance.now();
      oldControllers.forEach((c) => {
        const visible = c.seek(250 * INTERVAL);
        // Old double structuredClone on emit:
        visible.forEach((b) => structuredClone(b));
      });
      oldScrubTimes.push(performance.now() - t0OldScrub);

      // 2. NEW Approach: fast cloneFootprintBarForReplay + shallow emit on scrub
      const t0NewStart = performance.now();
      const newSnapshots = datasets.map((chartBars) =>
        chartBars.map((bar) => cloneFootprintBarForReplay(bar))
      );
      const newControllers = newSnapshots.map((bars) => {
        const c = new ReplayController(() => {}, () => {});
        c.loadForSelection(bars, INTERVAL);
        return c;
      });
      newStartTimes.push(performance.now() - t0NewStart);

      const t0NewScrub = performance.now();
      newControllers.forEach((c) => {
        // New shallow emit: no second structuredClone
        c.seek(250 * INTERVAL);
      });
      newScrubTimes.push(performance.now() - t0NewScrub);
    }

    const row = {
      charts: chartCount,
      oldStartP50: percentile(oldStartTimes, 50).toFixed(2),
      oldStartP95: percentile(oldStartTimes, 95).toFixed(2),
      newStartP50: percentile(newStartTimes, 50).toFixed(2),
      newStartP95: percentile(newStartTimes, 95).toFixed(2),
      oldScrubP50: percentile(oldScrubTimes, 50).toFixed(2),
      oldScrubP95: percentile(oldScrubTimes, 95).toFixed(2),
      newScrubP50: percentile(newScrubTimes, 50).toFixed(2),
      newScrubP95: percentile(newScrubTimes, 95).toFixed(2),
    };
    results.push(row);

    // Assert that the new approach is strictly faster
    assert.ok(
      Number(row.newStartP50) < Number(row.oldStartP50),
      `New start p50 (${row.newStartP50}ms) must be faster than old start p50 (${row.oldStartP50}ms)`,
    );
    assert.ok(
      Number(row.newScrubP50) < Number(row.oldScrubP50),
      `New scrub p50 (${row.newScrubP50}ms) must be faster than old scrub p50 (${row.oldScrubP50}ms)`,
    );
  }

  // Print markdown benchmark table to stdout
  console.log("\n### Benchmark Results: Replay Bar Cloning (Issue #31)");
  console.log("| Charts | Old Start p50/p95 (ms) | New Start p50/p95 (ms) | Old Scrub p50/p95 (ms) | New Scrub p50/p95 (ms) | Speedup (Scrub) |");
  console.log("| :---: | :---: | :---: | :---: | :---: | :---: |");
  for (const r of results) {
    const speedup = (Number(r.oldScrubP50) / Math.max(0.01, Number(r.newScrubP50))).toFixed(1);
    console.log(`| ${r.charts} | ${r.oldStartP50} / ${r.oldStartP95} | ${r.newStartP50} / ${r.newStartP95} | ${r.oldScrubP50} / ${r.oldScrubP95} | ${r.newScrubP50} / ${r.newScrubP95} | **${speedup}x** |`);
  }
});

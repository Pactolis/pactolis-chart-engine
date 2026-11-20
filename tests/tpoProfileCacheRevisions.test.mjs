import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTpoProfileGroups, effectiveTpoBracketMs } from "../dist/core/analysis/tpoProfile.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { configurePerformanceTelemetry, snapshotPerformanceTelemetry } from "../dist/core/performanceTelemetry.js";
import { updateTpoProfileCache } from "../dist/core/render/overlay/tpoProfileCache.js";

const INTERVAL = 30 * 60_000;
const DAY = 48 * INTERVAL;
const START = Date.UTC(2026, 9, 1);

function makeBar(startTime, index) {
  const open = 60_000 + index % 7 * 10;
  return {
    startTime, open, high: open + 20, low: open - 10, close: open + 10,
    volume: 1, delta: 1, count: 1, cells: new Map(), sources: ["history"],
    completeness: "complete", hasRef: true,
  };
}

function trade(bar) {
  return {
    id: String(bar.startTime),
    time: bar.startTime + 100,
    receivedAt: bar.startTime + 200,
    price: bar.high + 10,
    qty: 2,
    isBuy: true,
    liquidation: false,
    source: "recovery",
  };
}

function fixture() {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 10 });
  series.loadBars(Array.from({ length: 4 * 48 + 17 }, (_, index) =>
    makeBar(START + index * INTERVAL, index)));
  const config = { tpoProfilePeriod: "daily", tpoBracketSize: "30m" };
  const mergeLeft = new Set();
  const refresh = (previous, range = [0, series.length], vaPercent = 0.7) => {
    const actual = updateTpoProfileCache(previous, series, range, config, vaPercent, mergeLeft);
    const { intervalMs, priceStep } = series.config;
    const expected = buildTpoProfileGroups(
      series.listReadonly(), ...range, config.tpoProfilePeriod,
      effectiveTpoBracketMs(config.tpoBracketSize, intervalMs), intervalMs, priceStep,
      vaPercent, mergeLeft,
    );
    assert.deepStrictEqual(actual.brackets, expected.brackets);
    assert.deepStrictEqual(actual.groups, expected.groups);
    return actual;
  };
  return { series, config, mergeLeft, refresh };
}

function measure(run) {
  const before = snapshotPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const state = run();
    const after = snapshotPerformanceTelemetry().counters;
    const delta = (name) => (after[name] ?? 0) - (before.counters[name] ?? 0);
    return {
      state,
      skipped: delta("chart.tpo.cache.skippedGroups"),
      computed: delta("chart.tpo.compute.groups"),
    };
  } finally {
    configurePerformanceTelemetry({ enabled: before.enabled });
  }
}

test("an in-place tail trade skips all closed TPO group comparisons", () => {
  const { series, refresh } = fixture();
  const before = refresh(null);
  const tail = series.at(series.length - 1);
  const { revision, structureRevision, nonTailRevision } = series;
  series.addTrade(trade(tail));
  assert.ok(series.revision > revision);
  assert.equal(series.structureRevision, structureRevision);
  assert.equal(series.nonTailRevision, nonTailRevision);

  const { state, skipped, computed } = measure(() => refresh(before));
  assert.equal(skipped, 4);
  assert.equal(computed, 1);
  for (let i = 0; i < skipped; i++) assert.strictEqual(state.groups[i].result, before.groups[i].result);
  assert.notStrictEqual(state.groups.at(-1).result, before.groups.at(-1).result);
});

const historicalWrites = [
  ["addTrade", (series, bar) => series.addTrade(trade(bar)), true],
  ["addTrades recovery", (series, bar) => series.addTrades([trade(bar)], { dedupe: false }), true],
  ["addCandleTrades", (series, bar) => series.addCandleTrades([trade(bar)]), true],
  ["addFootprintTrades", (series, bar) => series.addFootprintTrades([trade(bar)]), false],
  ["late liquidation", (series, bar) => series.addTrade({ ...trade(bar), liquidation: true }), false],
  ["reassertOHLC", (series, bar) => series.reassertOHLC(bar.startTime, bar.open, bar.high + 20, bar.low, {
    close: bar.high + 10, preferIncomingClose: true, observedAt: bar.startTime + 300,
  }), true],
];

for (const [name, mutate, changesProfile] of historicalWrites) {
  test(`${name} invalidates an in-place historical TPO input`, () => {
    const { series, refresh } = fixture();
    const before = refresh(null);
    const index = 48 + 5;
    const bar = series.at(index);
    const { revision, structureRevision, nonTailRevision } = series;
    mutate(series, bar);
    assert.strictEqual(series.at(index), bar);
    assert.ok(series.revision > revision);
    assert.equal(series.structureRevision, structureRevision);
    assert.ok(series.nonTailRevision > nonTailRevision);

    const { state, skipped, computed } = measure(() => refresh(before));
    assert.equal(skipped, 0);
    assert.equal(computed, changesProfile ? 1 : 0);
    assert.notDeepStrictEqual(state.brackets[index], before.brackets[index]);
    assert.equal(state.groups[1].result !== before.groups[1].result, changesProfile);
  });
}

test("each TPO reader sees historical edits across subsequent tail updates", () => {
  const { series, refresh } = fixture();
  const first = refresh(null);
  const second = refresh(null, [0, 96]);
  const oldBar = series.at(52);
  series.addTrade(trade(oldBar));
  series.addTrade(trade(series.at(series.length - 1)));
  assert.equal(measure(() => refresh(first)).computed, 2);
  const updated = measure(() => refresh(second, [0, 96]));
  assert.equal(updated.computed, 1);
  assert.equal(updated.skipped, 0);
});

test("replacement, repair, prepend and TPO settings retain full oracle parity", () => {
  const { series, config, mergeLeft, refresh } = fixture();
  let previous = refresh(null);
  const replaced = series.at(5);
  series.upsertBar({ ...replaced, high: replaced.high + 30, sources: ["history", "recovery"] });
  let current = measure(() => refresh(previous));
  assert.equal(current.skipped, 0);
  assert.equal(current.computed, 1);
  previous = current.state;

  const repaired = series.at(50);
  series.beginRepairBarrier([repaired.startTime]);
  series.replaceRange(repaired.startTime, repaired.startTime + INTERVAL, [
    { ...repaired, low: repaired.low - 30, sources: ["recovery"] },
  ]);
  series.commitRepairOwnership([repaired.startTime], 10n, []);
  current = measure(() => refresh(previous));
  assert.equal(current.skipped, 0);
  assert.equal(current.computed, 1);
  previous = current.state;

  series.replaceRange(START - DAY, START, Array.from({ length: 48 }, (_, index) =>
    makeBar(START - DAY + index * INTERVAL, index)));
  current = measure(() => refresh(previous));
  assert.equal(current.skipped, 0);
  previous = current.state;

  mergeLeft.add(START + DAY);
  const merged = refresh(previous);
  assert.ok(merged.groups.some((group) => group.sessionStarts.length === 2));
  mergeLeft.clear();
  const unmerged = refresh(merged);
  assert.ok(unmerged.groups.every((group) => group.sessionStarts.length === 1));
  config.tpoBracketSize = "1h";
  const configured = refresh(unmerged, [0, series.length], 0.8);
  const bars = [...series.listReadonly()];
  series.setPriceStep(5);
  series.loadBars(bars);
  const differentStep = refresh(configured, [0, series.length], 0.8);
  series.setInterval(INTERVAL / 2);
  series.loadBars(bars);
  refresh(differentStep, [0, series.length], 0.8);
});

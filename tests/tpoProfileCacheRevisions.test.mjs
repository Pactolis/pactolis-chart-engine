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

test("equivalent history replacements revalidate the references used by the next tail update", () => {
  const { series, refresh } = fixture();
  const before = refresh(null);
  const first = series.at(0);
  const replacement = series.listReadonly().slice(0, 48).map((bar) => ({
    ...bar, sources: [...bar.sources],
  }));
  series.replaceRange(START, START + DAY, replacement);
  assert.notStrictEqual(series.at(0), first);
  const revalidated = measure(() => refresh(before));
  assert.equal(revalidated.skipped, 0);
  assert.equal(revalidated.computed, 0);
  assert.strictEqual(revalidated.state.groups[0].result, before.groups[0].result);

  series.addTrade(trade(series.at(series.length - 1)));
  const updated = measure(() => refresh(revalidated.state));
  assert.equal(updated.skipped, 4);
  assert.equal(updated.computed, 1);
});

test("tail fast path skips closed scans, preserves brackets/results on close within range and no-op revision bumps", () => {
  const { series, refresh } = fixture();
  const initial = refresh(null);
  const tail = series.at(series.length - 1);

  // Close moves inside existing [low, high]: refreshes last bracket without recomputing calculateTpoProfile.
  series.addTrade({
    id: "inside-range-close",
    time: tail.startTime + 500,
    receivedAt: tail.startTime + 600,
    price: tail.low + 10,
    qty: 1.5,
    isBuy: false,
    liquidation: false,
    source: "live",
  });
  const bracketOnly = measure(() => refresh(initial));
  assert.equal(bracketOnly.skipped, 4);
  assert.equal(bracketOnly.computed, 0);
  for (let i = 0; i < initial.brackets.length - 1; i++) {
    assert.strictEqual(bracketOnly.state.brackets[i], initial.brackets[i]);
  }
  assert.notStrictEqual(bracketOnly.state.brackets.at(-1), initial.brackets.at(-1));
  assert.equal(bracketOnly.state.brackets.at(-1).bar.close, tail.low + 10);
  for (let i = 0; i < initial.groups.length; i++) {
    assert.strictEqual(bracketOnly.state.groups[i].result, initial.groups[i].result);
  }
  assert.notStrictEqual(bracketOnly.state.groups.at(-1), initial.groups.at(-1));
  // Immutability of prior snapshot.
  assert.notEqual(initial.brackets.at(-1).bar.close, tail.low + 10);

  // Revision bump without bar field edits hits tailChanges === "none".
  series.setPricePrecision(4);
  const noOp = measure(() => refresh(bracketOnly.state));
  assert.equal(noOp.skipped, 4);
  assert.equal(noOp.computed, 0);
  assert.strictEqual(noOp.state.brackets, bracketOnly.state.brackets);
  assert.strictEqual(noOp.state.groups, bracketOnly.state.groups);

  // High/low expansion on tail recomputes only the active group and preserves all closed references.
  series.addTrade({
    id: "expand-high",
    time: tail.startTime + 700,
    receivedAt: tail.startTime + 800,
    price: tail.high + 20,
    qty: 1,
    isBuy: true,
    liquidation: false,
    source: "live",
  });
  const expanded = measure(() => refresh(noOp.state));
  assert.equal(expanded.skipped, 4);
  assert.equal(expanded.computed, 1);
  for (let i = 0; i < 4; i++) assert.strictEqual(expanded.state.groups[i].result, initial.groups[i].result);
  assert.notStrictEqual(expanded.state.groups.at(-1).result, noOp.state.groups.at(-1).result);
  for (let i = 0; i < expanded.state.brackets.length - 1; i++) {
    assert.strictEqual(expanded.state.brackets[i], bracketOnly.state.brackets[i]);
  }
});

test("tail fast path handles multi-bar brackets, new session boundaries, merged groups, off-tail pan and backward replay", () => {
  const { series, config, mergeLeft, refresh } = fixture();
  config.tpoBracketSize = "1h";
  const initial = refresh(null);
  const tail = series.at(series.length - 1);

  // Live trade on aggregated 1h bracket whose lastCachedBracket merges multiple 30m bars (append to make even bracket length).
  const nextSameSession = makeBar(tail.startTime + INTERVAL, series.length);
  series.upsertBar(nextSameSession);
  const afterSameSessionAppend = measure(() => refresh(initial));
  assert.equal(afterSameSessionAppend.skipped, 0);
  assert.equal(afterSameSessionAppend.computed, 1);

  // Subsequent live trade on that multi-bar 1h bracket re-enters tail fast path.
  series.addTrade(trade(series.at(series.length - 1)));
  const multiBarTailTick = measure(() => refresh(afterSameSessionAppend.state));
  assert.equal(multiBarTailTick.skipped, 4);
  assert.equal(multiBarTailTick.computed, 1);
  for (let i = 0; i < multiBarTailTick.state.brackets.length - 1; i++) {
    assert.strictEqual(multiBarTailTick.state.brackets[i], afterSameSessionAppend.state.brackets[i]);
  }

  // Cross UTC day boundary -> new active session, then tail fast path skips 5 closed groups.
  config.tpoBracketSize = "30m";
  const baseTail = refresh(multiBarTailTick.state);
  series.upsertBar(makeBar(START + 5 * DAY, 240));
  const newDay = measure(() => refresh(baseTail));
  assert.equal(newDay.skipped, 0);
  assert.equal(newDay.state.groups.length, 6);
  series.addTrade(trade(series.at(series.length - 1)));
  const newDayTick = measure(() => refresh(newDay.state));
  assert.equal(newDayTick.skipped, 5);
  assert.equal(newDayTick.computed, 1);

  // Merged last group + live tick, then undo.
  mergeLeft.add(START + 5 * DAY);
  const merged = refresh(newDayTick.state);
  series.addTrade({ ...trade(series.at(series.length - 1)), id: "merged-tail", price: series.at(series.length - 1).high + 30 });
  const mergedTick = measure(() => refresh(merged));
  assert.equal(mergedTick.skipped, 4);
  assert.equal(mergedTick.computed, 1);
  mergeLeft.clear();
  const unmerged = refresh(mergedTick.state);
  assert.equal(unmerged.groups.length, 6);

  // Panning away from tail does not misuse tail fast path.
  const panned = refresh(unmerged, [0, 120]);
  series.addTrade({ ...trade(series.at(series.length - 1)), id: "offscreen-tail", price: series.at(series.length - 1).high + 40 });
  const pannedAfterTick = refresh(panned, [0, 120]);
  assert.strictEqual(pannedAfterTick.groups.at(-1).result, panned.groups.at(-1).result);

  // Backward replay truncation retains exact oracle parity.
  const full = [...series.listReadonly()];
  series.loadBars(full.slice(0, 110));
  const rewound = refresh(unmerged, [0, 110]);
  series.addTrade(trade(series.at(series.length - 1)));
  const rewoundTick = measure(() => refresh(rewound, [0, 110]));
  assert.equal(rewoundTick.skipped, 2);
  assert.equal(rewoundTick.computed, 1);
});

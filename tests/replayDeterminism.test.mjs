// T11-A slice 1: bar-level replay determinism (#329).
// Oracles are hand-authored bar lists and replay times, not replay output parity.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

globalThis.window ??= { setInterval, clearInterval };
globalThis.performance ??= { now: () => Date.now() };

const { ReplayController } = await import("../dist/features/replay/replayController.js");
const { ChartReplayCoordinator } = await import("../dist/features/chart/ChartReplayCoordinator.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 1, 0, 0);

function cell(priceBin, buyVol, sellVol) {
  return { priceBin, buyVol, sellVol, count: 2, buyCount: 1, sellCount: 1 };
}

/** Hand-authored 1m bars; each has two cells so the hash covers cell ordering. */
function bars1m(count = 6) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const open = 100 + i;
    out.push({
      startTime: T0 + i * MIN,
      open,
      high: open + 2,
      low: open - 1,
      close: open + 1,
      volume: 4,
      buyVolume: 3,
      sellVolume: 1,
      delta: 2,
      count: 4,
      // Inserted high price first: canonicalization must sort, not trust insertion order.
      cells: new Map([[open + 1, cell(open + 1, 2, 0)], [open, cell(open, 1, 1)]]),
      hasRef: true,
    });
  }
  return out;
}

/**
 * Canonical replay state, format version 1 (T11-A proposal section 3):
 * - fields: version, state, virtualTime, intervalMs, visibleBars sorted by startTime, each bar's
 *   cells as [priceBin, buyVol, sellVol, count] sorted by priceBin;
 * - numbers serialize with Number.prototype.toString via JSON; NaN and Infinity are rejected;
 * - wall-time fields (lastTick, pendingBars) and speed are excluded: they change timing, not results;
 * - ties: the series that feeds replay is keyed by startTime, so it holds one bar per time.
 * A change to any of these rules bumps the version, so hashes of two formats never compare equal.
 */
const REPLAY_CANONICAL_VERSION = 1;

function canonical(snapshot, visibleBars, intervalMs, version = REPLAY_CANONICAL_VERSION) {
  const value = {
    version,
    state: snapshot.state,
    virtualTime: snapshot.virtualTime,
    intervalMs,
    visibleBars: visibleBars
      .map((bar) => ({
        startTime: bar.startTime,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        delta: bar.delta,
        count: bar.count,
        cells: [...bar.cells.values()]
          .map((c) => [c.priceBin, c.buyVol, c.sellVol, c.count])
          .sort((a, b) => a[0] - b[0]),
      }))
      .sort((a, b) => a.startTime - b.startTime),
  };
  const text = JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("non-finite number in replay state");
    return item;
  });
  return createHash("sha256").update(text).digest("hex");
}

/** Replaces the interval timer and monotonic clock so a test controls wall time exactly. */
function withFakeClock(run) {
  const originalSetInterval = globalThis.window.setInterval;
  const originalClearInterval = globalThis.window.clearInterval;
  const originalNow = performance.now.bind(performance);
  let now = 0;
  let tick = null;
  globalThis.window.setInterval = (fn) => { tick = fn; return 1; };
  globalThis.window.clearInterval = () => { tick = null; };
  performance.now = () => now;
  try {
    return run({
      advance(ms) {
        now += ms;
        tick?.();
      },
      get tick() { return tick; },
    });
  } finally {
    performance.now = originalNow;
    globalThis.window.setInterval = originalSetInterval;
    globalThis.window.clearInterval = originalClearInterval;
  }
}

/** Seek to T0+2m, then play until `release` bars were released, ticking every `tickMs` at `speed`. */
function runSchedule({ speed, tickMs, release }) {
  const released = [];
  let last = null;
  const controller = new ReplayController((bar) => released.push(bar), (snapshot) => { last = snapshot; });
  const bars = bars1m();
  controller.loadForSelection(bars, MIN);
  const prefix = controller.seek(T0 + 2 * MIN);
  controller.setSpeed(speed);
  withFakeClock((clock) => {
    controller.play();
    let guard = 0;
    while (released.length < release && guard++ < 10_000) clock.advance(tickMs);
    controller.pause();
  });
  controller.dispose();
  return { prefix, released, snapshot: last, controller };
}

test("seek exposes exactly the bars completed at the replay time", () => {
  const controller = new ReplayController(() => {}, () => {});
  controller.loadForSelection(bars1m(), MIN);
  // Hand oracle: a bar is visible iff startTime + 1m <= virtualTime.
  assert.deepEqual(controller.seek(T0 + 2 * MIN).map((bar) => bar.startTime), [T0, T0 + MIN]);
  assert.deepEqual(controller.seek(T0 + 2 * MIN + 59_999).map((bar) => bar.startTime), [T0, T0 + MIN]);
  assert.deepEqual(controller.seek(T0 + 3 * MIN).map((bar) => bar.startTime), [T0, T0 + MIN, T0 + 2 * MIN]);
  assert.equal(controller.snapshot().virtualTime, T0 + 3 * MIN);
});

test("the same released bars give the same canonical hash at any speed and tick schedule", () => {
  const schedules = [
    { speed: 1, tickMs: 1_000 },
    { speed: 1, tickMs: 50 },
    { speed: 10, tickMs: 100 },
    { speed: 4, tickMs: 50 },
  ];
  const results = schedules.map((schedule) => runSchedule({ ...schedule, release: 3 }));
  for (const result of results) {
    // Hand oracle: two bars from the seek, then exactly three released in order.
    assert.deepEqual(result.prefix.map((bar) => bar.startTime), [T0, T0 + MIN]);
    assert.deepEqual(result.released.map((bar) => bar.startTime), [T0 + 2 * MIN, T0 + 3 * MIN, T0 + 4 * MIN]);
    // Event time, not wall time: the clock sits at the end of the last released bar.
    assert.equal(result.snapshot.virtualTime, T0 + 5 * MIN);
    assert.equal(result.snapshot.visibleBars, 5);
    assert.equal(result.snapshot.state, "paused");
  }
  const hashes = results.map((result) => canonical(result.snapshot, [...result.prefix, ...result.released], MIN));
  assert.equal(new Set(hashes).size, 1, "canonical replay state must not depend on speed or tick timing");
});

test("the canonical hash changes when replay content or time changes", () => {
  const base = runSchedule({ speed: 1, tickMs: 1_000, release: 3 });
  const visible = [...base.prefix, ...base.released];
  const reference = canonical(base.snapshot, visible, MIN);

  const changedBar = visible.map((bar, index) => (index === 4 ? { ...bar, close: bar.close + 0.5 } : bar));
  assert.notEqual(canonical(base.snapshot, changedBar, MIN), reference);

  const changedCell = visible.map((bar, index) => (
    index === 0 ? { ...bar, cells: new Map([[bar.open, cell(bar.open, 1, 2)], [bar.open + 1, cell(bar.open + 1, 2, 0)]]) } : bar
  ));
  assert.notEqual(canonical(base.snapshot, changedCell, MIN), reference);

  assert.notEqual(canonical({ ...base.snapshot, virtualTime: base.snapshot.virtualTime + 1 }, visible, MIN), reference);
  assert.equal(canonical({ ...base.snapshot, speed: 99 }, visible, MIN), reference, "speed is not part of the canonical state");
  assert.notEqual(canonical(base.snapshot, visible, MIN, REPLAY_CANONICAL_VERSION + 1), reference, "the format version is part of the hash");
});

test("a reset replay reproduces the canonical state of a fresh one", () => {
  const fresh = runSchedule({ speed: 1, tickMs: 1_000, release: 3 });
  const reference = canonical(fresh.snapshot, [...fresh.prefix, ...fresh.released], MIN);

  const released = [];
  let last = null;
  const controller = new ReplayController((bar) => released.push(bar), (snapshot) => { last = snapshot; });
  // A first session that plays elsewhere and is then exited.
  controller.loadForSelection(bars1m(), MIN);
  controller.seek(T0 + 4 * MIN);
  controller.step();
  controller.exit();
  // Reset: the same dataset and the same inputs as the fresh run.
  released.length = 0;
  controller.loadForSelection(bars1m(), MIN);
  const prefix = controller.seek(T0 + 2 * MIN);
  controller.step();
  controller.step();
  controller.step();
  controller.pause();
  assert.equal(canonical(last, [...prefix, ...released], MIN), reference);
  controller.dispose();
});

test("step releases one bar per call and ends in done without passing the last bar", () => {
  const released = [];
  let last = null;
  const controller = new ReplayController((bar) => released.push(bar.startTime), (snapshot) => { last = snapshot; });
  controller.loadForSelection(bars1m(3), MIN);
  controller.seek(T0);
  assert.equal(last.visibleBars, 0);
  controller.step();
  assert.deepEqual(released, [T0]);
  assert.equal(last.virtualTime, T0 + MIN);
  controller.step();
  controller.step();
  assert.deepEqual(released, [T0, T0 + MIN, T0 + 2 * MIN]);
  assert.equal(last.state, "done");
  assert.equal(last.virtualTime, T0 + 3 * MIN);
  controller.step();
  assert.deepEqual(released, [T0, T0 + MIN, T0 + 2 * MIN], "no bar after done");
  assert.equal(last.virtualTime, T0 + 3 * MIN);
});

test("timeframe round trip keeps the replay time and never shows an incomplete bar", () => {
  const controller = new ReplayController(() => {}, () => {});
  const oneMinute = bars1m(10);
  const fiveMinute = [0, 5].map((offset) => ({ ...bars1m(1)[0], startTime: T0 + offset * MIN }));
  controller.loadForSelection(oneMinute, MIN);
  controller.seek(T0 + 7 * MIN);

  const coarse = controller.reconfigure(fiveMinute, 5 * MIN);
  // Hand oracle: only the 00:00 5m bar has ended by 00:07; the 00:05 bar ends at 00:10.
  assert.deepEqual(coarse.visibleBars.map((bar) => bar.startTime), [T0]);
  assert.equal(controller.snapshot().virtualTime, T0 + 7 * MIN);

  const fine = controller.reconfigure(oneMinute, MIN);
  assert.deepEqual(fine.visibleBars.map((bar) => bar.startTime), [0, 1, 2, 3, 4, 5, 6].map((i) => T0 + i * MIN));
  assert.equal(controller.snapshot().virtualTime, T0 + 7 * MIN);
});

test("an exited controller's leftover tick releases nothing and emits nothing", () => {
  let released = 0;
  let emits = 0;
  const controller = new ReplayController(() => { released++; }, () => { emits++; });
  controller.loadForSelection(bars1m(), MIN);
  controller.seek(T0);
  withFakeClock((clock) => {
    controller.play();
    const leftover = clock.tick;
    controller.exit();
    released = 0;
    emits = 0;
    clock.advance(10 * 60_000);
    leftover();
  });
  assert.equal(released, 0);
  assert.equal(emits, 0);
});

// Tie policy: replay takes its bars from FootprintSeries, which is keyed by startTime.
test("the series that feeds replay is strictly ordered and last write wins on equal startTime", () => {
  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  const [a, b, c] = bars1m(3);
  series.upsertBar(c);
  series.upsertBar(a);
  series.upsertBar(b);
  series.upsertBar({ ...a, close: a.close - 1 });
  const starts = [];
  for (let i = 0; i < series.length; i++) starts.push(series.at(i).startTime);
  assert.deepEqual(starts, [T0, T0 + MIN, T0 + 2 * MIN]);
  assert.equal(series.at(0).close, a.close - 1);
});

function coordinatorHarness() {
  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  for (const bar of bars1m()) series.upsertBar(bar);
  const calls = { analysis: [], reloads: 0, paused: [] };
  let market = "BINANCE:BTCUSDT";
  const host = {
    pipeline: {
      series,
      intervalMs: MIN,
      setPaused(value) { calls.paused.push(value); },
    },
    session: { invalidate() {} },
    timeViewport: { applyDataUpdate() {}, placeReplayPrefixEnd() {} },
    svc: { updateAnalysisFromSeries(name) { calls.analysis.push(name); } },
    isDisposed: () => false,
    getMarket: () => market,
    autoFit() {},
    updateHook() {},
    // A history reload restores the full series, as the chart does after replay.
    loadHistory: async () => {
      calls.reloads++;
      series.clear();
      for (const bar of bars1m()) series.upsertBar(bar);
    },
  };
  const coordinator = new ChartReplayCoordinator(host);
  const starts = () => {
    const out = [];
    for (let i = 0; i < series.length; i++) out.push(series.at(i).startTime);
    return out;
  };
  return { coordinator, series, calls, starts, setMarket(value) { market = value; } };
}

test("coordinator seek replaces the chart series with exactly the completed prefix", () => {
  const { coordinator, calls, starts } = coordinatorHarness();
  coordinator.start();
  assert.equal(coordinator.getSnapshot().state, "selecting");
  coordinator.seek(T0 + 3 * MIN);
  assert.deepEqual(starts(), [T0, T0 + MIN, T0 + 2 * MIN]);
  assert.deepEqual(calls.paused, [true]);
  coordinator.seek(T0 + MIN);
  assert.deepEqual(starts(), [T0]);
  coordinator.exit({ reloadHistory: false });
  assert.deepEqual(calls.paused, [true, false]);
});

test("a replay bar is never applied to another market's chart", () => {
  const { coordinator, calls, starts, setMarket } = coordinatorHarness();
  coordinator.start();
  coordinator.seek(T0 + MIN);
  setMarket("BINANCE:ETHUSDT");
  coordinator.step();
  assert.deepEqual(starts(), [T0], "the BTC replay bar must not land after the market switch");
  assert.equal(coordinator.isActive(), false);
  assert.equal(calls.reloads, 0, "a market switch loads the new market's own history");
});

test("re-entering replay after exit starts from the full series and the same prefix", () => {
  const { coordinator, calls, starts } = coordinatorHarness();
  coordinator.start();
  coordinator.seek(T0 + 3 * MIN);
  const first = starts();
  coordinator.exit();
  assert.equal(calls.reloads, 1);
  assert.equal(starts().length, 6, "exit reloads the full history");
  coordinator.start();
  assert.equal(coordinator.getSnapshot().totalBars, 6);
  coordinator.seek(T0 + 3 * MIN);
  assert.deepEqual(starts(), first);
  assert.deepEqual(calls.analysis, ["BINANCE:BTCUSDT", "BINANCE:BTCUSDT"]);
  coordinator.exit({ reloadHistory: false });
});

test("a tick left over from an exited replay never lands in the next replay", () => {
  const { coordinator, starts } = coordinatorHarness();
  withFakeClock((clock) => {
    coordinator.start();
    coordinator.seek(T0 + MIN);
    coordinator.play();
    const leftover = clock.tick;
    coordinator.exit();
    coordinator.start();
    coordinator.seek(T0 + MIN);
    clock.advance(10 * 60_000);
    leftover();
    assert.deepEqual(starts(), [T0], "the old session's tick must not release into the new one");
    assert.equal(coordinator.getSnapshot().virtualTime, T0 + MIN);
  });
  coordinator.exit({ reloadHistory: false });
});

test("pausing drops partial progress, so wall time spent paused never releases a bar", () => {
  const released = [];
  const controller = new ReplayController((bar) => released.push(bar.startTime), () => {});
  controller.loadForSelection(bars1m(), MIN);
  controller.seek(T0 + MIN);
  controller.setSpeed(1);
  withFakeClock((clock) => {
    controller.play();
    clock.advance(600); // 0.6 of a bar at 1 bar/s
    controller.pause();
    clock.advance(10 * 60_000); // ten paused minutes
    controller.play();
    clock.advance(600);
    assert.deepEqual(released, [], "0.6 + 0.6 bars across a pause is not a bar");
    clock.advance(400);
    assert.deepEqual(released, [T0 + MIN], "a full second of play after resuming releases one bar");
    controller.pause();
  });
  controller.dispose();
});

test("replay input stays strictly ordered when the chart series received a duplicate bar", () => {
  const { coordinator, series, starts } = coordinatorHarness();
  const [first] = bars1m(1);
  series.upsertBar({ ...first, close: first.open });
  coordinator.start();
  assert.equal(coordinator.getSnapshot().totalBars, 6);
  coordinator.seek(T0 + 6 * MIN);
  const seen = starts();
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5].map((i) => T0 + i * MIN));
  assert.equal(series.at(0).close, first.open, "the later write is what replay shows");
  coordinator.exit({ reloadHistory: false });
});

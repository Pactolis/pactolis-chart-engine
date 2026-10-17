import test from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {
  setInterval,
  clearInterval,
};
globalThis.performance ??= { now: () => Date.now() };

const { ReplayController } = await import("../dist/features/replay/replayController.js");

function bar(startTime) {
  return {
    startTime,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    buyVolume: 1,
    sellVolume: 0,
    delta: 1,
    count: 1,
    cells: new Map(),
  };
}

test("reconfigure preserves virtual time and exposes only completed bars", () => {
  const states = [];
  const controller = new ReplayController(() => {}, (state) => states.push(state));
  controller.load([bar(0), bar(60_000), bar(120_000)], 0, 60_000);
  controller.step();
  controller.step();
  assert.equal(controller.snapshot().virtualTime, 120_000);

  const result = controller.reconfigure([bar(0), bar(300_000), bar(600_000)], 300_000);
  assert.equal(controller.snapshot().virtualTime, 120_000);
  assert.equal(result.visibleBars.length, 0, "in-progress 5m bar must stay hidden");
  assert.equal(states.at(-1).visibleBars, 0);
});

test("reconfigure reports whether playing state should resume", () => {
  const controller = new ReplayController(() => {}, () => {});
  controller.load([bar(0), bar(60_000)], 0, 60_000);
  controller.play();
  const result = controller.reconfigure([bar(0), bar(300_000)], 300_000);
  assert.equal(result.resume, true);
  controller.exit();
});

test("seek clamps to range and returns only completed bars", () => {
  const controller = new ReplayController(() => {}, () => {});
  controller.load([bar(0), bar(60_000), bar(120_000)], 0, 60_000);
  assert.equal(controller.seek(119_999).length, 1);
  assert.equal(controller.snapshot().virtualTime, 119_999);
  assert.equal(controller.seek(999_999).length, 3);
  assert.equal(controller.snapshot().virtualTime, 180_000);
});

test("selection mode keeps the full chart until a start time is chosen", () => {
  const controller = new ReplayController(() => {}, () => {});
  controller.loadForSelection([bar(0), bar(60_000), bar(120_000)], 60_000);
  assert.equal(controller.snapshot().state, "selecting");
  assert.equal(controller.snapshot().visibleBars, 3);
  controller.play();
  assert.equal(controller.snapshot().state, "selecting");
  const visible = controller.seek(120_000);
  assert.equal(controller.snapshot().state, "paused");
  assert.equal(visible.length, 2);
});

// Both tests below temporarily replace globalThis.window.setInterval/clearInterval
// and performance.now, but only ever synchronously (no await between patch and
// restore) so there is no window for another concurrently-running test file to
// observe the mutated globals — the isolation-disabled test runner shares this
// process, so an async gap here would be exactly the kind of leak that has
// broken unrelated tests on this branch before.
test("background-tab catch-up bounds bars released per tick and batches the state emit (finding 36)", () => {
  // Build far more bars than the per-tick cap so a single huge wall-clock gap
  // (the throttled-background-tab symptom) cannot drain in one tick.
  const bars = [];
  for (let i = 0; i < 200; i++) bars.push(bar(i * 60_000));

  let onBarCalls = 0;
  let onStateCalls = 0;
  const controller = new ReplayController(
    () => { onBarCalls++; },
    () => { onStateCalls++; },
  );
  controller.load(bars, 0, 60_000);
  controller.setSpeed(1);

  const originalSetInterval = globalThis.window.setInterval;
  const originalClearInterval = globalThis.window.clearInterval;
  // Node's native performance.now() requires `this` to be the actual Performance
  // object — a bare `performance.now` reference throws ERR_INVALID_THIS when
  // called unbound, so it must be bound before performance.now itself is reassigned.
  const originalNow = performance.now.bind(performance);
  let capturedTick = null;
  globalThis.window.setInterval = (fn) => { capturedTick = fn; return 1; };
  globalThis.window.clearInterval = () => {};
  try {
    controller.play();
    assert.ok(capturedTick, "play() should register an interval callback");
    onBarCalls = 0;
    onStateCalls = 0;
    // Simulate the tab having been backgrounded for 10 minutes: the next
    // performance.now() read inside tick() jumps far ahead of lastTick.
    performance.now = () => originalNow() + 10 * 60_000;
    capturedTick();
  } finally {
    performance.now = originalNow;
    globalThis.window.setInterval = originalSetInterval;
    globalThis.window.clearInterval = originalClearInterval;
    controller.dispose();
  }

  // A 10-minute gap at speed=1 implies 600 pending bars, but a single tick must
  // release at most the per-tick cap (20), not hundreds in one synchronous burst.
  assert.ok(onBarCalls > 0, "at least one bar should release");
  assert.ok(onBarCalls <= 20, `expected capped release, got ${onBarCalls} bars in one tick`);
  // Exactly one state emit for the whole burst, not one per released bar.
  assert.equal(onStateCalls, 1);
});

test("dispose() clears the interval without emitting, and is safe to call repeatedly (finding 37)", () => {
  const bars = [bar(0), bar(60_000), bar(120_000), bar(180_000)];
  let onStateCalls = 0;
  const controller = new ReplayController(() => {}, () => { onStateCalls++; });
  controller.load(bars, 0, 60_000);

  const originalSetInterval = globalThis.window.setInterval;
  const originalClearInterval = globalThis.window.clearInterval;
  const clearedIds = [];
  let registeredId = null;
  globalThis.window.setInterval = () => { registeredId = 42; return registeredId; };
  globalThis.window.clearInterval = (id) => { clearedIds.push(id); };
  try {
    controller.play();
    onStateCalls = 0;
    controller.dispose();
    assert.deepEqual(clearedIds, [42], "dispose() must clear the exact interval it registered");
  } finally {
    globalThis.window.setInterval = originalSetInterval;
    globalThis.window.clearInterval = originalClearInterval;
  }

  assert.equal(onStateCalls, 0, "dispose() must not emit");
  assert.doesNotThrow(() => controller.dispose(), "dispose() must be idempotent");
});

test("randomTime resolves to a completed-bar boundary", () => {
  const controller = new ReplayController(() => {}, () => {});
  controller.loadForSelection([bar(0), bar(60_000), bar(120_000)], 60_000);
  const original = Math.random;
  Math.random = () => 0.5;
  try {
    assert.equal(controller.randomTime(), 120_000);
  } finally {
    Math.random = original;
  }
});

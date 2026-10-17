import test from "node:test";
import assert from "node:assert/strict";

import { abortableDelay } from "../dist/features/chart/abortableDelay.js";

function countingTimers(t) {
  const live = new Set();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (cb, ms) => {
    const id = realSet(() => { live.delete(id); cb(); }, ms);
    live.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => { live.delete(id); realClear(id); };
  t.after(() => {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  });
  return live;
}

test("abortableDelay resolves true after the full delay", async (t) => {
  const live = countingTimers(t);
  const controller = new AbortController();
  assert.equal(await abortableDelay(5, controller.signal), true);
  assert.equal(live.size, 0);
});

test("abort ends the wait with false and clears the pending timer", async (t) => {
  const live = countingTimers(t);
  const controller = new AbortController();
  const wait = abortableDelay(60_000, controller.signal);
  assert.equal(live.size, 1);
  controller.abort();
  assert.equal(await wait, false);
  assert.equal(live.size, 0, "an aborted wait must not leave its timer behind");
});

test("an already aborted signal never schedules a timer", async (t) => {
  const live = countingTimers(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await abortableDelay(60_000, controller.signal), false);
  assert.equal(live.size, 0);
});

test("a completed wait detaches its abort listener", async () => {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = controller.signal;
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { added++; return realAdd(...args); };
  signal.removeEventListener = (...args) => { removed++; return realRemove(...args); };
  assert.equal(await abortableDelay(1, signal), true);
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

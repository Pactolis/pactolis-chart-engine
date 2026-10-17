import test from "node:test";
import assert from "node:assert/strict";

const originalLocation = globalThis.location;
const originalInfo = console.info;

test("load trace is opt-in and emits correlated elapsed stages", async (t) => {
  t.after(() => {
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    console.info = originalInfo;
  });
  const logs = [];
  console.info = (...args) => logs.push(args);
  globalThis.location = { search: "" };
  const trace = await import(`../dist/core/loadTrace.js?test=${Date.now()}`);
  assert.equal(trace.isLoadTraceEnabled(), false);
  assert.equal(trace.createLoadTrace("X:Y", 60_000), undefined);
  assert.equal(logs.length, 0);

  globalThis.location = { search: "?loadTrace=1" };
  const id = trace.createLoadTrace("X:Y", 60_000);
  trace.logLoadTrace(id, "fixture.stage", { bars: 2 });
  trace.finishLoadTrace(id, { cells: 3 });
  assert.ok(id);
  assert.deepEqual(logs.map((entry) => entry[0]), [
    "[load-trace] load.start",
    "[load-trace] fixture.stage",
    "[load-trace] load.complete",
  ]);
  assert.ok(logs.every((entry) => entry[1].traceId === id && Number.isFinite(entry[1].elapsedMs)));
});

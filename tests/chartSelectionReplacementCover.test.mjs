import test from "node:test";
import assert from "node:assert/strict";
import { ChartHistoryController } from "../dist/features/chart/ChartHistoryController.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

// Real controller, deferred pipeline/host ports; no source extraction or fake readiness.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function drain() {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
}
function fixture() {
  let disposed = false;
  let state = { type: "chart", market: "TEST:old", timeframe: "1m", scaleMode: "linear" };
  const loads = [], loading = [], settled = [];
  const pipeline = {
    series: new FootprintSeries({ intervalMs: 60_000, priceStep: 10 }),
    intervalMs: 60_000,
    pendingStepCorrection: Promise.resolve(null),
    activeHistoryFootprintReceived: false,
    activeHistoryFootprintAvailable: false,
    activeHistoryCandleSourceGap: null,
    cancelHistoryLoad() {},
    cancelRecentFootprintCoverageRepair() {},
    async changeConfig(config) {
      if (config.intervalMs !== undefined) this.intervalMs = config.intervalMs;
    },
    loadHistory() { const load = deferred(); loads.push(load); return load.promise; },
  };
  const host = {
    pipeline,
    session: { invalidate() {} },
    view: { area: { left: 0, width: 0 }, resetPriceScale() {} },
    timeViewport: { followsLatest: () => true, userViewportRevision: () => 0 },
    svc: {
      notifyActiveMarket() {}, notifyInteractiveHistorySettled() {},
      updateAnalysisFromSeries() {}, triggerAutoSync() {},
    },
    capture: {
      beginHistoryLoad: () => loads.length + 1,
      settleHistoryLoad: () => true,
      failHistoryLoad() {},
    },
    // An active replay disables unrelated open-bucket HTTP maintenance; no render/health is faked.
    replay: { isActive: () => true, getSnapshot: () => null },
    isDisposed: () => disposed,
    getState: () => state,
    autoFit() {}, shouldAutoFitSameBarLiveUpdate: () => false,
    setLoading: (value) => loading.push(value),
    revealCandles() {}, setFootprintAvailable() {},
    notifyHistorySettled: (...value) => settled.push(value),
  };
  const controller = new ChartHistoryController(host);
  return {
    controller, loads, loading, settled,
    select(market) {
      const previous = state;
      state = { ...state, market };
      controller.handleSelectionChange(previous, state);
    },
    dispose() { disposed = true; controller.dispose(); },
  };
}

for (const outcome of ["success", "error"]) {
  test(`F2 replacement cover survives older same-selection ${outcome} settlement`, async (t) => {
    useFakeChartDataSource(t);
    const f = fixture();
    const replacement = deferred();
    let replacementSettled = false;
    replacement.promise.then(() => { replacementSettled = true; });
    try {
      f.select("TEST:new");
      await drain();
      assert.equal(f.loads.length, 1, "PRECONDITION: real selection refresh reached deferred history");
      f.controller.trackInitialHistoryLoad(replacement.promise);
      const marker = f.loading.length;
      assert.equal(f.loading.at(-1), true);
      if (outcome === "error") f.loads[0].reject(new Error("F2 controlled older selection rejection"));
      else f.loads[0].resolve();
      await drain();
      const beforeReplacement = f.loading.slice(marker);
      const pendingAtObservation = !replacementSettled;
      // Settle the current owner too, so a permanent cover is not accepted as a fix.
      replacement.resolve();
      await drain();
      const afterReplacement = f.loading.slice(marker + beforeReplacement.length);
      console.log("F2-cover " + JSON.stringify({
        outcome, phase: "older-settled/current-replacement-was-pending",
        selectionLoads: f.loads.length, pendingAtObservation,
        beforeReplacement, afterReplacement,
      }));
      assert.equal(pendingAtObservation, true, "PRECONDITION: replacement remained genuinely pending");
      assert.deepEqual(beforeReplacement, [],
        "CONTRACT_ASSERT F2: older selection settlement must not uncover pending replacement");
      assert.deepEqual(afterReplacement, [false],
        "CONTRACT_ASSERT F2: newest replacement settlement must release its own cover exactly once");
    } finally {
      replacement.resolve();
      for (const load of f.loads) load.resolve();
      await drain();
      f.dispose();
    }
  });
}

test("F2 disposed selection load cannot release a later tracked cover", async (t) => {
  useFakeChartDataSource(t);
  const f = fixture();
  const replacement = deferred();
  try {
    f.select("TEST:new");
    await drain();
    assert.equal(f.loads.length, 1, "PRECONDITION: selection load started");
    f.controller.trackInitialHistoryLoad(replacement.promise);
    f.dispose();
    const marker = f.loading.length;
    f.loads[0].resolve();
    replacement.resolve();
    await drain();
    console.log("F2-disposed " + JSON.stringify({ afterDispose: f.loading.slice(marker) }));
    assert.deepEqual(f.loading.slice(marker), [],
      "CONTRACT_ASSERT F2: disposed selection settlement must not write coverfalse");
  } finally {
    replacement.resolve();
    for (const load of f.loads) load.resolve();
    await drain();
    f.dispose();
  }
});

test("F2 next selection retains cover against old selection and replacement settlements", async (t) => {
  useFakeChartDataSource(t);
  const f = fixture();
  const oldReplacement = deferred();
  try {
    f.select("TEST:first");
    await drain();
    assert.equal(f.loads.length, 1);
    f.controller.trackInitialHistoryLoad(oldReplacement.promise);
    f.select("TEST:second");
    await drain();
    assert.equal(f.loads.length, 2);
    const marker = f.loading.length;
    f.loads[0].resolve();
    oldReplacement.resolve();
    await drain();
    assert.deepEqual(f.loading.slice(marker), [],
      "CONTRACT_ASSERT F2: next selection owns cover while its history is pending");
    f.loads[1].resolve();
    await drain();
    assert.deepEqual(f.loading.slice(marker), [false],
      "CONTRACT_ASSERT F2: current selection can release cover after its own load");
  } finally {
    oldReplacement.resolve();
    for (const load of f.loads) load.resolve();
    await drain();
    f.dispose();
  }
});

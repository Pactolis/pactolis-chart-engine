// #333 phase 1 — TEST-ONLY RED. The new rawViewContract module does NOT exist on main; its
// the fixture tests or the independent cache-bug RED in this same file. Runtime: NOT_RUN.
// strips cells/liquidations from pre-2020 bars; BASE is an independent test literal, not an import.
import test from "node:test";
import assert from "node:assert/strict";
globalThis.$state ??= (value) => value; // dist modules read Svelte runes at import time
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { movingAverageIndicatorDefinition } = await import("../dist/features/indicators/builtins/movingAverage.js");
const loadContract = () => import("../dist/features/chart/rawViewContract.js");
const MINUTE = 60_000, MARKET = "BINANCE:BTCUSDT";
const BASE = 1_577_836_800_000; // 2020-01-01T00:00:00Z, after FOOTPRINT_START_TIME
const OWNER = { panel: "main" };
const CHART = { market: MARKET, timeframe: "1m", intervalMs: MINUTE };

function fixtureBar(startTime, o, h, l, c) {
  return {
    startTime, open: o, high: h, low: l, close: c, volume: 24, delta: 2, count: 10,
    liquidationBuyVol: 1, liquidationSellVol: 2,
    cells: new Map([
      [c - 2, { priceBin: c - 2, buyVol: 7, sellVol: 5, count: 6, buyCount: 4, sellCount: 2, liquidationBuyVol: 1, liquidationSellVol: 0 }],
      [c + 2, { priceBin: c + 2, buyVol: 6, sellVol: 6, count: 4, buyCount: 2, sellCount: 2, liquidationBuyVol: 0, liquidationSellVol: 2 }],
    ]),
    hasRef: true, completeness: "complete", sources: ["history"], cellRevision: 1,
    updatedAt: 1_000 + startTime, deltaBySize: [3, -1, 0, 0, 0, 0, 0, 0, 0, 0],
  };
}
const rawFixture = () => [fixtureBar(BASE, 10, 14, 8, 12), fixtureBar(BASE + MINUTE, 12, 16, 10, 14), fixtureBar(BASE + 2 * MINUTE, 14, 18, 12, 16)];
function loadedSeries(bars) {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  series.loadBars(bars);
  return series;
}

// BEFORE any op: independent refs for every bar, cells Map, each cell, sources, deltaBySize,
// plus a Map-deep structuredClone snapshot and the three counters.
function captureBaseline(series) {
  const bars = series.listReadonly();
  const refs = bars.map((b) => ({ bar: b, cells: b.cells, sources: b.sources,
    deltaBySize: b.deltaBySize, cellRefs: [...b.cells.entries()] }));
  return { length: bars.length, refs, deep: structuredClone(bars), revision: series.revision,
    structureRevision: series.structureRevision, resetEpoch: series.resetEpoch };
}
function assertUntouched(series, base, label) {
  assert.equal(series.revision, base.revision, label);
  assert.equal(series.structureRevision, base.structureRevision, label);
  assert.equal(series.resetEpoch, base.resetEpoch, label);
  assert.equal(series.length, base.length, label); // cardinality guard, no vacuous loops
  const bars = series.listReadonly();
  assert.deepEqual(bars, base.deep, label);
  for (let i = 0; i < base.refs.length; i++) {
    const r = base.refs[i], live = bars[i];
    assert.ok(live === r.bar, label);
    assert.ok(live.cells === r.cells && live.sources === r.sources && live.deltaBySize === r.deltaBySize, label);
    assert.ok(live.cells.size === r.cellRefs.length, label);
    for (const [key, cell] of r.cellRefs) assert.ok(live.cells.get(key) === cell, label);
  }
}

test("fixture: loadBars places literal raw bars, cells and all optional fields", () => {
  const series = loadedSeries(rawFixture());
  const bars = series.listReadonly();
  assert.equal(bars.length, 3); // 3 bars, 2 cells each before any loop
  assert.deepEqual(bars.map((b) => b.startTime), [BASE, BASE + MINUTE, BASE + 2 * MINUTE]);
  assert.deepEqual(bars.map((b) => [b.open, b.high, b.low, b.close]), [[10, 14, 8, 12], [12, 16, 10, 14], [14, 18, 12, 16]]);
  for (const b of bars) {
    assert.equal(b.cells.size, 2); let buy = 0, sell = 0, count = 0, liqBuy = 0, liqSell = 0;
    for (const cell of b.cells.values()) {
      buy += cell.buyVol; sell += cell.sellVol; count += cell.count ?? 0;
      liqBuy += cell.liquidationBuyVol ?? 0; liqSell += cell.liquidationSellVol ?? 0;
    }
    assert.equal(buy + sell, b.volume); assert.equal(buy - sell, b.delta); assert.equal(count, b.count);
    assert.equal(liqBuy, 1); assert.equal(liqSell, 2); assert.equal(b.liquidationBuyVol, 1); assert.equal(b.liquidationSellVol, 2);
    assert.equal(b.updatedAt, 1_000 + b.startTime);
    assert.deepEqual(b.deltaBySize, [3, -1, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(b.deltaBySize.reduce((s, v) => s + v, 0), b.delta);
    assert.equal(b.hasRef, true); assert.equal(b.completeness, "complete"); assert.equal(b.cellRevision, 1);
    assert.deepEqual(b.sources, ["history"]);
  }
  const again = series.listReadonly(); // reference identity stable across calls (no re-cloning)
  for (let i = 0; i < 3; i++) {
    assert.ok(again[i] === bars[i] && again[i].cells === bars[i].cells && again[i].sources === bars[i].sources);
    assert.ok(again[i].deltaBySize === bars[i].deltaBySize);
    for (const cell of bars[i].cells.values()) assert.ok(again[i].cells.get(cell.priceBin) === cell);
  }
});

test("contract RED: capture and ALL resolver ops leave the raw series untouched", async () => {
  const m = await loadContract();
  const series = loadedSeries(rawFixture());
  const base = captureBaseline(series);
  const source = m.captureRawSource(OWNER, series, CHART);
  assertUntouched(series, base, "capture");
  assert.ok(source.owner === OWNER && source.series === series);
  assert.equal(source.market, MARKET); assert.equal(source.timeframe, CHART.timeframe); assert.equal(source.intervalMs, MINUTE);
  assert.equal(source.resetEpoch, base.resetEpoch); assert.equal(source.revision, base.revision); assert.equal(source.structureRevision, base.structureRevision);
  assert.equal(m.sameRawSource(source, m.captureRawSource(OWNER, series, CHART)), true); assertUntouched(series, base, "sameRawSource");
  assert.ok(m.resolveIndicatorInput(undefined, source).source === source); assertUntouched(series, base, "input default");
  assert.ok(m.resolveIndicatorInput("raw", source).source === source); assertUntouched(series, base, "input raw");
  assert.equal(m.resolveIndicatorInput("view", source).status, "unsupported"); assertUntouched(series, base, "input view");
  m.resolveRawCursor(source, 1.5, 12.5, "raw"); assertUntouched(series, base, "cursor raw");
  m.resolveRawCursor(source, 0.5, 12.5, "synthetic-noninvertible"); assertUntouched(series, base, "cursor synthetic");
  m.resolveRawCursor(source, 9, 12.5, "raw"); assertUntouched(series, base, "cursor outside");
  const gapped = loadedSeries([fixtureBar(BASE, 10, 14, 8, 12), fixtureBar(BASE + 2 * MINUTE, 14, 18, 12, 16)]);
  const gapBase = captureBaseline(gapped); // gapped series gets its own refs/deep/counter baseline
  const gapSource = m.captureRawSource(OWNER, gapped, CHART);
  assertUntouched(gapped, gapBase, "gap capture");
  m.resolveRawCursor(gapSource, 0.75, 12.5, "raw");
  assertUntouched(gapped, gapBase, "gap resolver");
});

test("contract RED: sameRawSource identity rules and per-field isolation", async () => {
  const m = await loadContract();
  const series = loadedSeries(rawFixture());
  const a = m.captureRawSource(OWNER, series, CHART);
  assert.equal(m.sameRawSource(a, m.captureRawSource(OWNER, series, CHART)), true);
  assert.equal(m.sameRawSource(a, m.captureRawSource({ panel: "main" }, series, CHART)), false);
  const series2 = loadedSeries(rawFixture());
  assert.equal(series2.revision, series.revision); // equal counters, still distinct series
  assert.equal(m.sameRawSource(a, m.captureRawSource(OWNER, series2, CHART)), false);
  assert.equal(m.sameRawSource(a, m.captureRawSource(OWNER, series, { ...CHART, market: "OTHER:XYZ" })), false);
  assert.equal(m.sameRawSource(a, m.captureRawSource(OWNER, series, { ...CHART, timeframe: "5m" })), false);
  assert.equal(m.sameRawSource(a, m.captureRawSource(OWNER, series, { ...CHART, intervalMs: 5 * MINUTE })), false);
    assert.equal(m.sameRawSource(a, { ...a, structureRevision: a.structureRevision + 1 }), false);
  assert.equal(m.sameRawSource(a, { ...a, revision: a.revision + 1 }), false);
  assert.equal(m.sameRawSource(a, { ...a, resetEpoch: a.resetEpoch + 1 }), false);
});

test("contract RED: each stale counter field makes BOTH cursor axes stale-source", async () => {
  const m = await loadContract();
  const source = m.captureRawSource(OWNER, loadedSeries(rawFixture()), CHART);
  for (const key of ["resetEpoch", "revision", "structureRevision"]) { // readonly clone, no canonical mutation
    const res = m.resolveRawCursor({ ...source, [key]: source[key] + 1 }, 0.5, 12.5, "raw");
    assert.equal(res.time.status, "unknown"); assert.equal(res.time.reason, "stale-source");
    assert.equal(res.price.status, "unknown"); assert.equal(res.price.reason, "stale-source");
  }
});

test("contract RED: resolveIndicatorInput default/explicit raw vs explicit view", async () => {
  const m = await loadContract();
  const source = m.captureRawSource(OWNER, loadedSeries(rawFixture()), CHART);
  const byDefault = m.resolveIndicatorInput(undefined, source);
  assert.equal(byDefault.status, "raw"); assert.ok(byDefault.source === source);
  const explicitRaw = m.resolveIndicatorInput("raw", source);
  assert.equal(explicitRaw.status, "raw"); assert.ok(explicitRaw.source === source);
  const view = m.resolveIndicatorInput("view", source);
  assert.equal(view.status, "unsupported"); assert.equal(view.requested, "view");
  assert.equal(view.reason, "view-adapter-unavailable"); // truthful: adapter unavailable
});

test("contract RED: resolveRawCursor regular-prefix boundary (root rule)", async () => {
  const m = await loadContract();
  const series = loadedSeries(rawFixture().slice(0, 2)); // prefix [BASE, BASE+60k], length 2
  assert.equal(series.length, 2);
  const source = m.captureRawSource(OWNER, series, CHART);
  for (const [ordinal, time] of [[0, BASE], [0.5, BASE + 30_000], [1, BASE + MINUTE], [1.5, BASE + 90_000]]) {
    const res = m.resolveRawCursor(source, ordinal, 12.5, "raw"); // finite 0<=ordinal<length
    assert.equal(res.time.status, "known"); assert.equal(res.time.time, time); assert.ok(res.time.source === source);
    assert.equal(res.price.status, "known"); assert.equal(res.price.price, 12.5); assert.ok(res.price.source === source);
  }
  for (const ordinal of [2, 2.5, -0.01, NaN, Infinity, -Infinity]) {
    const res = m.resolveRawCursor(source, ordinal, 12.5, "raw"); assert.equal(res.time.status, "unknown");
    assert.equal(res.time.reason, ordinal === 2 || ordinal === 2.5 || ordinal === -0.01 ? "outside-source" : "non-finite");
    assert.equal(res.price.status, "known"); assert.equal(res.price.price, 12.5); // raw axis independent
  }
  const far = m.resolveRawCursor(source, 0, 99999.75, "raw"); // finite out-of-range price stays raw
  assert.equal(far.price.status, "known"); assert.equal(far.price.price, 99999.75);
  const nf = m.resolveRawCursor(source, 0, NaN, "raw");
  assert.equal(nf.price.status, "unknown"); assert.equal(nf.price.reason, "non-finite");
  assert.equal(nf.time.status, "known");
  const syn = m.resolveRawCursor(source, 0.5, 12.5, "synthetic-noninvertible");
  assert.equal(syn.price.status, "unknown"); assert.equal(syn.price.reason, "non-invertible");
  assert.equal(syn.time.status, "known"); assert.equal(syn.time.time, BASE + 30_000); // time can be known
});

test("contract RED: irregular gap ordinal is unknown despite interpolation", async () => {
  const m = await loadContract();
  const series = loadedSeries([fixtureBar(BASE, 10, 14, 8, 12), fixtureBar(BASE + 2 * MINUTE, 14, 18, 12, 16)]);
  const source = m.captureRawSource(OWNER, series, CHART);
  assert.equal(series.timeOfIndex(0.75), BASE + 90_000); // coordinate interpolation exists...
  const res = m.resolveRawCursor(source, 0.75, 12.5, "raw");
  assert.equal(res.time.status, "unknown"); assert.equal(res.time.reason, "outside-source"); // no bar covers gap
  assert.equal(res.price.status, "known"); assert.equal(res.price.price, 12.5);
});

test("contract RED: empty series and clear() stale source", async () => {
  const m = await loadContract();
  const emptySource = m.captureRawSource(OWNER, new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 }), CHART);
  const res = m.resolveRawCursor(emptySource, 0, 12.5, "raw");
  assert.equal(res.time.status, "unknown"); assert.equal(res.time.reason, "empty");
  assert.equal(res.price.status, "known"); // price is an axis coordinate, not an observed trade
  const series = loadedSeries(rawFixture());
  const a = m.captureRawSource(OWNER, series, CHART);
  const epoch = series.resetEpoch;
  series.clear(); // actual boundary: epoch bumps; snapshot no longer matches live series
  series.loadBars(rawFixture());
  assert.notEqual(series.resetEpoch, epoch);
  assert.equal(m.sameRawSource(a, m.captureRawSource(OWNER, series, CHART)), false);
  const staleRes = m.resolveRawCursor(a, 0.5, 12.5, "raw");
  assert.equal(staleRes.time.status, "unknown"); assert.equal(staleRes.time.reason, "stale-source");
  assert.equal(staleRes.price.status, "unknown"); assert.equal(staleRes.price.reason, "stale-source");
});

test("contract RED: revision-only setPricePrecision invalidates; reset no-op stable", async () => {
  const m = await loadContract();
  const series = loadedSeries(rawFixture());
  series.setPricePrecision(2); // known baseline FIRST: loadBars inference value is unknown
  assert.equal(series.config.pricePrecision, 2);
  const a = m.captureRawSource(OWNER, series, CHART);
  const rev = series.revision, struct = series.structureRevision, epoch = series.resetEpoch;
  series.setPricePrecision(3); // ACTUAL revision-only mutation
  assert.notEqual(series.revision, rev); // real bump; no arithmetic on the counter itself
  assert.equal(series.structureRevision, struct); assert.equal(series.resetEpoch, epoch);
  assert.equal(series.config.pricePrecision, 3);
  assert.equal(m.sameRawSource(a, m.captureRawSource(OWNER, series, CHART)), false);
  const res = m.resolveRawCursor(a, 0.5, 12.5, "raw"); // old cursor stale on both axes
  assert.equal(res.time.status, "unknown"); assert.equal(res.time.reason, "stale-source");
  assert.equal(res.price.status, "unknown"); assert.equal(res.price.reason, "stale-source");
  const revBeforeReset = series.revision; // saved BEFORE the first reset (B45 independent baseline)
  series.resetPricePrecision(); // resets a SET precision -> revision bump
  assert.equal(series.config.pricePrecision, undefined);
  const revAfterReset = series.revision;
  assert.notEqual(revAfterReset, revBeforeReset); // independent: reset bump measured alone, not vs set(3)
  series.resetPricePrecision(); // precision already undefined: NOOP, revision stable
  assert.equal(series.revision, revAfterReset);
  assert.equal(series.structureRevision, struct); assert.equal(series.resetEpoch, epoch);
});

test("contract RED: structure append (upsertBar) bumps revision+structure, not epoch", async () => {
  const m = await loadContract();
  const series = loadedSeries(rawFixture());
  const a = m.captureRawSource(OWNER, series, CHART);
  const rev = series.revision, struct = series.structureRevision, epoch = series.resetEpoch;
  assert.equal(series.upsertBar(fixtureBar(BASE + 3 * MINUTE, 16, 20, 14, 18)), true); // ACTUAL mutation
  assert.equal(series.length, 4);
  assert.ok(series.revision > rev); assert.ok(series.structureRevision > struct);
  assert.equal(series.resetEpoch, epoch);
  assert.equal(m.sameRawSource(a, m.captureRawSource(OWNER, series, CHART)), false);
  const res = m.resolveRawCursor(a, 0.5, 12.5, "raw"); // old cursor stale after structure change
  assert.equal(res.time.status, "unknown"); assert.equal(res.time.reason, "stale-source");
  assert.equal(res.price.status, "unknown"); assert.equal(res.price.reason, "stale-source");
});

test("replay prefix: at(2) undefined, length 2, SMA2 prefix literal [null,13]", async () => {
  const full = rawFixture();
  const retainedFuture = fixtureBar(BASE + 2 * MINUTE, 999000, 1000000, 998000, 1000000); // NOT loaded
  const series = loadedSeries(full.slice(0, 2));
  assert.equal(series.length, 2); assert.equal(series.at(2), undefined); // at(2) missing on ACTUAL API
  const settings = { lines: [{ id: "raw-sma2", method: "sma", period: 2, timeframe: "chart", enabled: true, color: "#44aaff" }] };
  const instance = { id: "raw-sma2", type: movingAverageIndicatorDefinition.type, title: "MA", visible: true, paneId: "p", order: 0, settings, seq: 1 };
  const prepared = movingAverageIndicatorDefinition.prepareData({
    ctx: {}, view: {}, series, rect: { top: 0, height: 100 }, range: [0, series.length],
    instance, settings, chart: CHART, requestRefresh() {},
  });
  assert.equal(prepared.status, "ok");
  const line = prepared.meta.series[0];
  assert.equal(line.points.length, 2); // exact prefix length, not parity with future
  assert.deepEqual(line.points.map((p) => p.time), [BASE, BASE + MINUTE]);
  assert.deepEqual(line.points.map((p) => p.value), [null, 13]); // prefix literal
  assert.equal(retainedFuture.close, 1000000); // future dataset retained but unused
});

test("interaction cache: same settings/revision values but different series must not reuse stale prepared", async () => {
  const { ChartIndicatorController } = await import("../dist/features/chart/ChartIndicatorController.js");
  const definition = { ...movingAverageIndicatorDefinition, prepareCache: "series-range" }; // maxAgeMs 0
  const controller = Object.create(ChartIndicatorController.prototype); // no DOM/constructor claim
  controller.interactionPreparedCache = new Map();
  const shiftedBar = (b) => ({
    ...b, open: b.open + 90, high: b.high + 90, low: b.low + 90, close: b.close + 90,
    cells: new Map([...b.cells].map(([k, cell]) => [k + 90, { ...cell, priceBin: cell.priceBin + 90 }])),
  });
  const s1 = loadedSeries(rawFixture()); // closes [12,14,16]
  const s2 = loadedSeries(rawFixture().map(shiftedBar)); // closes [102,104,106]
  assert.deepEqual(s1.listReadonly().map((b) => b.close), [12, 14, 16]);
  assert.deepEqual(s2.listReadonly().map((b) => b.close), [102, 104, 106]);
  for (const b of s2.listReadonly()) {
    assert.equal(b.volume, 24); assert.equal(b.delta, 2); assert.equal(b.count, 10);
    for (const cell of b.cells.values()) assert.ok(cell.priceBin >= b.low && cell.priceBin <= b.high);
  }
  assert.equal(s2.revision, s1.revision); // equal revision/structure/epoch values...
  assert.equal(s2.structureRevision, s1.structureRevision); assert.equal(s2.resetEpoch, s1.resetEpoch);
  assert.notEqual(s1, s2); // ...but distinct series
  const settings = { lines: [{ id: "raw-sma2", method: "sma", period: 2, timeframe: "chart", enabled: true, color: "#44aaff" }] };
  const instance = { id: "raw-sma2", type: definition.type, title: "MA", visible: true, paneId: "p", order: 0, settings, seq: 1 };
  const mkContext = (series) => ({ ctx: {}, view: {}, series, rect: { top: 0, height: 100 },
    range: [0, 3], instance, settings, chart: CHART, requestRefresh() {} });
  const first = controller.prepareInteractionData(instance, definition, mkContext(s1));
  assert.equal(first.status, "ok"); assert.equal(first.meta.series.length, 1);
  assert.deepEqual(first.meta.series[0].points.map((p) => p.time), [BASE, BASE + MINUTE, BASE + 2 * MINUTE]);
  assert.deepEqual(first.meta.series[0].points.map((p) => p.value), [null, 13, 15]);
  assert.ok(controller.interactionPreparedCache.has(instance.id)); // cache path actually active
  // Same Map/instance/settings/range/chart/timeBucket; only the series differs. Expected fresh
  // prepare over s2 -> [null,103,105]; actual bug returns stale cached s1 values.
  const second = controller.prepareInteractionData(instance, definition, mkContext(s2));
  assert.equal(second.status, "ok"); assert.deepEqual(second.meta.series[0].points.map((p) => p.time), [BASE, BASE + MINUTE, BASE + 2 * MINUTE]);
  assert.deepEqual(second.meta.series[0].points.map((p) => p.value), [null, 103, 105]); // correct-reason RED
});

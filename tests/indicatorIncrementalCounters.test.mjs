// #128 verification: counter-based (not wall-clock) guard that live tail ticks and pan
// frames of the converted indicators stay on the incremental/cached path. Each indicator
// is primed once on a 10k-bar series; then 20 tail ticks must raise only its
// `indicator.incremental.hit.<kind>` counter and never `indicator.incremental.full.<kind>`.
// Pan frames (no data change) must not trigger a full recompute either. A trade into an
// old bar and a settings change must fall back to the full path, which proves the
// assertions can fail. Volume Profile's window moves with the viewport, so its pan frames
// (and its settings-keyed cache) are covered only for the tail / old-bar cases.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { configurePerformanceTelemetry, snapshotPerformanceTelemetry } = await import("../dist/core/performanceTelemetry.js");
const load = async (name) => Object.values(await import(`../dist/features/indicators/builtins/${name}.js`)).find((v) => v && typeof v.prepareData === "function");

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const N = 10_000;
function mkBar(i) {
  const close = 10_000 + Math.round(Math.sin(i / 9) * 30 + (i % 7));
  const cells = new Map();
  for (let c = 0; c < 5; c++) { const b = close - 2 + c; cells.set(b, { priceBin: b, buyVol: 1 + (c % 3), sellVol: 1 + (c % 2), count: 2, buyCount: 1, sellCount: 1 }); }
  return { startTime: T0 + i * MIN, open: close - 1, high: close + 3, low: close - 3, close, volume: 10 + (i % 5), delta: (i % 3) - 1, count: 5, cells, hasRef: true, cellRevision: 1, completeness: "complete", sources: ["history"] };
}

const kinds = [
  { file: "volume", kind: "volume", overrides: { showMa: true, maPeriod: 20 }, pan: true },
  { file: "volumeProfile", kind: "volumeProfile", overrides: { mode: "lookback", lookbackBars: 300 }, pan: false },
  { file: "bollinger", kind: "bollinger", pan: true },
  { file: "cci", kind: "cci", pan: true },
  { file: "mfi", kind: "mfi", pan: true },
  { file: "kdj", kind: "kdj", pan: true },
  { file: "dmi", kind: "dmi", pan: true },
  { file: "superTrend", kind: "superTrend", pan: true },
  { file: "stochRsi", kind: "stochRsi", pan: true },
  { file: "ichimoku", kind: "ichimoku", pan: true },
];

for (const spec of kinds) {
  test(`${spec.kind}: tail ticks and pan frames never take the full-recompute path`, async () => {
    configurePerformanceTelemetry({ enabled: true });
    const def = await load(spec.file);
    const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
    series.loadBars(Array.from({ length: N }, (_, i) => mkBar(i)));
    const settings = { ...def.defaultSettings(), ...(spec.overrides ?? {}) };
    const ctx = {
      ctx: {}, view: { colWidth: 6, xOfIndex: (i) => i * 6, indexOfX: (x) => x / 6 }, series, rect: { top: 0, height: 100 }, range: [N - 200, N],
      instance: { id: `guard-${spec.kind}`, type: def.type, title: def.type, visible: true, paneId: "p", order: 0, settings, seq: 1 }, settings, requestRefresh() {},
    };
    const hit = () => snapshotPerformanceTelemetry().counters[`indicator.incremental.hit.${spec.kind}`] ?? 0;
    const full = () => snapshotPerformanceTelemetry().counters[`indicator.incremental.full.${spec.kind}`] ?? 0;
    def.prepareData(ctx); // prime: the one allowed full computation
    assert.ok(full() >= 1, "priming must run the full path once");

    let [h0, f0] = [hit(), full()];
    const tail = () => series.listReadonly().at(-1);
    for (let k = 0; k < 20; k++) {
      series.addTrades([{ time: tail().startTime + 1000 + k, price: tail().close, qty: 0.1, isBuy: k % 2 === 0, id: `g${spec.kind}${k}` }]);
      def.prepareData(ctx);
    }
    assert.equal(full() - f0, 0, `${spec.kind}: tail ticks must not run the full path`);
    assert.equal(hit() - h0, 20, `${spec.kind}: every tail tick must hit the incremental path`);

    if (spec.pan) {
      [h0, f0] = [hit(), full()];
      for (let k = 1; k <= 20; k++) { ctx.range = [N - 200 - k, N - k]; def.prepareData(ctx); }
      assert.equal(full() - f0, 0, `${spec.kind}: pan frames must not run the full path`);
      ctx.range = [N - 200, N];
    }

    // Negative controls: these must leave the incremental path.
    f0 = full();
    series.addTrades([{ time: series.listReadonly()[N - 50].startTime + 5, price: 10_000, qty: 0.1, isBuy: true, id: `old${spec.kind}` }]);
    def.prepareData(ctx);
    assert.equal(full() - f0, 1, `${spec.kind}: a change to an old bar must fall back to the full path`);
    f0 = full();
    ctx.settings = { ...ctx.settings, ...(spec.kind === "volume" ? { maPeriod: 21 } : spec.kind === "volumeProfile" ? { lookbackBars: 301 } : spec.kind === "ichimoku" ? { tenkanPeriod: 10 } : spec.kind === "supertrend" || spec.kind === "superTrend" ? { period: 11 } : { period: 15 }) };
    def.prepareData(ctx);
    assert.equal(full() - f0, 1, `${spec.kind}: a settings change must fall back to the full path`);
  });
}

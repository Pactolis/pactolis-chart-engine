import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { keltnerIndicatorDefinition as definition } from "../dist/features/indicators/builtins/keltner.js";
import { createIndicatorInstance, listIndicatorDefinitions } from "../dist/features/indicators/registry.js";
import { IndicatorManager } from "../dist/features/indicators/IndicatorManager.js";
import { createIndicatorPaneHeadersModel } from "../dist/features/indicators/indicatorPaneHeaders.js";
import { configurePerformanceTelemetry, snapshotPerformanceTelemetry } from "../dist/core/performanceTelemetry.js";

const MINUTE = 60_000;
function bars(count) {
  return Array.from({ length: count }, (_, i) => ({ startTime: i * MINUTE, open: 100 + i,
    high: 102 + i, low: 98 + i, close: 100 + i, volume: 1, delta: 0, count: 1, cells: new Map(), hasRef: true }));
}
function series(count) { const result = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 }); result.loadBars(bars(count)); return result; }
function context(data, id = "live", overrides = {}) {
  const instance = createIndicatorInstance(definition.type, 0);
  instance.id = id;
  instance.settings = { ...instance.settings, ...overrides };
  return { ctx: {}, view: {}, series: data, range: [0, data.listReadonly().length], rect: { top: 0, height: 100 },
    settings: instance.settings, instance, requestRefresh() {} };
}
const plots = (prepared) => prepared.meta.series.map((plot) => [plot.key, plot.points]);

test("Keltner EMA20 / Wilder ATR10 / 2 matches hand-derived OHLC reference and warmup", () => {
  // Reference: close_i=100+i; high_i=close_i+2, low_i=close_i-2, hence TR_i=4
  // and Wilder ATR10=4 from i=9 onward. EMA20 seeds at i=19 with mean(100..119)
  // =109.5, then alpha=2/21 makes EMA_i=close_i-9.5. Both bands differ by 8.
  // The requested first max(20,10)=20 bars are suppressed, including seed bar 19.
  const prepared = definition.prepareData(context(series(25)));
  for (const plot of prepared.meta.series) {
    assert.ok(plot.points.slice(0, 20).every((point) => point.value === null));
    const offset = plot.key === "upper" ? 8 : plot.key === "lower" ? -8 : 0;
    for (const point of plot.points.slice(20)) assert.ok(Math.abs(point.value - (100 + point.index - 9.5 + offset)) < 1e-12);
  }
});

test("Keltner tail trades are exactly equal to full recalculation, without full live rebuilds", () => {
  configurePerformanceTelemetry({ enabled: true });
  for (const settings of [{}, { emaPeriod: 1, atrPeriod: 1 }, { emaPeriod: 3, atrPeriod: 7 }, { emaPeriod: 500, atrPeriod: 500 }]) {
    const data = series(70);
    const live = context(data, "live", settings);
    definition.prepareData(live);
    for (let i = 0; i < 8; i++) {
      data.addTrades([{ time: 69 * MINUTE + 100 + i, price: 165 + i * 3, qty: 1, isBuy: true, id: `tick-${i}` }]);
      const before = snapshotPerformanceTelemetry().counters;
      const actual = definition.prepareData(live);
      const after = snapshotPerformanceTelemetry().counters;
      assert.equal(after["indicator.incremental.full.keltner"], before["indicator.incremental.full.keltner"], "no full-series calculation per live tick");
      assert.equal(after["indicator.incremental.hit.keltner"], (before["indicator.incremental.hit.keltner"] ?? 0) + 1);
      assert.deepEqual(plots(actual), plots(definition.prepareData(context(data, `reference-${i}`, settings))));
    }
    data.addTrades([{ time: 70 * MINUTE + 100, price: 180, qty: 1, isBuy: true, id: "new-bar" }]);
    live.range = [0, data.listReadonly().length];
    assert.deepEqual(plots(definition.prepareData(live)), plots(definition.prepareData(context(data, "new-bar-reference", settings))));
  }
});

test("Keltner settings, disabled-by-default catalog, JSON persistence, restore and removal", () => {
  const entry = listIndicatorDefinitions().find((item) => item.type === definition.type);
  assert.equal(entry.group, "Volatilite/Bant");
  assert.equal(entry.category, "custom");
  const doc = { defaultView: globalThis, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
  const root = { ownerDocument: doc, querySelectorAll: () => [], getBoundingClientRect: () => ({ height: 600, width: 800 }) };
  const manager = new IndicatorManager({ ownerDocument: doc, root, initial: [], headers: createIndicatorPaneHeadersModel(),
    onChange() {}, onLayoutChange() {}, onInvalidate() {} });
  try {
    assert.deepEqual(manager.serialize(), [], "registering the catalog never enables the indicator");
    const instance = createIndicatorInstance(definition.type, 0);
    instance.settings = { ...instance.settings, emaPeriod: 5, atrPeriod: 3, multiplier: 1.5, showLastValueLabel: false };
    manager.restore([instance]);
    const persisted = JSON.parse(JSON.stringify(manager.serialize()));
    manager.restore([]);
    manager.restore(persisted);
    assert.deepEqual(manager.serialize(), persisted);
    const fields = definition.settingsSchema.sections.flatMap((section) => section.fields).map((field) => field.key);
    for (const key of ["emaPeriod", "atrPeriod", "multiplier", "lineWidth", "showLastValueLabel"]) assert.ok(fields.includes(key));
    assert.equal(definition.getHeaderLabel({ settings: instance.settings }), "KC 5/3×1.5");
    manager.deleteIndicator(instance.id);
    assert.deepEqual(manager.serialize(), []);
  } finally { manager.dispose(); }
});

test("Keltner price overlay emits three last-value labels and obeys label settings", () => {
  const data = series(25);
  const ctx = context(data);
  const labels = [];
  ctx.view = { area: { left: 0, top: 0, width: 800, height: 400 }, colWidth: 10, xOfIndex: (i) => i * 10, yOfPrice: (p) => 400 - p };
  ctx.ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {} };
  ctx.queuePriceLabel = (...args) => labels.push(args);
  const prepared = definition.prepareData(ctx);
  definition.drawPriceOverlay(ctx, prepared);
  assert.equal(labels.length, 3);
  ctx.settings.showLastValueLabel = false;
  definition.drawPriceOverlay(ctx, prepared);
  assert.equal(labels.length, 3);
});

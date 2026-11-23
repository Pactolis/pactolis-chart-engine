import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { IndicatorManager } from "../dist/features/indicators/IndicatorManager.js";
import { countIndicatorBuiltinStatesForSeries } from "../dist/features/indicators/builtins/stateRegistry.js";
import { getIndicatorDefinition } from "../dist/features/indicators/registry.js";

const INTERVAL = 60_000;
const BASE_TIME = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);

function makeSeries(barCount) {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  const bars = [];
  for (let i = 0; i < barCount; i += 1) {
    const price = 100 + Math.sin(i * 0.1) * 10;
    bars.push({
      startTime: BASE_TIME + i * INTERVAL,
      open: price,
      high: price + 2,
      low: price - 2,
      close: price + 0.5,
      volume: 20,
      delta: 1,
      count: 1,
      cells: new Map([[Math.round(price), { priceBin: Math.round(price), buyVol: 11, sellVol: 9, count: 1 }]]),
      completeness: "complete",
    });
  }
  series.loadBars(bars);
  return series;
}

function makeFakeView() {
  return {
    area: { left: 0, top: 0, width: 800, height: 400 },
    subPanesH: 120,
    colWidth: 8,
    xOfIndex: (i) => i * 8,
    yOfPrice: (p) => 400 - p,
  };
}

test("#290: deleting built-in indicators purges per-series state deterministically while preserving undo", () => {
  const series = makeSeries(200);
  const view = makeFakeView();
  const fakeDoc = { dispatchEvent() { return true; } };
  const fakeRoot = {};
  const manager = new IndicatorManager({
    ownerDocument: fakeDoc,
    root: fakeRoot,
    initial: [],
    onChange() {},
    onLayoutChange() {},
    onInvalidate() {},
  });

  const types = ["macd", "atr", "rsi", "moving-average", "volume-profile"];
  const createdIds = [];
  for (let round = 0; round < 6; round += 1) {
    for (const type of types) {
      const def = getIndicatorDefinition(type);
      const id = `${type}-${round}`;
      createdIds.push(id);
      const instance = {
        id,
        type,
        title: def.name,
        visible: true,
        collapsed: false,
        paneHeight: def.paneHeight,
        placement: def.defaultPlacement,
        order: createdIds.length,
        settings: def.defaultSettings(),
      };
      def.prepareData({
        instance,
        settings: instance.settings,
        series,
        range: [0, 200],
        view,
        ctx: {},
      });
    }
  }
  assert.ok(countIndicatorBuiltinStatesForSeries(series) >= 30);

  manager.restore(createdIds.map((id, idx) => {
    const type = types[idx % types.length];
    const def = getIndicatorDefinition(type);
    return {
      id,
      type,
      title: def.name,
      visible: true,
      collapsed: false,
      paneHeight: def.paneHeight,
      placement: def.defaultPlacement,
      order: idx,
      settings: def.defaultSettings(),
    };
  }));

  for (const id of createdIds) {
    manager.deleteIndicator(id);
  }
  assert.equal(countIndicatorBuiltinStatesForSeries(series), 0, "all deleted built-in indicator states must be purged");

  manager.dispose();
});

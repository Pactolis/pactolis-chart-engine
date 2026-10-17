import test from "node:test";
import assert from "node:assert/strict";
import {
  applyStrategyPreset,
  calculateStrategyLevels,
  normalizeStrategySettings,
  saveStrategyPreset,
} from "../dist/core/analysis/strategyLevels.js";

const DAY = 86_400_000;

function bar(day, open, high, low, close) {
  return {
    startTime: day,
    open,
    high,
    low,
    close,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
    completeness: "complete",
  };
}

const definition = {
  id: "custom-week",
  label: "Custom Week",
  source: { kind: "previous-completed-period", period: "weekly" },
  groups: [
    { id: "main", label: "Main" },
    { id: "zone", label: "Zone" },
  ],
  labelFormat: "name-ratio",
  levels: [
    { id: "line-025", group: "main", kind: "line", ratio: 0.25, name: "Quarter", color: "#22c55e" },
    { id: "zone-618", group: "zone", kind: "zone", fromRatio: 0.618, toRatio: 0.66, name: "Golden", color: "#eab308", fillOpacity: 0.2 },
  ],
};

test("strategy levels calculate custom line and zone ratios from configured source", () => {
  const monday = Date.UTC(2026, 5, 15);
  const bars = [];
  for (let i = 0; i < 7; i++) bars.push(bar(monday + i * DAY, 100, 110, 90, 100));

  const levels = calculateStrategyLevels(definition, bars, monday + 7 * DAY);
  const line = levels.find((item) => item.id === "line-025");
  const zone = levels.find((item) => item.id === "zone-618");

  assert.equal(line?.price, 105);
  assert.equal(line?.label, "Quarter · 0.25");
  assert.equal(zone?.fromPrice, 97.64);
  assert.equal(zone?.toPrice, 96.8);
  assert.equal(zone?.label, "Golden · 0.618-0.66");
  assert.equal(zone?.kind, "zone");
});

test("strategy settings normalize custom visibility and presets", () => {
  const custom = normalizeStrategySettings(definition, {
    visible: { "line-025": false },
    levels: [
      { id: "line-025", group: "main", kind: "line", ratio: 0.25, name: "Quarter", color: "#22c55e" },
      { id: "line-050", group: "main", kind: "line", ratio: 0.5, name: "Mid", color: "#38bdf8" },
    ],
  });

  assert.equal(custom.visible["line-025"], false);
  assert.equal(custom.visible["line-050"], true);

  const saved = saveStrategyPreset(definition, custom, "My preset", 1234);
  const changed = normalizeStrategySettings(definition, {
    ...saved,
    activePresetId: undefined,
    levels: [{ id: "line-075", group: "main", kind: "line", ratio: 0.75, name: "Three Quarter", color: "#f59e0b" }],
  });
  const applied = applyStrategyPreset(definition, changed, saved.presets[0].id);

  assert.equal(saved.presets.length, 1);
  assert.equal(applied.activePresetId, saved.presets[0].id);
  assert.deepEqual(applied.levels.map((item) => item.id), ["line-025", "line-050"]);
});

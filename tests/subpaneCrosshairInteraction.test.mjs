import test from "node:test";
import assert from "node:assert/strict";
import { getIndicatorDefinition } from "../dist/features/indicators/registry.js";
import { barStatsIndicatorDefinition } from "../dist/features/indicators/builtins/barStats.js";
import { liquidationsIndicatorDefinition } from "../dist/features/indicators/builtins/liquidations.js";
import { fundingRegimeIndicatorDefinition } from "../dist/features/indicators/builtins/fundingRegime.js";
import { futuresPositioningIndicatorDefinition } from "../dist/features/indicators/builtins/futuresPositioning.js";
import { crossExchangeOpenInterestIndicatorDefinition } from "../dist/features/indicators/builtins/crossExchangeOpenInterest.js";

test("all five legacy crosshair subpane indicators have drawInteraction defined", () => {
  const indicators = [
    barStatsIndicatorDefinition,
    liquidationsIndicatorDefinition,
    fundingRegimeIndicatorDefinition,
    futuresPositioningIndicatorDefinition,
    crossExchangeOpenInterestIndicatorDefinition,
  ];

  for (const def of indicators) {
    assert.ok(def, `Indicator definition ${def?.type} must exist`);
    assert.equal(typeof def.drawInteraction, "function", `Indicator ${def.type} must define drawInteraction`);
  }
});

test("indicators registered in registry have drawInteraction defined", () => {
  const types = [
    "bar-stats",
    "liquidations",
    "funding-regime",
    "futures-positioning",
    "cross-exchange-open-interest",
  ];

  for (const type of types) {
    const def = getIndicatorDefinition(type);
    assert.ok(def, `Definition for ${type} must be found in registry`);
    assert.equal(typeof def.drawInteraction, "function", `Definition for ${type} must have drawInteraction`);
  }
});

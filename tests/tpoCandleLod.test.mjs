import assert from "node:assert/strict";
import { test } from "node:test";
import { candleStyleFor, chartLodForSpacing } from "../dist/core/render/chartLod.js";

test("candle styles for built-in chart types across the footprint LOD boundary", () => {
  assert.equal(chartLodForSpacing(5.9), "candlestick");
  assert.equal(chartLodForSpacing(6), "footprint");

  const cases = [
    ["candlestick", ["full", "full"], ["full", "full"]],
    ["tpo", ["full", "full"], ["full", "full"]],
    ["footprint", ["full", "full"], ["none", "strip"]],
    ["footprintProfile", ["full", "full"], ["none", "strip"]],
  ];
  for (const [type, narrow, wide] of cases) {
    for (const [lod, expected] of [["candlestick", narrow], ["footprint", wide]]) {
      for (const enabled of [false, true]) {
        assert.equal(candleStyleFor(lod, type, enabled), expected[Number(enabled)], `${type} ${lod}, candles=${enabled}`);
      }
    }
  }
});

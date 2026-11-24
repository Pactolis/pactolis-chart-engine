import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import * as syncAllowlist from "../dist/core/syncAllowlist.js";
import { niceStepForPrice, quantizeToStep } from "../dist/core/priceStep.js";
import {
  buildTpoProfileGroups,
  calculateTpoProfile,
  effectiveTpoBracketMs,
} from "../dist/core/analysis/tpoProfile.js";

const {
  configureFootprintBootstrapMarkets,
  constrainChartTypeForMarket,
  getFootprintSupport,
  isFootprintSyncAllowed,
  persistableChartTypeForMarket,
  recordFootprintSupport,
  resetFootprintSupport,
} = syncAllowlist;

const ALL_TYPES = ["footprint", "footprintProfile", "candlestick", "tpo"];

test("only footprint-cell chart types are constrained on unallowed markets; TPO stays enabled", () => {
  resetFootprintSupport();
  configureFootprintBootstrapMarkets(["BINANCE_FUTURES:btcusdt"]);
  try {
    assert.equal("requiresFootprintCells" in syncAllowlist, false, "helper must stay module-internal");

    for (const type of ALL_TYPES) {
      assert.equal(constrainChartTypeForMarket("BINANCE_FUTURES:btcusdt", type), type);
      assert.equal(persistableChartTypeForMarket("BINANCE_FUTURES:btcusdt", type), type);
    }

    // Unknown support (bootstrap miss, server has not responded yet):
    // constrain forces only footprint/footprintProfile; persist keeps user's requested type.
    assert.equal(isFootprintSyncAllowed("BYBIT:solusdt"), false);
    assert.equal(getFootprintSupport("BYBIT:solusdt"), undefined);
    assert.equal(constrainChartTypeForMarket("BYBIT:solusdt", "tpo"), "tpo");
    assert.equal(constrainChartTypeForMarket("BYBIT:solusdt", "candlestick"), "candlestick");
    assert.equal(constrainChartTypeForMarket("BYBIT:solusdt", "footprint"), "candlestick");
    assert.equal(constrainChartTypeForMarket("BYBIT:solusdt", "footprintProfile"), "candlestick");
    for (const type of ALL_TYPES) {
      assert.equal(persistableChartTypeForMarket("BYBIT:solusdt", type), type);
    }

    // Explicit server denial (allowed: false): TPO and candlestick still allowed and persistable.
    recordFootprintSupport("BYBIT:solusdt", false);
    assert.equal(isFootprintSyncAllowed("BYBIT:solusdt"), false);
    assert.equal(getFootprintSupport("BYBIT:solusdt"), false);
    assert.equal(constrainChartTypeForMarket("BYBIT:solusdt", "tpo"), "tpo");
    assert.equal(constrainChartTypeForMarket("BYBIT:solusdt", "candlestick"), "candlestick");
    assert.equal(constrainChartTypeForMarket("BYBIT:solusdt", "footprint"), "candlestick");
    assert.equal(constrainChartTypeForMarket("BYBIT:solusdt", "footprintProfile"), "candlestick");
    assert.equal(persistableChartTypeForMarket("BYBIT:solusdt", "tpo"), "tpo");
    assert.equal(persistableChartTypeForMarket("BYBIT:solusdt", "candlestick"), "candlestick");
    assert.equal(persistableChartTypeForMarket("BYBIT:solusdt", "footprint"), "candlestick");
    assert.equal(persistableChartTypeForMarket("BYBIT:solusdt", "footprintProfile"), "candlestick");

    // Server promotion (allowed: true) keeps footprint sync permission cleanly separated from TPO.
    recordFootprintSupport("BYBIT:solusdt", true);
    assert.equal(isFootprintSyncAllowed("BYBIT:solusdt"), true);
    for (const type of ALL_TYPES) {
      assert.equal(constrainChartTypeForMarket("BYBIT:solusdt", type), type);
      assert.equal(persistableChartTypeForMarket("BYBIT:solusdt", type), type);
    }
  } finally {
    resetFootprintSupport();
    configureFootprintBootstrapMarkets([]);
  }
});

test("niceStepForPrice + calculateTpoProfile stays within MAX_BINS_PER_BAR (10_000) across 40% daily range and 4000x30m bars", () => {
  const MAX_BINS_PER_BAR = 10_000;
  const INTERVAL = 30 * 60_000;
  const START = Date.UTC(2026, 9, 1);

  for (const basePrice of [0.0000123, 0.15]) {
    const step = niceStepForPrice(basePrice);
    assert.ok(Number.isFinite(step) && step > 0);

    // Build 4000 x 30m bars where every UTC day walks across a 40% intraday range (+/-20%).
    const bars = Array.from({ length: 4000 }, (_, i) => {
      const phase = (i % 48) / 47;
      const mid = basePrice * (0.8 + 0.4 * phase);
      const halfSpan = basePrice * 0.02;
      const open = Math.max(step, mid - halfSpan * 0.5);
      const close = Math.max(step, mid + halfSpan * 0.5);
      const low = Math.max(step, mid - halfSpan);
      const high = mid + halfSpan;
      return {
        startTime: START + i * INTERVAL,
        open,
        high,
        low,
        close,
        volume: 100,
        delta: 0,
        count: 0,
        cells: new Map(),
        hasRef: true,
        completeness: "complete",
        sources: ["history"],
      };
    });

    // Also measure a single extreme bar covering a full 40% daily range against MAX_BINS_PER_BAR.
    const dailyLow = quantizeToStep(basePrice * 0.8, step);
    const dailyHigh = quantizeToStep(basePrice * 1.2, step);
    const full40PctSpanBins = Math.round((dailyHigh - dailyLow) / step);
    assert.ok(full40PctSpanBins <= MAX_BINS_PER_BAR, `40% daily span ${full40PctSpanBins} must fit within ${MAX_BINS_PER_BAR}`);

    const extremeSingleBar = { ...bars[0], low: basePrice * 0.8, high: basePrice * 1.2 };
    const singleProfile = calculateTpoProfile([extremeSingleBar], step, 0.7);
    assert.equal(singleProfile.levels.length, full40PctSpanBins + 1);

    const t0 = performance.now();
    const groups = buildTpoProfileGroups(
      bars,
      0,
      bars.length,
      "daily",
      effectiveTpoBracketMs("30m", INTERVAL),
      INTERVAL,
      step,
      0.7,
    );
    const elapsedMs = Math.round((performance.now() - t0) * 1000) / 1000;

    assert.ok(groups.groups.length >= 83);
    const firstResult = groups.groups[0].result;
    assert.ok(firstResult.poc !== null && firstResult.vah !== null && firstResult.val !== null);
    assert.ok(firstResult.levels.length > 0 && firstResult.totalCount > 0);
    console.log(
      "TPO_PRICESTEP_CHECK_JSON:" +
      JSON.stringify({
        basePrice,
        niceStep: step,
        full40PctSpanBins,
        singleBarLevels: singleProfile.levels.length,
        groups: groups.groups.length,
        firstSessionLevels: firstResult.levels.length,
        elapsedMs4000Bars: elapsedMs,
      }),
    );
  }

  // Wide bar within the 250_000-entry dense level budget is preserved instead of dropped.
  const hugeBar = {
    startTime: START,
    open: 100,
    high: 100 + 20_000 * 0.0001,
    low: 100,
    close: 101,
    volume: 1,
    delta: 0,
    count: 0,
    cells: new Map(),
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
  };
  const wideResult = calculateTpoProfile([hugeBar], 0.0001, 0.7);
  assert.equal(wideResult.levels.length, 20_001);
  assert.equal(wideResult.poc, 100);
  assert.equal(wideResult.truncated, false);

  // Degenerate range exceeding the 250_000-entry budget avoids dense-level OOM while keeping exact POC/VA.
  const degenerateBar = {
    ...hugeBar,
    high: 100 + 500_000 * 0.0001,
  };
  const guarded = calculateTpoProfile([degenerateBar], 0.0001, 0.7);
  assert.equal(guarded.levels.length, 0);
  assert.equal(guarded.truncated, true);
  assert.equal(guarded.poc, 100);
  assert.equal(guarded.val, 100);
  assert.equal(guarded.vah, 135);
});

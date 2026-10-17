import test from "node:test";
import assert from "node:assert/strict";
import { evaluateChartCaptureReadiness } from "../dist/features/chart/captureReadiness.js";

const base = {
  disposed: false,
  market: "BINANCE_FUTURES:btcusdt",
  timeframe: "4h",
  selectionGeneration: 3,
  priceStep: 25,
  history: {
    status: "settled",
    generation: 7,
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "4h",
    footprintReceived: false,
  },
  analysis: {
    revision: 44,
    market: "BINANCE_FUTURES:btcusdt",
    canonical: {
      status: "complete",
      market: "BINANCE_FUTURES:btcusdt",
      runKey: "BINANCE_FUTURES:btcusdt|25",
      generation: 9,
      revision: 44,
      failedPeriods: [],
    },
  },
  renderedAnalysisRevision: 44,
  renderedAnalysisMarket: "BINANCE_FUTURES:btcusdt",
};

test("capture readiness accepts a fully canonical zero-footprint chart after its revision is painted", () => {
  const result = evaluateChartCaptureReadiness(base);
  assert.equal(result.ready, true);
  assert.equal(result.reason, "READY");
  assert.equal(result.history.footprintReceived, false, "zero footprint is a valid settled state");
});

test("capture readiness rejects canonical completion until that exact analysis revision is rendered", () => {
  const result = evaluateChartCaptureReadiness({ ...base, renderedAnalysisRevision: 43 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "RENDER_PENDING");
});

test("capture readiness rejects partial or failed canonical analysis instead of treating visible progressive levels as complete", () => {
  for (const status of ["partial", "failed"]) {
    const result = evaluateChartCaptureReadiness({
      ...base,
      analysis: { ...base.analysis, canonical: { ...base.analysis.canonical, status, revision: null, failedPeriods: ["monthly"] } },
    });
    assert.equal(result.ready, false);
    assert.equal(result.reason, "ANALYSIS_FAILED");
  }
});

test("capture readiness is generation/state bound and rejects stale history from another selection", () => {
  const result = evaluateChartCaptureReadiness({
    ...base,
    history: { ...base.history, timeframe: "1h" },
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "HISTORY_PENDING");
});

test("capture readiness requires the canonical runKey for the chart's current market and price step", () => {
  const result = evaluateChartCaptureReadiness({
    ...base,
    analysis: { ...base.analysis, canonical: { ...base.analysis.canonical, runKey: "BINANCE_FUTURES:btcusdt|10" } },
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "ANALYSIS_PENDING");
});

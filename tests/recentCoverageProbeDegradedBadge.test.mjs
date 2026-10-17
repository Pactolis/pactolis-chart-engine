// Recent-footprint coverage probe vs. the status-bar "Data partial" badge.
//
// The probe is background repair over a 36h lookback (ChartHistoryController,
// RECENT_FOOTPRINT_RETRY_LOOKBACK_MS) and its bars are discarded unless the coverage
// checks accept them. A response that is degraded only because candles were missing for
// buckets the footprint store did hold (`meta.footprint.droppedBars > 0`, no
// `provenance[].error`) is exactly what `recentCoverageHardFailure` treats as non-fatal,
// so it must not raise a badge over the window the user actually charted. A degradation
// the probe does treat as fatal still has to reach the user, with its real cause.
import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";

const FROM = Date.UTC(2024, 0, 1);
const TO = FROM + 60_000;

function coverage(q) {
  return {
    schemaVersion: 1,
    source: "binance-usdm-aggTrade",
    instrument: q.reference,
    authority: "provisional",
    status: "complete",
    requestedFrom: q.from,
    requestedTo: q.to,
    coveredFrom: q.from,
    coveredThrough: q.to,
    durableThroughId: null,
    projectionThroughId: "100",
    authorityToken: "token",
    reasonCode: null,
  };
}

function historyBar(startTime) {
  return {
    startTime,
    open: 100, high: 101, low: 99, close: 100,
    volume: 1, delta: 1, count: 1,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map(),
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
    updatedAt: startTime,
  };
}

function pipelineFor(meta) {
  const degraded = [];
  const services = {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    fetchHistory: async (q) => {
      q.onMeta?.(meta(q));
      return [historyBar(FROM)];
    },
  };
  const pipeline = new ChartDataPipeline({
    market: "M",
    intervalMs: 60_000,
    priceStep: 1,
    services,
    onDataDegraded: (state, detail) => degraded.push({ state, detail }),
  });
  return { pipeline, degraded };
}

test("probe keeps a dropped-bars-only degradation off the status bar", async () => {
  const { pipeline, degraded } = pipelineFor((q) => ({
    schemaVersion: 2,
    generatedAt: q.to,
    degraded: true,
    footprint: { available: true, droppedBars: 2155 },
    footprintCoverage: coverage(q),
  }));

  await pipeline.repairRecentFootprintCoverage(FROM, TO);
  assert.deepEqual(
    degraded.filter((entry) => entry.state),
    [],
    "a window the probe itself retries must not raise the degraded badge",
  );
  pipeline.dispose();
});

test("probe still surfaces a degradation it treats as fatal, with the source's reason", async () => {
  const { pipeline, degraded } = pipelineFor((q) => ({
    schemaVersion: 2,
    generatedAt: q.to,
    degraded: true,
    footprint: { available: true, droppedBars: 2155 },
    provenance: [{
      source: "binance-klines",
      completeness: "partial",
      error: "klines HTTP 429: rate limit retries exhausted",
    }],
    footprintCoverage: coverage(q),
  }));

  await pipeline.repairRecentFootprintCoverage(FROM, TO);
  const raised = degraded.filter((entry) => entry.state);
  assert.equal(raised.length > 0, true, "a kline source failure must reach the user");
  assert.equal(raised[0].detail, "klines HTTP 429: rate limit retries exhausted");
  pipeline.dispose();
});

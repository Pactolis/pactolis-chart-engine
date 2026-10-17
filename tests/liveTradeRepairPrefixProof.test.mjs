import test from "node:test";
import assert from "node:assert/strict";
import { repairSnapshotReason } from "../dist/features/chart/LiveTradeRepairController.js";

const market = "BTCUSDT";
const interval = 60_000;
const priceStep = 0.1;
const from = 129_600_000;
const to = 129_660_000;
const firstEventTime = from + 123;

function meta(prefixOverrides = {}, snapshotOverrides = {}) {
  const prefixProof = {
    kind: "rest-discovery-prefix-v1",
    requestedFrom: from,
    firstEventTime,
    firstAggregateId: "42",
    discoveryFrom: from,
    discoveryAt: to,
    // Deliberately older than the REST start: a >36h Vision gap may remain incomplete,
    // while this proof is allowed to establish only the requested REST prefix.
    visionCoverageEnd: from - 24 * 60 * 60 * 1000,
    ...prefixOverrides,
  };
  return {
    repairSnapshot: {
      schemaVersion: 3,
      mode: "trade-id-v1",
      source: "binance-usdm-aggTrade",
      instrument: market,
      interval,
      priceStep,
      authority: "provisional",
      authorityToken: "generation-token",
      watermark: "50",
      requestedFrom: from,
      requestedTo: to,
      coveredFrom: firstEventTime,
      coveredThrough: to,
      bucketFrom: from,
      bucketThrough: to,
      coverageProof: {
        kind: "resolver-watermark-prefix-v3",
        authority: "provisional",
        authorityToken: "generation-token",
        projectionThroughId: "50",
        requestedFrom: from,
        requestedTo: to,
        coveredFrom: firstEventTime,
        coveredThrough: to,
        watermarkComplete: true,
        prefixProof,
      },
      ...snapshotOverrides,
    },
  };
}

test("verified REST discovery proves the empty prefix without a previous provisional day", () => {
  assert.equal(
    repairSnapshotReason(meta(), market, from, to, interval, priceStep, null),
    null,
  );
});

test("REST discovery proof cannot claim bytes before its persisted discovery boundary", () => {
  const rejection = repairSnapshotReason(
    meta({ discoveryFrom: from + 1 }),
    market,
    from,
    to,
    interval,
    priceStep,
    null,
  );
  assert.equal(rejection?.state, "pending");
  assert.match(rejection?.detail ?? "", /does not prove the requested prefix/);
});

test("REST discovery proof rejects a first trade beyond the snapshot watermark", () => {
  const rejection = repairSnapshotReason(
    meta({ firstAggregateId: "51" }),
    market,
    from,
    to,
    interval,
    priceStep,
    null,
  );
  assert.equal(rejection?.state, "pending");
});

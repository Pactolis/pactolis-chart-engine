import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { bucketStart } from "../dist/core/time.js";

const INTERVAL = 60_000;
// Footprint cells are stripped before FOOTPRINT_START_TIME, so a bucket from the
// live era is the only fixture that can assert cells survive the merge.
const START = bucketStart(Date.UTC(2024, 5, 13, 9, 41), INTERVAL);

function makeBar() {
  return {
    startTime: START,
    open: 105,
    high: 120,
    low: 80,
    close: 110,
    volume: 2,
    delta: 1,
    count: 2,
    cells: new Map([[100, {
      priceBin: 100,
      buyVol: 2,
      sellVol: 1,
      count: 2,
      buyCount: 1,
      sellCount: 1,
    }]]),
    hasRef: true,
    updatedAt: 200,
  };
}

function seededSeries() {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.upsertBar(makeBar());
  return series;
}

test("reassertOHLC restores REST open without erasing websocket extrema or footprint cells", () => {
  const series = seededSeries();
  const cells = series.get(START).cells;
  assert.equal(cells.size, 1, "fixture must carry footprint the merge can drop");

  series.reassertOHLC(START, 100, 115, 90, { close: 105, preferIncomingClose: false });

  const merged = series.get(START);
  assert.equal(merged.open, 100, "REST open is authoritative for the bucket");
  assert.equal(merged.high, 120, "a websocket high newer than the REST snapshot must survive");
  assert.equal(merged.low, 80, "a websocket low newer than the REST snapshot must survive");
  assert.equal(merged.close, 110, "newer websocket close must survive an older REST snapshot");
  assert.equal(merged.cells, cells, "OHLC reconciliation must not replace the footprint map");
  assert.equal(merged.cells.get(100).buyVol, 2);
});

test("reassertOHLC can accept a fresher REST close while still preserving the widest range", () => {
  const series = seededSeries();

  series.reassertOHLC(START, 100, 125, 85, { close: 130, preferIncomingClose: true });

  const merged = series.get(START);
  assert.equal(merged.open, 100);
  assert.equal(merged.high, 130, "the chosen close must remain inside the merged range");
  assert.equal(merged.low, 80, "older live extrema are still retained");
  assert.equal(merged.close, 130);
});

test("reassertOHLC carries the observation time of the close it adopts", () => {
  const series = seededSeries();

  series.reassertOHLC(START, 100, 125, 85, { close: 130, preferIncomingClose: true, observedAt: 900 });
  assert.equal(series.get(START).updatedAt, 900, "the next reconciliation must compare against the data now held");

  // A rejected close leaves the bar's freshness alone, so a later, genuinely newer
  // response is still allowed to win.
  series.reassertOHLC(START, 100, 125, 85, { close: 140, preferIncomingClose: false, observedAt: 5_000 });
  assert.equal(series.get(START).close, 130);
  assert.equal(series.get(START).updatedAt, 900);

  // An out-of-order response must never wind the bar's freshness backwards.
  series.reassertOHLC(START, 100, 125, 85, { close: 131, preferIncomingClose: true, observedAt: 400 });
  assert.equal(series.get(START).updatedAt, 900);
});

test("reassertOHLC without options preserves the bar it patches", () => {
  const series = seededSeries();

  // The periodic day+ maintenance refresh calls the four-argument form.
  series.reassertOHLC(START, 100, 112, 95);

  const merged = series.get(START);
  assert.equal(merged.open, 100);
  assert.equal(merged.high, 120, "a REST high below the observed high must not shrink the candle");
  assert.equal(merged.low, 80, "a REST low above the observed low must not shrink the candle");
  assert.equal(merged.close, 110, "an omitted close leaves the live close in place");
  assert.equal(merged.updatedAt, 200);
});

test("repair-owned bars ignore maintenance OHLC while explicit replacement can hand ownership off", () => {
  const series = seededSeries();
  const before = { ...series.get(START), cells: series.get(START).cells };

  series.commitRepairOwnership([START], 100n, []);
  series.reassertOHLC(START, 50, 500, 10, { close: 400, preferIncomingClose: true, observedAt: 1_000 });

  const protectedBar = series.get(START);
  assert.equal(protectedBar.open, before.open);
  assert.equal(protectedBar.high, before.high);
  assert.equal(protectedBar.low, before.low);
  assert.equal(protectedBar.close, before.close);
  assert.equal(protectedBar.volume, before.volume);
  assert.equal(protectedBar.delta, before.delta);
  assert.equal(protectedBar.count, before.count);
  assert.equal(protectedBar.cells, before.cells);
  assert.equal(protectedBar.updatedAt, before.updatedAt);

  const handoff = { ...makeBar(), open: 90, high: 95, low: 85, close: 92, volume: 7, delta: 3, count: 7 };
  series.replaceRange(START, START + INTERVAL, [handoff]);
  const replaced = series.get(START);
  assert.equal(replaced.open, 90, "verified explicit history handoff still uses replacement semantics");
  assert.equal(replaced.volume, 7);
});

test("reassertOHLC ignores buckets the series does not hold", () => {
  const series = seededSeries();
  series.reassertOHLC(START + INTERVAL, 1, 2, 0.5, { close: 1.5, preferIncomingClose: true });
  assert.equal(series.get(START + INTERVAL), undefined);
  assert.equal(series.length, 1);
});

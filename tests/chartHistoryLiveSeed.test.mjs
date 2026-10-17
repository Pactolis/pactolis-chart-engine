import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The controller pulls in Svelte-rune stores through its connection-state import, so
// its wiring is asserted on source. The behaviour it wires up — the merge, the emitted
// history patch and the retry decision — is covered headlessly in
// chartLiveBarSeedApply.test.mjs and liveBarSeedRetryPolicy.test.mjs.
const controllerUrl = new URL("../src/features/chart/ChartHistoryController.ts", import.meta.url);

async function seedImplementation() {
  const source = await readFile(controllerUrl, "utf8");
  const start = source.indexOf("private async runLiveBarOHLCSeed(");
  const end = source.indexOf("private queueLiveBarOHLCSeedRetry(", start);
  assert.ok(start >= 0 && end > start, "live-bar seed implementation must remain explicit");
  return { source, seed: source.slice(start, end) };
}

test("settled history starts the seed before footprint auto-sync can cancel maintenance", async () => {
  const { source } = await seedImplementation();

  const scheduleIndex = source.indexOf("this.scheduleLiveBarOHLCSeed(requestedMarket, requestedTimeframe, resolvedIntervalMs)");
  const autoSyncIndex = source.indexOf("this.host.svc.triggerAutoSync(requestedMarket, this.host.pipeline.series.config.priceStep)");
  assert.ok(scheduleIndex >= 0, "settled history must schedule an explicit live-bar seed");
  assert.ok(autoSyncIndex > scheduleIndex, "the seed must be started before footprint auto-sync can cancel maintenance work");

  // cancelMaintenanceRefresh only aborts the pipeline's periodic refresh, so the seed
  // has to own a request that refresh cannot reach.
  assert.match(source, /cancelMaintenanceRefresh\(\): void \{\s*this\.host\.pipeline\.cancelLiveBarOHLCRefresh\(\);\s*\}/);
});

test("the seed owns a direct-first request that maintenance cancellation cannot reach", async () => {
  const { seed } = await seedImplementation();

  assert.match(seed, /fetchLiveOhlc\(\{/,
    "the live seed must prefer the direct Binance candle source with gateway fallback");
  assert.match(seed, /includeFootprint: false/);
  assert.doesNotMatch(seed, /purpose:\s*["']maintenance["']/,
    "the seed fallback must stay on the interactive history queue");
  assert.doesNotMatch(seed, /fetchSharedLiveOhlc\(/,
    "the seed must not share the cancelable/coalesced periodic maintenance request");
  assert.doesNotMatch(seed, /refreshLiveBarOHLC\(/,
    "the seed must not share the cancelable periodic maintenance request");
  assert.doesNotMatch(seed, /isFootprintSyncBusy/,
    "a busy footprint sync must not skip the seed the open candle depends on");
});

test("a seed request settles on dispose, on a market change and on a hung backend", async () => {
  const { source, seed } = await seedImplementation();

  assert.match(seed, /signal:\s*abort\.signal/,
    "the request must remain abortable with the chart while fetchLiveOhlc owns the total timeout");
  assert.doesNotMatch(seed, /AbortSignal\.timeout|LIVE_OHLC_SEED_REQUEST_TIMEOUT_MS/,
    "the seed must not start a second timeout budget outside fetchLiveOhlc");
  assert.match(source, /private cancelLiveBarOHLCSeed\(\): void \{[\s\S]*?this\.liveOhlcSeedAbort\?\.abort\(\);[\s\S]*?\}/,
    "cancelling the seed must abort the request in flight");
  for (const caller of ["dispose", "refresh"]) {
    assert.ok(source.includes("this.cancelLiveBarOHLCSeed();"), `${caller} must be able to cancel a pending seed`);
  }
});

test("the seed applies through the pipeline so the viewport sees the appended open bar", async () => {
  const { seed } = await seedImplementation();

  assert.match(seed, /this\.host\.pipeline\.applyLiveBarSeed\(bars, \{/,
    "writing to the series directly would skip onUpdate, and the viewport places latest on that event");
  assert.doesNotMatch(seed, /series\.upsertBar\(|series\.reassertOHLC\(/,
    "the merge belongs to the pipeline, which owns the series and the history patch");
  assert.match(seed, /observedAt: requestedAt/,
    "a websocket tick received after the REST cutoff must own the close");
});

test("failed and empty seeds stay pending on every timeframe, and stop terminating", async () => {
  const { source, seed } = await seedImplementation();

  assert.match(seed, /from: job\.target/,
    "the window must start at the bucket the seed targeted so a rollover still repairs it");
  assert.match(seed, /shouldRetryLiveBarSeed\(\{/,
    "retrying must be a policy decision, not an unconditional reschedule");
  assert.match(seed, /reason === "empty" \? job\.consecutiveEmpty \+ 1 : 0/);
  assert.match(seed, /hasLiveBar: this\.host\.pipeline\.series\.get\(liveStart\) !== undefined/,
    "an empty answer means something different once the live stream has opened the bucket");
  assert.match(source, /liveBarSeedRetryDelayMs\(job\.attempt\)/,
    "the backoff must come from the shared policy, which is unit-tested for its deadline");
  assert.match(
    source,
    /void this\.runLiveBarOHLCSeed\(\{ \.\.\.job, attempt: job\.attempt \+ 1 \}\);\s*\}, liveBarSeedRetryDelayMs\(job\.attempt\)\)/,
    "counting the retry before scheduling it would skip the first, shortest backoff step",
  );
  assert.doesNotMatch(source, /intervalMs >= DAY_MS[\s\S]{0,200}scheduleLiveBarOHLCSeed/,
    "the seed must not be gated on day+ timeframes the way the periodic refresh is");
});

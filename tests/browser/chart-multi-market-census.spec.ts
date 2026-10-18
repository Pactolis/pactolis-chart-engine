import { expect, test, type Page, type TestInfo } from "@playwright/test";

/**
 * Issues #377 and #392 - four and eight visible charts: capacity and financial
 * census (diagnostic).
 *
 * #308 product decision (2026-10-09): multi-chart measurements use a DIFFERENT
 * market per chart. Every /history request carries its market in `markets`,
 * so each market's fixture universe is anchored on its own first wide request
 * without having to correlate same-market requests to panels. Footprint exists
 * on only 7 markets, so the eight-chart grid repeats one market; both of its
 * charts read the same market universe (same market, same trades).
 *
 * Given N real public mountChart/ChartRuntime mounts filling a 1280x720
 * viewport (2x2 at 640x360 or 4x2 at 320x360 per chart), one footprint market
 * per chart, 1m, priceStep 1, 0 indicators / 0 drawings, targetBars=2000, and
 * the harness history endpoint (a one-shot JSON phase 1, then the streamed
 * JSON phase 2) serving 4 literal trades per closed minute;
 * When all charts mount at once and load, then sit idle, then take a
 * crosshair sweep and a drag pan on every chart;
 * Then each chart independently shows 2000 unique ordered closed bars with
 * OHLC 100/103/99/102, volume 4, delta 2, count 4 and four literal cells
 * (99 sell, 100/102/103 buy), read through public getAnalysisSnapshot in
 * <= 24-bar chunks (84 per chart), and the run reports mount-to-ready time,
 * frame intervals, long tasks and JS heap per phase.
 *
 * Frame numbers are a CI-machine regression alarm, not a device guarantee.
 * #308 frame budget (2026-10-09, "Kademeli 30"): with 4 and 8 charts the
 * interaction phases (idle, crosshair, pan) must keep frame p95 <= 33.3 ms;
 * the load phase is reported only. The single-chart 16.7 ms target lives in
 * history-worker-performance.spec.ts and is unchanged. Every measurement is
 * printed as one JSON line.
 *
 * #308 workload profiles L2-L6 (pairwise matrix from the 2026-10-04 proposal,
 * product decisions of 2026-10-09) reuse the same harness with more history,
 * indicators and drawings per chart:
 *
 *   profile  bars/chart  charts  indicators/chart  drawings/chart
 *   L2       2000        4       10                100
 *   L3       2000        8       50                500
 *   L4       10000       1       10                500
 *   L5       10000       4       50                0
 *   L6       10000       8       0                 100
 *   L7       20000       1       50                100
 *   L8       20000       4       0                 500
 *   L9       20000       8       10                0
 *   Tam      20000       8       50                500
 *
 * The matrix asked for 50k bars in L7-L9; the app holds at most 20000 bars
 * per chart, so they run at 20000 (#308 decision "20k ile ölç"), and "Tam" is
 * the supported maximum: 8 charts, 20000 bars, 50 indicators, 500 drawings.
 *
 * Indicator mix "Karma": mostly light ones computed from the bars, one CVD and
 * one heavy derivative (Liquidations) whose external series is a fixed
 * fixture. Separate panes are kept to three per chart (CVD, Liquidations, RSI
 * at the 60 px minimum) so the price area stays usable in a 360 px cell; the
 * remaining light indicators sit on the price pane. The financial census, the
 * transport checks and the teardown are the same as for the empty charts, and
 * every indicator must report status "ok" and every drawing must be listed.
 * The profiles' frame, heap and timing numbers are reported only: the
 * "Kademeli 30" gate was set on empty charts, and no threshold has been
 * decided yet for loaded profiles.
 */

const FUNCTIONAL_WEBGL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader-webgl",
  "--enable-unsafe-swiftshader",
];

const VIEWPORT = { width: 1280, height: 720 };

// Precise heap numbers and a GC hook for the retained-heap readings (see
// HEAP_CEILING_BYTES).
const HEAP_ARGS = ["--enable-precise-memory-info", "--js-flags=--expose-gc"];

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS, ...HEAP_ARGS] }, viewport: VIEWPORT });

/**
 * #308 memory decisions (2026-10-09, "Kalıcı bellek" and "Kapı"): the 1 GB
 * per-tab ceiling is a CI gate on the RETAINED heap, read right after a forced
 * GC after load and after interaction (and every minute of the endurance run). The
 * instantaneous heap (uncollected garbage included, which swings between runs
 * with GC timing: 383-1130 MB for L5 on the same code) and its peak, sampled
 * on every animation frame, are reported for information only.
 */
const HEAP_CEILING_BYTES = 1024 * 1024 * 1024;

interface Scenario {
  id: string;
  issue: number;
  title: string;
  markets: string[];
  columns: number;
  rows: number;
  bars: number;
  indicators: number;
  drawings: number;
  // Only the empty 4- and 8-chart grids carry the #308 "Kademeli 30" gate.
  frameGate: boolean;
  // Burst profile: live trades replace the pointer phases (see BURST below).
  burst?: boolean;
  // Endurance profile: live trades at the normal rate for minutes (see ENDURANCE).
  endurance?: boolean;
  timeoutMs: number;
  // Mount-to-ready deadline; 90 s unless the workload needs longer.
  readyTimeoutMs?: number;
}

const FOOTPRINT_MARKETS = [
  "BINANCE_FUTURES:btcusdt",
  "BINANCE_FUTURES:ethusdt",
  "BINANCE_FUTURES:solusdt",
  "BINANCE_FUTURES:avaxusdt",
  "BINANCE_FUTURES:xauusdt",
  "BINANCE_FUTURES:xagusdt",
  "BINANCE_FUTURES:clusdt",
];
const FOUR_MARKETS = FOOTPRINT_MARKETS.slice(0, 4);
const EIGHT_MARKETS = [...FOOTPRINT_MARKETS, FOOTPRINT_MARKETS[0]];
const SCENARIOS: Scenario[] = [
  {
    id: "377",
    issue: 377,
    title: "#377 four charts on four markets: 2000-bar census each, with load, idle and crosshair frame measurements",
    markets: FOUR_MARKETS,
    columns: 2,
    rows: 2,
    bars: 2_000,
    indicators: 0,
    drawings: 0,
    frameGate: true,
    timeoutMs: 120_000,
  },
  {
    id: "392",
    issue: 392,
    title: "#392 eight charts on seven markets: 2000-bar census each, with load, idle and crosshair frame measurements",
    markets: EIGHT_MARKETS,
    columns: 4,
    rows: 2,
    bars: 2_000,
    indicators: 0,
    drawings: 0,
    frameGate: true,
    timeoutMs: 180_000,
  },
  {
    id: "L2",
    issue: 308,
    title: "#308 L2 four charts, 2000 bars, 10 indicators and 100 drawings each: census and measurements (report-only)",
    markets: FOUR_MARKETS,
    columns: 2,
    rows: 2,
    bars: 2_000,
    indicators: 10,
    drawings: 100,
    frameGate: false,
    timeoutMs: 180_000,
  },
  {
    id: "L3",
    issue: 308,
    title: "#308 L3 eight charts, 2000 bars, 50 indicators and 500 drawings each: census and measurements (report-only)",
    markets: EIGHT_MARKETS,
    columns: 4,
    rows: 2,
    bars: 2_000,
    indicators: 50,
    drawings: 500,
    frameGate: false,
    timeoutMs: 300_000,
  },
  {
    id: "L4",
    issue: 308,
    title: "#308 L4 one chart, 10000 bars, 10 indicators and 500 drawings: census and measurements (report-only)",
    markets: FOOTPRINT_MARKETS.slice(0, 1),
    columns: 1,
    rows: 1,
    bars: 10_000,
    indicators: 10,
    drawings: 500,
    frameGate: false,
    timeoutMs: 180_000,
  },
  {
    id: "L5",
    issue: 308,
    title: "#308 L5 four charts, 10000 bars, 50 indicators each: census and measurements (report-only)",
    markets: FOUR_MARKETS,
    columns: 2,
    rows: 2,
    bars: 10_000,
    indicators: 50,
    drawings: 0,
    frameGate: false,
    timeoutMs: 300_000,
  },
  {
    id: "L6",
    issue: 308,
    title: "#308 L6 eight charts, 10000 bars, 100 drawings each: census and measurements (report-only)",
    markets: EIGHT_MARKETS,
    columns: 4,
    rows: 2,
    bars: 10_000,
    indicators: 0,
    drawings: 100,
    frameGate: false,
    timeoutMs: 300_000,
  },
  {
    id: "L7",
    issue: 308,
    title: "#308 L7 one chart, 20000 bars, 50 indicators and 100 drawings: census and measurements (report-only)",
    markets: FOOTPRINT_MARKETS.slice(0, 1),
    columns: 1,
    rows: 1,
    bars: 20_000,
    indicators: 50,
    drawings: 100,
    frameGate: false,
    timeoutMs: 300_000,
  },
  {
    id: "L8",
    issue: 308,
    title: "#308 L8 four charts, 20000 bars, 500 drawings each: census and measurements (report-only)",
    markets: FOUR_MARKETS,
    columns: 2,
    rows: 2,
    bars: 20_000,
    indicators: 0,
    drawings: 500,
    frameGate: false,
    timeoutMs: 300_000,
  },
  {
    id: "L9",
    issue: 308,
    title: "#308 L9 eight charts, 20000 bars, 10 indicators each: census and measurements (report-only)",
    markets: EIGHT_MARKETS,
    columns: 4,
    rows: 2,
    bars: 20_000,
    indicators: 10,
    drawings: 0,
    frameGate: false,
    timeoutMs: 420_000,
  },
  {
    id: "Tam",
    issue: 308,
    title: "#308 Tam eight charts, 20000 bars, 50 indicators and 500 drawings each: census and measurements (report-only)",
    markets: EIGHT_MARKETS,
    columns: 4,
    rows: 2,
    bars: 20_000,
    indicators: 50,
    drawings: 500,
    frameGate: false,
    timeoutMs: 900_000,
    readyTimeoutMs: 420_000,
  },
  {
    id: "burst",
    issue: 308,
    title: "#308 burst: eight charts, 10000 bars, 100 drawings each, live trades at 10x the normal rate for 60 s (correctness gated, latency report-only)",
    markets: EIGHT_MARKETS,
    columns: 4,
    rows: 2,
    bars: 10_000,
    indicators: 0,
    drawings: 100,
    frameGate: false,
    burst: true,
    timeoutMs: 420_000,
  },
];

/**
 * #308 burst decision "10 kat, 60 sn": the normal trade rate times ten for one
 * minute, no correctness loss, and latency back to normal (under the 1 s
 * freshness target) within 5 s after the burst. The normal rate is this
 * harness's assumption (no product number exists): 20 trades/s per market,
 * so the burst is 200 trades/s per market, 1400/s over the seven markets.
 *
 * Trades arrive as gateway-shaped JSON frames read by the harness TradeFeed;
 * the frames come from a dedicated Worker on its own clock, every 10 ms one "trades" message per
 * market (at most 64 trades, the trade-ingest batch cap), plus a heartbeat
 * every second. Each trade's exchange time is the Worker's Date.now() when it
 * is generated, so a busy main thread shows up as queueing delay.
 *
 * Latency per message is measured twice: until the service has handed it to
 * every chart (delivery) and until the first animation frame after that
 * (frame). rAF is not pixel presentation; it is the earliest frame that can
 * show the trade. Correctness is a hard check: every chart receives every
 * trade exactly once and in order, and its closed live bars match OHLC,
 * volume, delta and count recomputed from the generated trades. The latency
 * numbers and the 5 s recovery verdict are reported only: the 1 s freshness
 * target is not a CI gate (#308 decision).
 */
const BURST = {
  normalTradesPerSecond: 20,
  multiplier: 10,
  baselineMs: 10_000,
  burstMs: 60_000,
  recoveryMs: 15_000,
  tickMs: 10,
  maxTradesPerMessage: 64,
  freshnessTargetMs: 1_000,
  recoveryTargetMs: 5_000,
};
/**
 * #308 endurance (30 and 60 min): the L2 workload (4 charts, 2000 bars, 10
 * indicators, 100 drawings), which stays under the 1 GB ceiling, receives
 * live trades at the burst profile's normal rate for the whole run through
 * the same gateway route and Worker. It looks for slow drift: retained heap
 * growth, and frame latency or frame time creeping up. Correctness is gated
 * as in the burst (every trade exactly once and in order, live bars equal to
 * the recomputed ones); the minute-by-minute numbers and the heap trend are
 * reported only, since no drift threshold has been decided. It runs only when
 * CHART_ENDURANCE_MINUTES is set, from the "Chart endurance" workflow.
 */
const ENDURANCE_MINUTES = Number(process.env.CHART_ENDURANCE_MINUTES ?? 0) || 0;
const ENDURANCE = {
  normalTradesPerSecond: BURST.normalTradesPerSecond,
  sampleMs: 60_000,
  tickMs: BURST.tickMs,
  maxTradesPerMessage: BURST.maxTradesPerMessage,
};
const ENDURANCE_SCENARIO: Scenario = {
  id: "endurance",
  issue: 308,
  title: "#308 endurance: L2 load with live trades at the normal rate for CHART_ENDURANCE_MINUTES (correctness gated, drift report-only)",
  markets: FOUR_MARKETS,
  columns: 2,
  rows: 2,
  bars: 2_000,
  indicators: 10,
  drawings: 100,
  frameGate: false,
  endurance: true,
  // Mount, census and teardown take about two minutes for L2.
  timeoutMs: ENDURANCE_MINUTES * 60_000 + 600_000,
};
// #308 endurance 8Tam: the Tam workload (eight charts, 20000 bars, 50
// indicators, 500 drawings) under the same gates, Worker and minute
// sampling; CHART_ENDURANCE_PROFILE selects which profile runs.
const ENDURANCE_8TAM_SCENARIO: Scenario = {
  ...(SCENARIOS.find((candidate) => candidate.id === "Tam") as Scenario),
  id: "endurance-8tam",
  title: "#308 endurance 8Tam: eight charts, 20000 bars, 50 indicators and 500 drawings each with live trades for CHART_ENDURANCE_MINUTES (correctness gated, drift report-only)",
  endurance: true,
  // Mount, census and teardown of the Tam workload take about ten minutes.
  timeoutMs: ENDURANCE_MINUTES * 60_000 + 1_500_000,
};
const ENDURANCE_PROFILE = process.env.CHART_ENDURANCE_PROFILE === "8Tam" ? ENDURANCE_8TAM_SCENARIO : ENDURANCE_SCENARIO;const INTERVAL_MS = 60_000;
// The app plans history in windows of at most 20000 buckets, the open one
// included (HISTORY_MAX_WINDOW_BARS, src/features/data/aggr.ts). A 20000-bar
// load therefore splits: the newest window carries 19999 closed bars and a
// second one the oldest bar. The universe is anchored on the newest window.
const HISTORY_MAX_WINDOW_BARS = 20_000;
const CHUNK_BARS = 24;
const FRAME_BUDGET_MS = 1000 / 60;
// #308 multi-chart interaction budget: frame p95 <= 33.3 ms (30 fps). Chromium
// rAF timestamps are coarsened to 0.1 ms, so a two-vsync frame reads 33.3 or
// 33.4 ms; the tolerance keeps that one rounding step from failing the gate.
const MULTI_CHART_INTERACTION_FRAME_P95_MS = 1000 / 30;
const RAF_TIMESTAMP_TOLERANCE_MS = 0.1;
// WireBar cell tuple: [priceBin, buyVol, sellVol, liqBuy, liqSell, count, buyCount, sellCount]
const LITERAL_CELLS: number[][] = [
  [99, 0, 1, 0, 0, 1, 0, 1],
  [100, 1, 0, 0, 0, 1, 1, 0],
  [102, 1, 0, 0, 0, 1, 1, 0],
  [103, 1, 0, 0, 0, 1, 1, 0],
];
const FIXTURE_SOURCE = "multi-market-census-fixture";
const FIXTURE_GENERATED_AT = Date.now();

interface LiteralBar {
  t: number; o: number; h: number; l: number; c: number; v: number; d: number; n: number;
  cells: number[][];
  completeness: "complete";
  updatedAt: number;
}

interface MarketUniverse {
  anchorFrom: number;
  anchorTo: number;
  times: number[];
}

interface ObservedRequest {
  market: string;
  // Window reaches past the market's fixture universe (live era).
  pastUniverse: boolean;
  format: string;
  from: number;
  to: number;
  served: number;
  bytes: number;
}

function bucketStartOf(ms: number): number {
  return Math.floor(ms / INTERVAL_MS) * INTERVAL_MS;
}

function fixtureBar(t: number, withCells: boolean): LiteralBar {
  return {
    t, o: 100, h: 103, l: 99, c: 102, v: 4, d: 2, n: 4,
    cells: withCells ? LITERAL_CELLS.map((cell) => [...cell]) : [],
    completeness: "complete",
    updatedAt: t + INTERVAL_MS,
  };
}

// The fixture market trades only inside its bars-minute universe and never
// after it, so every window, including ones past a minute rollover, has a
// truthful answer: the universe bars inside [from, to]. Only the streamed
// phase carries cells and claims footprint coverage.
function envelopeMeta(market: string, from: number, to: number, withCoverage: boolean) {
  const meta: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: FIXTURE_GENERATED_AT,
    provenance: [{ source: FIXTURE_SOURCE, market, completeness: "complete", from, to }],
  };
  if (withCoverage) {
    meta.footprintCoverage = {
      schemaVersion: 1, source: FIXTURE_SOURCE, instrument: market, authority: "provisional", status: "complete",
      requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to,
      durableThroughId: null, projectionThroughId: null, authorityToken: null, reasonCode: null,
    };
  }
  return meta;
}

// Fixed Liquidations series (the "Karma" heavy derivative indicator): one
// point per minute of the requested window (seconds), deterministic values.
// The endpoint is the gateway's /api/metrics/liquidations, never Coinalyze.
function liquidationFixture(url: URL) {
  const from = Number(url.searchParams.get("from")) * 1000;
  const to = Number(url.searchParams.get("to")) * 1000;
  const points = [];
  for (let time = Math.ceil(from / INTERVAL_MS) * INTERVAL_MS; time <= to; time += INTERVAL_MS) {
    const step = time / INTERVAL_MS;
    const longLiquidationsUsd = 1_000 + (step % 7) * 250;
    const shortLiquidationsUsd = 800 + (step % 5) * 300;
    points.push({
      time, longLiquidationsUsd, shortLiquidationsUsd,
      totalLiquidationsUsd: longLiquidationsUsd + shortLiquidationsUsd,
      liquidationDeltaUsd: shortLiquidationsUsd - longLiquidationsUsd,
      components: [{
        exchange: "Binance", exchangeKey: "binancef", symbol: "BTCUSDT_PERP.A", symbolOnExchange: "BTCUSDT",
        longLiquidationsUsd, shortLiquidationsUsd,
      }],
    });
  }
  return {
    ok: true,
    data: {
      source: "coinalyze", base: url.searchParams.get("base"), interval: url.searchParams.get("interval"),
      from: from / 1000, to: to / 1000,
      selectedExchanges: (url.searchParams.get("exchanges") ?? "").split(","),
      selectedMarketTypes: (url.searchParams.get("marketTypes") ?? "").split(","),
      symbols: ["BTCUSDT_PERP.A"], points,
    },
  };
}

function quantiles(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { samples: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted[sorted.length - 1]) };
}

function frameSummary(intervals: number[], longTasks: number[]) {
  const dropped = intervals.reduce((total, interval) => (
    interval >= FRAME_BUDGET_MS * 1.5 ? total + Math.max(0, Math.round(interval / FRAME_BUDGET_MS) - 1) : total
  ), 0);
  return {
    frameMs: quantiles(intervals),
    droppedFrames: dropped,
    longTasks: { count: longTasks.length, maxMs: longTasks.length ? Math.round(Math.max(...longTasks)) : 0 },
  };
}

// Worker that plays the gateway: it owns the frame sequence after the
// handshake and stamps each trade with its own clock (see BURST).
const BURST_WORKER_SOURCE = `
self.onmessage = (event) => {
  const cfg = event.data;
  let sequence = cfg.firstSequence;
  const instruments = cfg.markets.map((market) => market.split(":")[1].toUpperCase());
  const start = Date.now();
  const burstStart = start + cfg.baselineMs;
  const burstEnd = burstStart + cfg.burstMs;
  const end = burstEnd + cfg.recoveryMs;
  const due = cfg.markets.map(() => 0);
  const generated = cfg.markets.map(() => 0);
  const minutes = cfg.markets.map(() => new Map());
  let lastHeartbeat = 0;
  let lastTick = start;
  const tick = () => {
    const now = Date.now();
    const phase = now < burstStart ? 0 : now < burstEnd ? 1 : 2;
    if (now - lastHeartbeat >= 1000) {
      self.postMessage({ kind: "raw", raw: JSON.stringify({ type: "heartbeat", v: 1, epoch: cfg.epoch, sequence: sequence++, timestamp: now }) });
      lastHeartbeat = now;
    }
    const rate = cfg.normalTradesPerSecond * (phase === 1 ? cfg.multiplier : 1);
    const elapsed = now - lastTick;
    lastTick = now;
    cfg.markets.forEach((market, m) => {
      due[m] += rate * elapsed / 1000;
      let pending = Math.floor(due[m]);
      due[m] -= pending;
      while (pending > 0) {
        const size = Math.min(pending, cfg.maxTradesPerMessage);
        pending -= size;
        const trades = [];
        for (let k = 0; k < size; k++) {
          const id = ++generated[m];
          // Within the series' 0.3 % tick-outlier guard of the history close (102).
          const price = 102 + [0, 0.25, 0.5, 0.25][id % 4];
          const quantity = 1 + (id % 3);
          const side = id % 5 < 3 ? "buy" : "sell";
          const tradeCount = 1 + (id % 2);
          trades.push({
            schemaVersion: 1, venue: "binance", market: "usd_perp", instrument: instruments[m],
            tradeId: String(id), exchangeTimestamp: now, receivedTimestamp: now, price, quantity, side, tradeCount,
            liquidation: false, source: { session: "burst-source", sequence: id },
          });
          const bucket = Math.floor(now / cfg.intervalMs) * cfg.intervalMs;
          let bar = minutes[m].get(bucket);
          if (!bar) { bar = [bucket, price, price, price, price, 0, 0, 0]; minutes[m].set(bucket, bar); }
          bar[2] = Math.max(bar[2], price); bar[3] = Math.min(bar[3], price); bar[4] = price;
          bar[5] += quantity; bar[6] += side === "buy" ? quantity : -quantity; bar[7] += tradeCount;
        }
        self.postMessage({
          kind: "trades", time: now, phase, count: size,
          raw: JSON.stringify({ type: "trades", v: 1, epoch: cfg.epoch, sequence: sequence++, trades }),
        });
      }
    });
    if (now >= end) {
      self.postMessage({ kind: "done", start, burstStart, burstEnd, end: now, generated, minutes: minutes.map((map) => [...map.values()]) });
      return;
    }
    setTimeout(tick, cfg.tickMs);
  };
  tick();
};
`;

// The Worker's raw frames go straight to the harness trade feed.
async function openGateway(page: Page) {
  await page.evaluate(() => {
    const state = (window as any).__multiMarketCensus;
    const { service } = state.live;
    state.live.socket = { onmessage: (event: { data: string }) => service.receive(event.data) };
  });
}

async function runBurst(page: Page, uniqueMarkets: string[], panelIds: string[], markets: string[]) {
  await openGateway(page);
  return page.evaluate(async ({ uniqueMarkets, panelIds, markets, burst, workerSource, intervalMs }) => {
    const state = (window as any).__multiMarketCensus;
    const { socket, subscriptions } = state.live;
    const emit = (raw: string) => socket.onmessage?.({ data: raw });
    const epoch = 1;

    // Per trades message: exchange time, phase, delivery and frame latency.
    const time: number[] = [];
    const phase: number[] = [];
    const delivered: number[] = [];
    const framed: number[] = [];
    let awaitingFrame: number[] = [];
    state.onFrame = (wallNow: number) => {
      for (const index of awaitingFrame) framed[index] = wallNow - time[index];
      awaitingFrame = [];
    };
    const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
    const done = await new Promise<any>((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(`burst worker failed: ${event.message}`));
      worker.onmessage = (event) => {
        const data = event.data;
        if (data.kind === "done") { resolve(data); return; }
        emit(data.raw);
        if (data.kind !== "trades") return;
        const index = time.length;
        time.push(data.time);
        phase.push(data.phase);
        delivered.push(Date.now() - data.time);
        framed.push(Number.NaN);
        awaitingFrame.push(index);
      };
      worker.postMessage({ ...burst, markets: uniqueMarkets, epoch, firstSequence: 2, intervalMs });
    });
    worker.terminate();
    // Let the last frames land before the frame hook is removed.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    state.onFrame = null;

    const quantiles = (values: number[]) => {
      const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
      if (!sorted.length) return null;
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
      return { samples: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] };
    };
    const latency = (which: number) => ({
      deliveryMs: quantiles(delivered.filter((_, index) => phase[index] === which)),
      frameMs: quantiles(framed.filter((_, index) => phase[index] === which)),
    });
    // Recovery: how long after the burst ends a trade still reached a frame
    // later than the freshness target.
    let recoveredAfterMs = 0;
    time.forEach((at, index) => {
      const shownAt = at + framed[index];
      if (framed[index] > burst.freshnessTargetMs && shownAt > done.burstEnd) {
        recoveredAfterMs = Math.max(recoveredAfterMs, shownAt - done.burstEnd);
      }
    });
    // One-second timeline of the worst frame latency.
    const timeline: number[] = [];
    time.forEach((at, index) => {
      const second = Math.floor((at - done.start) / 1000);
      timeline[second] = Math.max(timeline[second] ?? 0, Math.round(framed[index]));
    });

    // Closed live bars of each chart, read once the stream has stopped.
    const lastMinute = Math.max(...done.minutes.flat().map((bar: number[]) => bar[0]));
    const firstMinute = Math.min(...done.minutes.flat().map((bar: number[]) => bar[0]));
    const liveBars = panelIds.map((panelId: string) => {
      const runtime = state.registry.getChartRuntime(panelId);
      const snapshot = runtime.getAnalysisSnapshot({
        now: lastMinute + intervalMs, visibleTimeRange: { from: firstMinute, to: lastMinute }, maxLevelsAndDrawings: 0, maxIndicatorSamples: 1,
      });
      return snapshot.candles.map((candle: any) => [
        candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.delta, candle.count,
      ]);
    });
    const toPerformance = (wall: number) => wall - performance.timeOrigin;
    return {
      generated: Object.fromEntries(uniqueMarkets.map((market: string, index: number) => [market, done.generated[index]])),
      expectedBars: Object.fromEntries(uniqueMarkets.map((market: string, index: number) => [market, done.minutes[index]])),
      liveBars: Object.fromEntries(panelIds.map((panelId: string, index: number) => [panelId, { market: markets[index], bars: liveBars[index] }])),
      subscriptions: subscriptions.map((record: any) => ({ ...record })),
      messages: time.length,
      phasesAt: {
        baseline: toPerformance(done.start), burst: toPerformance(done.burstStart),
        recovery: toPerformance(done.burstEnd), end: toPerformance(done.end),
      },
      latency: { baseline: latency(0), burst: latency(1), recovery: latency(2) },
      recoveredAfterMs: Math.round(recoveredAfterMs),
      worstFrameLatencyPerSecondMs: timeline,
      unframedMessages: framed.filter((value) => !Number.isFinite(value)).length,
    };
  }, { uniqueMarkets, panelIds, markets, burst: BURST, workerSource: BURST_WORKER_SOURCE, intervalMs: INTERVAL_MS });
}

// Endurance: the same Worker at the normal rate for the whole run. Nothing is
// kept per message; each minute is folded into one sample (after a forced GC,
// so the heap line shows retained memory rather than garbage).
async function runEndurance(page: Page, uniqueMarkets: string[], panelIds: string[], markets: string[], durationMs: number) {
  await openGateway(page);
  return page.evaluate(async ({ uniqueMarkets, panelIds, markets, config, workerSource, intervalMs }) => {
    const state = (window as any).__multiMarketCensus;
    const { socket, subscriptions } = state.live;
    const emit = (raw: string) => socket.onmessage?.({ data: raw });
    const quantiles = (values: number[]) => {
      const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
      if (!sorted.length) return null;
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
      const round = (value: number) => Math.round(value * 10) / 10;
      return { samples: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1]) };
    };

    const streamStartedAt = performance.now();
    let sampleStartedAt = streamStartedAt;
    let current = { trades: 0, messages: 0, delivered: [] as number[], framed: [] as number[] };
    let awaitingFrame: number[] = [];
    // #345: capture the previous hook BEFORE overwriting it so the finally
    // below restores the real predecessor instead of our own closure.
    const previousOnFrame = state.onFrame;
    state.onFrame = (wallNow: number) => {
      for (const time of awaitingFrame) current.framed.push(wallNow - time);
      awaitingFrame = [];
    };
    const samples: unknown[] = [];
    const takeSample = () => {
      (window as any).gc?.();
      const now = performance.now();
      // Endurance frames are folded here and dropped; load frames stay.
      const frames = state.frames.filter((frame: any) => frame.at > sampleStartedAt && frame.at <= now);
      const longTasks = state.longTasks.filter((task: any) => task.at >= sampleStartedAt && task.at < now);
      state.frames = state.frames.filter((frame: any) => frame.at <= streamStartedAt || frame.at > now);
      state.longTasks = state.longTasks.filter((task: any) => task.at < streamStartedAt || task.at >= now);
      samples.push({
        minute: samples.length + 1,
        at: now,
        heapBytes: (performance as any).memory?.usedJSHeapSize ?? null,
        trades: current.trades,
        messages: current.messages,
        deliveryMs: quantiles(current.delivered),
        frameLatencyMs: quantiles(current.framed),
        frameMs: quantiles(frames.map((frame: any) => frame.interval)),
        longTasks: { count: longTasks.length, maxMs: longTasks.length ? Math.round(Math.max(...longTasks.map((task: any) => task.duration))) : 0 },
      });
      current = { trades: 0, messages: 0, delivered: [], framed: [] };
      sampleStartedAt = now;
    };
    // #345: the sampler, the blob URL and the Worker are acquired inside this
    // single ownership boundary and released on every path (reject, constructor
    // or postMessage failure, or a createObjectURL/setInterval throw).
    let sampler: ReturnType<typeof setInterval> | null = null;
    let workerUrl: string | null = null;
    let done: any = null;
    let unframedMessages = 0;
    try {
      sampler = setInterval(takeSample, config.sampleMs);
      workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
      const worker = new Worker(workerUrl);
      try {
        done = await new Promise<any>((resolve, reject) => {
          worker.onerror = (event) => reject(new Error(`endurance worker failed: ${event.message}`));
          worker.onmessage = (event) => {
            const data = event.data;
            if (data.kind === "done") { resolve(data); return; }
            emit(data.raw);
            if (data.kind !== "trades") return;
            current.trades += data.count;
            current.messages += 1;
            current.delivered.push(Date.now() - data.time);
            awaitingFrame.push(data.time);
          };
          worker.postMessage({
            normalTradesPerSecond: config.normalTradesPerSecond, multiplier: 1,
            baselineMs: config.durationMs, burstMs: 0, recoveryMs: 0,
            tickMs: config.tickMs, maxTradesPerMessage: config.maxTradesPerMessage,
            markets: uniqueMarkets, epoch: 1, firstSequence: 2, intervalMs,
          });
        });
      } finally {
        worker.terminate();
      }
      // The sampler's own tick must cover the last full minute; no sample is fabricated.
      const streamDeadline = streamStartedAt + config.durationMs + 50;
      while (performance.now() < streamDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      if (sampler !== null) clearInterval(sampler);
      unframedMessages = awaitingFrame.length;
      state.onFrame = previousOnFrame;
      if (workerUrl !== null) URL.revokeObjectURL(workerUrl);
    }

    const lastMinute = Math.max(...done.minutes.flat().map((bar: number[]) => bar[0]));
    const firstMinute = Math.min(...done.minutes.flat().map((bar: number[]) => bar[0]));
    const liveBars = panelIds.map((panelId: string) => {
      const runtime = state.registry.getChartRuntime(panelId);
      const snapshot = runtime.getAnalysisSnapshot({
        now: lastMinute + intervalMs, visibleTimeRange: { from: firstMinute, to: lastMinute }, maxLevelsAndDrawings: 0, maxIndicatorSamples: 1,
      });
      return snapshot.candles.map((candle: any) => [
        candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.delta, candle.count,
      ]);
    });
    return {
      generated: Object.fromEntries(uniqueMarkets.map((market: string, index: number) => [market, done.generated[index]])),
      expectedBars: Object.fromEntries(uniqueMarkets.map((market: string, index: number) => [market, done.minutes[index]])),
      liveBars: Object.fromEntries(panelIds.map((panelId: string, index: number) => [panelId, { market: markets[index], bars: liveBars[index] }])),
      subscriptions: subscriptions.map((record: any) => ({ ...record })),
      durationMs: Math.round(done.end - done.start),
      samples: samples as Array<{ minute: number; at: number; heapBytes: number | null; trades: number; messages: number; deliveryMs: { p95: number } | null; frameLatencyMs: { p95: number } | null; longTasks: { count: number } }>,
      unframedMessages,
    };
  }, { uniqueMarkets, panelIds, markets, config: { ...ENDURANCE, durationMs }, workerSource: BURST_WORKER_SOURCE, intervalMs: INTERVAL_MS });
}

// Median heap of the first and last few one-minute samples. The first minute
// is skipped: it still settles the load and the indicators' first refetch.
function heapTrend(samples: Array<{ heapBytes: number | null }>) {
  const heaps = samples.map((sample) => sample.heapBytes).filter((value): value is number => value !== null);
  if (heaps.length < 4) return null;
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const width = Math.min(5, Math.floor((heaps.length - 1) / 2));
  const early = median(heaps.slice(1, 1 + width));
  const late = median(heaps.slice(-width));
  const minutes = heaps.length - 1 - width;
  return {
    windowMinutes: width,
    earlyMedianBytes: early,
    lateMedianBytes: late,
    growthBytes: late - early,
    growthBytesPerMinute: Math.round((late - early) / Math.max(1, minutes)),
  };
}

// Pure minute-sample integrity checks shared by the endurance gate and its
// negative self-test: finite unique monotonic timestamps, finite bounded
// heaps, cadence-derived count, bounded spacing and span (harness checks,
// not a latency SLO).
function validateEnduranceSamples(samples: Array<{ minute: number; at: number; heapBytes: number | null }>,
  durationMs: number, minutes: number, sampleMs: number): string[] {
  const violations: string[] = [];
  if (!Number.isFinite(durationMs) || durationMs < minutes * sampleMs) violations.push(`duration ${durationMs}ms < ${minutes * sampleMs}ms`);
  const expectedCount = Math.max(1, Math.floor(durationMs / sampleMs));
  if (samples.length < expectedCount) violations.push(`sample count ${samples.length} < cadence count ${expectedCount}`);
  samples.forEach((sample, index) => {
    if (sample.minute !== index + 1) violations.push(`minute numbering at index ${index}: ${sample.minute}`);
    if (!Number.isFinite(sample.at) || sample.at < 0) violations.push(`non-finite/negative timestamp at minute ${sample.minute}`);
    if (typeof sample.heapBytes !== "number" || !Number.isFinite(sample.heapBytes) || sample.heapBytes < 0 || sample.heapBytes > HEAP_CEILING_BYTES) violations.push(`invalid heap at minute ${sample.minute}`);
    if (index === 0) return;
    const intervalMs = sample.at - samples[index - 1].at;
    if (!(intervalMs > 0)) violations.push(`non-monotonic/duplicate timestamp before minute ${sample.minute}`);
    else if (intervalMs > sampleMs * 1.5) violations.push(`gap ${Math.round(intervalMs)}ms before minute ${sample.minute} (missing sample)`);
  });
  if (samples.length >= 2 && samples[samples.length - 1].at - samples[0].at < (samples.length - 1) * sampleMs) violations.push(`sample span under ${(samples.length - 1) * sampleMs}ms`);
  return violations;
}

// #308 endurance evidence: one bounded JSON file (endurance-evidence.json),
// the only artifact this suite asks to upload; it is written and attached
// after cleanup and stays honest about partial failures.
async function attachEnduranceEvidence(testInfo: TestInfo, evidence: Record<string, unknown>) {
  const json = JSON.stringify(evidence);
  // The bound is on UTF-8 bytes, not on UTF-16 code units.
  if (Buffer.byteLength(json, "utf8") > 256 * 1024) throw new Error(`endurance evidence exceeds 256 KiB: ${Buffer.byteLength(json, "utf8")} bytes`);
  const { writeFile } = await import("node:fs/promises");
  const path = testInfo.outputPath("endurance-evidence.json");
  await writeFile(path, json, "utf8");
  await testInfo.attach("endurance-evidence", { path, contentType: "application/json" });
}
async function runScenario(scenario: Scenario, page: Page, testInfo?: TestInfo) {
  // Concurrent mounts plus the measured phases take longer than the
  // single-chart census; the phases themselves are bounded below.
  test.setTimeout(scenario.timeoutMs);
  const BAR_COUNT = scenario.bars;
  const ANCHOR_SPLIT_BARS = BAR_COUNT >= HISTORY_MAX_WINDOW_BARS ? 1 : 0;
  const MARKETS = scenario.markets;
  const UNIQUE_MARKETS = [...new Set(MARKETS)];
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const PANEL_IDS = MARKETS.map((_, index) => `multi-market-census-${runId}-${index}`);
  const cellWidth = VIEWPORT.width / scenario.columns;
  const cellHeight = VIEWPORT.height / scenario.rows;
  const cellLeft = (index: number) => (index % scenario.columns) * cellWidth;
  // Empty charts take the pointer at mid-height. Loaded charts take it 40 px
  // below the top: above the drawings (all priced in the lower half of the
  // bars' range) and clear of the indicator panes at the bottom.
  const pointerOffsetY = scenario.indicators || scenario.drawings ? 40 : cellHeight / 2;
  const cellPointerY = (index: number) => Math.floor(index / scenario.columns) * cellHeight + pointerOffsetY;
  const allTrue = MARKETS.map(() => true);

  const universes = new Map<string, MarketUniverse>();
  const requests: ObservedRequest[] = [];
  const gateViolations: string[] = [];
  let seedFallbackRequests = 0;
  let websocketAttempts = 0;
  let liquidationRequests = 0;

  // Live OHLC seed prefers Binance REST first; an empty payload makes it fall
  // back to the intercepted gateway route. No external network.
  await page.route("**/fapi/v1/klines*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  // Any exchange/gateway socket is closed locally; the Vite HMR socket is left alone.
  await page.routeWebSocket((url) => url.hostname !== "127.0.0.1", (ws) => {
    websocketAttempts += 1;
    ws.close();
  });

  // Any other gateway API call is unexpected: recorded and refused.
  const unexpectedApiRequests: string[] = [];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (unexpectedApiRequests.length < 16) unexpectedApiRequests.push(url.pathname);
    return route.abort();
  });
  await page.route("**/api/metrics/liquidations*", (route) => {
    liquidationRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(liquidationFixture(new URL(route.request().url()))) });
  });

  await page.route(/\/history(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const market = url.searchParams.get("markets") ?? "";
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    const format = url.searchParams.has("stream") ? "stream" : "";
    const interval = Number(url.searchParams.get("interval"));
    const priceStep = Number(url.searchParams.get("priceStep"));

    const violation = !MARKETS.includes(market)
      ? `unexpected market ${market}`
      : !Number.isInteger(from) || !Number.isInteger(to) || from > to
        ? `${market}: bounds are not ordered integers`
        : interval !== INTERVAL_MS
          ? `${market}: interval ${interval}`
          : url.searchParams.has("priceStep") && priceStep !== 1
            ? `${market}: priceStep ${priceStep}`
            : null;
    if (violation) {
      gateViolations.push(violation);
      return route.abort();
    }

    // Each market's universe comes from ITS OWN first request wide enough for
    // targetBars; earlier narrow seed-fallback windows get an empty,
    // coverage-free answer.
    let universe = universes.get(market);
    if (!universe && to - from >= (BAR_COUNT - 1 - ANCHOR_SPLIT_BARS) * INTERVAL_MS) {
      const newestClosed = bucketStartOf(to) - INTERVAL_MS;
      universe = {
        anchorFrom: from,
        anchorTo: to,
        times: Array.from({ length: BAR_COUNT }, (_, i) => newestClosed - (BAR_COUNT - 1 - i) * INTERVAL_MS),
      };
      universes.set(market, universe);
    }
    if (!universe) {
      seedFallbackRequests += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { bars: [] }, meta: { schemaVersion: 1, generatedAt: FIXTURE_GENERATED_AT } }),
      });
    }
    const served = universe.times.filter((t) => t >= from && t <= to);
    const streamed = format === "stream";
    const body = JSON.stringify({ ok: true, data: { bars: served.map((t) => fixtureBar(t, streamed)) }, meta: envelopeMeta(market, from, to, streamed) });
    requests.push({ market, pastUniverse: to > universe.anchorTo, format, from, to, served: served.length, bytes: Buffer.byteLength(body) });
    return route.fulfill({ status: 200, contentType: "application/json", body });
  });

  // #308 endurance provenance: the sources Vite actually served (URL, HTTP
  // status, body SHA256), never a Git blob hash.
  const servedSources: Array<Promise<unknown>> = [];
  page.on("response", (response) => {
    if (!testInfo || !new URL(response.url()).pathname.startsWith("/src/")) return;
    servedSources.push((async () => {
      try {
        const { createHash } = await import("node:crypto");
        return { url: response.url(), status: response.status(),
          bodySha256: createHash("sha256").update(await response.body()).digest("hex") };
      } catch (error) { return { url: response.url(), error: String(error) }; }
    })());
  });
  let primaryError: unknown = null;
  let hasPrimary = false;
  let summary: Record<string, unknown> | null = null;
  // #308: declared outside the try so the post-cleanup evidence block can read it (scope fix).
  let endurance: Awaited<ReturnType<typeof runEndurance>> | null = null;
  let teardown: {
    disposeErrors: string[];
    registryRestored: boolean;
    rootsRemoved: boolean;
    pageErrors: string[];
    fetchHistoryCalls: number;
  } | null = null;

  try {
    // A same-origin document that does not run the app: "/@vite/client" is
    // answered with the full app shell for a navigation, whose dockview
    // watermark covers the charts and would take every pointer event.
    await page.goto("/harness/blank.html");
    await page.evaluate(() => {
      document.body.replaceChildren();
      document.body.style.margin = "0";
      return document.querySelector(".dv-root") === null;
    }).then((appAbsent) => expect(appAbsent).toBe(true));

    // Frame probe and owned state live on one window key; teardown reads it back.
    await page.evaluate(async ({ markets, panelIds, columns, cellWidth, cellHeight, bars, indicatorCount, drawingCount, burst }) => {
      const state = {
        pageErrors: [] as string[],
        fetchHistoryCalls: 0,
        frames: [] as Array<{ at: number; interval: number }>,
        longTasks: [] as Array<{ at: number; duration: number }>,
        lastFrame: null as number | null,
        sampling: true,
        observer: null as PerformanceObserver | null,
        listener: null as ((event: PromiseRejectionEvent) => void) | null,
        meta: null as HTMLMetaElement | null,
        registry: null as any,
        baseline: null as Map<string, unknown> | null,
        roots: [] as HTMLDivElement[],
        handles: [] as Array<{ dispose(): void }>,
        mountStartedAt: 0,
        live: null as any,
        panelStates: [] as any[],
        onFrame: null as ((wallNow: number) => void) | null,
        peakHeapBytes: 0,
        readHeap: null as (() => { instantBytes: number | null; retainedBytes: number | null }) | null,
      };
      (window as any).__multiMarketCensus = state;

      state.listener = (event: PromiseRejectionEvent) => {
        if (state.pageErrors.length < 32) state.pageErrors.push(String(event.reason));
      };
      window.addEventListener("unhandledrejection", state.listener);

      // Instantaneous heap (before GC) now, then retained heap after a forced GC.
      state.readHeap = () => {
        const instantBytes = (performance as any).memory?.usedJSHeapSize ?? null;
        (window as any).gc();
        return { instantBytes, retainedBytes: (performance as any).memory?.usedJSHeapSize ?? null };
      };
      const sample = (now: number) => {
        if (!state.sampling) return;
        state.peakHeapBytes = Math.max(state.peakHeapBytes, (performance as any).memory?.usedJSHeapSize ?? 0);
        state.onFrame?.(performance.timeOrigin + now);
        if (state.lastFrame !== null) state.frames.push({ at: now, interval: now - state.lastFrame });
        state.lastFrame = now;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      try {
        state.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state.longTasks.push({ at: entry.startTime, duration: entry.duration });
        });
        state.observer.observe({ type: "longtask", buffered: false });
      } catch { /* frame intervals stay authoritative without longtask support */ }

      const meta = document.createElement("meta");
      meta.setAttribute("name", "footprint-config");
      meta.setAttribute("content", `targetBars=${bars}`);
      state.meta = meta;
      document.head.appendChild(meta);

      const registry = await import("/harness/chart.ts");
      state.registry = registry;
      for (const panelId of panelIds) {
        if (registry.getChartRuntime(panelId) !== undefined) throw new Error(`panel id already owned: ${panelId}`);
      }
      state.baseline = new Map(registry.listChartRuntimeEntries().map((entry: readonly [string, unknown]) => [entry[0], entry[1]]));

      const { mountChart } = await import("/harness/chart.ts");
      const { createChartSurfaceModel } = await import("/harness/chart.ts");
      const { DrawingManager } = await import("/src/features/drawings/drawingManager.ts");
      const { DEFAULT_VOLUME_PROFILE_SETTINGS } = await import("/src/core/analysis/volumeProfile.ts");
      const { normalizePreviousWeekStrategySettings } = await import("/src/core/analysis/previousWeekStrategy.ts");
      const { normalizeMondayRangeSettings } = await import("/src/core/analysis/mondayRange.ts");
      const { createIndicatorInstanceAsync } = await import("/src/features/indicators/registry.ts");
      const { getDrawingTool } = await import("/src/features/drawings/toolRegistry.ts");

      // "Karma" mix: CVD, Liquidations and RSI in 60 px panes, then light
      // price-pane indicators in a fixed cycle with varied periods.
      const overlayCycle = ["moving-average", "bollinger-bands", "supertrend", "vwap", "ichimoku", "volume-profile"];
      const indicatorsFor = async (count: number) => {
        const types = count === 0 ? [] : ["cvd", "liquidations", "rsi"];
        for (let index = 0; types.length < count; index++) types.push(overlayCycle[index % overlayCycle.length]);
        const instances = [];
        for (const [order, type] of types.entries()) {
          const instance = await createIndicatorInstanceAsync(type, order);
          const round = Math.floor(Math.max(0, order - 3) / overlayCycle.length);
          if (instance.placement === "separate-pane") instance.paneHeight = 60;
          if (type === "moving-average") {
            instance.settings.lines = (instance.settings.lines as Array<Record<string, unknown>>)
              .map((line) => ({ ...line, period: Number(line.period) + round, method: round % 2 ? "ema" : "sma" }));
          }
          if (type === "bollinger-bands" || type === "supertrend") instance.settings.period = Number(instance.settings.period) + round;
          instances.push(instance);
        }
        return instances;
      };

      // Drawings spread over the newest 150 minutes and priced 99..100.5, the
      // lower half of the bars' 99..103 range, cycling ten common tools that
      // stay inside their anchors' prices. The upper half is left free for the
      // pointer, so a drag pans the chart instead of moving a drawing.
      const drawingCycle: Array<[string, number]> = [
        ["trend", 2], ["horizontal", 1], ["rectangle", 2], ["fibonacci-retracement", 2], ["parallel-channel", 3],
        ["text", 1], ["ellipse", 2], ["arrow-line", 2], ["price-range", 2], ["date-range", 2],
      ];
      const newestClosed = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
      const drawingsFor = (market: string, count: number) => Array.from({ length: count }, (_, index) => {
        const [type, anchors] = drawingCycle[index % drawingCycle.length];
        const tool = getDrawingTool(type as never);
        const start = newestClosed - (10 + (index * 7) % 140) * 60_000;
        const points = Array.from({ length: anchors }, (_, anchor) => ({
          time: start + anchor * 5 * 60_000,
          price: 99 + ((index + anchor) % 4) * 0.5,
        }));
        return {
          id: `census-drawing-${index}`, type, points, market,
          color: tool.color, lineWidth: tool.lineWidth, lineStyle: tool.lineStyle,
          fillOpacity: tool.fillOpacity, showLabel: tool.showLabel, showPriceLabel: tool.showPriceLabel,
          showTimeLabel: tool.showTimeLabel, extendLeft: tool.extendLeft, extendRight: tool.extendRight,
          text: type === "text" ? `census ${index}` : undefined,
          locked: false, visible: true,
        };
      });

      // Burst profile: one harness TradeFeed reading gateway-shaped "trades"
      // frames from the Worker (see BURST).
      let subscribeToTrades = (_market: string, _cb: (trade: unknown) => void) => () => {};
      if (burst) {
        const { TradeFeed } = await import("/harness/tradeFeed.ts");
        const service = new TradeFeed();
        // Every subscription checks exactly-once, in-order delivery itself.
        const subscriptions: Array<{ market: string; received: number; violations: string[] }> = [];
        state.live = { service, subscriptions };
        subscribeToTrades = (market, cb) => {
          const record = { market, received: 0, violations: [] as string[] };
          subscriptions.push(record);
          return service.subscribe(market, (trade: any) => {
            record.received += 1;
            if (trade.id !== String(record.received) && record.violations.length < 8) {
              record.violations.push(`expected trade ${record.received}, got ${trade.id}`);
            }
            cb(trade);
          });
        };
      }

      const servicesFor = (market: string) => {
        const drawings = new DrawingManager(() => {});
        drawings.replace(drawingsFor(market, drawingCount) as never);
        drawings.setMarket(market);
        const analysisContext = {
          market,
          profileSettings: DEFAULT_VOLUME_PROFILE_SETTINGS,
          previousWeekStrategySettings: normalizePreviousWeekStrategySettings(null),
          previousWeekStrategyLevels: [],
          mondayRangeSettings: normalizeMondayRangeSettings(null),
          mondayRangeLevels: [],
          nakedPocs: [],
          referenceLevels: [],
          drawings,
        };
        return {
          subscribeToTrades: (subscribedMarket: string, cb: (trade: unknown) => void) => subscribeToTrades(subscribedMarket, cb),
          fetchPriceStep: async () => 1,
          fetchPriceStepResult: async () => ({ step: 1, resolved: true }),
          fetchPricePrecision: async () => undefined,
          fetchHistory: async () => { state.fetchHistoryCalls += 1; return []; },
          fetchNpocSnapshot: async () => ({ schemaVersion: 3, market, levels: [], valueAreas: [] }),
          notifyActiveMarket: () => {},
          notifyInteractiveCandlesReady: () => {},
          notifyInteractiveHistorySettled: () => {},
          triggerAutoSync: () => {},
          isFootprintSyncBusy: () => false,
          updateAnalysisFromSeries: () => {},
          getAnalysisRevisionSnapshot: () => ({
            revision: 1,
            market,
            canonical: { status: "complete" as const, market, runKey: null, generation: 1, revision: 1, failedPeriods: [] as string[] },
          }),
          getAutomaticLevelsAsOf: () => null,
          subscribeAnalysis: () => () => {},
          subscribeAnalysisRevision: () => () => {},
          getAnalysisContext: () => analysisContext,
          notifyBarClose: () => {},
          notify: () => {},
        };
      };

      // Indicator definitions (the heavy one is lazily loaded) and instances
      // are prepared before the clock starts, like a saved workspace.
      const indicatorSets: unknown[][] = [];
      for (let index = 0; index < markets.length; index++) indicatorSets.push(await indicatorsFor(indicatorCount));
      const services = markets.map((market) => servicesFor(market));

      // All charts mount in the same task, like a restored grid workspace.
      state.mountStartedAt = performance.now();
      markets.forEach((market, index) => {
        const root = document.createElement("div");
        root.dataset.censusPanel = String(index);
        root.style.cssText = `position:fixed;left:${(index % columns) * cellWidth}px;top:${Math.floor(index / columns) * cellHeight}px;width:${cellWidth}px;height:${cellHeight}px;`;
        state.roots.push(root);
        document.body.appendChild(root);
        const panelState = { type: "chart", market, timeframe: "1m", scaleMode: "linear", indicators: indicatorSets[index] };
        state.panelStates.push(panelState);
        const handle = mountChart(
          root,
          panelState as never,
          services[index] as never,
          panelIds[index],
          createChartSurfaceModel() as never,
        );
        state.handles.push(handle as { dispose(): void });
      });
    }, {
      markets: MARKETS, panelIds: PANEL_IDS, columns: scenario.columns, cellWidth, cellHeight,
      bars: BAR_COUNT, indicatorCount: scenario.indicators, drawingCount: scenario.drawings,
      burst: scenario.burst === true || scenario.endurance === true,
    });

    // Wait for every market's own anchor request.
    await expect.poll(() => universes.size, { timeout: 20_000 }).toBe(UNIQUE_MARKETS.length);
    const expected = MARKETS.map((market) => {
      const universe = universes.get(market)!;
      expect(universe.anchorFrom).toBe(universe.times[ANCHOR_SPLIT_BARS]);
      expect(universe.anchorTo).toBeGreaterThanOrEqual(universe.times[BAR_COUNT - 1] + INTERVAL_MS);
      return { market, times: universe.times, now: universe.times[BAR_COUNT - 1] + INTERVAL_MS };
    });

    // Load phase ends when each chart's first and last 24-bar chunks carry all cells.
    const load = await page.evaluate(async ({ panelIds, expected, chunkBars, cellWidth, cellHeight, indicatorCount, readyTimeoutMs }) => {
      const state = (window as any).__multiMarketCensus;
      const readyAt: Array<number | null> = panelIds.map(() => null);
      // Indicators are judged on the newest chunk only: the oldest bars sit
      // inside long lookbacks (MA 200, Bollinger), where "no-data" is right.
      const chunkReady = (runtime: any, from: number, to: number, now: number, indicators: boolean) => {
        const snapshot = runtime.getAnalysisSnapshot({ now, visibleTimeRange: { from, to }, maxLevelsAndDrawings: 0, maxIndicatorSamples: 1 });
        return snapshot.candles.length === chunkBars && snapshot.candles.every((candle: any) => (candle.footprint?.length ?? 0) === 4)
          && (!indicators || (snapshot.indicators.length === indicatorCount
            && snapshot.indicators.every((indicator: any) => indicator.status === "ok")));
      };
      const deadline = performance.now() + readyTimeoutMs;
      while (readyAt.some((value) => value === null)) {
        if (performance.now() > deadline) {
          // Say what each unready chart is missing.
          const detail = panelIds.map((panelId: string, index: number) => {
            if (readyAt[index] !== null) return "ready";
            const runtime = state.registry.getChartRuntime(panelId);
            if (!runtime) return "no runtime";
            const { times, now } = expected[index];
            return [[times[0], times[chunkBars - 1]], [times[times.length - chunkBars], times[times.length - 1]]].map(([from, to]) => {
              const snapshot = runtime.getAnalysisSnapshot({ now, visibleTimeRange: { from, to }, maxLevelsAndDrawings: 0, maxIndicatorSamples: 1 });
              const notOk = snapshot.indicators.filter((indicator: any) => indicator.status !== "ok").map((indicator: any) => `${indicator.type}:${indicator.status}`);
              return `candles ${snapshot.candles.length}, cells ${snapshot.candles.filter((candle: any) => (candle.footprint?.length ?? 0) === 4).length}, indicators ${snapshot.indicators.length} not ok [${[...new Set(notOk)].join(",")}]`;
            }).join(" | ");
          });
          throw new Error(`multi-market readiness timeout: ${JSON.stringify(detail)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        panelIds.forEach((panelId: string, index: number) => {
          if (readyAt[index] !== null) return;
          const runtime = state.registry.getChartRuntime(panelId);
          const { times, now } = expected[index];
          if (runtime
            && chunkReady(runtime, times[0], times[chunkBars - 1], now, false)
            && chunkReady(runtime, times[times.length - chunkBars], times[times.length - 1], now, true)) {
            readyAt[index] = performance.now();
          }
        });
      }
      const runtimes = panelIds.map((panelId: string) => state.registry.getChartRuntime(panelId));
      return {
        startedAt: state.mountStartedAt,
        endedAt: Math.max(...(readyAt as number[])),
        mountToReadyMs: (readyAt as number[]).map((at) => Math.round(at - state.mountStartedAt)),
        distinctRuntimes: new Set(runtimes).size,
        visible: state.roots.map((root: HTMLElement) => {
          const rect = root.getBoundingClientRect();
          return rect.width === cellWidth && rect.height === cellHeight && root.isConnected && root.querySelector("canvas") !== null;
        }),
        heap: state.readHeap(),
      };
    }, {
      panelIds: PANEL_IDS, expected, chunkBars: CHUNK_BARS, cellWidth, cellHeight,
      indicatorCount: scenario.indicators, readyTimeoutMs: scenario.readyTimeoutMs ?? 90_000,
    });
    expect(load.distinctRuntimes).toBe(MARKETS.length);
    expect(load.visible).toEqual(allTrue);

    let idleStartedAt = 0, idleEndedAt = 0, crosshairStartedAt = 0, crosshairEndedAt = 0, panStartedAt = 0, panEndedAt = 0;
    const panMoved: boolean[] = [];
    let live: Awaited<ReturnType<typeof runBurst>> | null = null;
    if (scenario.burst) {
      live = await runBurst(page, UNIQUE_MARKETS, PANEL_IDS, MARKETS);
    } else if (scenario.endurance) {
      endurance = await runEndurance(page, UNIQUE_MARKETS, PANEL_IDS, MARKETS, ENDURANCE_MINUTES * 60_000);
    } else {
      // Idle phase: all charts loaded, no input, 2 s.
      idleStartedAt = await page.evaluate(() => performance.now());
      await page.waitForTimeout(2_000);
      idleEndedAt = await page.evaluate(() => performance.now());

      // Crosshair phase: a horizontal pointer sweep across each chart in turn.
      crosshairStartedAt = await page.evaluate(() => performance.now());
      for (let index = 0; index < MARKETS.length; index++) {
        const left = cellLeft(index);
        const y = cellPointerY(index);
        await page.mouse.move(left + 16, y);
        await page.mouse.move(left + cellWidth - 40, y, { steps: 60 });
      }
      await page.waitForTimeout(250);
      crosshairEndedAt = await page.evaluate(() => performance.now());

      // Pan phase: drag each chart to the right and back, so every chart
      // re-renders a moving bar window rather than just the crosshair layer.
      // The #308 workload profiles pan with a horizontal wheel (trackpad
      // swipe) instead: with hundreds of drawings on screen a press lands on
      // a drawing and would move it rather than the chart.
      const panByWheel = !scenario.frameGate;
      const visibleRange = (panelId: string) => page.evaluate((id) => (
        (window as any).__multiMarketCensus.registry.getChartRuntime(id)?.getVisibleTimeRange() ?? null
      ), panelId);
      panStartedAt = await page.evaluate(() => performance.now());
      for (let index = 0; index < MARKETS.length; index++) {
        const left = cellLeft(index);
        const y = cellPointerY(index);
        const before = await visibleRange(PANEL_IDS[index]);
        await page.mouse.move(left + cellWidth * 0.15, y);
        let dragged;
        if (panByWheel) {
          for (let step = 0; step < 40; step++) await page.mouse.wheel(-12, 0);
          dragged = await visibleRange(PANEL_IDS[index]);
          for (let step = 0; step < 40; step++) await page.mouse.wheel(12, 0);
        } else {
          await page.mouse.down();
          await page.mouse.move(left + cellWidth * 0.8, y, { steps: 40 });
          dragged = await visibleRange(PANEL_IDS[index]);
          await page.mouse.move(left + cellWidth * 0.15, y, { steps: 40 });
          await page.mouse.up();
        }
        panMoved.push(before !== null && dragged !== null && dragged.from < before.from);
      }
      await page.waitForTimeout(250);
      panEndedAt = await page.evaluate(() => performance.now());
    }

    const probe = await page.evaluate(() => {
      const state = (window as any).__multiMarketCensus;
      state.sampling = false;
      state.observer?.disconnect();
      return {
        frames: state.frames as Array<{ at: number; interval: number }>,
        longTasks: state.longTasks as Array<{ at: number; duration: number }>,
        heap: state.readHeap(),
        peakHeapBytes: state.peakHeapBytes as number,
        gcExposed: typeof (window as any).gc === "function",
      };
    });
    const phase = (from: number, to: number) => frameSummary(
      probe.frames.filter((frame) => frame.at > from && frame.at <= to).map((frame) => frame.interval),
      probe.longTasks.filter((task) => task.at >= from && task.at < to).map((task) => task.duration),
    );
    const phases: Record<string, ReturnType<typeof frameSummary>> = endurance
      ? { load: phase(load.startedAt, load.endedAt) }
      : live
      ? {
        load: phase(load.startedAt, load.endedAt),
        baseline: phase(live.phasesAt.baseline, live.phasesAt.burst),
        burst: phase(live.phasesAt.burst, live.phasesAt.recovery),
        recovery: phase(live.phasesAt.recovery, live.phasesAt.end),
      }
      : {
        load: phase(load.startedAt, load.endedAt),
        idle: phase(idleStartedAt, idleEndedAt),
        crosshair: phase(crosshairStartedAt, crosshairEndedAt),
        pan: phase(panStartedAt, panEndedAt),
      };
    if (!live && !endurance) {
      expect(phases.idle.frameMs?.samples ?? 0).toBeGreaterThan(30);
      expect(phases.crosshair.frameMs?.samples ?? 0).toBeGreaterThan(30);
      expect(phases.pan.frameMs?.samples ?? 0).toBeGreaterThan(30);
      if (scenario.frameGate) {
        for (const name of ["idle", "crosshair", "pan"] as const) {
          expect(phases[name].frameMs!.p95, `${name} frame p95 with ${MARKETS.length} charts (#308 budget 33.3 ms)`)
            .toBeLessThanOrEqual(MULTI_CHART_INTERACTION_FRAME_P95_MS + RAF_TIMESTAMP_TOLERANCE_MS);
        }
      }
      // The drag really scrolled each chart back in time.
      expect(panMoved).toEqual(allTrue);
    }

    const objects = await page.evaluate(async ({ panelIds, expected, chunkBars }) => {
      const state = (window as any).__multiMarketCensus;
      // One wide read per chart lists every drawing and every indicator's
      // status. The Liquidations request key moves with the clock every 30 s,
      // so a refetch can briefly read "loading"; such a read is repeated.
      const objects = [];
      for (const [index, panelId] of panelIds.entries()) {
        const runtime = state.registry.getChartRuntime(panelId);
        const { times, now } = expected[index];
        let result = null;
        let attempts = 0;
        const deadline = performance.now() + 10_000;
        do {
          if (attempts++ > 0) await new Promise((resolve) => setTimeout(resolve, 100));
          const snapshot = runtime.getAnalysisSnapshot({
            now, visibleTimeRange: { from: times[times.length - chunkBars], to: times[times.length - 1] },
            maxLevelsAndDrawings: 10_000, maxBytes: 64 * 1024 * 1024, maxIndicatorSamples: 1,
          });
          const drawingStatuses: Record<string, number> = {};
          for (const drawing of snapshot.drawings) drawingStatuses[drawing.status] = (drawingStatuses[drawing.status] ?? 0) + 1;
          result = {
            drawingStatuses,
            drawingCount: snapshot.drawings.length,
            indicatorStatuses: snapshot.indicators.map((indicator: any) => `${indicator.type}:${indicator.status}`),
          };
        } while (result.indicatorStatuses.some((status: string) => status.endsWith(":loading")) && performance.now() < deadline);
        objects.push({ ...result, attempts });
      }
      // The census below reads candles only. Each read would otherwise
      // recompute every indicator over the whole series, so the indicators,
      // already checked above, are hidden first.
      state.handles.forEach((handle: any, index: number) => {
        const panelState = state.panelStates[index];
        if (panelState.indicators.length) {
          handle.updateState({ ...panelState, indicators: panelState.indicators.map((indicator: any) => ({ ...indicator, visible: false })) });
        }
      });
      return objects;
    }, { panelIds: PANEL_IDS, expected, chunkBars: CHUNK_BARS });

    // Census: 84 public reads of <= 24 bars per chart.
    const census = await page.evaluate(async ({ panelIds, expected, chunkBars }) => {
      const state = (window as any).__multiMarketCensus;
      const readMs: number[] = [];
      const perChart = panelIds.map((panelId: string, index: number) => {
        const runtime = state.registry.getChartRuntime(panelId);
        if (!runtime) throw new Error(`runtime missing at census: ${panelId}`);
        const { times, now } = expected[index];
        const bars: Array<[number, number, number, number, number, number, number, number, number, number[][]]> = [];
        const warnings: string[] = [];
        let meta = { market: "", timeframe: "", intervalMs: 0, lastClosedBarEnd: 0, indicators: 0, levels: 0 };
        let reads = 0;
        for (let offset = 0; offset < times.length; offset += chunkBars) {
          const to = times[Math.min(offset + chunkBars - 1, times.length - 1)];
          const startedAt = performance.now();
          // Drawings and indicator samples are checked once below, not per chunk.
          const snapshot = runtime.getAnalysisSnapshot({
            now, visibleTimeRange: { from: times[offset], to }, maxLevelsAndDrawings: 0, maxIndicatorSamples: 1,
          });
          readMs.push(performance.now() - startedAt);
          reads += 1;
          meta = {
            market: snapshot.market,
            timeframe: snapshot.timeframe,
            intervalMs: snapshot.intervalMs,
            lastClosedBarEnd: snapshot.lastClosedBarEnd,
            indicators: Math.max(meta.indicators, snapshot.indicators.length),
            levels: meta.levels + snapshot.levels.length,
          };
          // maxLevelsAndDrawings: 0 announces its own reduction.
          warnings.push(...snapshot.warnings.filter((warning: string) => !warning.startsWith("Level/drawing scope was reduced")));
          for (const candle of snapshot.candles) {
            bars.push([
              candle.time, candle.endTime, candle.open, candle.high, candle.low, candle.close,
              candle.volume, candle.delta, candle.count,
              (candle.footprint ?? []).map((cell: any) => [
                cell.price, cell.buyVolume, cell.sellVolume, cell.totalVolume, cell.delta,
                cell.tradeCount, cell.buyTradeCount, cell.sellTradeCount,
              ]),
            ]);
          }
        }
        return { bars, warnings, meta, reads };
      });
      return { perChart, readMs };
    }, { panelIds: PANEL_IDS, expected, chunkBars: CHUNK_BARS });

    // Independent oracle per chart: expected values come from the fixture
    // declaration and each market's own anchor request, never from the Runtime.
    const totals = { bars: 0, cells: 0, volume: 0, delta: 0, count: 0 };
    census.perChart.forEach((chart, index) => {
      const { market, times, now } = expected[index];
      expect(chart.reads, market).toBe(Math.ceil(BAR_COUNT / CHUNK_BARS));
      expect(chart.meta).toEqual({
        // Indicators are hidden for the census (checked above).
        market, timeframe: "1m", intervalMs: INTERVAL_MS, lastClosedBarEnd: now, indicators: 0, levels: 0,
      });
      const chartObjects = objects[index];
      expect(chartObjects.drawingCount, `${market} drawings`).toBe(scenario.drawings);
      expect(chartObjects.drawingStatuses, `${market} drawing statuses`).toEqual(scenario.drawings ? { ok: scenario.drawings } : {});
      expect(chartObjects.indicatorStatuses.filter((status: string) => !status.endsWith(":ok")), `${market} indicators not ok`).toEqual([]);
      expect(chartObjects.indicatorStatuses.length).toBe(scenario.indicators);
      for (const warning of chart.warnings) {
        expect(warning, `${market} snapshot warning`).not.toMatch(
          /exceeded|Detailed footprint cells are limited|Candle context is limited|No closed candles intersect/i,
        );
      }
      expect(chart.bars.map((bar) => bar[0]), `${market} bar times`).toEqual(times);
      // Compared in plain JS and asserted once per chart: one expect per bar
      // costs Playwright a recorded step, which stalls 10k-bar charts.
      const expectedBar = JSON.stringify([INTERVAL_MS, 100, 103, 99, 102, 4, 2, 4]);
      const expectedCells = JSON.stringify([
        [99, 0, 1, 1, -1, 1, 0, 1],
        [100, 1, 0, 1, 1, 1, 1, 0],
        [102, 1, 0, 1, 1, 1, 1, 0],
        [103, 1, 0, 1, 1, 1, 1, 0],
      ]);
      const mismatches: string[] = [];
      for (const [time, endTime, open, high, low, close, volume, delta, count, cells] of chart.bars) {
        const bar = JSON.stringify([endTime - time, open, high, low, close, volume, delta, count]);
        const barCells = JSON.stringify(cells);
        if ((bar !== expectedBar || barCells !== expectedCells) && mismatches.length < 5) mismatches.push(`bar ${time}: ${bar} ${barCells}`);
        totals.bars += 1;
        totals.cells += cells.length;
        totals.volume += volume;
        totals.delta += delta;
        totals.count += count;
      }
      expect(mismatches, `${market} bars that differ from the fixture`).toEqual([]);
    });
    const charts = MARKETS.length;
    const allBars = charts * BAR_COUNT;
    expect(totals).toEqual({ bars: allBars, cells: allBars * 4, volume: allBars * 4, delta: allBars * 2, count: allBars * 4 });
    expect(census.readMs.length).toBe(charts * Math.ceil(BAR_COUNT / CHUNK_BARS));

    const stream = live ?? endurance;
    if (stream) {
      const subscriptions: Array<{ market: string; received: number; violations: string[] }> = stream.subscriptions;
      // Exactly once and in order, to every chart on the market.
      for (const market of UNIQUE_MARKETS) {
        const charts = MARKETS.filter((candidate) => candidate === market).length;
        const active = subscriptions.filter((record) => record.market === market && record.received > 0);
        expect(stream.generated[market], `${market} generated trades`).toBeGreaterThan(0);
        expect(active.map((record) => [record.received, record.violations]), `${market} deliveries`)
          .toEqual(Array.from({ length: charts }, () => [stream.generated[market], []]));
      }
      // Each chart's closed live bars equal the bars recomputed from the trades.
      for (const [panelId, chart] of Object.entries(stream.liveBars)) {
        expect(chart.bars, `${chart.market} live bars on ${panelId}`).toEqual(stream.expectedBars[chart.market]);
      }
      expect(stream.unframedMessages).toBe(0);
    }
    expect(probe.gcExposed, "GC hook for retained-heap readings").toBe(true);
    // #308 "Kapı": retained heap over 1 GB turns CI red.
    for (const [name, reading] of [["after load", load.heap], ["after interaction", probe.heap]] as const) {
      expect(reading.retainedBytes, `retained heap ${name}`).not.toBeNull();
      expect(reading.retainedBytes!, `retained heap ${name} (#308 ceiling 1 GB)`).toBeLessThanOrEqual(HEAP_CEILING_BYTES);
    }
    if (endurance) {
      // #308: a post-GC heap the browser did not report is unknown, never
      // healthy; every sample must be a finite byte count under the ceiling.
      const badHeap = endurance.samples.filter((sample) => {
        const heap = sample.heapBytes;
        return typeof heap !== "number" || !Number.isFinite(heap) || heap < 0 || heap > HEAP_CEILING_BYTES;
      }).map((sample) => sample.minute);
      expect(badHeap, "endurance minutes with missing or invalid heap").toEqual([]);
      // The Worker itself must have streamed the full N minutes; the (N-1)
      // span is legitimate only for the N one-minute samples (checked by the
      // shared validator together with count, uniqueness, spacing and heaps).
      expect(endurance.durationMs, "endurance actual duration").toBeGreaterThanOrEqual(ENDURANCE_MINUTES * 60_000);
      expect(validateEnduranceSamples(endurance.samples, endurance.durationMs, ENDURANCE_MINUTES, ENDURANCE.sampleMs), "endurance minute-sample integrity").toEqual([]);
    }

    // Transport: every market used both the one-shot JSON phase and the streamed
    // stream, and nothing reached the fetchHistory fallback.
    for (const market of UNIQUE_MARKETS) {
      expect(requests.some((r) => r.market === market && r.format === ""), `${market} JSON request`).toBe(true);
      expect(requests.some((r) => r.market === market && r.format === "stream"), `${market} streamed request`).toBe(true);
    }
    expect(gateViolations).toEqual([]);
    expect(unexpectedApiRequests).toEqual([]);
    expect(await page.evaluate(() => (window as any).__multiMarketCensus.fetchHistoryCalls)).toBe(0);

    summary = {
      test: "chart-multi-market-census",
      profile: scenario.id,
      issue: scenario.issue,
      reference: scenario.frameGate
        ? "CI machine regression alarm, not a device guarantee; #308 interaction frame p95 budget 33.3 ms, load reported only"
        : "CI machine reference, report-only: no threshold decided for loaded #308 profiles",
      workload: { barsPerChart: BAR_COUNT, indicatorsPerChart: scenario.indicators, drawingsPerChart: scenario.drawings },
      layout: {
        charts: MARKETS.length,
        grid: `${scenario.columns}x${scenario.rows}`,
        viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
        chartPx: `${cellWidth}x${cellHeight}`,
        markets: MARKETS,
        // A repeated market's charts share one fixture universe.
        repeatedMarkets: UNIQUE_MARKETS.filter((market) => MARKETS.indexOf(market) !== MARKETS.lastIndexOf(market)),
      },
      totals,
      mountToReadyMs: load.mountToReadyMs,
      allReadyMs: Math.round(load.endedAt - load.startedAt),
      phases,
      censusReadMs: quantiles(census.readMs),
      jsHeapBytes: {
        reference: "#308 CI gate: retained heap after a forced GC <= 1 GB per tab; instantaneous and peak are information only",
        ceilingBytes: HEAP_CEILING_BYTES,
        afterLoad: load.heap,
        afterInteraction: probe.heap,
        peakInstantBytes: probe.peakHeapBytes,
        retainedWithinCeiling: Math.max(load.heap.retainedBytes ?? 0, probe.heap.retainedBytes ?? 0) <= HEAP_CEILING_BYTES,
      },
      transport: {
        jsonRequests: requests.filter((r) => r.format === "").length,
        streamRequests: requests.filter((r) => r.format === "stream").length,
        responseBytes: requests.reduce((total, r) => total + r.bytes, 0),
        seedFallbackRequests,
        websocketAttempts,
        liquidationRequests,
        pastUniverseRequests: requests.filter((r) => r.pastUniverse).length,
      },
      ...(live ? {
        burst: {
          reference: "report-only: 1 s freshness is a soft target; recovery verdict is the #308 5 s criterion, not a CI gate",
          normalTradesPerSecondPerMarket: BURST.normalTradesPerSecond,
          burstTradesPerSecondPerMarket: BURST.normalTradesPerSecond * BURST.multiplier,
          phasesMs: { baseline: BURST.baselineMs, burst: BURST.burstMs, recovery: BURST.recoveryMs },
          generatedTrades: live.generated,
          messages: live.messages,
          latency: live.latency,
          recoveredAfterMs: live.recoveredAfterMs,
          recoveredWithinTarget: live.recoveredAfterMs <= BURST.recoveryTargetMs,
          worstFrameLatencyPerSecondMs: live.worstFrameLatencyPerSecondMs,
        },
      } : {}),
      ...(endurance ? {
        endurance: {
          reference: "drift report-only (no threshold decided); heap sampled after a forced GC once a minute, each sample gated at 1 GB",
          minutes: ENDURANCE_MINUTES,
          durationMs: endurance.durationMs,
          normalTradesPerSecondPerMarket: ENDURANCE.normalTradesPerSecond,
          generatedTrades: endurance.generated,
          heapTrend: heapTrend(endurance.samples),
          // The 60 min run also reports where it stood at 30 min.
          heapTrendAt30Min: endurance.samples.length >= 60 ? heapTrend(endurance.samples.slice(0, 30)) : null,
          perMinute: endurance.samples,
        },
      } : {}),
    };
  } catch (error) {
    hasPrimary = true;
    primaryError = error;
  } finally {
    try {
      teardown = await page.evaluate(async (panelIds) => {
        const state = (window as any).__multiMarketCensus;
        if (!state) return { disposeErrors: [], registryRestored: true, rootsRemoved: true, pageErrors: [], fetchHistoryCalls: 0 };
        state.sampling = false;
        state.observer?.disconnect();
        const disposeErrors: string[] = [];
        for (const handle of state.handles) {
          try { handle.dispose(); } catch (error) { disposeErrors.push(String(error)); }
        }
        let registryRestored = !state.registry;
        if (state.registry && state.baseline) {
          const deadline = performance.now() + 5_000;
          while (!registryRestored && performance.now() < deadline) {
            const current = new Map(state.registry.listChartRuntimeEntries().map((entry: readonly [string, unknown]) => [entry[0], entry[1]]));
            registryRestored = current.size === state.baseline.size
              && [...state.baseline.entries()].every(([id, runtime]: [string, unknown]) => current.get(id) === runtime)
              && panelIds.every((panelId: string) => !current.has(panelId));
            if (!registryRestored) await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        for (const root of state.roots) root.remove();
        state.meta?.remove();
        if (state.listener) window.removeEventListener("unhandledrejection", state.listener);
        const result = {
          disposeErrors,
          registryRestored,
          rootsRemoved: state.roots.every((root: HTMLElement) => !root.isConnected),
          pageErrors: state.pageErrors,
          fetchHistoryCalls: state.fetchHistoryCalls,
        };
        delete (window as any).__multiMarketCensus;
        return result;
      }, PANEL_IDS);
    } catch (error) {
      if (!hasPrimary) {
        hasPrimary = true;
        primaryError = new Error(`multi-market teardown failed: ${String(error)}`);
      }
    }
  }

  // The measurement line prints after cleanup so it is never mistaken for a pass.
  if (summary) console.log(JSON.stringify({ ...summary, teardown }));
  // SUCCESS requires the financial gates AND this cleanup gate, both before evidence.
  let cleanupError: unknown = null, provenanceError: unknown = null, evidenceError: unknown = null;
  if (!hasPrimary) {
    try {
      expect(teardown).toEqual({ disposeErrors: [], registryRestored: true, rootsRemoved: true, pageErrors: [], fetchHistoryCalls: 0 });
    } catch (error) { cleanupError = error; }
  }
  if (testInfo) {
    const { createHash } = await import("node:crypto");
    const { readFile } = await import("node:fs/promises");
    const { relative } = await import("node:path");
    let devicePixelRatio: unknown;
    try { devicePixelRatio = await page.evaluate(() => window.devicePixelRatio); }
    catch (error) { devicePixelRatio = `unavailable: ${String(error)}`; }
    // Bounded (<= 32), deduped served sources; valid provenance is mandatory
    // for PASS and never silently accepted on hash errors.
    const seenUrls = new Set<string>();
    const servedProvenance = (await Promise.all(servedSources)).filter((record: any) => {
      if (!record || seenUrls.has(record.url)) return false;
      seenUrls.add(record.url);
      return true;
    }).slice(0, 32);
    const provenanceValid = servedProvenance.length > 0
      && servedProvenance.every((record: any) => record.status === 200 && /^[0-9a-f]{64}$/.test(record.bodySha256 ?? ""));
    if (!hasPrimary && !cleanupError) {
      try { expect(provenanceValid, "served-source provenance present and hashed").toBe(true); }
      catch (error) { provenanceError = error; }
    }
    const terminal = hasPrimary ? "FAIL" : cleanupError || provenanceError ? "PARTIAL" : "PASS";
    const stages = {
      measurement: summary ? "reached" : "not reached",
      financial: hasPrimary ? "not reached" : "passed",
      cleanup: hasPrimary ? "not reached" : cleanupError ? `failed: ${String(cleanupError)}` : "passed",
      evidence: "written",
    };
    // #308 evidence reports partial failures as such; the only uploaded file.
    try {
      await attachEnduranceEvidence(testInfo, {
        test: "chart-multi-market-census",
        profile: scenario.id,
        issue: scenario.issue,
        terminal,
        stages,
        minutes: ENDURANCE_MINUTES,
        workload: { charts: MARKETS.length, markets: MARKETS, barsPerChart: BAR_COUNT,
          indicatorsPerChart: scenario.indicators, drawingsPerChart: scenario.drawings },
        layout: { viewport: `${VIEWPORT.width}x${VIEWPORT.height}`, grid: `${scenario.columns}x${scenario.rows}` },
        elapsedMs: endurance ? endurance.durationMs : null,
        samples: endurance ? endurance.samples.map((sample) => ({ minute: sample.minute, at: Math.round(sample.at), heapBytes: sample.heapBytes })) : [],
        sampleIntervalsMs: endurance ? endurance.samples.slice(1).map((sample, index) => Math.round(sample.at - endurance.samples[index].at)) : [],
        heapTrend: endurance ? heapTrend(endurance.samples) : null,
        delivery: endurance ? {
          tradesTotal: endurance.samples.reduce((total, sample) => total + sample.trades, 0),
          messagesTotal: endurance.samples.reduce((total, sample) => total + sample.messages, 0),
          unframedMessages: endurance.unframedMessages,
          deliveryP95MaxMs: Math.max(0, ...endurance.samples.map((sample) => sample.deliveryMs?.p95 ?? 0)),
          frameLatencyP95MaxMs: Math.max(0, ...endurance.samples.map((sample) => sample.frameLatencyMs?.p95 ?? 0)),
        } : null,
        census: summary ? { totals: summary.totals, transport: summary.transport,
          peakInstantBytes: (summary.jsHeapBytes as Record<string, unknown> | undefined)?.peakInstantBytes ?? null } : null,
        coverage: { gateway: "in-test mock gateway; production gateway NOT RUN",
          native: "native production qualification NOT RUN" },
        financial: endurance && !hasPrimary
          ? { tradesExactlyOnceInOrder: true, liveBarsMatchRecomputed: true, unframedMessages: endurance.unframedMessages }
          : "assertions not reached",
        resources: { teardown, disposeErrors: teardown?.disposeErrors ?? null,
          registryRestored: teardown?.registryRestored ?? null, rootsRemoved: teardown?.rootsRemoved ?? null },
        provenance: {
          declaredSourceSHA: process.env.CHART_ENDURANCE_SOURCE_SHA ?? null,
          executedTest: { file: relative(process.cwd(), testInfo.file),
            testFileSha256: createHash("sha256").update(await readFile(testInfo.file)).digest("hex") },
          servedSources: servedProvenance,
          runtime: { node: process.version, playwright: testInfo.config.version, project: testInfo.project.name,
            chromium: page.context().browser()?.version() ?? null, os: { platform: process.platform, arch: process.arch },
            launch: { headless: testInfo.project.use.headless ?? null, channel: testInfo.project.use.channel ?? null, display: process.env.DISPLAY ?? null },
            viewport: page.viewportSize(), devicePixelRatio },
        },
        failure: hasPrimary ? String(primaryError) : cleanupError ? String(cleanupError)
          : provenanceError ? `served-source provenance missing or invalid: ${String(provenanceError)}` : null,
      });
    } catch (error) { evidenceError = error; stages.evidence = "failed: attach"; }
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (provenanceError) throw provenanceError;
  if (evidenceError) throw evidenceError;
}

// Negative oracle for the minute-sample validator: short, dense/duplicate,
// unknown-heap and non-finite-timestamp sets must all be rejected.
test("#308 census minute-sample validator rejects fabricated sets", () => {
  const good = Array.from({ length: 3 }, (_, index) => ({ minute: index + 1, at: 60_000 * (index + 1), heapBytes: 1_000 }));
  expect(validateEnduranceSamples(good, 180_000, 3, 60_000)).toEqual([]);
  expect(validateEnduranceSamples(good.slice(0, 2), 180_000, 3, 60_000).join()).toContain("count");
  expect(validateEnduranceSamples([good[0], { minute: 2, at: 60_000, heapBytes: 1_000 }, good[2]], 180_000, 3, 60_000).join()).toContain("non-monotonic");
  expect(validateEnduranceSamples([good[0], { minute: 2, at: 90_000, heapBytes: null }, good[2]], 180_000, 3, 60_000).join()).toContain("invalid heap");
  expect(validateEnduranceSamples([{ minute: 1, at: Number.NaN, heapBytes: 1 }, good[1], good[2]], 180_000, 3, 60_000).join()).toContain("non-finite");
  expect(validateEnduranceSamples([{ minute: 1, at: 60_000, heapBytes: 1_000 }, { minute: 2, at: 70_000, heapBytes: 1_000 },
    { minute: 3, at: 80_000, heapBytes: 1_000 }], 180_000, 3, 60_000).join()).toContain("span");
});

for (const scenario of SCENARIOS) test(scenario.title, ({ page }) => runScenario(scenario, page));

// Endurance runs only on request: the "Chart endurance" workflow sets
// CHART_ENDURANCE_MINUTES.
test(ENDURANCE_PROFILE.title, async ({ page }, testInfo) => {
  test.skip(ENDURANCE_MINUTES <= 0, "set CHART_ENDURANCE_MINUTES to run the #308 endurance profile");
  await runScenario(ENDURANCE_PROFILE, page, testInfo);
});

// A worker-scoped browser fixture keeps the native test's page/context on the
// same Chromium instance while preserving the file-level legacy test.use.
// Playwright 1.63 derives context and page from browser; launchOptions is a
// worker option and cannot be changed by describe-scoped test.use.
const nativeTest = test.extend({
  browser: [async ({ playwright, browserName, launchOptions, headless, channel }, use) => {
    if (browserName !== "chromium") throw new Error("#326 native qualification requires Chromium CDP");
    const browser = await playwright.chromium.launch({
      ...launchOptions, headless, channel,
      args: [...(launchOptions.args ?? []), "--enable-automation"],
    });
    try { await use(browser); }
    finally { await browser.close({ reason: "Test ended." }); }
  }, { scope: "worker", timeout: 0 }],
});
// #326: qualification only; fixture analysis service + real Bridge, not engine proof.
// One document, 1/4/8 owners x eight cycles. No active accounting record is reset.
nativeTest("#326 native lifecycle qualification: repeated mounted owner census", async ({ page, browser }, testInfo) => {
  test.setTimeout(300_000);
  const transport: Array<{ market: string; format: string; bars: number; bytes: number; completed: boolean }> = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("crash", () => errors.push("page crash"));
  await page.route("**/fapi/v1/klines*", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/**", (r) => r.abort());
  await page.route(/\/history(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const market = url.searchParams.get("markets") ?? "";
    const from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to"));
    const format = url.searchParams.has("stream") ? "stream" : "";
    if (!FOOTPRINT_MARKETS.includes(market) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || from > to || to - from > 33 * INTERVAL_MS || Number(url.searchParams.get("interval")) !== INTERVAL_MS) {
      errors.push("unbounded/invalid history: " + url); await route.abort(); return;
    }
    // `to` is inclusive: an older chunk ends 1 ms before the next bucket, whose bar it still owns.
    const newest = bucketStartOf(to + 1) - INTERVAL_MS;
    const bars = Array.from({ length: 32 }, (_, i) => newest - (31 - i) * INTERVAL_MS)
      .filter((t) => t >= from && t <= to).map((t) => fixtureBar(t, format === "stream"));
    const body = Buffer.from(JSON.stringify({ ok: true, data: { bars }, meta: envelopeMeta(market, from, to, format === "stream") }));
    const record = { market, format, bars: bars.length, bytes: body.length, completed: false };
    transport.push(record);
    try {
      await route.fulfill({ status: 200, body, contentType: "application/json" });
      record.completed = true;
    } catch (error) { errors.push("history completion: " + error); }
  });
  let primary: unknown;
  const cleanupErrors: unknown[] = [];
  let result: any;
  const provenance: any = { node: process.version, versions: process.versions, playwright: testInfo.config.version,
    project: testInfo.project.name, configuredUse: testInfo.project.use, chromium: browser.version(),
    suppliedSourceSHA: process.env.QUALIFICATION_SHA ?? null, sourceSHAStatus: "supplied, not independently verified" };
  const sourceVersions: Array<Promise<any>> = [];
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/src/")) sourceVersions.push((async () => {
      try { return { url: response.url(), status: response.status(),
        sha256: createHash("sha256").update(await response.body()).digest("hex") }; }
      catch (error) { return { url: response.url(), error: String(error) }; }
    })());
  });
  try {
    provenance.executedTest = { file: testInfo.file,
      sha256: createHash("sha256").update(await readFile(testInfo.file)).digest("hex") };
    const cdp = await browser.newBrowserCDPSession();
    try {
      provenance.browserVersion = await cdp.send("Browser.getVersion");
      provenance.actualLaunch = await cdp.send("Browser.getBrowserCommandLine");
      expect(provenance.actualLaunch.arguments).toEqual(expect.arrayContaining(
        [...FUNCTIONAL_WEBGL_ARGS, ...HEAP_ARGS, "--enable-automation"]));
    } catch (error) { primary = error; throw error; }
    finally { try { await cdp.detach(); } catch (error) { cleanupErrors.push(error); } }
    await page.goto("/harness/blank.html");
    result = await page.evaluate(async (markets) => {
      document.body.replaceChildren();
      const meta = document.createElement("meta");
      meta.name = "footprint-config"; meta.content = "targetBars=32"; document.head.append(meta);
      const { mountChart } = await import("/harness/chart.ts");
      const { createChartSurfaceModel } = await import("/harness/chart.ts");
      const registry = await import("/harness/chart.ts");
      const { ChartSession } = await import("/src/features/chart/ChartSession.ts");
      const { ChartDataPipeline } = await import("/src/features/chart/ChartDataPipeline.ts");
      const { ChartHistoryController } = await import("/src/features/chart/ChartHistoryController.ts");
      const { ChartAnalysisBridge } = await import("/src/features/chart/ChartAnalysisBridge.ts");
      const { ChartCaptureCoordinator } = await import("/src/features/chart/ChartCaptureCoordinator.ts");
      const { DrawingManager } = await import("/src/features/drawings/drawingManager.ts");
      const { DEFAULT_VOLUME_PROFILE_SETTINGS } = await import("/src/core/analysis/volumeProfile.ts");
      const { normalizePreviousWeekStrategySettings } = await import("/src/core/analysis/previousWeekStrategy.ts");
      const { normalizeMondayRangeSettings } = await import("/src/core/analysis/mondayRange.ts");
      const originalRegistry = new Map(registry.listChartRuntimeEntries());
      const owners = new Map<string, any>(), restores: Array<() => void> = [];
      const listeners = new Set<any>(), observers = new Set<any>(), frames = new Map<number, any>();
      const glHandles = new Map<object, any>(), subscriptions = new Set<any>();
      const contexts = new WeakMap<object, { owner: string; id: number }>();
      const objectIds = new WeakMap<object, number>();
      let nextIdentity = 0, current = "";
      const retiredOwners = new Set<string>(), timers = new Map<number, any>();
      const issues: string[] = [], nativeLate: string[] = [], teardownCallbacks: string[] = [], reports: any[] = [];
      const originalRaf = window.requestAnimationFrame.bind(window);
      const originalCaf = window.cancelAnimationFrame.bind(window);
      const originalTimeout = window.setTimeout.bind(window);
      const delay = (ms: number) => new Promise((resolve) => originalTimeout(resolve, ms));
      const describe = (error: any): string => error instanceof AggregateError
        ? error.message + ": " + error.errors.map(describe).join("; ") : String(error);
      const assert = (ok: unknown, text: string) => { if (!ok) throw new Error(text); };
      const identity = (obj: object) => {
        if (!objectIds.has(obj)) objectIds.set(obj, ++nextIdentity);
        return objectIds.get(obj)!;
      };
      // Read-only diagnostic references; no listener ownership changes.
      let historyFailures: any[] = [];
      const historyLinks = (r: any) => {
        const links: string[] = [];
        if (r.target === document) links.push("document:target");
        for (const [id, rt] of registry.listChartRuntimeEntries()) {
          if (!owners.has(id)) continue;
          if (r.fn === (rt as any).historyController?.onVisibilityChange) links.push(id + ":visibilityCallback");
          const signal = (rt as any).pipeline?.historyController?.signal;
          if (signal && r.target === signal) links.push(id + ":pipeline.historyController.signal:target");
          if (signal && r.signal === signal) links.push(id + ":pipeline.historyController.signal:option");
        }
        return links;
      };
      const historyDiagnostic = (stage: string) => JSON.stringify({ stage, limit: "first 3; 8192 chars",
        nativeListenerExistence: "NOT_OBSERVABLE; probe-record-active is not native proof",
        publicRequestSignal: "NOT_CAPTURED (no exposed request signal reference)",
        records: historyFailures.slice(0, 3).map((r) => ({ probeId: identity(r), targetId: identity(r.target),
          targetCtor: r.target?.constructor?.name ?? "NOT_CAPTURED", type: r.type,
          callbackId: identity(r.fn), callbackName: r.fn?.name ?? "NOT_CAPTURED",
          capture: r.capture, once: r.once, optionSignalId: r.signal ? identity(r.signal) : null,
          sourceStack: r.sourceStack, registrationLinks: r.registrationLinks, mountLinks: r.mountLinks ?? "NOT_CAPTURED",
          terminalLinks: r.terminalLinks ?? "NOT_CAPTURED", retiredBy: r.retiredBy ?? null,
          probeRecordActive: listeners.has(r), observedLinksNow: historyLinks(r) })) }).slice(0, 8192);
      const domOwner = (target: any): string => target?.closest?.("[data-owner326]")?.dataset.owner326 ?? "";
      // Ownership is synchronous only; never keep this scope across an await.
      const within = (owner: string, fn: () => any) => {
        const previous = current; current = owner;
        try { return fn(); } finally { current = previous; }
      };
      const callback = (owner: string, kind: string, fn: Function, self: any, args: any[]) => {
        if (owners.get(owner)?.disposing) teardownCallbacks.push(owner + ":" + kind);
        if (owners.get(owner)?.terminal || retiredOwners.has(owner)) nativeLate.push(owner + ":" + kind);
        return within(owner, () => fn.apply(self, args));
      };
      const patch = (target: any, name: string, make: (old: any) => any) => {
        const old = target[name];
        restores.push(() => { target[name] = old; }); // registered BEFORE mutation, including partial setup
        target[name] = make(old);
      };
      let cleanupAll: () => Promise<unknown[]> = async () => []; // no owner can exist before setup completes
      let unknownBaseline: any = null;
      let observeTerminal = () => {};
      const activeResources = () => ({
        listeners: [...listeners].map((r) => ({ id: identity(r), owner: r.owner, type: r.type })),
        observers: [...observers].map((r) => ({ id: identity(r.instance), owner: r.owner, kind: r.kind })),
        raf: [...frames].map(([id, r]) => ({ id, owner: r.owner })),
        timers: [...timers].map(([id, r]) => ({ id, owner: r.owner, schedule: r.schedule, opaque: r.opaque ?? false })),
        subscriptions: [...subscriptions].map((r) => ({ id: identity(r), owner: r.owner, kind: r.kind })),
        gl: [...glHandles.values()].map((r) => ({ ...r })),
      });
      const terminal = async () => {
        const failures: unknown[] = [];
        try { failures.push(...await cleanupAll()); } catch (e) { failures.push(e); }
        try { await delay(300); } catch (e) { failures.push(e); }
        try { observeTerminal(); } catch (e) { failures.push(e); }
        if (nativeLate.length || issues.length) failures.push([...nativeLate, ...issues]);
        const active = activeResources(); // final observations BEFORE any patch is restored; maps are never cleared
        while (restores.length) try { restores.pop()!(); } catch (e) { failures.push(e); }
        try { meta.remove(); } catch (e) { failures.push(e); }
        delete (window as any).__qualification326;
        const evidence = { reports, nativeLate, issues, teardownCallbacks, active, unknownBaseline,
          historyDiagnostic: historyFailures.length ? historyDiagnostic("terminal") : null,
          cleanup: failures.map(describe), coverage: "observed native API registrations + subscription Set.add callsites; not universal async ownership; pre-patch resources not enumerable" };
        (window as any).__qualification326Evidence = evidence;
        return { failures, evidence };
      };
      // Accessible even when the FIRST instrumentation patch or any later setup operation throws.
      (window as any).__qualification326 = { terminal };
      // These are the five real owning classes, not a generic monitoring framework.
      for (const Ctor of [ChartSession, ChartDataPipeline, ChartHistoryController, ChartAnalysisBridge, ChartCaptureCoordinator]) {
        for (const name of Object.getOwnPropertyNames(Ctor.prototype)) {
          const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, name)!;
          if (name === "constructor" || typeof descriptor.value !== "function") continue;
          patch(Ctor.prototype, name, (old) => function (this: any, ...args: any[]) {
            const owner = domOwner(this.container) || this.services?.owner326
              || this.host?.pipeline?.services?.owner326 || this.host?.svc?.owner326 || current;
            if (owner && owners.has(owner)) {
              const o = owners.get(owner);
              if (name === "invalidateSurface") o.annotationRequests++;
              if (name === "onAnnotationRendered") o.bridgePaints++;
              if (name === "noteAnalysisPaint") o.paintedRevision = args[1];
              if (Ctor === ChartSession && name === "startRaf") o.sessionRafRequests++;
              if (Ctor === ChartDataPipeline && name === "_scheduleFlush") o.pipelineRafRequests++;
            }
            const flushRevision = Ctor === ChartDataPipeline && name === "_flushTrades" ? this.series.revision : null;
            const value = within(owner, () => old.apply(this, args));
            if (flushRevision !== null && this.series.revision > flushRevision && owners.has(owner))
              owners.get(owner).appliedFlushes++;
            return value;
          });
        }
      }
      const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
      const captureOf = (opts: any) => typeof opts === "boolean" ? opts : !!opts?.capture;
      const retireListener = (r: any, reason = "remove") => {
        r.retiredBy = reason; listeners.delete(r);
        if (r.signal && r.abort) remove.call(r.signal, "abort", r.abort);
      };
      patch(EventTarget.prototype, "addEventListener", () => function (this: any, type: string, fn: any, opts: any) {
        if (!fn) return add.call(this, type, fn, opts);
        const stack = new Error().stack ?? "";
        // A DOM marker or a previously registered IDENTICAL callback is evidence; nearby closures are not.
        const marked = new Set([...listeners].filter((r) => r.fn === fn && r.owner).map((r) => r.owner));
        const owner = current || domOwner(this) || (marked.size === 1 ? [...marked][0] : "");
        const capture = captureOf(opts);
        if (opts?.signal?.aborted) return add.call(this, type, fn, opts);
        if ([...listeners].some((r) => r.target === this && r.type === type && r.fn === fn && r.capture === capture)) return;
        const r: any = { owner, target: this, type, fn, capture, signal: opts?.signal, once: !!opts?.once,
          history: stack.includes("ChartHistoryController") };
        if (r.history) {
          identity(r); r.registrationLinks = historyLinks(r);
          r.sourceStack = stack.split("\n").slice(1, 6).map((line) =>
            line.replace(/https?:\/\/[^/]+/g, "<origin>").slice(0, 160)).join("\n").slice(0, 640);
        }
        r.wrapped = function (this: any, ...args: any[]) {
          if (r.once) retireListener(r, "once");
          return callback(r.owner, "listener:" + type, typeof fn === "function" ? fn : fn.handleEvent,
            typeof fn === "function" ? this : fn, args);
        };
        r.abort = () => retireListener(r, "option-signal-abort");
        listeners.add(r);
        if (r.signal) add.call(r.signal, "abort", r.abort, { once: true });
        try { return add.call(this, type, r.wrapped, opts); }
        catch (error) { retireListener(r, "registration-error"); throw error; }
      });
      patch(EventTarget.prototype, "removeEventListener", () => function (this: any, type: string, fn: any, opts: any) {
        const r = [...listeners].find((r) => r.target === this && r.type === type && r.fn === fn && r.capture === captureOf(opts));
        if (!r) return remove.call(this, type, fn, opts);
        retireListener(r); return remove.call(this, type, r.wrapped, opts);
      });
      patch(window, "requestAnimationFrame", () => (fn: FrameRequestCallback) => {
        const owner = current;
        let id = 0;
        id = originalRaf((time) => {
          frames.delete(id);
          callback(owner, "raf", fn, window, [time]);
        });
        frames.set(id, { owner, fn });
        const o = owners.get(owner); if (o) o.nativeRafs++;
        return id;
      });
      patch(window, "cancelAnimationFrame", () => (id: number) => { frames.delete(id); originalCaf(id); });
      for (const [schedule, cancel, repeated] of [
        ["setTimeout", "clearTimeout", false], ["setInterval", "clearInterval", true],
      ] as const) {
        patch(window, schedule, (old) => (fn: Function, ms?: number, ...args: any[]) => {
          const owner = current; let id = 0;
          if (typeof fn !== "function") {
            id = old.call(window, fn, ms, ...args);
            timers.set(id, { owner, schedule, opaque: true }); return id; // conservatively active until cleared
          }
          id = old.call(window, (...values: any[]) => {
            if (!repeated) timers.delete(id);
            callback(owner, schedule, fn, window, values);
          }, ms, ...args);
          timers.set(id, { owner, schedule }); return id;
        });
        patch(window, cancel, (old) => (id: number) => { timers.delete(id); old.call(window, id); });
      }
      // Native Set identity of the actual module-global footprint subscription.
      const footprintRecords = new Map<Function, any>();
      patch(Set.prototype, "add", (old) => function (this: Set<any>, value: any) {
        const stack = typeof value === "function" ? new Error().stack ?? "" : "";
        if (typeof value === "function" && stack.includes("subscribe")
          && ![...subscriptions].some((r) => r.nativeSet === this && r.fn === value)) {
          const r = { owner: current, kind: stack.includes("subscribeFootprintSupport") ? "footprint" : "unassigned-set",
            fn: value, nativeSet: this, runtimeConstructor: stack.includes("ChartRuntimeImpl") };
          if (r.kind === "footprint") footprintRecords.set(value, r);
          subscriptions.add(r);
        }
        return old.call(this, value);
      });
      patch(Set.prototype, "delete", (old) => function (this: Set<any>, value: any) {
        const r = [...subscriptions].find((r) => r.nativeSet === this && r.fn === value);
        if (r) {
          subscriptions.delete(r); if (r.kind === "footprint") footprintRecords.delete(value);
          const o = owners.get(r.owner);
          if (o) o.unsubscribes[r.kind] = (o.unsubscribes[r.kind] ?? 0) + 1;
        }
        return old.call(this, value);
      });
      for (const name of ["ResizeObserver", "MutationObserver"] as const) {
        const Native = (window as any)[name];
        patch(window, name, () => class extends Native {
          private record: any;
          constructor(fn: Function) {
            const r: any = { owner: current, kind: name, instance: null, targets: new Set() };
            super((...args: any[]) => callback(r.owner, name, fn, undefined, args));
            r.instance = this; this.record = r;
          }
          observe(target: Element, ...args: any[]) {
            this.record.owner ||= domOwner(target);
            this.record.targets.add(target); observers.add(this.record);
            return super.observe(target, ...args);
          }
          unobserve(target: Element) {
            this.record.targets.delete(target);
            if (!this.record.targets.size) observers.delete(this.record);
            return super.unobserve(target);
          }
          disconnect() { observers.delete(this.record); this.record.targets.clear(); return super.disconnect(); }
        });
      }
      patch(HTMLCanvasElement.prototype, "getContext", (old) => function (this: HTMLCanvasElement, ...args: any[]) {
        const value = old.apply(this, args), owner = domOwner(this);
        if (owner && value && args[0] === "webgl2" && !contexts.has(value)) {
          const id = identity(value); contexts.set(value, { owner, id });
          owners.get(owner).glContexts.push(id);
        }
        return value;
      });
      const kinds = ["Buffer", "Texture", "Framebuffer", "Renderbuffer", "Shader", "Program",
        "VertexArray", "Sampler", "Query", "TransformFeedback", "Sync"];
      for (const kind of kinds) {
        const create = kind === "Sync" ? "fenceSync" : "create" + kind, destroy = "delete" + kind;
        patch(WebGL2RenderingContext.prototype, create, (old) => function (this: any, ...args: any[]) {
          const handle = old.apply(this, args), ctx = contexts.get(this);
          if (ctx && handle) {
            glHandles.set(handle, { owner: ctx.owner, context: ctx.id, kind, identity: identity(handle) });
            owners.get(ctx.owner).glCreates++;
          }
          return handle;
        });
        patch(WebGL2RenderingContext.prototype, destroy, (old) => function (this: any, handle: object) {
          const r = glHandles.get(handle), ctx = contexts.get(this);
          if (r && (r.context !== ctx?.id || r.kind !== kind)) issues.push("wrong GL context/kind delete");
          const value = old.call(this, handle);
          if (r) glHandles.delete(handle);
          return value;
        });
      }
      const resourceIds = (owner: string) => ({
        gl: [...glHandles.values()].filter((r) => r.owner === owner).map((r) => [r.context, r.kind, r.identity]),
        listeners: [...listeners].filter((r) => r.owner === owner).map((r) => identity(r)),
        observers: [...observers].filter((r) => r.owner === owner).map((r) => identity(r.instance)),
        raf: [...frames].filter(([, r]) => r.owner === owner).map(([id]) => id),
        timers: [...timers].filter(([, r]) => r.owner === owner).map(([id]) => id),
        subscriptions: [...subscriptions].filter((r) => r.owner === owner).map((r) => identity(r)),
      });
      const unknownCohort = () => resourceIds("");
      const checkUnknown = (baseline: any, label: string) => {
        const after = unknownCohort();
        for (const kind of ["listeners", "observers", "subscriptions"] as const)
          assert(JSON.stringify(after[kind]) === JSON.stringify(baseline[kind]),
            label + ": unassigned " + kind + " identities changed " + JSON.stringify({ baseline, after }));
        // Transient handles can legitimately turn over; enforce actual baseline occupancy, retain every live record.
        for (const kind of ["raf", "timers"] as const)
          assert(after[kind].length === baseline[kind].length,
            label + ": unassigned " + kind + " occupancy changed " + JSON.stringify({ baseline, after }));
        return after;
      };
      const registryMatches = (baseline: Map<string, any>) => {
        const entries = new Map(registry.listChartRuntimeEntries());
        return entries.size === baseline.size && [...baseline].every(([id, rt]) => entries.get(id) === rt);
      };
      const waitFor = async (fn: () => boolean, label: string) => {
        const deadline = performance.now() + 20_000;
        while (!fn()) { assert(performance.now() < deadline, "timeout: " + label); await delay(20); }
      };
      const heap = () => {
        assert(typeof (window as any).gc === "function", "REQUIRED GC missing");
        const before = (performance as any).memory?.usedJSHeapSize;
        (window as any).gc();
        const after = (performance as any).memory?.usedJSHeapSize;
        assert(Number.isFinite(before) && Number.isFinite(after) && after > 0, "REQUIRED precise heap missing");
        assert(after <= 1024 * 1024 * 1024, "retained heap > 1GB");
        return { before, after, gc: "window.gc; expose-gc + precise-memory-info" };
      };
      const makeOwner = (id: string, market: string, index: number) => {
        const root = document.createElement("div"); root.dataset.owner326 = id;
        root.style.cssText = "position:fixed;width:300px;height:340px;left:" + (index % 4) * 310
          + "px;top:" + Math.floor(index / 4) * 350 + "px;";
        document.body.append(root);
        const o: any = { id, market, root, surface: createChartSurfaceModel(), handle: null, runtime: null,
          disposing: false, revision: 1, analysisInputs: 0, barCloseInputs: 0, bridgePaints: 0,
          annotationRequests: 0, paintedRevision: 0, nativeRafs: 0, sessionRafRequests: 0,
          pipelineRafRequests: 0, appliedFlushes: 0, glContexts: [], glCreates: 0, late: [], unsubscribes: {}, historySettled: 0, services: null };
        owners.set(id, o);
        const subscribe = (kind: string, fn: Function) => {
          if (kind === "analysis") {
            // subscribeAnalysis occurs in the SAME synchronous Runtime constructor as footprint registration.
            const stack = new Error().stack ?? "";
            const pending = [...footprintRecords.values()].filter((r) => !r.owner);
            // Both registrations occur inside one non-yielding Runtime constructor; unique native Set identity,
            // not a mount/await time window. An orphan from a failed constructor fails rather than being reassigned.
            assert(stack.includes("ChartAnalysisBridge") && stack.includes("ChartRuntimeImpl")
              && pending.length === 1 && pending[0].runtimeConstructor, id + ": footprint callback origin");
            pending[0].owner = id;
          }
          const r = { owner: id, kind, fn }; subscriptions.add(r); o.late.push(r);
          return () => {
            assert(subscriptions.has(r), id + ": duplicate unsubscribe " + kind);
            subscriptions.delete(r); o.unsubscribes[kind] = (o.unsubscribes[kind] ?? 0) + 1;
          };
        };
        const publish = () => {
          o.revision++;
          for (const r of subscriptions) if (r.owner === id && r.kind === "analysis")
            within(id, () => r.fn({ kind: "automatic-data", market, dataRevision: o.revision, visibilityRevision: 1 }));
          for (const r of subscriptions) if (r.owner === id && r.kind === "revision") within(id, () => r.fn());
        };
        const context = { market, drawings: new DrawingManager(() => {}),
          profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
          previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
          mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
          previousWeekStrategyLevels: [], mondayRangeLevels: [], nakedPocs: [], referenceLevels: [] };
        o.services = {
          owner326: id, subscribeToTrades: (_m: string, fn: Function) => subscribe("trades", fn),
          subscribeToTradeSessions: (fn: Function) => subscribe("sessions", fn),
          subscribeToTradeMarketReadiness: (fn: Function) => subscribe("readiness", fn),
          fetchPriceStep: async () => 1, fetchPriceStepResult: async () => ({ step: 1, resolved: true }),
          fetchPricePrecision: async () => undefined,
          fetchHistory: async () => { throw new Error("fetchHistory array port used instead of HTTP"); },
          fetchNpocSnapshot: async () => ({ schemaVersion: 3, market, levels: [], valueAreas: [] }),
          subscribeAnalysis: (fn: Function) => subscribe("analysis", fn),
          subscribeAnalysisRevision: (fn: Function) => subscribe("revision", fn),
          getAnalysisRevisionSnapshot: () => ({ market, revision: o.revision, canonical: {
            status: "complete", market, runKey: market + "|1", generation: o.revision, revision: o.revision, failedPeriods: [] } }),
          getAnalysisContext: () => context, getAutomaticLevelsAsOf: () => null,
          updateAnalysisFromSeries: (_m: string, series: any) => {
            assert(series === registry.getChartRuntime(id)?.pipeline.series, id + ": foreign analysis series");
            o.analysisInputs++; publish();
          },
          notifyBarClose: () => { o.barCloseInputs++; publish(); },
          notifyActiveMarket() {}, notifyInteractiveCandlesReady() {}, notifyInteractiveHistorySettled() { o.historySettled++; },
          triggerAutoSync() {}, isFootprintSyncBusy: () => false, notify() {},
        };
        o.handle = mountChart(root, { type: "chart", market, timeframe: "1m", scaleMode: "linear", indicators: [] } as never,
          o.services, id, o.surface);
      };
      const ready = async (id: string) => {
        const o = owners.get(id);
        await waitFor(() => o.surface.status === "ready" && !!registry.getChartRuntime(id), id + ": mount");
        o.runtime = registry.getChartRuntime(id);
        // Every mounted owner's load must settle: a sibling still loading holds transient history listeners.
        await waitFor(() => [...owners.values()].every((x) => x.historySettled === 1), id + ": actual initial history completion of every mounted owner");
        // Constructor history registration has an exact private callback identity at mount-ready.
        for (const [ownerId, rt] of registry.listChartRuntimeEntries()) {
          if (!owners.has(ownerId)) continue;
          for (const r of listeners) if (r.fn === (rt as any).historyController.onVisibilityChange) r.owner = ownerId;
        }
        for (const r of listeners) if (r.history) r.mountLinks = historyLinks(r);
        historyFailures = [...listeners].filter((r) => r.history && !r.owner);
        assert(!historyFailures.length, "unattributed history listener"
          + (historyFailures.length ? " " + historyDiagnostic("mount") : ""));
        await waitFor(() => o.runtime.getCaptureReadiness().ready && o.runtime.pipeline.series.length >= 32,
          id + ": settled history + painted analysis");
        assert(o.runtime.pipeline.series === o.runtime.session.series, id + ": mounted series identity");
        assert(o.analysisInputs > 0 && o.revision > 1 && o.annotationRequests > 0 && o.bridgePaints > 0,
          id + ": actual history -> service -> Bridge missing");
        const times = Array.from({ length: 32 }, (_, i) => o.runtime.pipeline.series.at(i).startTime);
        assert(o.runtime.pipeline.series.length === 32 && times.every((t, i) => i === 0 || t - times[i - 1] === 60_000),
          id + ": closed series extent");
        const expectedCells = [
          [99, 0, 1, 1, -1, 1, 0, 1], [100, 1, 0, 1, 1, 1, 1, 0],
          [102, 1, 0, 1, 1, 1, 1, 0], [103, 1, 0, 1, 1, 1, 1, 0],
        ];
        for (let offset = 0; offset < 32; offset += 24) {
          const end = Math.min(offset + 24, 32);
          const snapshot = o.runtime.getAnalysisSnapshot({ now: Math.floor(Date.now() / 60000) * 60000,
            visibleTimeRange: { from: times[offset], to: times[end - 1] },
            maxLevelsAndDrawings: 0, maxIndicatorSamples: 1 });
          assert(snapshot.candles.length === end - offset, id + ": closed candle chunk count");
          for (const [index, b] of snapshot.candles.entries()) {
            assert(b.time === times[offset + index], id + ": closed candle chunk identity");
            assert(JSON.stringify([b.open, b.high, b.low, b.close, b.volume, b.delta, b.count]) === "[100,103,99,102,4,2,4]",
              id + ": literal HTTP finance mismatch");
            assert(JSON.stringify(b.footprint.map((cell: any) => [cell.price, cell.buyVolume, cell.sellVolume,
              cell.totalVolume, cell.delta, cell.tradeCount, cell.buyTradeCount, cell.sellTradeCount]))
              === JSON.stringify(expectedCells), id + ": literal streamed completion/cells mismatch");
          }
        }
        const dprListener = [...listeners].find((r) => r.owner === id && r.type === "change"
          && r.target instanceof MediaQueryList);
        assert(dprListener, id + ": actual DPR MediaQueryList listener missing");
        // Event-only accounting canary, NOT a claim of changed native devicePixelRatio.
        const oldDprIdentity = identity(dprListener);
        dprListener.target.dispatchEvent(new Event("change"));
        const rebound = [...listeners].find((r) => r.owner === id && r.type === "change"
          && r.target instanceof MediaQueryList);
        assert(rebound && identity(rebound) !== oldDprIdentity && !listeners.has(dprListener),
          id + ": DPR callback-origin re-registration accounting failed");
        const capture = await o.runtime.captureNativePng();
        assert(capture.bytes > 0 && capture.blob.type === "image/png" && capture.width > 0
          && capture.canonicalRevision === o.revision, id + ": native annotation/capture handshake");
        const resources = resourceIds(id);
        assert(resources.gl.length > 0 && o.glContexts.length === 1 && resources.listeners.length >= 10
          && resources.observers.length > 0 && resources.subscriptions.length === 6 && o.nativeRafs > 0
          && o.sessionRafRequests > 0, id + ": positive alive native ownership missing");
        return { id, contexts: [...o.glContexts], alive: resources, historyInputs: o.analysisInputs };
      };
      const cleanupOwner = async (id: string) => {
        const o = owners.get(id); if (!o) return;
        o.disposing = true;
        const cleanup: string[] = [];
        o.runtime ||= registry.getChartRuntime(id);
        if (!o.disposeAttempted) {
          o.disposeAttempted = true;
          try { o.handle?.dispose(); } catch (e) { cleanup.push(id + ": handle.dispose: " + e); }
        }
        // If composite dispose threw, separately attempt every terminal owner operation.
        if (cleanup.length && o.runtime && !o.fallbackAttempted) { o.fallbackAttempted = true; for (const [target, name] of [
          [o.runtime.analysisBridge, "dispose"], [o.runtime.historyController, "dispose"],
          [o.runtime.replayCoordinator, "dispose"], [o.runtime.syncController, "dispose"],
          [o.runtime.captureCoordinator, "dispose"], [o.runtime, "disposeInput"],
          [o.runtime.session, "destroy"], [o.runtime.renderCoordinator, "dispose"],
          [o.runtime.renderer, "dispose"], [o.runtime.pipeline, "dispose"], [o.runtime.indicatorController, "dispose"],
        ]) { try { target[name](); } catch (e) { cleanup.push(id + ": " + name + ": " + e); } } }
        o.terminal = true;
        const readinessBefore = o.runtime?.pipeline.latestMarketReadiness;
        const before = [o.runtime?.pipeline.series.length, o.annotationRequests, o.bridgePaints, o.paintedRevision,
          o.runtime?.pipeline.pendingTrades.length, o.runtime?.pipeline.recentCoverageRepair];
        // Invoke REAL subscribed callbacks held only for this late-response oracle.
        for (const r of o.late) try {
          if (r.kind === "analysis") r.fn({ kind: "automatic-data", market: o.market, dataRevision: 999, visibilityRevision: 1 });
          if (r.kind === "revision") r.fn();
          if (r.kind === "trades") r.fn({ id: "999999", market: o.market, time: Date.now(), price: 102, qty: 1, isBuy: true });
          if (r.kind === "sessions") r.fn({ generation: 999, epoch: 999, session: "late326", boundaryAt: Date.now() });
          if (r.kind === "readiness") r.fn({ market: o.market, generation: 999, epoch: 999, session: "late326",
            boundaryAt: Date.now(), acknowledgedAt: Date.now(), transportGeneration: 999 });
        } catch (e) { cleanup.push(id + ": late service callback: " + e); }
        await delay(300);
        for (const check of [
          () => assert(JSON.stringify(before) === JSON.stringify([o.runtime?.pipeline.series.length,
            o.annotationRequests, o.bridgePaints, o.paintedRevision, o.runtime?.pipeline.pendingTrades.length,
            o.runtime?.pipeline.recentCoverageRepair]), id + ": late callback mutated disposed runtime"),
          () => assert(o.runtime?.pipeline.latestMarketReadiness === readinessBefore,
            id + ": late matching-market readiness mutated disposed pipeline"),
          () => assert(Object.values(resourceIds(id)).every((rows) => rows.length === 0),
            id + ": leaked identities " + JSON.stringify(resourceIds(id))),
          () => assert(["trades", "sessions", "readiness", "analysis", "revision", "footprint"]
            .every((kind) => o.unsubscribes[kind] === 1), id + ": unsubscribe imbalance " + JSON.stringify(o.unsubscribes)),
          () => { o.root.remove(); assert(!registry.getChartRuntime(id), id + ": registry retained"); },
        ]) try { check(); } catch (e) { cleanup.push(String(e)); }
        for (const r of historyFailures) r.terminalLinks = historyLinks(r);
        // Release all known strong probe refs AFTER assertions; never clear leak maps.
        o.late.length = 0; o.handle = o.runtime = o.services = o.root = o.surface = null;
        retiredOwners.add(id); owners.delete(id);
        if (cleanup.length) throw new AggregateError(cleanup, id + ": cleanup failures");
      };
      cleanupAll = async () => {
        const failures: unknown[] = [];
        for (const id of [...owners.keys()]) try { await cleanupOwner(id); } catch (e) { failures.push(e); }
        return failures;
      };
      let primary: unknown;
      const failures: unknown[] = [];
      try {
        // Explicit accounting canary: native once + AbortSignal, duplicate identity and capture.
        (() => {
        const target = new EventTarget(), controller = new AbortController();
        let fired = 0; owners.set("canary", { disposing: false, nativeRafs: 0 });
        within("canary", () => {
          const fn = () => { fired++; };
          target.addEventListener("once326", fn, { once: true });
          target.addEventListener("once326", fn, { once: true });
          target.addEventListener("abort326", fn, { capture: true, signal: controller.signal });
          target.dispatchEvent(new Event("once326")); controller.abort(); target.dispatchEvent(new Event("abort326"));
        });
        assert(fired === 1 && resourceIds("canary").listeners.length === 0, "native once/AbortSignal accounting");
        owners.delete("canary");
        })(); // All canary target/controller/callback probe refs leave scope BEFORE GC.
        (() => {
          const before = unknownCohort(), target = new EventTarget(), fn = () => {};
          function subscribe326Canary() { const set = new Set<Function>(); set.add(fn); return () => set.delete(fn); }
          const unsubscribe = subscribe326Canary(), observer = new ResizeObserver(fn);
          target.addEventListener("unknown326", fn); observer.observe(document.body);
          const raf = requestAnimationFrame(fn), timer = setTimeout(fn, 60_000);
          const active = unknownCohort();
          for (const kind of ["listeners", "observers", "raf", "timers", "subscriptions"] as const)
            assert(active[kind].length === before[kind].length + 1, "unassigned canary missing " + kind);
          target.removeEventListener("unknown326", fn); observer.disconnect();
          cancelAnimationFrame(raf); clearTimeout(timer); unsubscribe();
          checkUnknown(before, "unassigned canary cleanup");
        })();
        await delay(300);
        unknownBaseline = unknownCohort();
        observeTerminal = () => {
          const observed = activeResources();
          reports.push({ terminalResources: observed, unassigned: unknownCohort() });
          const checks = [
            () => checkUnknown(unknownBaseline, "final original cohort"),
            () => assert(Object.values(observed).every((rows) => rows.every((r: any) => !r.owner)),
              "final named resources retained " + JSON.stringify(observed)),
            () => assert(registryMatches(originalRegistry), "terminal original registry mismatch"),
          ];
          const errors: unknown[] = [];
          for (const check of checks) try { check(); } catch (e) { errors.push(e); }
          if (errors.length) throw new AggregateError(errors, "all final resource observations");
        };
        const beforeForeign = heap();
        makeOwner("foreign326", markets[1], 0);
        await ready("foreign326");
        await delay(100);
        let foreignRuntime: any = registry.getChartRuntime("foreign326");
        const baseline = new Map(registry.listChartRuntimeEntries());
        const foreignIdentity = resourceIds("foreign326"), foreignUnknown = unknownCohort();
        assert(foreignIdentity.gl.length > 0, "foreign owner GL never initialized");
        for (const count of [1, 4, 8]) for (let cycle = 0; cycle < 8; cycle++) {
          const before = heap(), alive: any[] = [];
          const ids = Array.from({ length: count }, (_, i) => "cycle326-" + count + "-" + cycle + "-" + i);
          for (const [i, id] of ids.entries()) makeOwner(id, markets[i % markets.length], i);
          for (const id of ids) alive.push(await ready(id));
          // Real live subscriber delivery: queued by default pipeline scheduler, then bar-close -> Bridge.
          for (const id of ids) {
            const o = owners.get(id), tail = o.runtime.pipeline.series.at(o.runtime.pipeline.series.length - 1).startTime;
            for (let i = 0; i < 2; i++) {
              const r = [...subscriptions].find((r) => r.owner === id && r.kind === "trades")!;
              const revision = o.runtime.pipeline.series.revision, completed = o.appliedFlushes;
              within(id, () => r.fn({ id: String(70000 + i), market: o.market,
                time: tail + (i + 1) * 60000 + 1000, price: 102, qty: 1, isBuy: i === 0 }));
              // Queue-empty alone is not application. Await REAL changed series + completed native flush
              // before the next bucket; the first flush establishes lastBarStart without a bar-close notification.
              await waitFor(() => o.runtime.pipeline.pendingTrades.length === 0
                && o.runtime.pipeline.series.revision > revision && o.appliedFlushes > completed
                && o.runtime.pipeline.series.at(o.runtime.pipeline.series.length - 1).startTime === tail + (i + 1) * 60000,
                id + ": completed live flush " + i);
            }
            await waitFor(() => o.runtime.pipeline.pendingTrades.length === 0 && o.barCloseInputs > 0
              && o.runtime.getCaptureReadiness().ready, id + ": bar-close handshake");
            assert(o.pipelineRafRequests > 0, id + ": actual pipeline RAF absent");
            const capture = await o.runtime.captureNativePng();
            assert(capture.bytes > 0 && capture.canonicalRevision === o.revision && o.paintedRevision === o.revision,
              id + ": live bar-close -> real Bridge -> capture revision missing");
            const live = o.runtime.getAnalysisSnapshot({ now: tail + 3 * 60000, maxLevelsAndDrawings: 0,
              maxIndicatorSamples: 1 }).candles.filter((b: any) => b.time > tail);
            assert(live.length === 2 && live.every((b: any, i: number) =>
              JSON.stringify([b.open, b.high, b.low, b.close, b.volume, b.delta, b.count])
                === JSON.stringify([102, 102, 102, 102, 1, i === 0 ? 1 : -1, 1])),
              id + ": final live literal finance mismatch");
          }
          for (const id of ids) await cleanupOwner(id);
          await delay(300); // final native late-fire interval, after every terminal owner cleanup
          assert(registryMatches(baseline) && registry.getChartRuntime("foreign326") === foreignRuntime,
            "whole registry identity baseline not restored");
          const foreignAfter = resourceIds("foreign326");
          // RAF ids are transient; every persistent foreign handle/listener/observer/subscription must survive.
          for (const kind of ["gl", "listeners", "observers", "subscriptions"] as const)
            assert(JSON.stringify(foreignAfter[kind]) === JSON.stringify(foreignIdentity[kind]), "foreign " + kind + " disturbed");
          assert(nativeLate.length === 0 && issues.length === 0, "late-native/accounting violations: " + [...nativeLate, ...issues]);
          const unassigned = checkUnknown(foreignUnknown, "cycle " + count + "/" + cycle);
          const after = heap();
          reports.push({ count, cycle, before, after, alive, unassigned,
            retainedGrowth: after.after - before.after, retainedSlopeDiagnosticOnly: true });
        }
        await cleanupOwner("foreign326");
        foreignRuntime = null; baseline.delete("foreign326");
        await delay(300);
        assert(registryMatches(originalRegistry), "final original registry mismatch");
        checkUnknown(unknownBaseline, "after foreign disposal");
        const final = heap(), samples = reports.filter((r) => r.count).map((r) => r.after.after);
        reports.push({ final, beforeForeign, retainedGrowth: final.after - beforeForeign.after, samples,
          retainedSlopeBytesPerCycle: samples.length > 1 ? (samples.at(-1)! - samples[0]) / (samples.length - 1) : null,
          slopeDiagnosticOnly: true, heapAcceptance: "human #308: post-GC <=1GB only, no sub-cap leak-free proof" });
      } catch (e) { primary = e; }
      finally {
        const closed = await terminal(); failures.push(...closed.failures);
      }
      (window as any).__qualification326Evidence.primary = primary ? describe(primary) : null;
      if (primary || failures.length) throw new AggregateError([...(primary ? [primary] : []), ...failures],
        "qualification primary + cleanup: " + [primary, ...failures].filter(Boolean).map(describe).join("; "));
      return { terminal: (window as any).__qualification326Evidence, reports, analysisSeam: "fixture service + real Bridge; NOT canonical engine", discard: "NOT_RUN: native discard capability not established; no simulation",
        teardownCallbacks, document: "one origin navigation; all 24 cycles in this document" };
    }, FOOTPRINT_MARKETS);
    expect(result.reports.filter((r: any) => r.count).length).toBe(24);
    expect(transport.length).toBeGreaterThan(0);
    expect(transport.every((r) => r.completed && r.bytes > 0)).toBe(true);
    expect(transport.some((r) => r.format === "" && r.bars === 32)).toBe(true);
    // Phase 2 arrives in CHUNK_BARS windows (24 + 8): one load is two consecutive streamed responses.
    expect(transport.some((r, i) => r.format === "stream" && transport[i + 1]?.format === "stream" && transport[i + 1].market === r.market && r.bars + transport[i + 1].bars === 32)).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) { primary = error; }
  finally {
    try {
      const final = await page.evaluate(async () => {
        const s = (window as any).__qualification326;
        if (s) await s.terminal(); // early partial-setup path uses the SAME full observation/restoration sequence
        const evidence = (window as any).__qualification326Evidence;
        delete (window as any).__qualification326Evidence;
        return evidence ?? null;
      });
      if (final) {
        result = { ...(result ?? {}), terminal: final };
        cleanupErrors.push(...final.cleanup);
      }
    } catch (error) { cleanupErrors.push(error); }
    try { await testInfo.attach("lifecycle-qualification", { contentType: "application/json",
      body: Buffer.from(JSON.stringify({ sourceSHA: process.env.QUALIFICATION_SHA ?? "unrecorded", provenance,
        sourceVersions: await Promise.all(sourceVersions), runtime: result ?? null, primary: primary ? String(primary) : null,
        transport, errors, cleanupErrors: cleanupErrors.map(String) })) }); }
    catch (error) { cleanupErrors.push(error); }
    if (errors.length) cleanupErrors.push(new Error("final page/history errors: " + errors.join("; ")));
  }
  if (primary || cleanupErrors.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanupErrors], "#326 primary + all cleanup errors");
});

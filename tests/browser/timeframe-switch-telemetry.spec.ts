import { expect, test, type Page } from "@playwright/test";
import { FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";

test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

const MARKET = "BINANCE_FUTURES:btcusdt";
const ALL_TIMEFRAMES = [
  "1m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h",
  "1d", "3d", "1w", "2w",
  "1M", "2M", "3M", "6M", "12M",
] as const;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_TOKEN_MS = 30 * DAY_MS;
const MONTH_SPANS = new Set([1, 2, 3, 6, 12]);
const BAR_COUNT = 60;
const ITERATIONS = 3;

function utcMonthStart(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function monthSpan(intervalMs: number): number {
  const months = intervalMs / MONTH_TOKEN_MS;
  return Number.isInteger(months) && MONTH_SPANS.has(months) ? months : 0;
}

function bucketStart(time: number, intervalMs: number): number {
  const months = monthSpan(intervalMs);
  if (months) {
    const d = new Date(time);
    const month = Math.floor(d.getUTCMonth() / months) * months;
    return utcMonthStart(d.getUTCFullYear(), month);
  }
  if (intervalMs === WEEK_MS || intervalMs === 2 * WEEK_MS) {
    const day = Math.floor(time / DAY_MS) * DAY_MS;
    const d = new Date(day);
    const monday = day - ((d.getUTCDay() + 6) % 7) * DAY_MS;
    if (intervalMs === WEEK_MS) return monday;
    const anchor = Date.UTC(1970, 0, 5);
    return anchor + Math.floor((monday - anchor) / intervalMs) * intervalMs;
  }
  return Math.floor(time / intervalMs) * intervalMs;
}

function buildAlignedBars(intervalMs: number, count: number, withCells: boolean, now = Date.now()) {
  const openBucket = bucketStart(now, intervalMs);
  const starts: number[] = [];
  let cursor = openBucket;
  for (let i = 0; i < count; i++) {
    const prev = bucketStart(cursor - 1, intervalMs);
    if (prev < 0 || prev >= cursor) break;
    cursor = prev;
    starts.push(cursor);
  }
  starts.reverse();
  const bars = starts.map((t, index) => {
    const o = 60_000 + (index % 10) * 20;
    const c = o + (index % 2 === 0 ? 30 : -20);
    const h = Math.max(o, c) + 40;
    const l = Math.min(o, c) - 40;
    const cells = withCells
      ? Array.from({ length: 8 }, (_, k) => [l + k * 10, 1.4 + k * 0.2, 1.1 + k * 0.15, 0, 0, 4, 2, 2])
      : [];
    return { t, o, h, l, c, v: 20, d: 2.4, n: 32, cells, completeness: "complete", updatedAt: now };
  });
  return { openBucket, bars };
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] * 100) / 100;
}

async function runBackendSuite(page: Page, backend: "webgl2" | "canvas2d") {
  let cacheMode: "cold" | "warm" = "cold";
  let currentTag = "init";
  const bytesByTag = new Map<string, number>();
  const requestsByTag = new Map<string, number>();
  let delayedGates: Array<{ interval: number; release: () => void }> = [];
  let holdIntervalMs: number | null = null;

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return route.abort();
    }
    if (url.pathname !== "/history") {
      return route.continue();
    }
    const q = url.searchParams;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    const interval = Number(q.get("interval"));
    const includeFootprint = q.get("includeFootprint") !== "0";
    const now = Date.now();
    const openBucket = bucketStart(now, interval);

    if (holdIntervalMs !== null && interval === holdIntervalMs) {
      await new Promise<void>((resolve) => {
        delayedGates.push({ interval, release: resolve });
      });
    }

    let bars;
    if (from >= openBucket) {
      bars = [{ t: openBucket, o: 60100, h: 60150, l: 60080, c: 60120, v: 5, d: 1, n: 8, cells: [], completeness: "provisional", updatedAt: now }];
    } else {
      const built = buildAlignedBars(interval, BAR_COUNT, includeFootprint, now);
      bars = built.bars.filter((b) => b.t >= from && b.t <= to);
    }

    const meta = {
      schemaVersion: 2,
      generatedAt: now,
      cache: { hit: cacheMode === "warm" },
      candleCoverage: {
        schemaVersion: 1,
        source: "binance-klines",
        instrument: MARKET,
        ownership: "snapshot",
        status: "verified",
        requestedFrom: from,
        requestedTo: to,
        snapshotAt: now,
        closedThrough: openBucket - 1,
        reasonCode: null,
      },
      footprint: { available: true, allowed: true, priceStep: 10 },
      footprintCoverage: {
        schemaVersion: 1,
        source: "binance-usdm-aggTrade",
        instrument: MARKET,
        authority: includeFootprint ? "canonical" : null,
        status: includeFootprint ? "verified" : "pending",
        requestedFrom: from,
        requestedTo: to,
        coveredFrom: includeFootprint ? from : null,
        coveredThrough: includeFootprint ? to : null,
        durableThroughId: includeFootprint ? "500" : null,
        projectionThroughId: includeFootprint ? "500" : null,
        authorityToken: includeFootprint ? "canonical" : null,
        reasonCode: null,
      },
    };
    const body = JSON.stringify({ ok: true, data: { bars }, meta });
    bytesByTag.set(currentTag, (bytesByTag.get(currentTag) ?? 0) + Buffer.byteLength(body));
    requestsByTag.set(currentTag, (requestsByTag.get(currentTag) ?? 0) + 1);
    return route.fulfill({ contentType: "application/json", body });
  });

  await openHarness(page, `?chart=${encodeURIComponent(MARKET)}&timeframe=15m&type=footprint&priceStep=10&gpu=${backend}`);
  const hook = page.locator('[data-testid="chart-hook"]');
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  await expect(hook).toHaveAttribute("data-gpu-backend", backend);

  const perTf: Record<string, {
    coldFirstCandleMs: number[];
    coldHistoryReadyMs: number[];
    coldBytes: number;
    coldAborts: number;
    warmFirstCandleMs: number[];
    warmHistoryReadyMs: number[];
    warmBytes: number;
    warmAborts: number;
  }> = {};
  for (const tf of ALL_TIMEFRAMES) {
    perTf[tf] = {
      coldFirstCandleMs: [],
      coldHistoryReadyMs: [],
      coldBytes: 0,
      coldAborts: 0,
      warmFirstCandleMs: [],
      warmHistoryReadyMs: [],
      warmBytes: 0,
      warmAborts: 0,
    };
  }

  // Enable telemetry in browser
  await page.evaluate(async () => {
    const telemetry = await import("/src/core/performanceTelemetry.ts");
    telemetry.configurePerformanceTelemetry({ enabled: true });
    telemetry.resetPerformanceTelemetry();
  });

  for (const mode of ["cold", "warm"] as const) {
    cacheMode = mode;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      for (const tf of ALL_TIMEFRAMES) {
        currentTag = `${mode}:${tf}:${iter}`;
        bytesByTag.set(currentTag, 0);
        requestsByTag.set(currentTag, 0);
        const switchResult = await page.evaluate(async ({ tf }) => {
          const harness = await import("/harness/chart.ts");
          const telemetry = await import("/src/core/performanceTelemetry.ts");
          const r = harness.getChartRuntime("harness-chart")!;
          // Ensure switching to the same tf in sequence resets via a neighbor first if needed.
          if (r.getState().timeframe === tf) {
            r.updateState({ ...r.getState(), timeframe: tf === "1m" ? "5m" : "1m" });
            await new Promise<void>((resolve) => {
              const check = () => {
                const hook = document.querySelector('[data-testid="chart-hook"]');
                if (hook?.getAttribute("data-history-loading") === "false") resolve();
                else setTimeout(check, 5);
              };
              check();
            });
          }
          telemetry.resetPerformanceTelemetry();
          const t0 = performance.now();
          r.updateState({ ...r.getState(), timeframe: tf });
          await new Promise<void>((resolve) => {
            const deadline = performance.now() + 10_000;
            const check = () => {
              const snap = telemetry.snapshotSwitchTelemetry();
              const firstPainted = snap.marks.find((m) => m.name === "chart:first-candle-painted" && m.timeframe === tf);
              const historyReady = snap.marks.find((m) => m.name === "chart:history-ready" && m.timeframe === tf);
              const hookEl = document.querySelector('[data-testid="chart-hook"]');
              if ((firstPainted && historyReady && hookEl?.getAttribute("data-history-loading") === "false") || performance.now() > deadline) {
                resolve();
              } else {
                requestAnimationFrame(check);
              }
            };
            requestAnimationFrame(check);
          });
          const snap = telemetry.snapshotSwitchTelemetry();
          const firstPainted = snap.marks.find((m) => m.name === "chart:first-candle-painted" && m.timeframe === tf);
          const historyReady = snap.marks.find((m) => m.name === "chart:history-ready" && m.timeframe === tf);
          const aborts = snap.jobs.filter((j) => j.phase === "aborted").length;
          return {
            firstCandleMs: firstPainted ? Math.max(0, firstPainted.atMs - t0) : null,
            historyReadyMs: historyReady ? Math.max(0, historyReady.atMs - t0) : null,
            aborts,
            seriesLen: r.getAnalysisSnapshot ? harness.getChartRuntime("harness-chart")!.getState().timeframe : tf,
          };
        }, { tf });

        expect(switchResult.firstCandleMs, `${backend} ${mode} ${tf} firstCandle`).not.toBeNull();
        expect(switchResult.historyReadyMs, `${backend} ${mode} ${tf} historyReady`).not.toBeNull();
        const bytes = bytesByTag.get(currentTag) ?? 0;
        if (mode === "cold") {
          perTf[tf].coldFirstCandleMs.push(switchResult.firstCandleMs!);
          perTf[tf].coldHistoryReadyMs.push(switchResult.historyReadyMs!);
          perTf[tf].coldBytes += bytes;
          perTf[tf].coldAborts += switchResult.aborts;
        } else {
          perTf[tf].warmFirstCandleMs.push(switchResult.firstCandleMs!);
          perTf[tf].warmHistoryReadyMs.push(switchResult.historyReadyMs!);
          perTf[tf].warmBytes += bytes;
          perTf[tf].warmAborts += switchResult.aborts;
        }
      }
    }
  }

  // Rapid switches: 1m -> 1d -> 15m and 1w -> 12M -> 5m with held stale responses + live trade merge check
  currentTag = "rapid-1";
  holdIntervalMs = 24 * 60 * 60_000; // hold 1d
  await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts");
    const telemetry = await import("/src/core/performanceTelemetry.ts");
    telemetry.resetPerformanceTelemetry();
    const r = harness.getChartRuntime("harness-chart")!;
    r.updateState({ ...r.getState(), timeframe: "1m" });
    r.updateState({ ...r.getState(), timeframe: "1d" });
    r.updateState({ ...r.getState(), timeframe: "15m" });
  });
  await expect(hook).toHaveAttribute("data-timeframe", "15m");
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  for (const gate of delayedGates) gate.release();
  delayedGates = [];
  holdIntervalMs = null;

  const rapid1Check = await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts");
    const telemetry = await import("/src/core/performanceTelemetry.ts");
    const r = harness.getChartRuntime("harness-chart")!;
    const hookEl = document.querySelector('[data-testid="chart-hook"]')!;
    const interval = Number(hookEl.getAttribute("data-series-interval"));
    // Push a live trade into the open bucket and verify open + closed merge.
    const now = Date.now();
    harness.harnessChart?.services.pushTrade("BINANCE_FUTURES:btcusdt", {
      id: "999999",
      time: now,
      price: 60125,
      qty: 1.5,
      isBuy: true,
      liquidation: false,
      market: "BINANCE_FUTURES:btcusdt",
      source: "live",
      receivedAt: now,
    });
    await new Promise((res) => setTimeout(res, 60));
    const snap = telemetry.snapshotSwitchTelemetry();
    const counters = telemetry.snapshotPerformanceTelemetry().counters;
    return {
      timeframe: r.getState().timeframe,
      interval,
      seriesLen: Number(hookEl.getAttribute("data-series-len")),
      aborts: snap.jobs.filter((j) => j.phase === "aborted").length,
      cacheHits: counters["pipeline.history.cache.hit"] ?? 0,
      repeatedRanges: counters["pipeline.history.request.repeated_range"] ?? 0,
    };
  });
  expect(rapid1Check.timeframe).toBe("15m");
  expect(rapid1Check.interval).toBe(15 * 60_000);
  expect(rapid1Check.seriesLen).toBeGreaterThanOrEqual(BAR_COUNT);
  expect(rapid1Check.aborts).toBeGreaterThanOrEqual(1);

  currentTag = "rapid-2";
  holdIntervalMs = 12 * MONTH_TOKEN_MS; // hold 12M
  await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts");
    const r = harness.getChartRuntime("harness-chart")!;
    r.updateState({ ...r.getState(), timeframe: "1w" });
    r.updateState({ ...r.getState(), timeframe: "12M" });
    r.updateState({ ...r.getState(), timeframe: "5m" });
  });
  await expect(hook).toHaveAttribute("data-timeframe", "5m");
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  for (const gate of delayedGates) gate.release();
  delayedGates = [];
  holdIntervalMs = null;
  const rapid2Interval = await hook.getAttribute("data-series-interval");
  expect(Number(rapid2Interval)).toBe(5 * 60_000);

  const summaryRows = ALL_TIMEFRAMES.map((tf) => {
    const row = perTf[tf];
    return {
      timeframe: tf,
      cold: {
        firstCandleP50Ms: percentile(row.coldFirstCandleMs, 0.5),
        firstCandleP95Ms: percentile(row.coldFirstCandleMs, 0.95),
        historyReadyP50Ms: percentile(row.coldHistoryReadyMs, 0.5),
        historyReadyP95Ms: percentile(row.coldHistoryReadyMs, 0.95),
        aborts: row.coldAborts,
        bytes: Math.round(row.coldBytes / ITERATIONS),
      },
      warm: {
        firstCandleP50Ms: percentile(row.warmFirstCandleMs, 0.5),
        firstCandleP95Ms: percentile(row.warmFirstCandleMs, 0.95),
        historyReadyP50Ms: percentile(row.warmHistoryReadyMs, 0.5),
        historyReadyP95Ms: percentile(row.warmHistoryReadyMs, 0.95),
        aborts: row.warmAborts,
        bytes: Math.round(row.warmBytes / ITERATIONS),
      },
    };
  });

  return {
    backend,
    iterationsPerMode: ITERATIONS,
    timeframes: summaryRows,
    rapid15mCheck: rapid1Check,
    rapid5mIntervalMs: Number(rapid2Interval),
  };
}

test("19 timeframe switch telemetry across WebGL2 and Canvas 2D (#242)", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const webglCtx = await browser.newContext();
  const canvasCtx = await browser.newContext();
  try {
    const webglPage = await webglCtx.newPage();
    const webgl = await runBackendSuite(webglPage, "webgl2");
    const canvasPage = await canvasCtx.newPage();
    const canvas2d = await runBackendSuite(canvasPage, "canvas2d");

    const evidence = {
      issue: 242,
      market: MARKET,
      barsPerLoad: BAR_COUNT,
      webgl2: webgl,
      canvas2d,
    };
    console.log("TF_SWITCH_EVIDENCE", JSON.stringify(evidence));
    await testInfo.attach("timeframe-switch-telemetry-242.json", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });

    expect(webgl.timeframes).toHaveLength(19);
    expect(canvas2d.timeframes).toHaveLength(19);
  } finally {
    await webglCtx.close();
    await canvasCtx.close();
  }
});

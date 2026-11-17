import { expect, test } from "@playwright/test";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import { FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
  viewport: { width: 1280, height: 720 },
});

function buildAligned1mBars(count: number, endAligned: number) {
  const MIN = 60_000;
  const first = endAligned - (count - 1) * MIN;
  return Array.from({ length: count }, (_, idx) => {
    const t = first + idx * MIN;
    const o = 60_000 + (idx % 12) * 10 + Math.floor(idx / 12) * 20;
    const c = o + (idx % 2 === 0 ? 15 : -10);
    const l = Math.min(o, c) - 10;
    const h = Math.max(o, c) + 10;
    return {
      t,
      o,
      h,
      l,
      c,
      v: 30 + (idx % 9),
      d: idx % 2 === 0 ? 6 : -4,
      n: 10 + (idx % 5),
      cells: [
        [l, 4, 5, 0, 0],
        [o, 10 + (idx % 4), 6, 0, 0],
        [h, 5, 3 + (idx % 3), 0, 0],
      ],
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: endAligned,
    };
  });
}

function aggregateWireBars(bars1m: ReturnType<typeof buildAligned1mBars>, intervalMs: number) {
  const buckets = new Map<number, ReturnType<typeof buildAligned1mBars>[number]>();
  for (const bar of bars1m) {
    const start = Math.floor(bar.t / intervalMs) * intervalMs;
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        ...bar,
        t: start,
        cells: bar.cells.map((c) => [...c]),
      });
      continue;
    }
    existing.h = Math.max(existing.h, bar.h);
    existing.l = Math.min(existing.l, bar.l);
    existing.c = bar.c;
    existing.v += bar.v;
    existing.d += bar.d;
    existing.n += bar.n;
    const cellMap = new Map<number, number[]>(existing.cells.map((c) => [c[0], [...c]]));
    for (const c of bar.cells) {
      const prev = cellMap.get(c[0]);
      if (!prev) cellMap.set(c[0], [...c]);
      else {
        prev[1] += c[1];
        prev[2] += c[2];
      }
    }
    existing.cells = [...cellMap.values()].sort((a, b) => a[0] - b[0]);
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

test("ChartRuntime replay parity: TPO (#144), 10 indicators, timeframe round-trip (1m->5m->15m->1m), linked follower, and live unlinked chart", async ({ page }) => {
  test.setTimeout(90_000);
  const MIN = 60_000;
  const endAligned = Math.floor(Date.now() / (15 * MIN)) * (15 * MIN);
  const full1m = buildAligned1mBars(90, endAligned);
  const full5m = aggregateWireBars(full1m, 5 * MIN);
  const full15m = aggregateWireBars(full1m, 15 * MIN);

  // Use exact prefix slicing for oracle market BINANCE_FUTURES:ethusdt (only first 35 bars)
  const oraclePrefix35 = full1m.slice(0, 35);

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });

  await page.route(/\/history(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const market = url.searchParams.get("markets") ?? "";
    const interval = Number(url.searchParams.get("interval") ?? MIN);
    let bars = full1m;
    if (market === "BINANCE_FUTURES:ethusdt") {
      bars = oraclePrefix35;
    } else if (interval === 5 * MIN) {
      bars = full5m;
    } else if (interval === 15 * MIN) {
      bars = full15m;
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { bars },
        meta: {
          schemaVersion: 1,
          generatedAt: Date.now(),
          footprint: { available: true, allowed: true, priceStep: 10 },
          footprintCoverage: {
            status: "complete",
            requestedFrom: bars[0].t,
            requestedTo: bars.at(-1)!.t + interval,
            coveredFrom: bars[0].t,
            coveredThrough: bars.at(-1)!.t + interval,
          },
        },
      }),
    });
  });

  await openHarness(page, "?fit=40");

  const result = await page.evaluate(async ({ full1mTimes, minMs }) => {
    const [harness, { createHarnessServices }, { createIndicatorInstanceAsync }] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
      import("/src/features/indicators/registry.ts"),
    ]);

    const indicatorTypes = [
      "volume-profile",
      "vwap",
      "cvd",
      "volume",
      "rsi",
      "moving-average",
      "bollinger-bands",
      "atr",
      "macd",
      "supertrend",
    ] as const;

    const makeIndicators = async () => Promise.all(indicatorTypes.map((type, idx) => createIndicatorInstanceAsync(type, idx)));

    const waitReady = async (panelId: string, surface: any, minBars: number) => {
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        const rt = harness.getChartRuntime(panelId);
        if (rt && rt.pipeline.series.length >= minBars && !surface.historyOverlay && !surface.historyBackground) return rt;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for ${panelId}`);
    };

    const serializeBars = (rt: any) =>
      rt.pipeline.series.listReadonly().map((b: any) => ({
        startTime: b.startTime,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        delta: b.delta,
        cells: [...b.cells.entries()].sort((a, b2) => a[0] - b2[0]),
      }));

    // Mount 3 active charts: Replay Owner (btcusdt), Fresh Oracle (ethusdt = prefix35), Independent Live (solusdt)
    const mounts: Array<{ id: string; root: HTMLDivElement; handle: { dispose(): void; updateState(s: ChartPanelState): void }; svc: any }> = [];
    const mountPanel = async (id: string, market: string, left: number, top: number, chartType: ChartPanelState["chartType"], withInds: boolean) => {
      const root = document.createElement("div");
      root.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:420px;height:350px;`;
      document.body.appendChild(root);
      const svc = createHarnessServices({ priceStep: 10, priceStepResolved: true });
      const inds = withInds ? await makeIndicators() : [];
      const state: ChartPanelState = {
        type: "chart",
        market,
        timeframe: "1m",
        scaleMode: "linear",
        chartType,
        candles: true,
        indicators: inds,
      };
      const surface = harness.createChartSurfaceModel();
      const handle = harness.mountChart(root, state, svc, id, surface);
      mounts.push({ id, root, handle, svc });
      return { root, handle, svc, state, surface };
    };

    try {
      const owner = await mountPanel("r-owner", "BINANCE_FUTURES:btcusdt", 0, 0, "tpo", true);
      const oracle = await mountPanel("r-oracle", "BINANCE_FUTURES:ethusdt", 430, 0, "tpo", true);
      const linked = await mountPanel("r-linked", "BINANCE_FUTURES:btcusdt", 0, 360, "footprint", false);
      const live = await mountPanel("r-live", "BINANCE_FUTURES:solusdt", 430, 360, "footprint", false);

      const rtOwner = await waitReady("r-owner", owner.surface, 90) as any;
      const rtOracle = await waitReady("r-oracle", oracle.surface, 35) as any;
      const rtLinked = await waitReady("r-linked", linked.surface, 90) as any;
      const rtLive = await waitReady("r-live", live.surface, 90) as any;

      // Link r-linked to r-owner replay clock
      const unsubLink = rtOwner.subscribeReplayState((snap: any) => {
        rtLinked.applyExternalReplay(snap);
      });

      const liveVolBefore = rtLive.pipeline.series.at(rtLive.pipeline.series.length - 1)!.volume;

      // Forward seek (70) -> backward seek (34) -> step (35) on r-owner
      rtOwner.startReplay();
      rtOwner.replaySeek(full1mTimes[70]);
      await rtOwner.session.captureCompositePng();
      rtOwner.replaySeek(full1mTimes[34]);
      rtOwner.replayStep();
      await rtOwner.session.captureCompositePng();
      await rtOracle.session.captureCompositePng();
      await rtLinked.session.captureCompositePng();

      // Independent unlinked live chart keeps receiving live trades unaffected by replay
      const liveTailTime = rtLive.pipeline.series.at(rtLive.pipeline.series.length - 1)!.startTime + 500;
      live.svc.pushTrade("BINANCE_FUTURES:solusdt", {
        id: "unlinked-live-1",
        time: liveTailTime,
        price: 60_000,
        qty: 7,
        isBuy: true,
        liquidation: false,
        market: "BINANCE_FUTURES:solusdt",
        source: "live",
        receivedAt: liveTailTime + 1,
      });
      await new Promise((r) => setTimeout(r, 40));
      await new Promise((r) => requestAnimationFrame(r));
      const liveVolAfter = rtLive.pipeline.series.at(rtLive.pipeline.series.length - 1)!.volume;

      // Compare TPO cache groups, 10 indicator snapshots, pane header labels & bars/cells parity between r-owner (35 via backward seek+step) and r-oracle (fresh 35)
      const linkedLength = rtLinked.pipeline.series.length;
      const ownerBars35 = serializeBars(rtOwner);
      const oracleBars35 = serializeBars(rtOracle);
      const ownerTpoGroups = (rtOwner.overlay?.tpoCache?.groups ?? []).map((g: any) => g.result);
      const oracleTpoGroups = (rtOracle.overlay?.tpoCache?.groups ?? []).map((g: any) => g.result);
      const ownerHeaders = owner.surface.indicatorHeaders.panes.map((p: any) => ({ id: p.id, label: p.label }));
      const oracleHeaders = oracle.surface.indicatorHeaders.panes.map((p: any) => ({ id: p.id, label: p.label }));
      const ownerIndSnapshots = rtOwner.indicatorController.getAnalysisSnapshots(rtOwner.pipeline.series, [0, 35], 35);
      const oracleIndSnapshots = rtOracle.indicatorController.getAnalysisSnapshots(rtOracle.pipeline.series, [0, 35], 35);

      // Timeframe round-trip during active replay at mid-15m timestamp (index 37 -> virtualTime = T0 + 37m)
      rtOwner.replaySeek(full1mTimes[37]);
      const vtBeforeTf = rtOwner.getReplaySnapshot()!.virtualTime;

      const waitTf = async (expectedInterval: number) => {
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
          if (rtOwner.pipeline.intervalMs === expectedInterval && rtOwner.pipeline.series.length > 0) {
            await new Promise((r) => setTimeout(r, 80));
            return;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`Timed out waiting for interval ${expectedInterval}`);
      };

      owner.handle.updateState({ ...rtOwner.getState(), timeframe: "5m" });
      await waitTf(5 * minMs);
      const snap5m = rtOwner.getReplaySnapshot()!;
      const bars5m = serializeBars(rtOwner);

      owner.handle.updateState({ ...rtOwner.getState(), timeframe: "15m" });
      await waitTf(15 * minMs);
      const snap15m = rtOwner.getReplaySnapshot()!;
      const bars15m = serializeBars(rtOwner);

      owner.handle.updateState({ ...rtOwner.getState(), timeframe: "1m" });
      await waitTf(minMs);
      const snapBack1m = rtOwner.getReplaySnapshot()!;
      const barsBack1m = serializeBars(rtOwner);

      unsubLink();
      rtOwner.exitReplay();

      return {
        ownerBars35,
        oracleBars35,
        ownerTpoGroups,
        oracleTpoGroups,
        ownerHeadersCount: ownerHeaders.length,
        oracleHeadersCount: oracleHeaders.length,
        ownerHeadersLabels: ownerHeaders.map((h: any) => h.label),
        oracleHeadersLabels: oracleHeaders.map((h: any) => h.label),
        ownerIndSnapshots,
        oracleIndSnapshots,
        linkedLength,
        liveVolDelta: liveVolAfter - liveVolBefore,
        vtBeforeTf,
        tf5m: { vt: snap5m.virtualTime, count: bars5m.length, maxEnd: Math.max(...bars5m.map((b: any) => b.startTime + 5 * minMs)) },
        tf15m: { vt: snap15m.virtualTime, count: bars15m.length, maxEnd: Math.max(...bars15m.map((b: any) => b.startTime + 15 * minMs)) },
        tfBack1m: { vt: snapBack1m.virtualTime, count: barsBack1m.length },
      };
    } finally {
      for (const m of mounts) {
        m.handle.dispose();
        m.root.remove();
      }
    }
  }, { full1mTimes: full1m.map((b) => b.t), minMs: MIN });

  expect(result.liveVolDelta).toBe(7);
  expect(result.linkedLength).toBe(35);
  expect(result.ownerBars35).toEqual(result.oracleBars35);
  expect(result.ownerTpoGroups.length).toBeGreaterThan(0);
  expect(result.ownerTpoGroups).toEqual(result.oracleTpoGroups);
  expect(result.ownerHeadersCount).toBe(result.oracleHeadersCount);
  expect(result.ownerHeadersLabels).toEqual(result.oracleHeadersLabels);
  expect(result.ownerIndSnapshots).toEqual(result.oracleIndSnapshots);
  expect(result.tf5m.vt).toBe(result.vtBeforeTf);
  expect(result.tf5m.maxEnd).toBeLessThanOrEqual(result.vtBeforeTf);
  expect(result.tf15m.vt).toBe(result.vtBeforeTf);
  expect(result.tf15m.maxEnd).toBeLessThanOrEqual(result.vtBeforeTf);
  expect(result.tfBack1m.vt).toBe(result.vtBeforeTf);
  expect(result.tfBack1m.count).toBe(37);
});

test("BROWSER PROBE: ChartRuntime drawing overlay skips future drawings (> virtualTime) during replay", async ({ page }) => {
  test.setTimeout(60_000);
  const MIN = 60_000;
  const endAligned = Math.floor(Date.now() / (15 * MIN)) * (15 * MIN);
  const full1m = buildAligned1mBars(60, endAligned);

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });
  await page.route(/\/history(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { bars: full1m },
        meta: {
          schemaVersion: 1,
          generatedAt: Date.now(),
          footprint: { available: true, allowed: true, priceStep: 10 },
          footprintCoverage: { status: "complete", requestedFrom: full1m[0].t, requestedTo: endAligned + MIN, coveredFrom: full1m[0].t, coveredThrough: endAligned + MIN },
        },
      }),
    }),
  );

  await openHarness(page, "?fit=40");
  const probe = await page.evaluate(async ({ futureT1, futureT2, seekT }) => {
    const [harness, { createHarnessServices }] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
    ]);
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:0;top:0;width:800px;height:400px;";
    document.body.appendChild(root);
    const svc = createHarnessServices({ priceStep: 10, priceStepResolved: true });
    svc.drawings.setMarket("BINANCE_FUTURES:btcusdt");
    const probeSurface = harness.createChartSurfaceModel();
    const handle = harness.mountChart(root, {
      type: "chart",
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1m",
      scaleMode: "linear",
      chartType: "candlestick",
      candles: true,
    } as any, svc, "browser-probe-draw", probeSurface);

    try {
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        const rt = harness.getChartRuntime("browser-probe-draw");
        if (rt && rt.pipeline.series.length >= 60 && !probeSurface.historyOverlay && !probeSurface.historyBackground) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const rt = harness.getChartRuntime("browser-probe-draw") as any;
      rt.startReplay();
      rt.replaySeek(seekT);

      // Attach a drawing strictly anchored in the future (> seekT)
      svc.drawings.replace([{
        id: "future-trend-browser",
        type: "trend",
        market: "BINANCE_FUTURES:btcusdt",
        color: "#ff0000",
        lineWidth: 2,
        lineStyle: "solid",
        visible: true,
        points: [
          { time: futureT1, price: 60_050 },
          { time: futureT2, price: 60_150 },
        ],
      }]);

      // Pan slightly right into empty future canvas space so futureT1..futureT2 sit inside viewport width
      rt.view.offsetX -= 450;
      const annotationCanvas = root.querySelector('[data-chart-surface="annotation"]') as HTMLCanvasElement;
      const ctx2d = annotationCanvas.getContext("2d")!;
      const drawnXs: number[] = [];
      const origMoveTo = ctx2d.moveTo.bind(ctx2d);
      ctx2d.moveTo = function (x: number, y: number) {
        drawnXs.push(x);
        return origMoveTo(x, y);
      };
      const lastVisibleX = rt.view.xOfIndex(rt.pipeline.series.length - 1);
      rt.invalidate();
      await rt.session.captureCompositePng();
      const futureStrokesBeyondLastBar = drawnXs.filter((x) => x > lastVisibleX + 5).length;
      return { lastVisibleX, futureStrokesBeyondLastBar };
    } finally {
      handle.dispose();
      root.remove();
    }
  }, { seekT: full1m[25].t, futureT1: full1m[45].t, futureT2: full1m[55].t });

  console.log("BROWSER_PROBE_FUTURE_DRAWING", JSON.stringify(probe));
  expect(probe.futureStrokesBeyondLastBar).toBe(0);
});

import { expect, test } from "@playwright/test";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import { FUNCTIONAL_WEBGL_ARGS, FROZEN_NOW, INTERVAL_MS, openHarness } from "./support/history.js";

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

test("a late two-phase history response cannot extend the active replay series", async ({ page }) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  const liveBucket = Math.floor(FROZEN_NOW / INTERVAL_MS) * INTERVAL_MS;
  const fastBars = [liveBucket - 4 * INTERVAL_MS, liveBucket - 3 * INTERVAL_MS].map((t, index) => ({
    t,
    o: 60_000 + index * 10,
    h: 60_030 + index * 10,
    l: 59_990 + index * 10,
    c: 60_020 + index * 10,
    v: 3,
    d: 1,
    n: 2,
    cells: [[60_000 + index * 10, 2, 1, 0, 0]],
    completeness: "complete" as const,
    updatedAt: FROZEN_NOW,
  }));
  const phase2Bars = [
    ...fastBars,
    {
      ...fastBars[1]!,
      t: liveBucket - 2 * INTERVAL_MS,
      o: 60_040,
      h: 60_070,
      l: 60_030,
      c: 60_060,
      cells: [[60_040, 2, 1, 0, 0]],
    },
  ];
  let phase2StartedResolve!: () => void;
  let phase2Release!: () => void;
  let phase2SettledResolve!: () => void;
  let phase2Requested = false;
  const phase2Started = new Promise<void>((resolve) => { phase2StartedResolve = resolve; });
  const phase2Gate = new Promise<void>((resolve) => { phase2Release = resolve; });
  const phase2Settled = new Promise<void>((resolve) => { phase2SettledResolve = resolve; });

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });
  await page.route(/\/history(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const streamedPhase2 = url.searchParams.get("stream") === "1";
    if (streamedPhase2) {
      phase2Requested = true;
      phase2StartedResolve();
      await phase2Gate;
      try {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: { bars: phase2Bars } }),
        });
      } catch {
        // Replay intentionally aborts the in-flight fetch. The late fixture response
        // is still released below to exercise the stale-result boundary.
      } finally {
        phase2SettledResolve();
      }
      return;
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { bars: fastBars } }),
    });
  });
  await openHarness(page);

  await page.evaluate(async () => {
    const [harness, { createHarnessServices }] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
    ]);
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:0;top:0;width:640px;height:480px";
    document.body.appendChild(root);
    const surface = harness.createChartSurfaceModel();
    const state = { type: "chart", market: "BINANCE_FUTURES:btcusdt", timeframe: "15m", scaleMode: "linear" } as const;
    const svc = createHarnessServices({ priceStep: 10, priceStepResolved: true });
    const handle = harness.mountChart(root, state, svc, "replay-phase2-race", surface);
    (window as any).__replayPhase2Race = { harness, handle, root, surface };
  });
  await phase2Started;
  let before: { historyBackground: boolean; replayTarget: number; maxEnd: number; barEnds: number[] } | null = null;
  try {
    await page.waitForFunction(() => {
      const fixture = (window as any).__replayPhase2Race;
      const runtime = fixture?.harness.getChartRuntime("replay-phase2-race");
      return Boolean(runtime && fixture.surface.historyBackground && runtime.pipeline.series.length >= 2);
    });

    before = await page.evaluate(({ intervalMs }) => {
      const fixture = (window as any).__replayPhase2Race;
      const runtime = fixture.harness.getChartRuntime("replay-phase2-race");
    const historyBackground = fixture.surface.historyBackground;
      runtime.startReplay();
      const snapshot = runtime.getReplaySnapshot();
      const replayTarget = snapshot.rangeStart + 2 * intervalMs;
      runtime.replaySeek(replayTarget);
      const bars = runtime.pipeline.series.listReadonly().map((bar: any) => bar.startTime + runtime.pipeline.intervalMs);
      return {
      historyBackground,
        replayTarget,
        maxEnd: Math.max(...bars),
        barEnds: bars,
      };
    }, { intervalMs: INTERVAL_MS });
  } finally {
    phase2Release();
    if (phase2Requested) await phase2Settled;
  }
  await page.waitForFunction(() => {
    const fixture = (window as any).__replayPhase2Race;
    return fixture && !fixture.surface.historyBackground && !fixture.surface.historyOverlay;
  });
  if (!before) throw new Error("Replay snapshot was not captured before releasing phase 2");
  expect(before.historyBackground).toBe(true);
  expect(before.maxEnd).toBeLessThanOrEqual(before.replayTarget);
  const after = await page.evaluate(() => {
    const fixture = (window as any).__replayPhase2Race;
    const runtime = fixture.harness.getChartRuntime("replay-phase2-race");
    const replayTarget = runtime.getReplaySnapshot().virtualTime;
    const barEnds = runtime.pipeline.series.listReadonly().map((bar: any) => bar.startTime + runtime.pipeline.intervalMs);
    return { replayTarget, maxEnd: Math.max(...barEnds), barEnds };
  });
  expect(after.maxEnd).toBeLessThanOrEqual(after.replayTarget);
  expect(after.barEnds).toEqual(before.barEnds);
  await page.evaluate(() => {
    const fixture = (window as any).__replayPhase2Race;
    fixture.handle.dispose();
    fixture.root.remove();
    delete (window as any).__replayPhase2Race;
  });
});

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

  const stripTransientIndicatorMeta = (snapshots: any[]) =>
    snapshots.map((snap) => ({
      ...snap,
      instanceId: "<id>",
      series: Array.isArray(snap.series)
        ? snap.series.map((s: any) => ({
            ...s,
            label: snap.type === "volume" && s.key === "volume" ? "<base>" : s.label,
          }))
        : snap.series,
    }));

  expect(result.liveVolDelta).toBe(7);
  expect(result.linkedLength).toBe(35);
  expect(result.ownerBars35).toEqual(result.oracleBars35);
  expect(result.ownerTpoGroups.length).toBeGreaterThan(0);
  expect(result.ownerTpoGroups).toEqual(result.oracleTpoGroups);
  expect(result.ownerHeadersCount).toBe(result.oracleHeadersCount);
  expect(result.ownerHeadersLabels).toEqual(result.oracleHeadersLabels);
  expect(stripTransientIndicatorMeta(result.ownerIndSnapshots)).toEqual(
    stripTransientIndicatorMeta(result.oracleIndSnapshots),
  );
  expect(result.tf5m.vt).toBe(result.vtBeforeTf);
  expect(result.tf5m.maxEnd).toBeLessThanOrEqual(result.vtBeforeTf);
  expect(result.tf15m.vt).toBe(result.vtBeforeTf);
  expect(result.tf15m.maxEnd).toBeLessThanOrEqual(result.vtBeforeTf);
  expect(result.tfBack1m.vt).toBe(result.vtBeforeTf);
  expect(result.tfBack1m.count).toBe(37);
});

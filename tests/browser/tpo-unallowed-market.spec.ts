import { expect, test } from "@playwright/test";
import type { ChartPanelState, ChartType } from "../../src/core/chartPanelState.js";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, openHarness, type WireBar } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
  viewport: { width: 1200, height: 720 },
});

const ALLOWED_MARKET = "BINANCE_FUTURES:btcusdt";
const UNALLOWED_MARKET = "BYBIT:solusdt";

function buildPairedBars(count: number): { ohlcvBars: WireBar[]; footprintBars: WireBar[] } {
  const intervalMs = 30 * 60_000;
  const start = Math.floor(FROZEN_NOW / intervalMs) * intervalMs - (count - 1) * intervalMs;
  const ohlcvBars: WireBar[] = [];
  const footprintBars: WireBar[] = [];
  for (let i = 0; i < count; i++) {
    const t = start + i * intervalMs;
    const o = 60_000 + (i % 9) * 10;
    const c = o + (i % 2 === 0 ? 20 : -10);
    const l = Math.min(o, c) - 20;
    const h = Math.max(o, c) + 30;
    ohlcvBars.push({
      t,
      o,
      h,
      l,
      c,
      v: 25,
      d: 0,
      n: 0,
      cells: [],
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: FROZEN_NOW,
    });
    footprintBars.push({
      t,
      o,
      h,
      l,
      c,
      v: 25,
      d: 5,
      n: 12,
      cells: [
        [l, 5, 3, 0, 0],
        [o, 7, 5, 0, 0],
        [h, 3, 2, 0, 0],
      ],
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: FROZEN_NOW,
    });
  }
  return { ohlcvBars, footprintBars };
}

test("unallowed OHLCV markets support TPO with zero extra requests, pair-type persistence, and identical POC/VAH/VAL", async ({ page }) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  const { ohlcvBars, footprintBars } = buildPairedBars(120);
  const historyRequests: Array<{ market: string; includeFootprint: string | null; purpose: string | null }> = [];

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });

  await page.route(/\/history(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const market = (url.searchParams.get("markets") ?? "").toUpperCase();
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    historyRequests.push({
      market,
      includeFootprint: url.searchParams.get("includeFootprint"),
      purpose: url.searchParams.get("purpose"),
    });
    if (market.startsWith("BINANCE_FUTURES:")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: { bars: footprintBars },
          meta: {
            schemaVersion: 1,
            generatedAt: FROZEN_NOW,
            footprint: { available: true, allowed: true, priceStep: 10 },
            footprintCoverage: {
              status: "complete",
              requestedFrom: Number.isFinite(from) ? from : footprintBars[0].t,
              requestedTo: Number.isFinite(to) ? to : footprintBars[footprintBars.length - 1].t,
              coveredFrom: footprintBars[0].t,
              coveredThrough: footprintBars[footprintBars.length - 1].t + 30 * 60_000,
            },
          },
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { bars: ohlcvBars },
        meta: {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          footprint: { available: false, allowed: false, priceStep: 10 },
        },
      }),
    });
  });

  await openHarness(page, "?fit=120");

  const evidence = await page.evaluate(async ({ allowedMarket, unallowedMarket }) => {
    const [harness, { createHarnessServices }, { chartHost }] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
      import("/src/features/chart/chartHost.ts"),
    ]);

    const nextFrames = async (count = 3) => {
      for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    };

    const waitReady = async (panelId: string, expectedMarket: string) => {
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        const rt = harness.getChartRuntime(panelId);
        if (rt && rt.getState().market === expectedMarket && rt.pipeline.series.length >= 120) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 80));
      await nextFrames(4);
    };

    const readTpoSummary = (rt: NonNullable<ReturnType<typeof harness.getChartRuntime>>) => {
      const overlay = Reflect.get(rt, "overlay") as {
        tpoCache?: {
          groups?: Array<{
            result: {
              poc: number | null;
              vah: number | null;
              val: number | null;
              totalCount: number;
              levels: Array<{ priceBin: number; count: number }>;
            };
          }>;
        } | null;
        getTpoProfileAt(x: number, y: number): unknown;
      };
      const groups = overlay?.tpoCache?.groups ?? [];
      return {
        hitZone: overlay?.getTpoProfileAt(rt.view.xOfIndex(10), rt.view.area.top + 10) ?? null,
        groups: groups.map((g) => ({
          poc: g.result.poc,
          vah: g.result.vah,
          val: g.result.val,
          totalCount: g.result.totalCount,
          levels: g.result.levels.map((l) => ({ priceBin: l.priceBin, count: l.count })),
        })),
      };
    };

    let autoSyncCalls = 0;
    const emittedStates: Array<{ market: string; chartType?: ChartType }> = [];
    const host = chartHost();

    // 1. Direct mount of unallowed market with chartType: "tpo" + switching candlestick <-> tpo <-> footprint.
    const rootA = document.createElement("div");
    rootA.style.cssText = "position:fixed;left:0;top:0;width:600px;height:680px;";
    document.body.appendChild(rootA);
    const svcA = createHarnessServices({ priceStep: 10, priceStepResolved: true });
    const wrapSvcA = {
      ...svcA,
      triggerAutoSync() {
        autoSyncCalls += 1;
      },
    };
    const handleA = harness.mountChart(
      rootA,
      {
        type: "chart",
        market: unallowedMarket,
        timeframe: "30m",
        scaleMode: "linear",
        chartType: "tpo",
        tpoMode: "blocks",
        tpoProfilePeriod: "daily",
        tpoBracketSize: "30m",
        candles: true,
      },
      wrapSvcA,
      "unallowed-a",
      harness.createChartSurfaceModel(),
      (next) => {
        emittedStates.push({ market: next.market, chartType: next.chartType });
      },
    );
    await waitReady("unallowed-a", unallowedMarket);
    const rtA = harness.getChartRuntime("unallowed-a")!;
    const afterInitialMount = {
      stateType: rtA.getState().chartType,
      persistableType: rtA.getPersistableState().chartType,
      tpo: readTpoSummary(rtA),
      emittedCount: emittedStates.length,
    };

    // Mount allowed market with identical OHLC bars to compare POC/VAH/VAL.
    const rootRef = document.createElement("div");
    rootRef.style.cssText = "position:fixed;left:600px;top:0;width:600px;height:680px;";
    document.body.appendChild(rootRef);
    const svcRef = createHarnessServices({ priceStep: 10, priceStepResolved: true });
    const handleRef = harness.mountChart(
      rootRef,
      {
        type: "chart",
        market: allowedMarket,
        timeframe: "30m",
        scaleMode: "linear",
        chartType: "tpo",
        tpoMode: "blocks",
        tpoProfilePeriod: "daily",
        tpoBracketSize: "30m",
        candles: true,
      },
      svcRef,
      "allowed-ref",
      harness.createChartSurfaceModel(),
    );
    await waitReady("allowed-ref", allowedMarket);
    const rtRef = harness.getChartRuntime("allowed-ref")!;
    const allowedTpo = readTpoSummary(rtRef);
    handleRef.dispose();
    rootRef.remove();

    // Quiesce resource timing entries before measuring toggleResourceDelta.
    const quiesceDeadline = performance.now() + 2_000;
    let prevResCount = performance.getEntriesByType("resource").length;
    while (performance.now() < quiesceDeadline) {
      await new Promise((r) => setTimeout(r, 50));
      await nextFrames(2);
      const nextResCount1 = performance.getEntriesByType("resource").length;
      await new Promise((r) => setTimeout(r, 50));
      await nextFrames(2);
      const nextResCount2 = performance.getEntriesByType("resource").length;
      if (nextResCount1 === prevResCount && nextResCount2 === prevResCount) break;
      prevResCount = nextResCount2;
    }

    // Measure requests around candlestick -> tpo -> candlestick and forced footprint on unallowed market.
    const resCountBeforeToggles = performance.getEntriesByType("resource").length;
    const autoSyncBeforeToggles = autoSyncCalls;

    rtA.setChartType("candlestick");
    await nextFrames(2);
    const afterExplicitCandle = {
      stateType: rtA.getState().chartType,
      persistableType: rtA.getPersistableState().chartType,
    };

    rtA.setChartType("tpo");
    await nextFrames(3);
    const afterBackToTpo = {
      stateType: rtA.getState().chartType,
      persistableType: rtA.getPersistableState().chartType,
      savedPairType: host.getPairChartType(unallowedMarket),
    };

    rtA.setChartType("candlestick");
    await nextFrames(2);
    const afterReturnFromTpoToCandle = {
      stateType: rtA.getState().chartType,
      persistableType: rtA.getPersistableState().chartType,
      savedPairType: host.getPairChartType(unallowedMarket),
    };

    // Footprint types on unallowed market must clamp to candlestick without overwriting a saved TPO choice.
    rtA.setChartType("tpo");
    await nextFrames(2);
    rtA.setChartType("footprint");
    await nextFrames(2);
    const afterForcedFootprint = {
      stateType: rtA.getState().chartType,
      persistableType: rtA.getPersistableState().chartType,
      savedPairType: host.getPairChartType(unallowedMarket),
    };

    const resCountAfterToggles = performance.getEntriesByType("resource").length;
    const autoSyncAfterToggles = autoSyncCalls;

    // 2. Market switching flow: allowed B (footprint) -> unallowed A (tpo) -> B (restores footprint) -> A (restores tpo).
    const rootSwitch = document.createElement("div");
    rootSwitch.style.cssText = "position:fixed;left:0;top:0;width:600px;height:680px;";
    document.body.appendChild(rootSwitch);
    const svcSwitch = createHarnessServices({ priceStep: 10, priceStepResolved: true });
    let switchAutoSync = 0;
    const wrapSvcSwitch = {
      ...svcSwitch,
      triggerAutoSync() {
        switchAutoSync += 1;
      },
    };
    const handleSwitch = harness.mountChart(
      rootSwitch,
      {
        type: "chart",
        market: allowedMarket,
        timeframe: "30m",
        scaleMode: "linear",
        chartType: "footprint",
        tpoMode: "blocks",
        tpoProfilePeriod: "daily",
        tpoBracketSize: "30m",
        candles: true,
      },
      wrapSvcSwitch,
      "switch-chart",
      harness.createChartSurfaceModel(),
    );
    await waitReady("switch-chart", allowedMarket);
    const rtSwitch = harness.getChartRuntime("switch-chart")!;
    const step1AllowedFootprint = rtSwitch.getState().chartType;

    // Switch to unallowed market (no saved pair type yet -> forced candlestick, then pick TPO).
    const freshUnallowed = "OKX:ethusdt";
    handleSwitch.updateState({ ...rtSwitch.getState(), market: freshUnallowed });
    await waitReady("switch-chart", freshUnallowed);
    const step2ForcedCandleOnFreshUnallowed = {
      stateType: rtSwitch.getState().chartType,
      persistableType: rtSwitch.getPersistableState().chartType,
    };

    rtSwitch.setChartType("tpo");
    await nextFrames(3);
    const step3PickedTpoOnFreshUnallowed = {
      stateType: rtSwitch.getState().chartType,
      persistableType: rtSwitch.getPersistableState().chartType,
      savedPairType: host.getPairChartType(freshUnallowed),
    };

    const syncBeforeReturnB = switchAutoSync;
    handleSwitch.updateState({ ...rtSwitch.getState(), market: allowedMarket });
    await waitReady("switch-chart", allowedMarket);
    const step4BackToAllowedB = {
      market: rtSwitch.getState().market,
      stateType: rtSwitch.getState().chartType,
      savedFreshUnallowedType: host.getPairChartType(freshUnallowed),
    };

    const syncBeforeReturnA = switchAutoSync;
    handleSwitch.updateState({ ...rtSwitch.getState(), market: freshUnallowed });
    await waitReady("switch-chart", freshUnallowed);
    const step5BackToUnallowedA = {
      market: rtSwitch.getState().market,
      stateType: rtSwitch.getState().chartType,
      persistableType: rtSwitch.getPersistableState().chartType,
      autoSyncDeltaOnUnallowedSwitch: switchAutoSync - syncBeforeReturnA,
    };

    handleA.dispose();
    handleSwitch.dispose();
    rootA.remove();
    rootSwitch.remove();

    return {
      afterInitialMount,
      allowedTpo,
      afterExplicitCandle,
      afterBackToTpo,
      afterReturnFromTpoToCandle,
      afterForcedFootprint,
      toggleResourceDelta: resCountAfterToggles - resCountBeforeToggles,
      toggleAutoSyncDelta: autoSyncAfterToggles - autoSyncBeforeToggles,
      step1AllowedFootprint,
      step2ForcedCandleOnFreshUnallowed,
      step3PickedTpoOnFreshUnallowed,
      step4BackToAllowedB,
      step5BackToUnallowedA,
      syncBeforeReturnB,
    };
  }, { allowedMarket: ALLOWED_MARKET, unallowedMarket: UNALLOWED_MARKET });

  // 1. Unallowed market renders TPO, preserves persistable chartType === "tpo", and matches allowed POC/VAH/VAL.
  expect(evidence.afterInitialMount.stateType).toBe("tpo");
  expect(evidence.afterInitialMount.persistableType).toBe("tpo");
  expect(evidence.afterInitialMount.tpo.hitZone).toBeTruthy();
  expect(evidence.afterInitialMount.tpo.groups.length).toBeGreaterThan(1);
  expect(evidence.afterInitialMount.tpo.groups).toEqual(evidence.allowedTpo.groups);

  // 2. Switching candlestick <-> tpo <-> candlestick updates pair memory cleanly with 0 network/autoSync requests.
  expect(evidence.afterExplicitCandle.stateType).toBe("candlestick");
  expect(evidence.afterExplicitCandle.persistableType).toBe("candlestick");
  expect(evidence.afterBackToTpo).toEqual({
    stateType: "tpo",
    persistableType: "tpo",
    savedPairType: "tpo",
  });
  expect(evidence.afterReturnFromTpoToCandle).toEqual({
    stateType: "candlestick",
    persistableType: "candlestick",
    savedPairType: "candlestick",
  });
  expect(evidence.afterForcedFootprint).toEqual({
    stateType: "candlestick",
    persistableType: "candlestick",
    savedPairType: "tpo",
  });
  expect(evidence.toggleResourceDelta).toBe(0);
  expect(evidence.toggleAutoSyncDelta).toBe(0);

  // 3. B (footprint) -> A (TPO) -> B (footprint) -> A (TPO) preserves per-market chartType without autoSync backfill on A.
  expect(evidence.step1AllowedFootprint).toBe("footprint");
  expect(evidence.step2ForcedCandleOnFreshUnallowed).toEqual({
    stateType: "candlestick",
    persistableType: "candlestick",
  });
  expect(evidence.step3PickedTpoOnFreshUnallowed).toEqual({
    stateType: "tpo",
    persistableType: "tpo",
    savedPairType: "tpo",
  });
  expect(evidence.step4BackToAllowedB).toEqual({
    market: ALLOWED_MARKET,
    stateType: "footprint",
    savedFreshUnallowedType: "tpo",
  });
  expect(evidence.step5BackToUnallowedA).toEqual({
    market: "OKX:ethusdt",
    stateType: "tpo",
    persistableType: "tpo",
    autoSyncDeltaOnUnallowedSwitch: 0,
  });

  // Verify no history request for unallowed markets asked for backfill rebuild.
  const unallowedRequests = historyRequests.filter((r) => !r.market.startsWith("BINANCE_FUTURES:"));
  expect(unallowedRequests.length).toBeGreaterThan(0);
  expect(unallowedRequests.every((r) => r.purpose !== "__repair_trade_id_v1")).toBe(true);
});

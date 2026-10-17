import { expect, test } from "@playwright/test";
import { installHistory, openHarness } from "./support/history.js";

// T11-A (#329): a replaying chart draws automatic levels as of its replay time, never the
// market's live levels, and hides nPOC. This mounts the real ChartRuntime on mock bridge
// history; its analysis services tag each level with where it came from.
test("a replaying chart takes its automatic levels as of the replay time and hides nPOC", async ({ page }) => {
  test.setTimeout(60_000);
  await installHistory(page);
  // Vite serves source modules whose paths can match the bridge's API patterns (".../markets.ts").
  await openHarness(page);

  const evidence = await page.evaluate(async () => {
    const [
      { mountChart },
      { createChartSurfaceModel },
      { getChartRuntime },
      { DrawingManager },
      { DEFAULT_VOLUME_PROFILE_SETTINGS },
      { normalizePreviousWeekStrategySettings },
      { normalizeMondayRangeSettings },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/chart.ts"),
      import("/harness/chart.ts"),
      import("/src/features/drawings/drawingManager.ts"),
      import("/src/core/analysis/volumeProfile.ts"),
      import("/src/core/analysis/previousWeekStrategy.ts"),
      import("/src/core/analysis/mondayRange.ts"),
    ]);
    type Level = { marker: string };
    type Levels = { previousWeekStrategyLevels: Level[]; mondayRangeLevels: Level[]; referenceLevels: Level[] };

    const market = "BINANCE_FUTURES:btcusdt";
    const tagged = (marker: string): Levels => ({
      previousWeekStrategyLevels: [{ marker }],
      mondayRangeLevels: [{ marker }],
      referenceLevels: [{ marker }],
    });
    // Level settings stay disabled so the layers never draw these marker objects; the test
    // reads which levels the chart hands them.
    const context = {
      market,
      profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
      previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
      mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
      nakedPocs: [],
      drawings: new DrawingManager(() => {}),
      ...tagged("live"),
    };
    let revision = 1;
    let portAvailable = true;
    const asOfCalls: { market: string; asOf: number }[] = [];
    const services = {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 0.1,
      fetchPricePrecision: async () => 1,
      getAnalysisContext: () => context,
      getAnalysisRevisionSnapshot: () => ({
        market,
        revision,
        canonical: { status: "complete", market, runKey: `replay-levels-${revision}`, generation: revision, revision, failedPeriods: [] },
      }),
      getAutomaticLevelsAsOf(name: string, asOf: number) {
        if (!portAvailable) return null;
        asOfCalls.push({ market: name, asOf });
        return tagged(`asof:${asOf}`);
      },
      subscribeAnalysis: () => () => {},
      subscribeAnalysisRevision: () => () => {},
      updateAnalysisFromSeries() {},
      fetchNpocSnapshot: () => new Promise(() => {}),
      notifyActiveMarket() {},
      notifyInteractiveCandlesReady() {},
      notifyInteractiveHistorySettled() {},
      triggerAutoSync() {},
      notifyBarClose() {},
      notify() {},
      isFootprintSyncBusy: () => false,
    };

    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:8px;top:16px;width:640px;height:360px;overflow:hidden;";
    document.body.appendChild(root);
    const panelId = `replay-levels-${Date.now()}`;
    const handle = mountChart(root, {
      type: "chart",
      market,
      timeframe: "1m",
      scaleMode: "linear",
      chartType: "candlestick",
      candles: true,
    } as never, services as never, panelId, createChartSurfaceModel());
    const waitFor = async (predicate: () => boolean, description: string) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${description}`);
    };

    try {
      await waitFor(() => Boolean(getChartRuntime(panelId)), "the chart runtime");
      // The private members are what every analysis layer of the chart reads from.
      const runtime = getChartRuntime(panelId) as unknown as {
        npocMarket: string | null;
        npocLevels: { price: number }[];
        pipeline: { series: { length: number; at(index: number): { startTime: number } } };
        startReplay(): void;
        replaySeek(time: number): void;
        exitReplay(): void;
        getReplaySnapshot(): { virtualTime: number } | null;
        getReplayAutomaticLevels(): Levels | null;
        getNpocLevels(): readonly { price: number }[];
        analysisContextForChart(): Levels & { nakedPocs: { price: number }[] };
      };
      await waitFor(() => runtime.pipeline.series.length > 10, "mock bridge history bars");
      // nPOC arrives from the backend; stand in a loaded level for this market.
      const loadNpoc = () => {
        runtime.npocMarket = market;
        runtime.npocLevels = [{ price: 555 }];
      };
      const markers = () => {
        const ctx = runtime.analysisContextForChart();
        return {
          pw: ctx.previousWeekStrategyLevels.map((level) => level.marker),
          mr: ctx.mondayRangeLevels.map((level) => level.marker),
          ref: ctx.referenceLevels.map((level) => level.marker),
          npoc: ctx.nakedPocs.map((level) => level.price),
        };
      };

      loadNpoc();
      const beforeReplay = markers();
      const series = runtime.pipeline.series;
      const seekTime = series.at(Math.floor(series.length / 2)).startTime;
      runtime.startReplay();
      runtime.replaySeek(seekTime);
      const replayTime = runtime.getReplaySnapshot()!.virtualTime;
      const inReplay = markers();
      const callsAtSeek = asOfCalls.length;
      // Several frames read the context; the as-of levels are computed once per input.
      for (let index = 0; index < 5; index++) runtime.analysisContextForChart();
      const callsAfterRepeatedReads = asOfCalls.length;

      // A canonical run that completes after the seek bumps the analysis revision. The chart
      // recomputes as of the same replay time, not as of now.
      revision++;
      const afterLateCompletion = markers();
      const callsAfterLateCompletion = asOfCalls.slice(callsAfterRepeatedReads);

      // New level settings are a new input too: the levels are recomputed, still as of replay time.
      const callsBeforeSettings = asOfCalls.length;
      context.previousWeekStrategySettings = normalizePreviousWeekStrategySettings({ enabled: false });
      markers();
      const callsAfterPreviousWeekSettings = asOfCalls.slice(callsBeforeSettings);
      context.mondayRangeSettings = normalizeMondayRangeSettings({ enabled: false });
      markers();
      const callsAfterMondaySettings = asOfCalls.slice(callsBeforeSettings);

      // The chart's public getters, read by its Object Tree, agree with what it draws.
      const publicInReplay = {
        levels: runtime.getReplayAutomaticLevels()?.previousWeekStrategyLevels.map((level) => level.marker) ?? null,
        npoc: runtime.getNpocLevels().map((level) => level.price),
      };

      // A host without the port shows no automatic levels in replay rather than the live ones.
      portAvailable = false;
      revision++;
      const withoutPort = markers();
      portAvailable = true;

      runtime.exitReplay();
      loadNpoc();
      const afterExit = markers();
      const publicAfterExit = {
        levels: runtime.getReplayAutomaticLevels(),
        npoc: runtime.getNpocLevels().map((level) => level.price),
      };
      return {
        replayTime,
        seekTime,
        beforeReplay,
        inReplay,
        repeatedReadCalls: callsAfterRepeatedReads - callsAtSeek,
        afterLateCompletion,
        callsAfterLateCompletion,
        callsAfterPreviousWeekSettings,
        callsAfterMondaySettings,
        publicInReplay,
        publicAfterExit,
        withoutPort,
        afterExit,
        asOfMarkets: [...new Set(asOfCalls.map((call) => call.market))],
      };
    } finally {
      handle.dispose();
      root.remove();
    }
  });

  const asOf = `asof:${evidence.replayTime}`;
  expect(evidence.replayTime).toBe(evidence.seekTime);
  expect(evidence.beforeReplay).toEqual({ pw: ["live"], mr: ["live"], ref: ["live"], npoc: [555] });
  expect(evidence.inReplay).toEqual({ pw: [asOf], mr: [asOf], ref: [asOf], npoc: [] });
  expect(evidence.repeatedReadCalls).toBe(0);
  expect(evidence.afterLateCompletion).toEqual({ pw: [asOf], mr: [asOf], ref: [asOf], npoc: [] });
  expect(evidence.callsAfterLateCompletion).toEqual([{ market: "BINANCE_FUTURES:btcusdt", asOf: evidence.replayTime }]);
  const call = { market: "BINANCE_FUTURES:btcusdt", asOf: evidence.replayTime };
  expect(evidence.callsAfterPreviousWeekSettings).toEqual([call]);
  expect(evidence.callsAfterMondaySettings).toEqual([call, call]);
  expect(evidence.publicInReplay).toEqual({ levels: [asOf], npoc: [] });
  expect(evidence.publicAfterExit).toEqual({ levels: null, npoc: [555] });
  expect(evidence.withoutPort).toEqual({ pw: [], mr: [], ref: [], npoc: [] });
  expect(evidence.afterExit).toEqual({ pw: ["live"], mr: ["live"], ref: ["live"], npoc: [555] });
  expect(evidence.asOfMarkets).toEqual(["BINANCE_FUTURES:btcusdt"]);
});

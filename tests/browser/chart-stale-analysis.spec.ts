import { expect, test } from "@playwright/test";
import { installHistory, openHarness } from "./support/history.js";

// #325 stale-analysis isolation on the real ChartRuntime: analysis results and notifications
// that arrive for a market the chart has left, or after the chart is disposed, change
// nothing. Two charts share one set of services, as panels do in the app:
// - nPOC: A goes BTC -> ETH -> BTC; the three snapshot requests answer late and out of
//   order. Only the latest BTC request may land, and the two superseded requests were aborted.
// - Analysis change/revision: an automatic-data change for the market A left does not
//   repaint A, while one for its current market does.
// - Dispose: analysis listeners A held before dispose are invoked afterwards and a late nPOC
//   answer for A arrives; A requests no repaint and nothing throws, while B keeps repainting
//   on its own market's changes.
test("stale analysis results and notifications are ineffective after a market switch and after dispose", async ({ page }) => {
  test.setTimeout(60_000);
  await installHistory(page);
  await openHarness(page);

  const evidence = await page.evaluate(async () => {
    const [
      { mountChart },
      { createChartSurfaceModel },
      { getChartRuntime },
      { ChartSession },
      { DrawingManager },
      { DEFAULT_VOLUME_PROFILE_SETTINGS },
      { normalizePreviousWeekStrategySettings },
      { normalizeMondayRangeSettings },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/chart.ts"),
      import("/harness/chart.ts"),
      import("/src/features/chart/ChartSession.ts"),
      import("/src/features/drawings/drawingManager.ts"),
      import("/src/core/analysis/volumeProfile.ts"),
      import("/src/core/analysis/previousWeekStrategy.ts"),
      import("/src/core/analysis/mondayRange.ts"),
    ]);
    const BTC = "BINANCE_FUTURES:btcusdt";
    const ETH = "BINANCE_FUTURES:ethusdt";
    const DAY = 86_400_000;
    const dayStart = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;

    // Repaint requests per chart root, counted on the real session methods.
    const repaints = new Map<Element, number>();
    const proto = ChartSession.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const originals = { invalidate: proto.invalidate, invalidateSurface: proto.invalidateSurface };
    for (const name of ["invalidate", "invalidateSurface"] as const) {
      const original = originals[name];
      proto[name] = function (this: { container: Element }, ...args: unknown[]) {
        repaints.set(this.container, (repaints.get(this.container) ?? 0) + 1);
        return original.apply(this, args);
      };
    }

    type Change = { kind: string; market?: string; dataRevision?: number; visibilityRevision?: number };
    const analysisListeners = new Set<(change: Change) => void>();
    const revisionListeners = new Set<() => void>();
    const revisions = new Map<string, number>([[BTC, 1], [ETH, 1]]);
    type NpocRequest = { market: string; signal: AbortSignal; resolve: (value: unknown) => void };
    const npocRequests: NpocRequest[] = [];
    const contextFor = (market: string) => ({
      market,
      profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
      previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
      mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
      nakedPocs: [],
      drawings: new DrawingManager(() => {}),
      previousWeekStrategyLevels: [],
      mondayRangeLevels: [],
      referenceLevels: [],
    });
    const contexts = new Map([[BTC, contextFor(BTC)], [ETH, contextFor(ETH)]]);
    const services = {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 0.1,
      fetchPricePrecision: async () => 1,
      getAnalysisContext: (market: string) => contexts.get(market),
      getAnalysisRevisionSnapshot: (market: string) => {
        const revision = revisions.get(market) ?? 1;
        return { market, revision, canonical: { status: "complete", market, runKey: `${market}|0.1`, generation: revision, revision, failedPeriods: [] } };
      },
      subscribeAnalysis: (listener: (change: Change) => void) => { analysisListeners.add(listener); return () => analysisListeners.delete(listener); },
      subscribeAnalysisRevision: (listener: () => void) => { revisionListeners.add(listener); return () => revisionListeners.delete(listener); },
      updateAnalysisFromSeries() {},
      fetchNpocSnapshot: (market: string, signal: AbortSignal) => new Promise((resolve) => { npocRequests.push({ market, signal, resolve }); }),
      notifyActiveMarket() {},
      notifyInteractiveCandlesReady() {},
      notifyInteractiveHistorySettled() {},
      triggerAutoSync() {},
      notifyBarClose() {},
      notify() {},
      isFootprintSyncBusy: () => false,
    };
    const npocResponse = (market: string, price: number) => ({
      schemaVersion: 3,
      market,
      levels: [{ period: "daily", periodStart: dayStart, pocLower: price, age: 1 }],
      valueAreas: [],
    });
    const emitChange = (market: string) => {
      revisions.set(market, (revisions.get(market) ?? 1) + 1);
      const change = { kind: "automatic-data", market, dataRevision: revisions.get(market), visibilityRevision: 1 };
      for (const listener of [...analysisListeners]) listener(change);
    };

    const realSetTimeout = window.setTimeout;
    const settle = () => new Promise((resolve) => realSetTimeout(resolve, 50));
    const waitFor = async (predicate: () => boolean, description: string) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => realSetTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${description}`);
    };
    const makeRoot = (left: number) => {
      const root = document.createElement("div");
      root.style.cssText = `position:fixed;left:${left}px;top:16px;width:560px;height:360px;overflow:hidden;`;
      document.body.appendChild(root);
      return root;
    };
    const state = (market: string) => ({ type: "chart", market, timeframe: "1m", scaleMode: "linear", chartType: "candlestick", candles: true }) as never;
    type Runtime = { getNpocLevels(): readonly { price: number; market: string }[] };
    const repaintsOf = (root: Element) => repaints.get(root) ?? 0;

    const roots = { A: makeRoot(8), B: makeRoot(590) };
    const ids = { A: `stale-analysis-a-${Date.now()}`, B: `stale-analysis-b-${Date.now()}` };
    const handles: Record<string, { updateState(next: never): void; dispose(): void } | null> = { A: null, B: null };
    try {
      handles.A = mountChart(roots.A, state(BTC), services as never, ids.A, createChartSurfaceModel());
      handles.B = mountChart(roots.B, state(ETH), services as never, ids.B, createChartSurfaceModel());
      await waitFor(() => Boolean(getChartRuntime(ids.A)) && Boolean(getChartRuntime(ids.B)), "both chart runtimes");
      const runtimeA = getChartRuntime(ids.A) as unknown as Runtime;
      const hookA = () => roots.A.querySelector("[data-series-len]") as HTMLElement | null;
      await waitFor(() => Number(hookA()?.dataset.seriesLen ?? 0) > 10, "A history bars");
      await waitFor(() => hookA()?.dataset.npocHistoryReady === "true", "A history settled for nPOC");
      await waitFor(() => npocRequests.length === 2, "the two startup nPOC requests");
      const aFirst = npocRequests.find((request) => request.market === BTC)!;
      const bOnly = npocRequests.find((request) => request.market === ETH)!;

      // nPOC A-B-A: BTC (first) -> ETH (second) -> BTC (third); answers arrive late, newest first.
      handles.A.updateState(state(ETH));
      await waitFor(() => npocRequests.length === 3, "A's ETH nPOC request");
      handles.A.updateState(state(BTC));
      await waitFor(() => npocRequests.length === 4, "A's second BTC nPOC request");
      const aSecond = npocRequests[2];
      const aThird = npocRequests[3];
      await waitFor(() => hookA()?.dataset.npocHistoryReady === "true", "A history settled again on BTC");
      aThird.resolve(npocResponse(BTC, 333));
      await waitFor(() => runtimeA.getNpocLevels().length === 1, "the current BTC nPOC level");
      aSecond.resolve(npocResponse(ETH, 222));
      aFirst.resolve(npocResponse(BTC, 111));
      await settle();
      const npoc = {
        requestMarkets: [aFirst.market, aSecond.market, aThird.market],
        abortedSuperseded: [aFirst.signal.aborted, aSecond.signal.aborted],
        currentAborted: aThird.signal.aborted,
        levels: runtimeA.getNpocLevels().map((level) => ({ market: level.market, price: level.price })),
      };
      bOnly.resolve(npocResponse(ETH, 444));

      // Analysis change for the market A left (ETH is B's) versus A's own market.
      await settle();
      const beforeStale = { A: repaintsOf(roots.A), B: repaintsOf(roots.B) };
      emitChange(ETH);
      await settle();
      const afterStale = { A: repaintsOf(roots.A), B: repaintsOf(roots.B) };
      emitChange(BTC);
      await settle();
      const afterOwn = { A: repaintsOf(roots.A), B: repaintsOf(roots.B) };

      // Dispose A while holding every listener it registered, plus one in-flight nPOC request.
      handles.A.updateState(state(ETH));
      await waitFor(() => npocRequests.length === 5, "A's in-flight ETH nPOC request");
      const lateForA = npocRequests[4];
      const heldAnalysis = [...analysisListeners];
      const heldRevision = [...revisionListeners];
      handles.A.dispose();
      handles.A = null;
      await waitFor(() => !getChartRuntime(ids.A), "A's registry teardown");
      const listenersAfterDispose = { analysis: analysisListeners.size, revision: revisionListeners.size };
      await settle();
      const beforeHeld = { A: repaintsOf(roots.A), B: repaintsOf(roots.B) };
      let thrown: string | null = null;
      try {
        const change = { kind: "automatic-data", market: ETH, dataRevision: 99, visibilityRevision: 1 };
        for (const listener of heldAnalysis) listener(change);
        for (const listener of heldRevision) listener();
        lateForA.resolve(npocResponse(ETH, 555));
        await settle();
      } catch (error) {
        thrown = String(error);
      }
      const afterHeld = { A: repaintsOf(roots.A), B: repaintsOf(roots.B) };

      return {
        npoc,
        heldCounts: { analysis: heldAnalysis.length, revision: heldRevision.length },
        listenersAfterDispose,
        lateForAAborted: lateForA.signal.aborted,
        staleChange: { A: afterStale.A - beforeStale.A, B: afterStale.B - beforeStale.B },
        ownChange: { A: afterOwn.A - afterStale.A, B: afterOwn.B - afterStale.B },
        heldAfterDispose: { A: afterHeld.A - beforeHeld.A, B: afterHeld.B - beforeHeld.B },
        thrown,
      };
    } finally {
      proto.invalidate = originals.invalidate;
      proto.invalidateSurface = originals.invalidateSurface;
      handles.A?.dispose();
      handles.B?.dispose();
      roots.A.remove();
      roots.B.remove();
    }
  });

  // nPOC: only A's latest BTC request lands; the two it superseded were aborted.
  expect(evidence.npoc.requestMarkets).toEqual(["BINANCE_FUTURES:btcusdt", "BINANCE_FUTURES:ethusdt", "BINANCE_FUTURES:btcusdt"]);
  expect(evidence.npoc.abortedSuperseded).toEqual([true, true]);
  expect(evidence.npoc.currentAborted).toBe(false);
  expect(evidence.npoc.levels).toEqual([{ market: "BINANCE_FUTURES:btcusdt", price: 333 }]);
  // A change for ETH repaints B (on ETH) and not A (back on BTC); a BTC change repaints A only.
  expect(evidence.staleChange.A).toBe(0);
  expect(evidence.staleChange.B).toBeGreaterThan(0);
  expect(evidence.ownChange.A).toBeGreaterThan(0);
  expect(evidence.ownChange.B).toBe(0);
  // Dispose: A unsubscribed, its held listeners and late nPOC are inert, B is unaffected.
  expect(evidence.heldCounts).toEqual({ analysis: 2, revision: 2 });
  expect(evidence.listenersAfterDispose).toEqual({ analysis: 1, revision: 1 });
  expect(evidence.lateForAAborted).toBe(true);
  expect(evidence.thrown).toBeNull();
  expect(evidence.heldAfterDispose.A).toBe(0);
  expect(evidence.heldAfterDispose.B).toBeGreaterThan(0);
});

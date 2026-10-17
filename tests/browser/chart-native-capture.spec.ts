import { openHarness } from "./support/history.js";
import { expect, test } from "@playwright/test";

const FUNCTIONAL_WEBGL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader-webgl",
  "--enable-unsafe-swiftshader",
];

test.use({ launchOptions: { args: FUNCTIONAL_WEBGL_ARGS } });

test("native capture reads the current WebGL framebuffer, flips it, composites annotation, and excludes interaction", async ({ page }) => {
  await openHarness(page);

  const result = await page.evaluate(async () => {
    const { ChartSession } = await import("/src/features/chart/ChartSession.ts");

    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:0;top:0;width:8px;height:8px;";
    const gpuCanvas = document.createElement("canvas");
    const annotationCanvas = document.createElement("canvas");
    const interactionCanvas = document.createElement("canvas");
    for (const canvas of [gpuCanvas, annotationCanvas, interactionCanvas]) {
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
      root.appendChild(canvas);
    }
    document.body.appendChild(root);

    const testWebGlAttributes: WebGLContextAttributes = {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    };
    const gl = gpuCanvas.getContext("webgl2", testWebGlAttributes);
    const annotationCtx = annotationCanvas.getContext("2d");
    const interactionCtx = interactionCanvas.getContext("2d");
    if (!gl || !annotationCtx || !interactionCtx) throw new Error("required chart contexts unavailable");

    const renderer = {
      render() {
        const w = gpuCanvas.width;
        const h = gpuCanvas.height;
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(1, 0, 0, 1); // top half remains red
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, w, Math.floor(h / 2));
        gl.clearColor(0, 1, 0, 1); // WebGL bottom half is green
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);
      },
      visibleRange() { return [0, 0] as [number, number]; },
    };

    const annotation = {
      render() {
        annotationCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
        annotationCtx.fillStyle = "rgb(0, 0, 255)";
        annotationCtx.fillRect(0, 0, 2, 2);
      },
    };
    const interaction = {
      render() {
        interactionCtx.clearRect(0, 0, interactionCanvas.width, interactionCanvas.height);
        interactionCtx.fillStyle = "rgb(0, 255, 255)";
        interactionCtx.fillRect(interactionCanvas.width - 2, interactionCanvas.height - 2, 2, 2);
      },
    };

    const session = new ChartSession({
      container: root,
      gpuCanvas,
      annotationCanvas,
      interactionCanvas,
      ownerDocument: document,
      gl,
      annotationCtx2d: annotationCtx,
      interactionCtx2d: interactionCtx,
      renderer,
      annotation,
      interaction,
      view: {} as never,
      series: { length: 1 } as never,
      crosshair: { visible: false, x: 0, y: 0 },
      onRestoreContext() {},
    });

    session.activate();
    const frame = await session.captureCompositePng();
    const bitmap = await createImageBitmap(frame.blob);
    const decoded = document.createElement("canvas");
    decoded.width = bitmap.width;
    decoded.height = bitmap.height;
    const decodedCtx = decoded.getContext("2d");
    if (!decodedCtx) throw new Error("decode canvas unavailable");
    decodedCtx.drawImage(bitmap, 0, 0);
    const pixels = decodedCtx.getImageData(0, 0, decoded.width, decoded.height).data;
    const pixel = (x: number, y: number) => {
      const offset = (y * decoded.width + x) * 4;
      return Array.from(pixels.slice(offset, offset + 4));
    };

    const samples = {
      annotationTopLeft: pixel(0, 0),
      gpuTop: pixel(Math.floor(decoded.width / 2), 1),
      gpuBottom: pixel(Math.floor(decoded.width / 2), decoded.height - 2),
      interactionBottomRight: pixel(decoded.width - 1, decoded.height - 1),
    };
    const contextAttributes = gl.getContextAttributes();
    const interactionPixel = interactionCtx.getImageData(
      interactionCanvas.width - 1,
      interactionCanvas.height - 1,
      1,
      1,
    ).data;

    bitmap.close();
    session.destroy();
    root.remove();

    return {
      type: frame.blob.type,
      bytes: frame.bytes,
      width: frame.width,
      height: frame.height,
      requestedPreserveDrawingBuffer: testWebGlAttributes.preserveDrawingBuffer,
      queriedPreserveDrawingBuffer: contextAttributes?.preserveDrawingBuffer ?? null,
      samples,
      actualInteractionPixel: Array.from(interactionPixel),
    };
  });

  expect(result.type).toBe("image/png");
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.width).toBeGreaterThan(0);
  expect(result.height).toBeGreaterThan(0);
  // getContextAttributes() is allowed to return null (for example after a
  // software-rendered context transition). The invariant is the requested
  // context attribute; when runtime introspection is available it must agree.
  expect(result.requestedPreserveDrawingBuffer).toBe(false);
  if (result.queriedPreserveDrawingBuffer !== null) {
    expect(result.queriedPreserveDrawingBuffer).toBe(false);
  }

  // Annotation overlays GPU in the PNG.
  expect(result.samples.annotationTopLeft.slice(0, 3)).toEqual([0, 0, 255]);
  // WebGL bottom-left readPixels orientation must become top-left PNG orientation.
  expect(result.samples.gpuTop.slice(0, 3)).toEqual([255, 0, 0]);
  expect(result.samples.gpuBottom.slice(0, 3)).toEqual([0, 255, 0]);
  // Interaction canvas really contains cyan, but that cyan must not appear in the capture.
  expect(result.actualInteractionPixel.slice(0, 3)).toEqual([0, 255, 255]);
  expect(result.samples.interactionBottomRight.slice(0, 3)).toEqual([0, 255, 0]);
});

// SOURCE CONTRACT (frozen from the PR head sources; no private runtime hooks, no fake renderer):
// - Startup history flows through the real browser transport: the runtime mount calls
//   loadHistory(undefined, { twoPhase: true }) (ChartRuntime.ts:1466); ChartHistoryController
//   requests to = Date.now(), from = bucketStart(to - interval * runtimeConfig.targetBars)
//   (ChartHistoryController.ts:187-194); ChartDataPipeline._loadHistory (ChartDataPipeline.ts:609+)
//   runs fetchAggrBars() (JSON envelope /history, no format param) and then streamAggrBars()
//   through the production module Worker (format=binary-v2 with NDJSON-v1 fallback, aggr.ts:548+).
//   services.fetchHistory never feeds this startup path.
// - captureReadiness requires settled history plus a canonical analysis snapshot whose runKey is
//   `${market}|${priceStep}` with status "complete" and a painted revision (captureReadiness.ts:53-83).
// - ChartInputController binds owner-global keydown/keyup/blur/pointerup on the canvas ownerWindow
//   and visibilitychange on its document, removing each with the same callback identity and default
//   capture=false (ChartInputController.ts:683-729). refreshHostLifecycle() is synchronous
//   (ChartRuntime.ts:932-939). The drawing magnet modifier is a module-global aggregate fed by
//   per-controller sources (drawingInteractionState.ts:13-31).
//
// Given the /history route serves query-aligned closed fixture bars (independent
// OHLC/volume/delta/count/cells/order invariants) for both owner markets through the production
// NDJSON/Worker path,
// When two real Runtimes mount via mountChart with per-owner public service fixtures,
// Then the real GL pixel baseline, native context loss/restore ledger, owner-global adoption
// isolation and teardown invariants below all hold.
test("real Runtime preserves native lifecycle, owner isolation, and candle pixels", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const interval = 60_000;
  const priceStep = 0.01;
  const owners = {
    A: { market: "BINANCE:BTCUSDT", open: 100, high: 102, low: 99, close: 101, left: 8, width: 560 },
    B: { market: "BINANCE:ETHUSDT", open: 200, high: 202, low: 199, close: 201, left: 590, width: 620 },
  };
  const fixtureOwner = new Map(Object.values(owners).map((owner) => [owner.market, owner]));
  // Coherent manually specified fills for every served bar, in increasing time order:
  // open buy, high buy, low sell, close buy; each raw qty 1 with tradeCount 1 (3 buys,
  // 1 sell). Served cells below are aggregated from THESE literal fills, while the per-bar
  // checks compare against the separately hand-written expectedCells oracle, never against
  // the same aggregation that produced the bars.
  const fixtureTrades = (owner) => [
    { price: owner.open, side: "buy" },
    { price: owner.high, side: "buy" },
    { price: owner.low, side: "sell" },
    { price: owner.close, side: "buy" },
  ];
  for (const owner of fixtureOwner.values()) {
    const fills = fixtureTrades(owner);
    if (fills[0].price !== owner.open || fills[fills.length - 1].price !== owner.close
      || Math.min(...fills.map((fill) => fill.price)) !== owner.low
      || Math.max(...fills.map((fill) => fill.price)) !== owner.high
      || fills.some((fill) => fill.price < owner.low || fill.price > owner.high)) {
      throw new Error("BLOCKED: fixture fills inconsistent with owner OHLC for " + owner.market);
    }
  }
  // Hand-computed expected price cells (price, buyQty, sellQty, liquidationBuy,
  // liquidationSell, count, buyCount, sellCount) ascending by price, one per fill.
  const expectedCells = new Map([
    ["BINANCE:BTCUSDT", [
      [99, 0, 1, 0, 0, 1, 0, 1],
      [100, 1, 0, 0, 0, 1, 1, 0],
      [101, 1, 0, 0, 0, 1, 1, 0],
      [102, 1, 0, 0, 0, 1, 1, 0],
    ]],
    ["BINANCE:ETHUSDT", [
      [199, 0, 1, 0, 0, 1, 0, 1],
      [200, 1, 0, 0, 0, 1, 1, 0],
      [201, 1, 0, 0, 0, 1, 1, 0],
      [202, 1, 0, 0, 0, 1, 1, 0],
    ]],
  ]);
  const historyEvidence = {
    aligned: true, queries: 0, returned: 0, populatedCells: 0,
    ohlc: true, volume: true, delta: true, count: true, cells: true, order: true, closedBars: true,
  };
  await page.route(/\/history(?:\?|$)/, (route) => {
    const params = new URL(route.request().url()).searchParams;
    const market = (params.get("markets") ?? "").split(",")[0] ?? "";
    const owner = fixtureOwner.get(market);
    const from = Number(params.get("from"));
    const to = Number(params.get("to"));
    historyEvidence.queries++;
    if (!owner || Number(params.get("interval")) !== interval || !(Number(params.get("priceStep")) > 0)) {
      historyEvidence.aligned = false;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars: [] } }) });
    }
    const firstBar = Math.ceil(from / interval) * interval;
    const lastBar = Math.min(Math.floor(to / interval) * interval, Math.floor(Date.now() / interval) * interval - interval);
    const bars = [];
    for (let startTime = firstBar; startTime <= lastBar; startTime += interval) {
      const cells = fixtureTrades(owner)
        .map((fill) => [fill.price, fill.side === "buy" ? 1 : 0, fill.side === "sell" ? 1 : 0, 0, 0, 1,
          fill.side === "buy" ? 1 : 0, fill.side === "sell" ? 1 : 0])
        .sort((left, right) => left[0] - right[0]);
      bars.push({
        t: startTime,
        o: owner.open,
        h: owner.high,
        l: owner.low,
        c: owner.close,
        v: 4,
        d: 2,
        n: 4,
        cells,
        completeness: "complete",
        updatedAt: startTime + interval - 1,
      });
    }
    let previousStart = -Infinity;
    for (const bar of bars) {
      historyEvidence.returned++;
      historyEvidence.populatedCells += bar.cells.length;
      if (bar.t % interval !== 0 || bar.t < from || bar.t > to) historyEvidence.aligned = false;
      if (bar.t <= previousStart) historyEvidence.order = false;
      previousStart = bar.t;
      if (bar.t + interval > Date.now()) historyEvidence.closedBars = false;
      if (bar.o !== owner.open || bar.h !== owner.high || bar.l !== owner.low || bar.c !== owner.close
        || !Number.isFinite(bar.o + bar.h + bar.l + bar.c)) historyEvidence.ohlc = false;
      if (bar.v !== 4) historyEvidence.volume = false;
      if (bar.d !== 2) historyEvidence.delta = false;
      if (bar.n !== 4) historyEvidence.count = false;
      if (bar.cells.length !== 4) historyEvidence.cells = false;
      const expectedBarCells = expectedCells.get(owner.market);
      if (!expectedBarCells || expectedBarCells.length !== bar.cells.length) historyEvidence.cells = false;
      for (let index = 0; index < bar.cells.length; index++) {
        const cell = bar.cells[index];
        const expectedCell = expectedBarCells?.[index];
        if (!cell || cell.length !== 8 || !expectedCell || cell.some((value, slot) => value !== expectedCell[slot])) {
          historyEvidence.cells = false;
          break;
        }
        const [price, buyQty, sellQty, liquidationBuy, liquidationSell, count, buyCount, sellCount] = cell;
        if (price < owner.low || price > owner.high
          || [buyQty, sellQty, liquidationBuy, liquidationSell, count, buyCount, sellCount]
            .some((value) => !Number.isFinite(value) || value < 0)
          || buyQty + sellQty !== count || buyCount + sellCount !== count) historyEvidence.cells = false;
      }
      const cellQty = bar.cells.reduce((sum, cell) => sum + cell[1] + cell[2], 0);
      const cellDelta = bar.cells.reduce((sum, cell) => sum + cell[1] - cell[2], 0);
      const cellCount = bar.cells.reduce((sum, cell) => sum + cell[5], 0);
      if (cellQty !== bar.v || cellDelta !== bar.d || cellCount !== bar.n) historyEvidence.cells = false;
    }
    const meta = {
      schemaVersion: 1,
      generatedAt: Date.now(),
      provenance: [{ source: "native-runtime-route-fixture", completeness: "complete" }],
      footprintCoverage: {
        schemaVersion: 1,
        source: "binance-usdm-aggTrade",
        instrument: market,
        authority: "provisional",
        status: "complete",
        requestedFrom: from,
        requestedTo: to,
        coveredFrom: from,
        coveredThrough: to,
        reasonCode: null,
        authorityToken: "native-runtime-route-fixture",
        projectionThroughId: "0",
      },
    };
    const format = params.get("format");
    if (format === "ndjson-v1" || format === "binary-v2") {
      return route.fulfill({
        status: 200,
        contentType: "application/x-ndjson; charset=utf-8",
        body: [
          JSON.stringify({ type: "header", schemaVersion: 1, interval, meta }),
          JSON.stringify({ type: "bars", sequence: 0, bars }),
          JSON.stringify({ type: "complete", count: bars.length, cellCount: bars.reduce((sum, bar) => sum + bar.cells.length, 0) }),
          "",
        ].join("\n"),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { bars }, meta }),
    });
  });

  // App-shell-free same-origin fixture document (issue 325): navigating any Vite-served
  // URL (previously "/@vite/client") can boot the app shell, whose OWN main-window
  // keydown / main-document visibilitychange listeners (App.svelte onMount registers,
  // onDestroy removes; ChartA/B dispose never owns them) pollute the owner-global
  // registration ledger below. Fulfill a DEDICATED same-origin document URL with minimal
  // sentinel HTML and no entry script instead; the dynamic imports below still load the
  // real runtime modules from the same Vite origin.
  const fixtureDocumentPath = "/__pactolis-native-runtime-lifecycle-fixture__";
  const fixtureSentinel = "pactolis-native-runtime-lifecycle-fixture";
  await page.route(fixtureDocumentPath, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${fixtureSentinel}</title></head>\n<body data-fixture="${fixtureSentinel}">\n<!-- ${fixtureSentinel}: app-shell-free native runtime lifecycle fixture; no entry script -->\n</body>\n</html>\n`,
    });
  });
  // A thrown value may itself be null or undefined, so primary presence is an independent
  // boolean flag, never inferred from the stored value (no null/undefined sentinel).
  let gotoThrown = false;
  let gotoError = undefined;
  try {
    await page.goto(fixtureDocumentPath);
  } catch (error) {
    gotoThrown = true;
    gotoError = error;
  } finally {
    // The route exists only to answer the fixture document navigation; unroute immediately
    // so every later request (history API, Vite module JS, Worker) hits the real stack.
    // Cleanup is always attempted; a cleanup failure surfaces only when the primary goto
    // error is absent (primary preserved as its original null/undefined), so goto never
    // masks itself and cleanup-only failures stay visible.
    try {
      await page.unroute(fixtureDocumentPath);
    } catch (cleanupError) {
      if (!gotoThrown) {
        throw cleanupError;
      }
    }
  }
  if (gotoThrown) {
    throw gotoError;
  }
  const fixtureBaseURL = testInfo.project.use.baseURL;
  expect(fixtureBaseURL, "project baseURL must be configured for the same-origin fixture comparison").toBeTruthy();
  const expectedFixtureOrigin = new URL(fixtureBaseURL).origin;
  const fixtureState = await page.evaluate(({ sentinel, expectedOrigin, expectedPath }) => ({
    navigated: location.pathname === expectedPath,
    sameOrigin: location.origin === expectedOrigin,
    sentinel: document.documentElement.outerHTML.includes(sentinel),
    entryScripts: document.querySelectorAll("script").length,
    appShellNode: document.documentElement.dataset.appSurface !== undefined || document.body.children.length > 0,
  }), { sentinel: fixtureSentinel, expectedOrigin: expectedFixtureOrigin, expectedPath: fixtureDocumentPath });
  expect(fixtureState.navigated).toBe(true);
  expect(fixtureState.sameOrigin).toBe(true);
  expect(fixtureState.sentinel).toBe(true);
  expect(fixtureState.entryScripts).toBe(0);
  expect(fixtureState.appShellNode).toBe(false);
  const capability = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    return { webgl2: Boolean(gl), loseContext: Boolean(gl?.getExtension("WEBGL_lose_context")) };
  });
  if (!capability.webgl2 || !capability.loseContext) {
    test.skip(true, "BLOCKED: native WebGL2/WEBGL_lose_context unavailable in this runtime (mandatory case, never counted green)");
  }

  const evidence = await page.evaluate(async (spec) => {
    const owners = spec.owners;
    const interval = spec.interval;
    const priceStep = spec.priceStep;
    const [
      { mountChart },
      { createChartSurfaceModel },
      { getChartRuntime },
      { DrawingManager },
      { DEFAULT_VOLUME_PROFILE_SETTINGS },
      { normalizePreviousWeekStrategySettings },
      { normalizeMondayRangeSettings },
      { FootprintRenderer },
      { subscribeDrawingMagnetTransient },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/chart.ts"),
      import("/harness/chart.ts"),
      import("/src/features/drawings/drawingManager.ts"),
      import("/src/core/analysis/volumeProfile.ts"),
      import("/src/core/analysis/previousWeekStrategy.ts"),
      import("/src/core/analysis/mondayRange.ts"),
      import("/src/core/render/footprintRenderer.ts"),
      import("/src/features/chart/drawingInteractionState.ts"),
    ]);

    const rootFor = (owner) => {
      const root = document.createElement("div");
      root.dataset.nativeRuntimeOwner = owner;
      root.style.cssText = "position:fixed;top:16px;height:360px;overflow:hidden;background:#101010;";
      root.style.left = owners[owner].left + "px";
      root.style.width = owners[owner].width + "px";
      document.body.appendChild(root);
      return root;
    };
    const roots = { A: rootFor("A"), B: rootFor("B") };
    const subscriptions = new Map();
    const analysisListeners = new Set();
    const revisionListeners = new Set();
    const revisions = new Map();
    const contexts = new Map(Object.keys(owners).map((key) => {
      const owner = owners[key];
      const drawings = new DrawingManager(() => {});
      return [owner.market, {
        market: owner.market,
        profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
        previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
        previousWeekStrategyLevels: [],
        mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
        mondayRangeLevels: [],
        nakedPocs: [],
        referenceLevels: [],
        drawings,
      }];
    }));
    const snapshot = (market) => {
      const revision = revisions.get(market) || 1;
      return {
        market,
        revision,
        canonical: {
          status: "complete",
          market,
          // captureReadiness expects `${market}|${priceStep}` (captureReadiness.ts:64).
          runKey: market + "|" + priceStep,
          generation: revision,
          revision,
          failedPeriods: [],
        },
      };
    };
    // Per-owner public service fixture. The input layer calls getAnalysisContext() with no
    // market (ChartInputController.ts:129); production resolves that through the shared
    // active-market context. Resolving it to this owner's own context keeps chart B's
    // controller source inactive so the module-global magnet aggregate has exactly one
    // active source (chart A) while adoption is measured.
    const servicesFor = (ownerKey) => ({
      subscribeToTrades(market, callback) {
        let set = subscriptions.get(market);
        if (!set) subscriptions.set(market, set = new Set());
        set.add(callback);
        return () => set.delete(callback);
      },
      fetchHistory() { return Promise.resolve([]); },
      fetchPriceStep: async () => priceStep,
      fetchPricePrecision: async () => 2,
      getAnalysisContext: (market) => contexts.get(market ?? owners[ownerKey].market),
      getAnalysisRevisionSnapshot: (market) => snapshot(market ?? owners[ownerKey].market),
      subscribeAnalysis(listener) {
        analysisListeners.add(listener);
        return () => analysisListeners.delete(listener);
      },
      subscribeAnalysisRevision(listener) {
        revisionListeners.add(listener);
        return () => revisionListeners.delete(listener);
      },
      updateAnalysisFromSeries(market) {
        revisions.set(market, (revisions.get(market) || 1) + 1);
        for (const listener of revisionListeners) listener();
        for (const listener of analysisListeners) listener({
          kind: "automatic-data",
          market,
          dataRevision: revisions.get(market),
          visibilityRevision: 1,
        });
      },
      fetchNpocSnapshot(market, signal) {
        if (signal && signal.aborted) return Promise.reject(new DOMException("NPOC aborted", "AbortError"));
        return new Promise((resolve, reject) => {
          const timer = window.setTimeout(() => resolve({ schemaVersion: 3, market, levels: [], valueAreas: [] }), 0);
          signal?.addEventListener("abort", () => {
            window.clearTimeout(timer);
            reject(new DOMException("NPOC aborted", "AbortError"));
          }, { once: true });
        });
      },
      notifyActiveMarket() {},
      notifyInteractiveCandlesReady() {},
      notifyInteractiveHistorySettled() {},
      triggerAutoSync() {},
      notifyBarClose() {},
      notify() {},
      isFootprintSyncBusy: () => false,
    });
    const newOwnerStats = () => ({
      renders: 0, draws: 0, pixelMatch: false, pixelMatches: 0, cellBars: 0, lastPixel: null,
      uniformLocations: 0, wrapperCreates: 0, matchedDeletes: 0, invalidatedDeletes: 0, unmatchedDeletes: 0,
      readPixelsCalls: 0,
      // Typed GL handle ledger: { state: "alive" | "lost-invalidated", kind, context, owner,
      // epoch }. epoch is the context-matched invalidation epoch the handle was created in; it
      // advances ONLY on an actual context invalidation (the loss event), never on restore. A
      // loss invalidates current-epoch alive handles instead of forgetting them, so the real
      // old renderer's matched deletes of pre-loss resources after restore stay distinguishable
      // from genuinely unmatched deletes; kind/context/owner/epoch mismatches fail loudly.
      handleStates: new Map(), lossEpoch: 0, handlesAtLoss: 0, createdAfterRestore: 0,
      invalidationEpoch: 0,
    });
    const ownerStats = { A: newOwnerStats(), B: newOwnerStats() };
    const restorers = [];
    let renderDepth = 0;
    let renderGl = null;
    const ownerOfCanvas = (canvas) => canvas?.closest?.("[data-native-runtime-owner]")?.dataset.nativeRuntimeOwner;
    const wrap = (prototype, name, wrapper) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor || typeof descriptor.value !== "function") throw new Error("BLOCKED: missing native observer method " + name);
      Object.defineProperty(prototype, name, { ...descriptor, value: wrapper(descriptor.value) });
      restorers.push(() => Object.defineProperty(prototype, name, descriptor));
    };
    const panelIds = { A: "native-runtime-A-" + Date.now(), B: "native-runtime-B-" + Date.now() };
    const makeState = (owner) => ({
      type: "chart",
      market: owners[owner].market,
      timeframe: "1m",
      scaleMode: "linear",
      chartType: "candlestick",
      candles: true,
      heat: false,
      cellNumbers: false,
      poc: false,
      stackedImbalance: false,
    });
    const waitFor = async (predicate, description, timeout = 12_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      throw new Error("Timed out waiting for " + description);
    };
    const tradeFor = (owner) => ({
      time: Date.now(),
      price: owners[owner].close + 0.25,
      qty: 0.25,
      tradeCount: 1,
      isBuy: true,
      market: owners[owner].market,
      source: "live",
    });
    const deliverTrade = (owner) => {
      const callbacks = subscriptions.get(owners[owner].market);
      if (!callbacks || callbacks.size === 0) throw new Error("missing actual trade subscription for " + owner);
      for (const callback of [...callbacks]) callback(tradeFor(owner));
    };

    let popup = null;
    let crosshairUnsubscribe = null;
    let magnetUnsubscribe = null;
    let previousTool = null;
    let runtimeA = null;
    let runtimeB = null;
    let capturedStaleCallback = null;
    const handles = { A: null, B: null };
    let inputCount = 0;
    const magnet = { initial: false, values: [], notifications: 0 };
    const adoption = {
      activeToolHorizontal: false,
      oldKeyDownTrue: false,
      oldBlurFalse: false,
      oldOwnerCanvasHover: false,
      newKeyDownTrue: false,
      oldBlurStaysTrue: false,
      newBlurFalse: false,
      oldKeyDownStaysFalse: false,
      newKeyDownPositiveAgain: false,
      newOwnerCanvasHover: false,
    };
    const removal = { addsCaptureFalse: false, identityCaptureOk: false, keydownAdds: 0, allTrackedOnOwnerGlobals: false, canvasTargetsAreCanvases: true, pendingGlobal: -1, pendingOnce: 0, pendingCanvas: 0, popupGlobalMembership: false, popupGlobalRemovedAfterTeardown: false, pendingGlobalDetail: [], ownerGlobalUnmatchedRemovals: 0, ownerGlobalCaptureMismatchedRemovals: 0, canvasUnmatchedRemovals: 0, canvasCaptureMismatchedRemovals: 0 };
    const cleanup = {
      registryRemoved: false,
      subscriptionRemoved: false,
      contextListenerRemoved: false,
      analysisListenersEmpty: false,
      revisionListenersEmpty: false,
      tradeSubscriptionsEmpty: false,
      staleCallbackThrew: false,
    };
    let loss = { outcome: null, lostDrawDelta: -1, order: [], aReadPixelsCalls: 0 };
    // Real observed lifecycle order of the capture slice: public capture call, native context
    // loss, and the public capture settle shape (never only a draw-call proxy).
    const lifecycleOrder = [];
    let restore = null;
    let hidden = { zeroGeometry: false, bitmapRetained: false, geometryRestored: false };
    // Bounded capture-order fence over the real native RAF scheduler (capture slice only).
    // Request and cancel share one native-ID identity space, so a callback cancelled while
    // held (or before its native frame fires) can never be revived by an old-ID ghost.
    let fenceArmed = false;
    const rafQueue = [];
    const rafByNativeId = new Map();
    let nativeRaf = null;
    let nativeCancelRaf = null;
    let rafWrapped = false;
    const drainRafFence = () => {
      fenceArmed = false;
      while (rafQueue.length) {
        const entry = rafQueue.shift();
        if (entry.cancelled) continue;
        // A drained entry terminates its native-ID record: it can never be revived later, and
        // a subsequent cancel of its id is a native no-op exactly like the real scheduler.
        entry.done = true;
        if (entry.nativeId !== undefined) rafByNativeId.delete(entry.nativeId);
        entry.callback(window.performance.now());
      }
    };
    const restoreNativeRaf = () => {
      if (!rafWrapped) return;
      rafWrapped = false;
      window.requestAnimationFrame = nativeRaf;
      window.cancelAnimationFrame = nativeCancelRaf;
    };
    // Presence flag for the primary thrown value (a thrown null/undefined still counts).
    const primary = { thrown: false, value: undefined };
    try {
      wrap(FootprintRenderer.prototype, "renderLayers", (original) => function (view, series, activeLayers) {
        const viewCopy = {
          area: { left: view.area.left, top: view.area.top, width: view.area.width, height: view.area.height },
          offsetX: view.offsetX,
          colWidth: view.colWidth,
          priceTop: view.priceTop,
          pricePerPx: view.pricePerPx,
        };
        const copiedBars = [];
        const first = Math.max(0, series.length - 300);
        for (let index = first; index < series.length; index++) {
          const bar = series.at(index);
          if (!bar) continue;
          const cells = Array.from(bar.cells, ([key, cell]) => [
            key,
            {
              priceBin: cell.priceBin,
              buyVol: cell.buyVol,
              sellVol: cell.sellVol,
              count: cell.count,
              buyCount: cell.buyCount,
              sellCount: cell.sellCount,
              liquidationBuyVol: cell.liquidationBuyVol,
              liquidationSellVol: cell.liquidationSellVol,
            },
          ]);
          copiedBars.push({
            index,
            startTime: bar.startTime,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            delta: bar.delta,
            count: bar.count,
            cells,
          });
        }
        renderDepth++;
        renderGl = null;
        try {
          return Reflect.apply(original, this, [view, series, activeLayers]);
        } finally {
          renderDepth--;
          try {
            const canvas = renderGl?.canvas;
            const owner = ownerOfCanvas(canvas);
            if (owner && ownerStats[owner]) {
              const stats = ownerStats[owner];
              stats.renders++;
              stats.cellBars = Math.max(stats.cellBars, copiedBars.filter((bar) => bar.cells.length > 0).length);
              if (activeLayers.has("candles") && canvas.clientWidth && canvas.clientHeight) {
                const target = owners[owner];
                const framebufferWidth = renderGl.drawingBufferWidth;
                const framebufferHeight = renderGl.drawingBufferHeight;
                const ratioX = framebufferWidth / canvas.clientWidth;
                const ratioY = framebufferHeight / canvas.clientHeight;
                for (const bar of copiedBars) {
                  if (bar.open !== target.open || bar.high !== target.high || bar.low !== target.low || bar.close !== target.close) continue;
                  const xLeft = viewCopy.area.left + viewCopy.offsetX + bar.index * viewCopy.colWidth;
                  const centerX = xLeft + viewCopy.colWidth / 2;
                  const yOpen = viewCopy.area.top + (viewCopy.priceTop - bar.open) / viewCopy.pricePerPx;
                  const yClose = viewCopy.area.top + (viewCopy.priceTop - bar.close) / viewCopy.pricePerPx;
                  const centerY = (yOpen + yClose) / 2;
                  if (!(centerX > viewCopy.area.left && centerX < viewCopy.area.left + viewCopy.area.width
                    && centerY > viewCopy.area.top && centerY < viewCopy.area.top + viewCopy.area.height
                    && Number.isFinite(centerX + centerY) && viewCopy.colWidth > 4)) continue;
                  const x = Math.floor(centerX * ratioX);
                  const y = canvas.height - 1 - Math.floor(centerY * ratioY);
                  if (x < 0 || y < 0 || x >= framebufferWidth || y >= framebufferHeight) continue;
                  const pixel = new Uint8Array(4);
                  renderGl.readPixels(x, y, 1, 1, renderGl.RGBA, renderGl.UNSIGNED_BYTE, pixel);
                  const rgba = Array.from(pixel);
                  stats.lastPixel = rgba;
                  if (Math.abs(rgba[0] - 69) <= 1 && Math.abs(rgba[1] - 219) <= 1
                    && Math.abs(rgba[2] - 158) <= 1 && rgba[3] === 255 && bar.cells.length > 0) {
                    stats.pixelMatch = true;
                    stats.pixelMatches++;
                  }
                  break;
                }
              }
            }
          } catch {
            // Observation must never replace a production render result or error.
          }
        }
      });
      const glPrototype = WebGL2RenderingContext.prototype;
      const glCreateKinds = [
        ["createBuffer", "buffer"], ["createVertexArray", "vertexArray"],
        ["createProgram", "program"], ["createShader", "shader"], ["createTexture", "texture"],
      ];
      for (const [name, kind] of glCreateKinds) {
        wrap(glPrototype, name, (original) => function (...args) {
          const result = Reflect.apply(original, this, args);
          const owner = ownerOfCanvas(this.canvas);
          const stats = owner ? ownerStats[owner] : null;
          if (result && stats) {
            stats.wrapperCreates++;
            stats.handleStates.set(result, {
              state: "alive", kind, context: this, owner, epoch: stats.invalidationEpoch,
            });
            if (stats.lossEpoch > 0) stats.createdAfterRestore++;
          }
          return result;
        });
      }
      const glDeleteKinds = [
        ["deleteBuffer", "buffer"], ["deleteVertexArray", "vertexArray"],
        ["deleteProgram", "program"], ["deleteShader", "shader"], ["deleteTexture", "texture"],
      ];
      for (const [name, kind] of glDeleteKinds) {
        wrap(glPrototype, name, (original) => function (...args) {
          const owner = ownerOfCanvas(this.canvas);
          const stats = owner ? ownerStats[owner] : null;
          const handle = args[0];
          if (stats && handle) {
            const entry = stats.handleStates.get(handle);
            if (entry) {
              if (entry.kind !== kind || entry.context !== this || entry.owner !== owner) {
                throw new Error("GL handle ledger mismatch on " + name + ": recorded kind=" + entry.kind
                  + " owner=" + entry.owner + " vs delete kind=" + kind + " owner=" + owner);
              }
              if (entry.state === "alive") {
                if (entry.epoch !== stats.invalidationEpoch) {
                  throw new Error("GL handle ledger invalidation-epoch mismatch on " + name);
                }
                stats.matchedDeletes++;
              } else if (entry.state === "lost-invalidated") {
                // Old-generation handles invalidated by the actual loss may only be deleted
                // through this exact recorded matching handle identity.
                stats.invalidatedDeletes++;
              }
              stats.handleStates.delete(handle);
            } else {
              stats.unmatchedDeletes++;
            }
          }
          return Reflect.apply(original, this, args);
        });
      }
      // Uniform locations are lookups, not resource wrappers; keep them in a separate counter.
      wrap(glPrototype, "getUniformLocation", (original) => function (...args) {
        const owner = ownerOfCanvas(this.canvas);
        if (owner && ownerStats[owner]) ownerStats[owner].uniformLocations++;
        return Reflect.apply(original, this, args);
      });
      wrap(glPrototype, "drawArraysInstanced", (original) => function (...args) {
        const result = Reflect.apply(original, this, args);
        const owner = ownerOfCanvas(this.canvas);
        if (owner && ownerStats[owner]) ownerStats[owner].draws++;
        if (renderDepth > 0) renderGl = this;
        return result;
      });
      // Real owner readPixels traffic (the actual GPU read path), independent of the draw proxy.
      wrap(glPrototype, "readPixels", (original) => function (...args) {
        const owner = ownerOfCanvas(this.canvas);
        if (owner && ownerStats[owner]) ownerStats[owner].readPixelsCalls++;
        return Reflect.apply(original, this, args);
      });
      // Registration ledger partitioned by the ACTUAL target: production binds owner-global
      // modifiers on the owner window/document AND some tracked types (keydown) directly on
      // chart canvases. Canvas-target records are accounted in their own target scope, never
      // mislabeled owner-global; callback identity, target, event type and the default
      // capture=false must match between add and remove in both scopes.
      const ownerGlobalTypes = new Set(["keydown", "keyup", "blur", "pointerup", "visibilitychange"]);
      const isOwnerGlobalTargetLedger = (target) => Boolean(target)
        && (target.self === target || target.defaultView !== undefined);
      const registrations = [];
      const removalCounts = {
        "owner-global": { unmatched: 0, captureMismatched: 0 },
        canvas: { unmatched: 0, captureMismatched: 0 },
      };
      const normalizedCapture = (options) => (typeof options === "boolean" ? options : Boolean(options?.capture));
      // The ledger installer is shared by every realm: this main document realm and the
      // adopted popup realm below (a popup is a separate realm with its OWN
      // EventTarget.prototype, so its registrations and removals are invisible to a
      // main-realm-only wrapper). Both realms record into one shared ledger keyed by the
      // ACTUAL target identity, type, callback identity and capture flag.
      const installEventTargetLedger = (realmPrototype) => {
        wrap(realmPrototype, "addEventListener", (original) => function (type, callback, options) {
          if (ownerGlobalTypes.has(type)) {
            const capture = normalizedCapture(options);
            const once = typeof options === "object" && options !== null && Boolean(options.once);
            // Real browser registration identity: a duplicate (target, type, callback, capture)
            // add is a dedup no-op; mirror that instead of double-counting production re-binds.
            const duplicate = registrations.some((entry) => !entry.removed && entry.target === this
              && entry.type === type && entry.callback === callback && entry.capture === capture);
            if (!duplicate) {
              // Bounded origin diagnostic for a pending record: producer callback identity and
              // a tiny creation stack, reported only when the strict pending oracle fails.
              const callbackName = typeof callback === "function" ? (callback.name || "<anonymous>") : String(callback);
              const origin = String(new Error().stack ?? "").split("\n").slice(1, 4).join(" | ").slice(0, 240);
              registrations.push({ target: this, type, callback, capture, once, removed: false, captureAtRemove: null,
                scope: isOwnerGlobalTargetLedger(this) ? "owner-global" : "canvas", callbackName, origin });
            }
          }
          return Reflect.apply(original, this, [type, callback, options]);
        });
        wrap(realmPrototype, "removeEventListener", (original) => function (type, callback, options) {
          if (ownerGlobalTypes.has(type)) {
            const capture = normalizedCapture(options);
            const record = registrations.find((entry) => !entry.removed && entry.target === this
              && entry.type === type && entry.callback === callback && entry.capture === capture);
            const scope = isOwnerGlobalTargetLedger(this) ? "owner-global" : "canvas";
            if (record) {
              record.removed = true;
              record.captureAtRemove = capture;
            } else if (registrations.some((entry) => !entry.removed && entry.target === this
              && entry.type === type && entry.callback === callback)) {
              // A removal whose capture does not match the registration would not remove the
              // real browser listener; it must never mark the record removed.
              removalCounts[scope].captureMismatched++;
            } else {
              removalCounts[scope].unmatched++;
            }
          }
          return Reflect.apply(original, this, [type, callback, options]);
        });
      };
      installEventTargetLedger(EventTarget.prototype);
  
    // Bounded test-local fence over the real native RAF scheduler for the capture-order
    // slice only. Both request and cancel are wrapped with one identity space (native ids),
    // so native cancels of held or pending callbacks are honored; drain + restore are
    // idempotent and run unconditionally in cleanup on every partial failure.
    nativeRaf = window.requestAnimationFrame.bind(window);
    nativeCancelRaf = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      const entry = { cancelled: false, callback, held: false, done: false, nativeId: undefined };
      const nativeId = nativeRaf((timestamp) => {
        if (entry.cancelled || entry.done) { rafByNativeId.delete(nativeId); return; }
        if (fenceArmed) {
          // The native frame fired while fenced: the native-ID record must stay alive THROUGH
          // the held period so a later cancelAnimationFrame(id) still finds and terminates this
          // queued callback; a drained or cancelled entry can never reappear as an old-ID ghost.
          entry.held = true;
          rafQueue.push(entry);
          return;
        }
        entry.done = true;
        rafByNativeId.delete(nativeId);
        entry.callback(timestamp);
      });
      entry.nativeId = nativeId;
      rafByNativeId.set(nativeId, entry);
      return nativeId;
    };
    window.cancelAnimationFrame = (id) => {
      const entry = rafByNativeId.get(id);
      if (entry) {
        entry.cancelled = true;
        rafByNativeId.delete(id);
        if (entry.held) {
          const heldIndex = rafQueue.indexOf(entry);
          if (heldIndex >= 0) rafQueue.splice(heldIndex, 1);
        }
        return;
      }
      // Foreign ids (scheduled before the wrap or by other hosts) stay native, and an id
      // whose wrapper already fired is a native no-op exactly like the real scheduler.
      return nativeCancelRaf(id);
    };
    rafWrapped = true;
// Restoration of the native requestAnimationFrame/cancelAnimationFrame pair is guaranteed
    // independently of the drain outcome: a drained callback that throws must never skip the
    // restore (the enclosing attempt records the drain failure without masking the primary
    // thrown value, which may itself be null or undefined).
    restorers.push(() => {
      try {
        drainRafFence();
      } finally {
        restoreNativeRaf();
      }
    });

      // Observer first: the initial aggregate snapshot must be false before any input binding.
      magnetUnsubscribe = subscribeDrawingMagnetTransient((active) => {
        magnet.notifications++;
        magnet.values.push(active);
      });
      magnet.initial = magnet.values[0] === false;

      handles.A = mountChart(roots.A, makeState("A"), servicesFor("A"), panelIds.A, createChartSurfaceModel());
      handles.B = mountChart(roots.B, makeState("B"), servicesFor("B"), panelIds.B, createChartSurfaceModel());
      await waitFor(() => getChartRuntime(panelIds.A) && getChartRuntime(panelIds.B), "two actual registered Runtimes");
      runtimeA = getChartRuntime(panelIds.A);
      runtimeB = getChartRuntime(panelIds.B);
      const initialTradeCallbacks = subscriptions.get(owners.A.market);
      capturedStaleCallback = initialTradeCallbacks && initialTradeCallbacks.size ? [...initialTradeCallbacks][0] : null;
      await waitFor(() => runtimeA.getCaptureReadiness().ready && runtimeB.getCaptureReadiness().ready, "capture-ready actual Worker-transport history and canonical analysis", 45_000);
      // Controlled lifecycle/pixel fixture, NOT the application's default-250 acceptance:
      // the initial 250 columns in these 498/558px plots are narrower than the unchanged
      // render-time sampler's >4px guard. Normalize only after real history has settled,
      // through the public range API; retain real GL, literal OHLC and exact RGBA oracles.
      const fixtureHistoryBars = 60;
      const fixtureFuturePaddingBars = 8;
      const fixtureColumns = 68;
      if (fixtureHistoryBars + fixtureFuturePaddingBars !== fixtureColumns) throw new Error("fixture column oracle is inconsistent");
      for (const [owner, runtime] of [["A", runtimeA], ["B", runtimeB]]) {
        await waitFor(() => roots[owner].getBoundingClientRect().width > 0 && runtime.view.area.width > 0,
          owner + " positive CSS/plot width before fixture normalization");
        const readiness = runtime.getCaptureReadiness();
        if (!readiness.ready || readiness.history.status !== "settled") throw new Error(owner + " history is not settled before normalization");
        const series = runtime.pipeline.series;
        if (series.config.intervalMs !== interval || series.length < fixtureHistoryBars) throw new Error(owner + " real series cannot supply the 60-bar fixture");
        const firstIndex = series.length - fixtureHistoryBars;
        const firstTime = series.at(firstIndex)?.startTime;
        const lastTime = series.at(series.length - 1)?.startTime;
        if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)
          || lastTime - firstTime !== 59 * interval) throw new Error(owner + " fixture real-bar range is not exactly 60 bars");
        for (let index = 0; index < fixtureHistoryBars; index++) {
          if (series.at(firstIndex + index)?.startTime !== firstTime + index * interval) throw new Error(owner + " fixture real bars are not contiguous");
        }
        // from/to are plot edges: 60 data columns plus eight future columns.
        const range = { from: firstTime, to: lastTime + 9 * interval };
        if (range.to - range.from !== 68 * interval) throw new Error(owner + " fixture range span is not exactly 68 columns");
        runtime.setVisibleTimeRange(range);
        const actualRange = runtime.getVisibleTimeRange();
        const expectedSpacing = runtime.view.area.width / 68;
        if (!actualRange || Math.abs(actualRange.from - range.from) > 1 || Math.abs(actualRange.to - range.to) > 1
          || !Number.isFinite(runtime.view.colWidth) || runtime.view.colWidth <= 4
          || Math.abs(runtime.view.colWidth - expectedSpacing) > 1e-9
          || Math.abs(runtime.view.area.width / runtime.view.colWidth - 68) > 1e-9) {
          throw new Error(owner + " public range API did not establish the exact fixture viewport");
        }
        runtime.goLatest();
        if (Math.abs(runtime.view.colWidth - expectedSpacing) > 1e-9
          || Math.abs(runtime.view.area.width / runtime.view.colWidth - 68) > 1e-9
          || runtime.view.colWidth <= 4) throw new Error(owner + " goLatest changed normalized fixture spacing");
      }
      await waitFor(() => ownerStats.A.pixelMatch && ownerStats.B.pixelMatch, "two baseline production candle pixels through the real GL path", 30_000);

      const canvasA = roots.A.querySelector('canvas[data-chart-surface="gpu-scene"]');
      const canvasB = roots.B.querySelector('canvas[data-chart-surface="gpu-scene"]');
      if (!canvasA || !canvasB) throw new Error("actual Runtime GPU canvases were not mounted");
      const glA = canvasA.getContext("webgl2");
      const lossExtension = glA?.getExtension("WEBGL_lose_context");
      if (!glA || !lossExtension) return { blocked: "WEBGL_LOSS_UNAVAILABLE" };

      // Given chart A is actively drawing on its real native context,
      deliverTrade("A");
      await waitFor(() => ownerStats.A.draws > 0, "chart A actively drawing before loss");
      const aPixelsAtLoss = ownerStats.A.pixelMatches;
      // Bounded capture-order fence: hold real native RAF callbacks so the accepted public
      // capture stays session-pending (pre-frame) across the actual native context loss.
      // The fence is flushed inside this slice and restored unconditionally in cleanup.
      fenceArmed = true;
      // One real native frame boundary under the armed fence: the fence provably holds the
      // real scheduler callback (pre-frame) that keeps the accepted public capture
      // session-pending, replacing the unconditional delay it approximated.
      await new Promise((resolve) => nativeRaf(() => resolve()));
      if (!runtimeA.getCaptureReadiness().ready) throw new Error("public capture readiness was false at the documented loss boundary");
      lifecycleOrder.push("capture-called");
      // Pre-frame reject path: the owner's actual readPixels counter is already positive from
      // the baseline pixel capture, so snapshot it right before the public capture invoke and
      // assert a zero delta at the pre-frame native-loss boundary below - this capture was
      // rejected before any frame ran, so it must not have performed a pixel read of its own.
      const aReadPixelsAtCaptureInvoke = ownerStats.A.readPixelsCalls;
      const pendingCapture = runtimeA.captureNativePng().then(
        (capture) => ({ capture, error: null }),
        (error) => ({ capture: null, error: { code: error?.code, message: String(error?.message || error) } }),
      );
      const drawsWhenCaptured = ownerStats.A.draws;
      // When the actual context is lost while the capture is session-pending (no frame ran),
      // the invalidation epoch advances exactly once, on this actual context invalidation.
      let lossLedgerError = null;
      const lostEvent = new Promise((resolve) => canvasA.addEventListener("webglcontextlost", () => {
        lifecycleOrder.push("context-lost");
        ownerStats.A.lossEpoch++;
        ownerStats.A.handlesAtLoss = 0;
        for (const [handle, entry] of ownerStats.A.handleStates) {
          if (entry.state !== "alive") continue;
          if (entry.epoch !== ownerStats.A.invalidationEpoch) {
            lossLedgerError = "alive GL handle from an earlier invalidation epoch at loss";
            continue;
          }
          ownerStats.A.handlesAtLoss++;
          entry.state = "lost-invalidated";
        }
        ownerStats.A.invalidationEpoch++;
        resolve();
      }, { once: true }));
      lossExtension.loseContext();
      await lostEvent;
      // Pre-frame native-loss boundary: the still-session-pending capture has been rejected by
      // the actual context loss without any frame or pixel read of its own (delta must be 0).
      if (ownerStats.A.readPixelsCalls !== aReadPixelsAtCaptureInvoke) {
        throw new Error("readPixels count changed across the pre-frame native-loss boundary (delta " + (ownerStats.A.readPixelsCalls - aReadPixelsAtCaptureInvoke) + ")");
      }
      if (lossLedgerError) throw new Error(lossLedgerError);
      const outcome = await pendingCapture;
      lifecycleOrder.push(outcome.error ? "capture-rejected" : "capture-resolved");
      // Drain every held native RAF callback synchronously (cancelled entries are skipped,
      // never revived by an old-ID ghost) and fully restore the original native RAF and
      // cancel before any lost-draw or B-positive measurement below.
      try {
        drainRafFence();
      } finally {
        restoreNativeRaf();
      }
      if (ownerStats.A.draws !== drawsWhenCaptured) {
        throw new Error("a native frame ran inside the capture-order fence (delta " + (ownerStats.A.draws - drawsWhenCaptured) + ")");
      }
      if (!outcome.error || outcome.error.code !== "CAPTURE_FAILED"
        || !outcome.error.message.includes("WebGL context was lost during capture")) {
        throw new Error("session-pending public capture across native context loss produced " + JSON.stringify(outcome));
      }
      // Then the frozen lost interval — starting immediately after the rejected capture and
      // covering the explicit surface intents, the wait, and B's independent trade/render —
      // has zero A draws, ending only immediately before restoreContext. The draw counter
      // stays true even while the context is lost (no filter suppresses it).
      const aDrawsAtLoss = ownerStats.A.draws;
      for (let index = 0; index < 3; index++) runtimeA.invalidate();
      // Non-vacuous lost interval measured on the real native scheduler: two actual RAF
      // frame boundaries elapse while the context is lost, and the interval ends on B's
      // real render/pixel positives below immediately before restoreContext, not on a delay.
      for (let frame = 0; frame < 2; frame++) {
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
      }

      // Chart B stays fully alive and rendering on its own untouched context.
      const bBefore = ownerStats.B.renders;
      const bPixelsBefore = ownerStats.B.pixelMatches;
      deliverTrade("B");
      await waitFor(() => ownerStats.B.renders > bBefore && ownerStats.B.pixelMatches > bPixelsBefore, "independent B trade/render while A is lost");
      if (ownerStats.B.lossEpoch !== 0) throw new Error("B context was invalidated by A loss");
      // End of the actual native context-lost interval, immediately before restoreContext.
      loss = { outcome: outcome.error, lostDrawDelta: ownerStats.A.draws - aDrawsAtLoss, order: lifecycleOrder.slice(), aReadPixelsCalls: ownerStats.A.readPixelsCalls, aPixelMatchesAtLoss: aPixelsAtLoss };
      if (loss.lostDrawDelta !== 0) throw new Error("A produced a native draw while its context was lost");
      // Frozen immutable pre-restore baselines, separate from the lost-interval snapshot.
      const aDrawsBeforeRestore = ownerStats.A.draws;
      const aPixelsBeforeRestore = ownerStats.A.pixelMatches;

      // When the context is restored, a fresh invalidation epoch is NOT opened: the production
      // restore listener (registered earlier than this late observer) synchronously stamps the
      // new renderer's resources in the CURRENT epoch, so this observer must not advance the
      // epoch a second time. The fresh resources draw the literal pixel oracle again.
      const restoredEvent = new Promise((resolve) => canvasA.addEventListener("webglcontextrestored", () => {
        resolve();
      }, { once: true }));
      lossExtension.restoreContext();
      await restoredEvent;
      await waitFor(() => ownerStats.A.createdAfterRestore > 0 && ownerStats.A.draws > aDrawsBeforeRestore && ownerStats.A.pixelMatches > aPixelsBeforeRestore, "restored A fresh-generation resources, real draw, and literal pixel oracle", 20_000);
      restore = {
        handlesAtLoss: ownerStats.A.handlesAtLoss,
        createdAfterRestore: ownerStats.A.createdAfterRestore,
        aMatchedDeletes: 0,
        aInvalidatedDeletes: 0,
        aUnmatchedDeletes: 0,
        bUnmatchedDeletes: 0,
        aWrapperCreates: ownerStats.A.wrapperCreates,
        aUniformLocations: ownerStats.A.uniformLocations,
        bUniformLocations: ownerStats.B.uniformLocations,
      };

      // Zero-size (hidden) owner: the measured DOM rect collapses to zero while the canvas
      // bitmap is retained, and re-activating with valid geometry keeps the surface usable.
      // A same-size activate() only measures and schedules; an empty pipeline queue does not
      // contract a new draw, so the draw oracle must come from a real public invalidate.
      const hiddenBitmap = { w: canvasA.width, h: canvasA.height };
      runtimeA.deactivate();
      roots.A.style.display = "none";
      // Two real native frame boundaries flush the hidden owner's style/layout change and
      // prove the bitmap is retained after actual native frames, not after a fixed delay.
      for (let frame = 0; frame < 2; frame++) {
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      const hiddenRect = roots.A.getBoundingClientRect();
      hidden.zeroGeometry = hiddenRect.width === 0 && hiddenRect.height === 0;
      hidden.bitmapRetained = canvasA.width === hiddenBitmap.w && canvasA.height === hiddenBitmap.h && canvasA.width > 0;
      if (!hidden.zeroGeometry) throw new Error("hidden owner still reports non-zero DOM geometry " + hiddenRect.width + "x" + hiddenRect.height);
      if (!hidden.bitmapRetained) throw new Error("hidden owner did not retain its canvas bitmap");
      roots.A.style.display = "block";
      runtimeA.activate();
      // Two real native frame boundaries let the re-activated owner's scheduled real frame
      // and the restored layout settle before geometry is measured, not a fixed delay.
      for (let frame = 0; frame < 2; frame++) {
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      const restoredRect = roots.A.getBoundingClientRect();
      if (restoredRect.width <= 0 || restoredRect.height <= 0) throw new Error("re-activated owner did not restore valid geometry");
      hidden.geometryRestored = true;
      const hiddenDraws = ownerStats.A.draws;
      const hiddenPixels = ownerStats.A.pixelMatches;
      runtimeA.invalidate();
      await waitFor(() => ownerStats.A.draws > hiddenDraws && ownerStats.A.pixelMatches > hiddenPixels, "public invalidate after hidden-to-valid owner geometry draws the literal pixel oracle");

      // Owner-global modifier isolation through the public DrawingManager tool and module aggregate.
      crosshairUnsubscribe = runtimeA.subscribeCrosshairMove(() => inputCount++);
      const drawingsA = contexts.get(owners.A.market).drawings;
      previousTool = drawingsA.activeTool;
      drawingsA.setTool("horizontal");
      adoption.activeToolHorizontal = drawingsA.activeTool === "horizontal";
      const mainWindow = window;
      const keyDownControl = (win) => win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }));
      const blurWindow = (win) => win.dispatchEvent(new win.Event("blur"));
      keyDownControl(mainWindow);
      adoption.oldKeyDownTrue = magnet.values.at(-1) === true;
      blurWindow(mainWindow);
      adoption.oldBlurFalse = magnet.values.at(-1) === false;

      // Canvas hover is its own evidence (public crosshair oracle), never an owner-global claim.
      const interactionCanvas = roots.A.querySelector('canvas[data-chart-surface="interaction"]');
      const rectBefore = interactionCanvas?.getBoundingClientRect();
      if (!interactionCanvas || !rectBefore || rectBefore.width <= 0 || rectBefore.height <= 0) {
        throw new Error("pre-adoption interaction surface has no valid geometry");
      }
      const hoverCanvas = (win, rect) => interactionCanvas.dispatchEvent(new win.PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        pointerId: 7,
        pointerType: "mouse",
      }));
      const beforeOldHover = inputCount;
      hoverCanvas(mainWindow, rectBefore);
      await waitFor(() => inputCount > beforeOldHover, "old owner canvas hover subscription processed the dispatched pointermove");
      adoption.oldOwnerCanvasHover = inputCount > beforeOldHover;

      // Adoption plus the synchronous host refresh; natural popup focus settles before priming.
      popup = window.open("about:blank", "native-runtime-adopted-owner");
      if (!popup || !popup.document.body) return { blocked: "POPUP_UNAVAILABLE" };
      // The popup is a separate realm: install its EventTarget ledger BEFORE adoptNode and the
      // synchronous refreshHostLifecycle, so the new owner-global registrations and their later
      // teardown removals are observed with real target identity from the very first one. The
      // wrap() restorer is pushed independently, so a partial failure between this install and
      // the adoption still restores the popup realm prototype during cleanup.
      installEventTargetLedger(popup.EventTarget.prototype);
      popup.document.body.appendChild(popup.document.adoptNode(roots.A));
      runtimeA.refreshHostLifecycle();
      const oldKeydownAdds = registrations.filter((entry) => entry.scope === "owner-global" && entry.target === mainWindow && entry.type === "keydown");
      removal.keydownAdds = oldKeydownAdds.length;
      // Owner-global modifiers/removals live only on the ACTUAL old/new owner windows (or
      // their documents) with default capture=false; canvas-target bindings of tracked types
      // are accounted in their own target scope, never mislabeled owner-global.
      const isActualOwnerGlobal = (target) => target === mainWindow || target === mainWindow.document
        || target === popup || target === popup.document;
      const ownerGlobalEntries = registrations.filter((entry) => entry.scope === "owner-global");
      const canvasEntries = registrations.filter((entry) => entry.scope === "canvas");
      // Positive adoption oracle on the ACTUAL new popup realm: the producer must register
      // keydown/keyup/blur/visibilitychange membership on the popup window/document itself
      // (never merely an old-record identity), and those popup-realm registrations must be
      // removed again during chart A teardown below.
      const isPopupRealmTarget = (target) => target === popup || target === popup.document;
      const popupEntries = ownerGlobalEntries.filter((entry) => isPopupRealmTarget(entry.target));
      removal.popupGlobalMembership = popupEntries.length > 0
        && ["keydown", "keyup", "blur", "visibilitychange"].every((type) => popupEntries.some((entry) => entry.type === type && !entry.removed));
      removal.allTrackedOnOwnerGlobals = ownerGlobalEntries.length > 0
        && ownerGlobalEntries.every((entry) => isActualOwnerGlobal(entry.target));
      removal.canvasTargetsAreCanvases = canvasEntries.every((entry) => entry.target.tagName === "CANVAS");
      removal.addsCaptureFalse = registrations.length > 0 && registrations.every((entry) => entry.capture === false);
      removal.identityCaptureOk = ownerGlobalEntries.some((entry) => entry.type === "keydown" && entry.removed
        && entry.capture === false && entry.captureAtRemove === false)
        && removalCounts["owner-global"].unmatched === 0 && removalCounts["owner-global"].captureMismatched === 0
        && removalCounts.canvas.unmatched === 0 && removalCounts.canvas.captureMismatched === 0;
      // Actual native popup readiness: the adopted realm's public document state must be
      // complete and visible before any key/blur priming, instead of a fixed settle delay.
      await waitFor(() => popup.document.readyState === "complete" && popup.document.visibilityState === "visible", "adopted popup realm document complete and visible");
      const notificationsBeforePrime = magnet.notifications;
      keyDownControl(popup);
      adoption.newKeyDownTrue = magnet.values.at(-1) === true;
      blurWindow(mainWindow);
      adoption.oldBlurStaysTrue = magnet.values.at(-1) === true && magnet.notifications === notificationsBeforePrime + 1;
      blurWindow(popup);
      adoption.newBlurFalse = magnet.values.at(-1) === false;
      keyDownControl(mainWindow);
      adoption.oldKeyDownStaysFalse = magnet.values.at(-1) === false && magnet.notifications === notificationsBeforePrime + 2;
      keyDownControl(popup);
      adoption.newKeyDownPositiveAgain = magnet.values.at(-1) === true;
      const rectAfter = interactionCanvas.getBoundingClientRect();
      if (rectAfter.width <= 0 || rectAfter.height <= 0) {
        throw new Error("adopted Runtime interaction surface has no valid owner geometry");
      }
      const beforeNewHover = inputCount;
      hoverCanvas(popup, rectAfter);
      await waitFor(() => inputCount > beforeNewHover, "adopted owner canvas hover subscription processed the dispatched pointermove");
      adoption.newOwnerCanvasHover = inputCount > beforeNewHover;
      if (!adoption.oldKeyDownTrue || !adoption.oldBlurFalse || !adoption.newKeyDownTrue
        || !adoption.oldBlurStaysTrue || !adoption.newBlurFalse || !adoption.oldKeyDownStaysFalse
        || !adoption.newKeyDownPositiveAgain || !adoption.oldOwnerCanvasHover || !adoption.newOwnerCanvasHover) {
        throw new Error("owner-global adoption isolation or canvas hover oracle failed: " + JSON.stringify(adoption));
      }

      // Teardown: stale owner listeners, subscriptions and captured callbacks must be ineffective.
      magnetUnsubscribe?.();
      magnetUnsubscribe = null;
      crosshairUnsubscribe?.();
      crosshairUnsubscribe = null;
      handles.A.dispose();
      await waitFor(() => !getChartRuntime(panelIds.A), "A runtime registry teardown");
      cleanup.registryRemoved = true;
      // The popup-realm registrations recorded at adoption must be removed by chart A
      // teardown itself (the input controller removal contract is synchronous).
      const popupEntriesAtTeardown = registrations.filter((entry) => entry.scope === "owner-global" && isPopupRealmTarget(entry.target));
      removal.popupGlobalRemovedAfterTeardown = popupEntriesAtTeardown.length > 0
        && popupEntriesAtTeardown.every((entry) => entry.removed);
      cleanup.subscriptionRemoved = !subscriptions.get(owners.A.market)?.size;
      const detachedContextEvent = new Event("webglcontextlost", { cancelable: true });
      canvasA.dispatchEvent(detachedContextEvent);
      cleanup.contextListenerRemoved = !detachedContextEvent.defaultPrevented;
      if (capturedStaleCallback) {
        try {
          capturedStaleCallback(tradeFor("A"));
        } catch {
          cleanup.staleCallbackThrew = true;
        }
      }
      const bDrawsBeforeTeardown = ownerStats.B.renders;
      const bPixelsBeforeTeardown = ownerStats.B.pixelMatches;
      deliverTrade("B");
      await waitFor(() => ownerStats.B.renders > bDrawsBeforeTeardown && ownerStats.B.pixelMatches > bPixelsBeforeTeardown, "B production draw after A teardown");
      const bRuntimeAliveBeforeClose = getChartRuntime(panelIds.B) === runtimeB;
      const aCanvasesRemoved = roots.A.querySelectorAll("canvas").length === 0;

      handles.B.dispose();
      await waitFor(() => !getChartRuntime(panelIds.B), "B runtime registry teardown");
      cleanup.analysisListenersEmpty = analysisListeners.size === 0;
      cleanup.revisionListenersEmpty = revisionListeners.size === 0;
      cleanup.tradeSubscriptionsEmpty = [...subscriptions.values()].every((set) => set.size === 0);
      // once:true records auto-remove in the real browser on first dispatch; they are reported
      // evidence only, never part of the pending leak oracle. Pending accounting is partitioned
      // by actual target: owner-global pending must reach zero; canvas-target pending is a
      // separately owned target account (the canvas element itself is torn down with the chart).
      const pendingOwnerGlobalEntries = registrations.filter((entry) => entry.scope === "owner-global" && !entry.removed && !entry.once);
      removal.pendingGlobal = pendingOwnerGlobalEntries.length;
      // Bounded diagnostic for a pending-record failure: actual type, target realm, producer
      // callback identity, capture and a tiny creation stack. Diagnostic evidence only - the
      // strict pendingGlobal zero oracle is never weakened by name filters or excludes.
      removal.pendingGlobalDetail = pendingOwnerGlobalEntries.slice(0, 8).map((entry) => ({
        type: entry.type,
        targetRealm: entry.target === mainWindow ? "main-window"
          : entry.target === mainWindow.document ? "main-document"
          : entry.target === popup ? "popup-window"
          : entry.target === popup?.document ? "popup-document" : "other",
        callbackName: entry.callbackName,
        capture: entry.capture,
        origin: entry.origin,
      }));
      removal.pendingOnce = registrations.filter((entry) => entry.scope === "owner-global" && !entry.removed && entry.once).length;
      removal.pendingCanvas = registrations.filter((entry) => entry.scope === "canvas" && !entry.removed).length;
      removal.ownerGlobalUnmatchedRemovals = removalCounts["owner-global"].unmatched;
      removal.ownerGlobalCaptureMismatchedRemovals = removalCounts["owner-global"].captureMismatched;
      removal.canvasUnmatchedRemovals = removalCounts.canvas.unmatched;
      removal.canvasCaptureMismatchedRemovals = removalCounts.canvas.captureMismatched;
      restore.aMatchedDeletes = ownerStats.A.matchedDeletes;
      restore.aInvalidatedDeletes = ownerStats.A.invalidatedDeletes;
      restore.aUnmatchedDeletes = ownerStats.A.unmatchedDeletes;
      restore.bUnmatchedDeletes = ownerStats.B.unmatchedDeletes;
      // CURRENT alive handles must be zero for BOTH owners after dispose. Surviving
      // lost-invalidated records from an earlier epoch are tracked separately: their native
      // resources were already freed by the actual invalidation, so a remaining record is
      // tracked accounting, not a live native leak — full-ledger emptiness is not asserted.
      restore.aHandlesAliveRemaining = [...ownerStats.A.handleStates.values()].filter((entry) => entry.state === "alive").length;
      restore.bHandlesAliveRemaining = [...ownerStats.B.handleStates.values()].filter((entry) => entry.state === "alive").length;
      restore.aHandlesLostInvalidatedRemaining = [...ownerStats.A.handleStates.values()].filter((entry) => entry.state === "lost-invalidated").length;
      restore.bHandlesLostInvalidatedRemaining = [...ownerStats.B.handleStates.values()].filter((entry) => entry.state === "lost-invalidated").length;
      if (!cleanup.subscriptionRemoved || !cleanup.contextListenerRemoved) {
        throw new Error("A subscription or native context listener remained after owner teardown");
      }

      return {
        blocked: null,
        magnetInitialFalse: magnet.initial,
        baselineA: ownerStats.A.pixelMatch,
        baselineB: ownerStats.B.pixelMatch,
        bothCellBars: ownerStats.A.cellBars > 0 && ownerStats.B.cellBars > 0,
        loss,
        restore,
        hidden,
        adoption,
        removal,
        cleanup,
        bDrawAfterATeardown: ownerStats.B.renders > bDrawsBeforeTeardown,
        aCanvasesRemoved,
        bRuntimeAlive: bRuntimeAliveBeforeClose,
      };
    } catch (error) {
      primary.thrown = true;
      primary.value = error;
      throw error;
    } finally {
      // Best-effort, independently attempted cleanup that preserves the primary thrown value;
      // wrapper installation happened inside this same try, so partial installs are restored too.
      const secondary = [];
      const attempt = (label, fn) => {
        try { fn(); } catch (error) { secondary.push(label + ": " + String(error?.message || error)); }
      };
      attempt("magnetUnsubscribe", () => magnetUnsubscribe?.());
      attempt("crosshairUnsubscribe", () => crosshairUnsubscribe?.());
      attempt("toolRestore", () => contexts.get(owners.A.market)?.drawings?.setTool(previousTool ?? null));
      attempt("disposeA", () => handles.A?.dispose());
      attempt("disposeB", () => handles.B?.dispose());
      for (const restoreFn of restorers.reverse()) attempt("restorePrototype", restoreFn);
      attempt("removeRootA", () => roots.A.remove());
      attempt("removeRootB", () => roots.B.remove());
      attempt("closePopup", () => { if (popup && !popup.closed) popup.close(); });
      if (secondary.length) {
        // Every attempt already ran: with no primary throw, a cleanup failure surfaces as its
        // own error after all attempts (never console-warn-only); with a primary throw the
        // original value stays primary and the bounded secondary detail remains a warning.
        if (!primary.thrown) {
          throw new Error("native-runtime cleanup failed with no primary error: " + secondary.join(" | "));
        }
        console.warn("native-runtime cleanup secondary errors (primaryThrown=true):", secondary.join(" | "));
      }
    }
  }, { owners, interval, priceStep });

  if (evidence.blocked) {
    test.skip(true, "BLOCKED: " + evidence.blocked + " (mandatory native case, never counted green)");
  }

  // F4-01: the fixture itself is the oracle for the startup wire contract.
  expect(historyEvidence.queries).toBeGreaterThan(0);
  expect(historyEvidence.returned).toBeGreaterThan(0);
  expect(historyEvidence.populatedCells).toBeGreaterThan(0);
  for (const key of ["aligned", "ohlc", "volume", "delta", "count", "cells", "order", "closedBars"]) {
    expect(historyEvidence[key]).toBe(true);
  }
  expect(evidence.magnetInitialFalse).toBe(true);
  expect(evidence.baselineA).toBe(true);
  expect(evidence.baselineB).toBe(true);
  expect(evidence.bothCellBars).toBe(true);
  expect(evidence.loss.outcome).toEqual({
    code: "CAPTURE_FAILED",
    message: "WebGL context was lost during capture",
  });
  expect(evidence.loss.lostDrawDelta).toBe(0);
  expect(evidence.loss.order).toEqual(["capture-called", "context-lost", "capture-rejected"]);
  expect(evidence.loss.aReadPixelsCalls).toBeGreaterThan(0);
  expect(evidence.loss.aPixelMatchesAtLoss).toBeGreaterThan(0);
  expect(evidence.restore.handlesAtLoss).toBeGreaterThan(0);
  expect(evidence.restore.createdAfterRestore).toBeGreaterThan(0);
  expect(evidence.restore.aMatchedDeletes).toBeGreaterThan(0);
  expect(evidence.restore.aInvalidatedDeletes).toBeGreaterThan(0);
  expect(evidence.restore.aUnmatchedDeletes).toBe(0);
  expect(evidence.restore.bUnmatchedDeletes).toBe(0);
  expect(evidence.restore.aHandlesAliveRemaining).toBe(0);
  expect(evidence.restore.bHandlesAliveRemaining).toBe(0);
  // Surviving lost-invalidated records are tracked accounting, not a live native leak; their
  // native resources were already freed by the actual invalidation.
  expect(evidence.restore.aHandlesLostInvalidatedRemaining).toBeGreaterThanOrEqual(0);
  expect(evidence.restore.bHandlesLostInvalidatedRemaining).toBeGreaterThanOrEqual(0);
  expect(evidence.hidden.zeroGeometry).toBe(true);
  expect(evidence.hidden.bitmapRetained).toBe(true);
  expect(evidence.hidden.geometryRestored).toBe(true);
  expect(evidence.adoption.activeToolHorizontal).toBe(true);
  expect(evidence.adoption.oldKeyDownTrue).toBe(true);
  expect(evidence.adoption.oldBlurFalse).toBe(true);
  expect(evidence.adoption.oldOwnerCanvasHover).toBe(true);
  expect(evidence.adoption.newKeyDownTrue).toBe(true);
  expect(evidence.adoption.oldBlurStaysTrue).toBe(true);
  expect(evidence.adoption.newBlurFalse).toBe(true);
  expect(evidence.adoption.oldKeyDownStaysFalse).toBe(true);
  expect(evidence.adoption.newKeyDownPositiveAgain).toBe(true);
  expect(evidence.adoption.newOwnerCanvasHover).toBe(true);
  expect(evidence.removal.keydownAdds).toBeGreaterThanOrEqual(2);
  expect(evidence.removal.addsCaptureFalse).toBe(true);
  expect(evidence.removal.identityCaptureOk).toBe(true);
  expect(evidence.removal.allTrackedOnOwnerGlobals).toBe(true);
  expect(evidence.removal.ownerGlobalCaptureMismatchedRemovals).toBe(0);
  expect(evidence.removal.ownerGlobalUnmatchedRemovals).toBe(0);
  expect(evidence.removal.canvasCaptureMismatchedRemovals).toBe(0);
  expect(evidence.removal.canvasUnmatchedRemovals).toBe(0);
  expect(evidence.removal.canvasTargetsAreCanvases).toBe(true);
  // Diagnostic publication only (issue 325, flaky pendingGlobal!=0 first attempt): the
  // strict zero oracle is unchanged; the already-computed bounded detail (target realm,
  // type, callback identity, capture, 3-frame bounded creation stack; max 8 records)
  // rides the failing assertion message so remote CI evidence can be read from the log.
  expect(
    evidence.removal.pendingGlobal,
    "pendingGlobalDetail: " + JSON.stringify(evidence.removal.pendingGlobalDetail),
  ).toBe(0);
  expect(evidence.removal.popupGlobalMembership).toBe(true);
  expect(evidence.removal.popupGlobalRemovedAfterTeardown).toBe(true);
  expect(evidence.cleanup.registryRemoved).toBe(true);
  expect(evidence.cleanup.subscriptionRemoved).toBe(true);
  expect(evidence.cleanup.contextListenerRemoved).toBe(true);
  expect(evidence.cleanup.analysisListenersEmpty).toBe(true);
  expect(evidence.cleanup.revisionListenersEmpty).toBe(true);
  expect(evidence.cleanup.tradeSubscriptionsEmpty).toBe(true);
  expect(evidence.bDrawAfterATeardown).toBe(true);
  expect(evidence.aCanvasesRemoved).toBe(true);
  expect(evidence.bRuntimeAlive).toBe(true);
  // staleCallbackThrew is reported evidence only: the stale callback must stay
  // ineffective (registry removed, B alive above), its throw shape is not contracted.
});

// Task 325 A3b — native pending owner RAF gap (production BDD RED case; isolated duplicate
// seed setup, the frozen 1400-line native fixture above stays byte-identical).
// Given two real public ChartRuntimes (A and B) mounted via mountChart on the app-shell-free
// same-origin fixture document, fed startup history through the production /history JSON +
// NDJSON-v1/binary-v2 Worker route with coherent literal 4-fills-per-bar fixtures
// (V=4, delta=2, count=4, independent hand-written expectedCells oracle), both
// capture-ready, warm and quiescent, and A adopted into a pre-created same-origin popup;
// When a public A.invalidate() queues exactly one NEW actual native RAF on the OLD main
// owner window and, in the SAME synchronous JS turn (no await between), the A host is
// adopted via popup.document.adoptNode/append followed by the synchronous public
// runtime.refreshHostLifecycle();
// Then the OLD main owner window must ACTUALLY cancelAnimationFrame that isolated pending
// id (real native cancellation, never a mere ledger belief), the isolated id must never
// fire or reschedule on the old owner, the pre-scheduled unrelated popup control frame must
// stay untouched and fire, a later fresh popup-owner frame must be cancelled by public
// dispose without firing or rescheduling, and B must stay healthy (registry alive, its own
// fired native frames, observable pixels, stable shared-stream subscription, unchanged
// closed financial fixture evidence). On the current unfixed source this fails as the
// specific old-owner cancellation=false behavior RED, not as a setup/timeout/type error.
//
// Review-36 repair map (every change confined to THIS appended case; the frozen fixture
// prefix above is untouched):
// (1) capture.bytes is a NUMBER on the source API (nativeCapture.ts NativeCaptureFrame);
//     PNG width/height/bytes are capture-metadata positivity only — candle evidence comes
//     from actual native GL draw calls plus real candle-color pixels decoded from the
//     captured PNG (theme.color.buy #3fe0a0 / theme.color.sell #e06c75).
// (2)/(4) A's own new-owner popup frames are isolated by ledger id DIFFS around the public
//     calls (beforeNewOwner is used); unrelated twoFrames/testOwned:false/control entries
//     can never satisfy a proof. Firing and pixels are asserted on the exact pinned entry.
// (3)/(5) The RAF ledger keeps the ORIGINAL raf/cancel identities separate from the bound
//     invocation helpers and restores them exactly (own-property vs prototype aware). The
//     delegating callback ALWAYS runs on the original native schedule, ALWAYS records the
//     actual fired timestamp even after cancellation (late-fired detection), and never
//     drops a callback. The ledger is capped per realm+native id and never evicts pinned
//     proof/control entries. B's subscriber identity/set/count is captured while A+B are
//     both alive, BEFORE the A dispose.
// (6) Real public A/B getAnalysisSnapshot() BEFORE adoption, AFTER adoption (A) and around
//     the B live leg, checked against the independent literal closed-bar table
//     (OHLC/V=4/delta=2/count=4/4 footprint cells), one explicit single-closed-bar
//     visibleTimeRange call, and the live B bar applied by four coherent public trades read
//     through the public AnalysisSnapshotOptions.now snapshot option — asserted on the
//     Runtime-APPLIED bar fields, never on invocation counts.
// (7) Cleanup disposes both runtimes and restores every wrapped API (RAF windows, GL
//     prototypes) before the popup is closed; only test-owned leftovers are cancelled
//     after the behavior evidence is captured.
test("real Runtime cancels a pending native owner RAF on adoption and destroy", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const interval = 60_000;
  const priceStep = 0.01;
  const owners = {
    A: { market: "BINANCE:BTCUSDT", open: 100, high: 102, low: 99, close: 101, left: 8, width: 560 },
    B: { market: "BINANCE:ETHUSDT", open: 200, high: 200.02, low: 199.99, close: 200.01, left: 590, width: 620 },
  };
  const fixtureOwner = new Map(Object.values(owners).map((owner) => [owner.market, owner]));
  // Coherent literal fills per served bar (open buy, high buy, low sell, close buy; qty 1,
  // tradeCount 1) — A literals unchanged; B literals are policy-safe independent oracle inputs; expectedCells is a separate
  // hand-written oracle, never the aggregation that produced the bars.
  const fixtureTrades = (owner) => [
    { price: owner.open, side: "buy" },
    { price: owner.high, side: "buy" },
    { price: owner.low, side: "sell" },
    { price: owner.close, side: "buy" },
  ];
  const expectedCells = new Map([
    ["BINANCE:BTCUSDT", [
      [99, 0, 1, 0, 0, 1, 0, 1],
      [100, 1, 0, 0, 0, 1, 1, 0],
      [101, 1, 0, 0, 0, 1, 1, 0],
      [102, 1, 0, 0, 0, 1, 1, 0],
    ]],
    ["BINANCE:ETHUSDT", [
      [199.99, 0, 1, 0, 0, 1, 0, 1],
      [200, 1, 0, 0, 0, 1, 1, 0],
      [200.01, 1, 0, 0, 0, 1, 1, 0],
      [200.02, 1, 0, 0, 0, 1, 1, 0],
    ]],
  ]);
  const historyEvidence = {
    aligned: true, queries: 0, returned: 0, populatedCells: 0,
    ohlc: true, volume: true, delta: true, count: true, cells: true, order: true, closedBars: true,
  };
  await page.route(/\/history(?:\?|$)/, (route) => {
    const params = new URL(route.request().url()).searchParams;
    const market = (params.get("markets") ?? "").split(",")[0] ?? "";
    const owner = fixtureOwner.get(market);
    const from = Number(params.get("from"));
    const to = Number(params.get("to"));
    historyEvidence.queries++;
    if (!owner || Number(params.get("interval")) !== interval || !(Number(params.get("priceStep")) > 0)) {
      historyEvidence.aligned = false;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars: [] } }) });
    }
    const firstBar = Math.ceil(from / interval) * interval;
    const lastBar = Math.min(Math.floor(to / interval) * interval, Math.floor(Date.now() / interval) * interval - interval);
    const bars = [];
    for (let startTime = firstBar; startTime <= lastBar; startTime += interval) {
      const cells = fixtureTrades(owner)
        .map((fill) => [fill.price, fill.side === "buy" ? 1 : 0, fill.side === "buy" ? 0 : 1, 0, 0, 1,
          fill.side === "buy" ? 1 : 0, fill.side === "buy" ? 0 : 1])
        .sort((left, right) => left[0] - right[0]);
      bars.push({ t: startTime, o: owner.open, h: owner.high, l: owner.low, c: owner.close, v: 4, d: 2, n: 4, cells, completeness: "complete", updatedAt: startTime + interval - 1 });
    }
    let previousStart = -Infinity;
    for (const bar of bars) {
      historyEvidence.returned++;
      historyEvidence.populatedCells += bar.cells.length;
      if (bar.t % interval !== 0 || bar.t < from || bar.t > to) historyEvidence.aligned = false;
      if (bar.t <= previousStart) historyEvidence.order = false;
      previousStart = bar.t;
      if (bar.t + interval > Date.now()) historyEvidence.closedBars = false;
      if (bar.v !== 4) historyEvidence.volume = false;
      if (bar.d !== 2) historyEvidence.delta = false;
      if (bar.n !== 4) historyEvidence.count = false;
      if (bar.cells.length !== 4) historyEvidence.cells = false;
      const expectedBarCells = expectedCells.get(owner.market);
      for (let index = 0; index < bar.cells.length; index++) {
        const cell = bar.cells[index];
        const expectedCell = expectedBarCells?.[index];
        if (!cell || cell.length !== 8 || !expectedCell || cell.some((value, slot) => value !== expectedCell[slot])) historyEvidence.cells = false;
      }
    }
    const meta = {
      schemaVersion: 1,
      generatedAt: Date.now(),
      provenance: [{ source: "native-runtime-route-fixture", completeness: "complete" }],
      footprintCoverage: {
        schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: market, authority: "provisional",
        status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to,
        reasonCode: null, authorityToken: "native-runtime-route-fixture", projectionThroughId: "0",
      },
    };
    const format = params.get("format");
    if (format === "ndjson-v1" || format === "binary-v2") {
      return route.fulfill({
        status: 200,
        contentType: "application/x-ndjson; charset=utf-8",
        body: [
          JSON.stringify({ type: "header", schemaVersion: 1, interval, meta }),
          JSON.stringify({ type: "bars", sequence: 0, bars }),
          JSON.stringify({ type: "complete", count: bars.length, cellCount: bars.reduce((sum, bar) => sum + bar.cells.length, 0) }),
          "",
        ].join("\n"),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars }, meta }) });
  });

  // App-shell-free same-origin fixture document (same approach as the frozen native test).
  const fixtureDocumentPath = "/__pactolis-native-pending-red-fixture__";
  const fixtureSentinel = "pactolis-native-pending-red-fixture";
  await page.route(fixtureDocumentPath, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><title>" + fixtureSentinel + "</title></head>\n<body data-fixture=\"" + fixtureSentinel + "\"><!-- " + fixtureSentinel + ": no entry script --></body>\n</html>\n",
    });
  });
  await page.goto(fixtureDocumentPath);
  await page.unroute(fixtureDocumentPath);
  const capability = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    return { webgl2: Boolean(gl) };
  });
  if (!capability.webgl2) {
    test.skip(true, "BLOCKED: native WebGL2 unavailable in this runtime (mandatory case, never counted green)");
  }

  // FE325 observability bridge: the two approved bounded browser diagnostic lines inside
  // page.evaluate (native-b-live-wait-diagnostic / native-b-live-wait-target-bar) are
  // browser console events only and never reach the Node job logs. This public Playwright
  // console listener forwards our exact diagnostic kinds to Node stdout as the WHOLE
  // original JSON string. Bounded per test attempt (max 2 forwarded lines, each <=1500
  // UTF-8 bytes, <=3000 total); strictly guarded so forwarding can never mask the original
  // page.evaluate error, the LedgerFatal classification, or a Node assertion error; the
  // forwarded lines are observation only and are never used as expected values.
  let forwardedNativeDiagnosticLines = 0;
  const forwardNativeDiagnosticConsole = (message) => {
    try {
      if (forwardedNativeDiagnosticLines >= 2 || message.type() !== "warning") return;
      const text = message.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      const kind = parsed && typeof parsed.kind === "string" ? parsed.kind : null;
      const isDiagnostic = kind === "native-b-live-wait-diagnostic" || kind === "native-b-live-wait-target-bar";
      const isFallbackShape = kind === "diagnostic-fallback"
        && Object.keys(parsed).length === 3
        && parsed.cause === "UNKNOWN"
        && parsed.truncatedForBound === true;
      if (!isDiagnostic && !isFallbackShape) return;
      forwardedNativeDiagnosticLines += 1;
      if (Buffer.byteLength(text, "utf8") > 1500) {
        console.log('{"kind":"diagnostic-fallback","cause":"node-forward-bound","truncatedForBound":true}');
        return;
      }
      console.log(text);
    } catch { /* forwarding guard: never masks the original page.evaluate error */ }
  };
  page.on("console", forwardNativeDiagnosticConsole);
  try {
  const evidence = await page.evaluate(async (spec) => {
    const owners = spec.owners;
    const interval = spec.interval;
    const priceStep = spec.priceStep;
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

    const rootFor = (owner) => {
      const root = document.createElement("div");
      root.dataset.nativeRuntimeOwner = owner;
      root.style.cssText = "position:fixed;top:16px;height:360px;overflow:hidden;background:#101010;";
      root.style.left = owners[owner].left + "px";
      root.style.width = owners[owner].width + "px";
      document.body.appendChild(root);
      return root;
    };
    const roots = { A: rootFor("A"), B: rootFor("B") };
    const subscriptions = new Map();
    const analysisListeners = new Set();
    const revisionListeners = new Set();
    const revisions = new Map();
    const contexts = new Map(Object.keys(owners).map((key) => {
      const owner = owners[key];
      return [owner.market, {
        market: owner.market,
        profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
        previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
        previousWeekStrategyLevels: [],
        mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
        mondayRangeLevels: [],
        nakedPocs: [],
        referenceLevels: [],
        drawings: new DrawingManager(() => {}),
      }];
    }));
    const snapshot = (market) => {
      const revision = revisions.get(market) || 1;
      return {
        market,
        revision,
        canonical: { status: "complete", market, runKey: market + "|" + priceStep, generation: revision, revision, failedPeriods: [] },
      };
    };
    const servicesFor = (ownerKey) => ({
      subscribeToTrades(market, callback) {
        let set = subscriptions.get(market);
        if (!set) subscriptions.set(market, set = new Set());
        set.add(callback);
        return () => set.delete(callback);
      },
      fetchHistory() { return Promise.resolve([]); },
      fetchPriceStep: async () => priceStep,
      fetchPricePrecision: async () => 2,
      getAnalysisContext: (market) => contexts.get(market ?? owners[ownerKey].market),
      getAnalysisRevisionSnapshot: (market) => snapshot(market ?? owners[ownerKey].market),
      subscribeAnalysis(listener) { analysisListeners.add(listener); return () => analysisListeners.delete(listener); },
      subscribeAnalysisRevision(listener) { revisionListeners.add(listener); return () => revisionListeners.delete(listener); },
      updateAnalysisFromSeries(market) {
        revisions.set(market, (revisions.get(market) || 1) + 1);
        for (const listener of revisionListeners) listener();
        for (const listener of analysisListeners) listener({ kind: "automatic-data", market, dataRevision: revisions.get(market), visibilityRevision: 1 });
      },
      fetchNpocSnapshot(market, signal) {
        if (signal && signal.aborted) return Promise.reject(new DOMException("NPOC aborted", "AbortError"));
        return new Promise((resolve, reject) => {
          const timer = window.setTimeout(() => resolve({ schemaVersion: 3, market, levels: [], valueAreas: [] }), 0);
          signal?.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("NPOC aborted", "AbortError")); }, { once: true });
        });
      },
      notifyActiveMarket() {},
      notifyInteractiveCandlesReady() {},
      notifyInteractiveHistorySettled() {},
      triggerAutoSync() {},
      notifyBarClose() {},
      notify() {},
      isFootprintSyncBusy: () => false,
    });

    // Native RAF ledger: REAL delegating wrappers in BOTH realms. Callbacks always run on
    // the original native schedule with the actual DOMHighResTimeStamp; ids are the
    // original native return values; cancel records the actual native cancellation. No
    // holding, dropping, delaying, draining or fake scheduling anywhere.
    const RAF_LEDGER_CAP = 256;
    const rafLedger = new Map(); // "realm:id" -> { realm, id, state, seq, cancelCalls, cancelRequested, testOwned, pinned, firedAt }
    const rafRestorers = [];
    let rafSequence = 0; // monotonic in-page ledger sequence; never subtract across clocks
    let observationFenceSeq = -1; // entries at/after this fence are protected evidence
    let ledgerOverflow = false; // fail-closed cap evidence, surfaced at the oracle
    let fixtureLedgerFatal = null; // explicit FIXTURE_LEDGER_OVERFLOW observation; never a silent evidence drop
    const installRafLedger = (win, realm) => {
      // ORIGINAL identities are stored separately from the bound invocation helpers and are
      // restored EXACTLY (own-property vs prototype aware), in both realms. The restorer is
      // registered BEFORE the mutation, so a partial-install throw still restores everything.
      const originalRaf = win.requestAnimationFrame;
      const originalCancel = win.cancelAnimationFrame;
      const rafWasOwn = Object.prototype.hasOwnProperty.call(win, "requestAnimationFrame");
      const cancelWasOwn = Object.prototype.hasOwnProperty.call(win, "cancelAnimationFrame");
      const nativeRaf = originalRaf.bind(win);
      const nativeCancel = originalCancel.bind(win);
      rafRestorers.push(() => {
        if (rafWasOwn) win.requestAnimationFrame = originalRaf;
        else delete win.requestAnimationFrame;
        if (cancelWasOwn) win.cancelAnimationFrame = originalCancel;
        else delete win.cancelAnimationFrame;
      });
      // Correction C: only long-settled, unpinned, non-test entries created strictly BEFORE
      // the observation fence may ever be pruned; PENDING/canceled, pinned, testOwned and
      // every post-fence entry are protected until the oracle reads them. When nothing is
      // evictable the ledger fails closed (ledgerOverflow) instead of hiding evidence; the
      // callback always still runs on the original native schedule.
      const evictForNewEntry = () => {
        for (const key of rafLedger.keys()) {
          const candidate = rafLedger.get(key);
          if (candidate.pinned || candidate.testOwned) continue;
          if (candidate.state === "pending" || candidate.state === "canceled") continue;
          if (observationFenceSeq >= 0 && candidate.seq >= observationFenceSeq) continue;
          rafLedger.delete(key);
          return true;
        }
        return false;
      };
      win.requestAnimationFrame = (callback) => {
        // Each native callback OWNS its ledger entry through this closure, so the ACTUAL
        // fire is always recorded (fired / late-fired even when canceled) even when the
        // capped global map has no space for the entry. The callback is never held,
        // dropped, delayed or drained and always receives the SAME original timestamp.
        const entry = { realm, id: null, state: "pending", seq: rafSequence++, cancelCalls: 0, cancelRequested: false, testOwned: false, pinned: false, firedAt: null };
        const id = nativeRaf((timestamp) => {
          entry.firedAt = timestamp; // ALWAYS record the actual fired timestamp
          entry.state = entry.state === "canceled" ? "late-fired" : "fired"; // a late callback is never hidden
          if (entry.unledgered) {
            fixtureLedgerFatal = "FIXTURE_LEDGER_OVERFLOW: an unledgered (cap-overflow) native " + entry.realm + "-realm RAF (id " + entry.id + ") actually fired; the capped global ledger never hid or dropped the callback, but this path never qualifies Green or RED";
          }
          return callback(timestamp); // ALWAYS delegate the original callback, same timestamp
        });
        entry.id = id;
        const key = realm + ":" + id;
        if (rafLedger.size < RAF_LEDGER_CAP || evictForNewEntry()) {
          rafLedger.set(key, entry); // only ever recorded within the hard cap
        } else {
          // Fail closed: the global ledger NEVER grows past the cap; the overflow is an
          // explicit fatal observation, never a silent evidence drop, and the closure
          // above still records the real fire.
          ledgerOverflow = true;
          entry.unledgered = true;
          fixtureLedgerFatal = "FIXTURE_LEDGER_OVERFLOW: the capped (" + RAF_LEDGER_CAP + ") native RAF ledger had no evictable pre-fence settled entry for a new " + realm + "-realm RAF (id " + id + ")";
        }
        return id;
      };
      win.cancelAnimationFrame = (id) => {
        const entry = rafLedger.get(realm + ":" + id);
        if (entry) {
          // Correction D: cumulative cancel history survives every later state (fired/late-fired).
          entry.cancelCalls += 1;
          entry.cancelRequested = true;
          if (entry.state === "pending") entry.state = "canceled";
        }
        return nativeCancel(id); // real native cancellation, never a ledger-only belief
      };
    };
    const realmPending = (realm) => [...rafLedger.values()].filter((entry) => entry.realm === realm && entry.state === "pending").map((entry) => entry.id);
    const entryFor = (realm, id) => rafLedger.get(realm + ":" + id);
    // The main-realm RAF ledger is installed INSIDE the outer try (Correction B).

    // Actual native GL draw ledger, grounded on the same public native GL methods the frozen
    // fixture wraps (WebGL2RenderingContext.prototype draw calls). Every call delegates to
    // the original; only observation is added. Installed per realm: the adopted popup is a
    // separate realm with its own prototype.
    const drawCounts = { A: 0, B: 0 };
    const glRestorers = [];
    const installDrawLedger = (realmWin) => {
      const proto = realmWin.WebGL2RenderingContext.prototype;
      for (const name of ["drawArrays", "drawArraysInstanced", "drawElements", "drawElementsInstanced"]) {
        const original = proto[name];
        if (typeof original !== "function") continue;
        const wasOwn = Object.prototype.hasOwnProperty.call(proto, name);
        glRestorers.push(() => { if (wasOwn) proto[name] = original; else delete proto[name]; });
        proto[name] = function (...args) {
          const result = original.apply(this, args);
          try {
            const canvas = this.canvas;
            if (canvas && typeof canvas.closest === "function") {
              const ownerRoot = canvas.closest("[data-native-runtime-owner]");
              const owner = ownerRoot?.dataset?.nativeRuntimeOwner;
              if (owner === "A" || owner === "B") drawCounts[owner]++;
            }
          } catch { /* observation must never break a production draw */ }
          return result;
        };
      }
    };
    // The main-realm GL draw ledger is installed INSIDE the outer try (Correction B).

    const pinEntry = (entry) => { if (entry) entry.pinned = true; return entry; };
    const testRaf = (win, realm, callback) => {
      const id = win.requestAnimationFrame(callback);
      const entry = entryFor(realm, id);
      if (entry) entry.testOwned = true; // test frames can never satisfy a proof
      return id;
    };
    const twoFrames = async (win, realm) => new Promise((resolve) => testRaf(win, realm, () => testRaf(win, realm, resolve)));
    // FE325 overflow classification correction: the capped-ledger fatal flag is checked
    // SYNCHRONOUSLY at every ledger-dependent observation boundary (same JS turn, no new
    // timers/waits/timeout changes), so a fixture ledger overflow is always classified as
    // FIXTURE_LEDGER_OVERFLOW instead of leaking a premise failure, a TypeError or a posthoc
    // boolean assertion.
    const ensureLedgerUsable = (checkpoint) => {
      if (fixtureLedgerFatal) throw new Error(fixtureLedgerFatal + " [checkpoint: " + checkpoint + "]");
    };
    const awaitLedgerChecked = async (description, thunk) => {
      ensureLedgerUsable(description + " before");
      try {
        return await thunk();
      } finally {
        ensureLedgerUsable(description + " after"); // on error too: the fatal flag (if actually set) wins
      }
    };
    const twoFramesChecked = (win, realm) => awaitLedgerChecked("twoFrames " + realm, () => twoFrames(win, realm));
    const waitFor = async (predicate, description, timeout = 12_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        // Outer async guard: a capped-ledger overflow fails the observation IMMEDIATELY
        // at this await boundary instead of burning the full timeout on unusable evidence.
        if (fixtureLedgerFatal) throw new Error(fixtureLedgerFatal);
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      if (fixtureLedgerFatal) throw new Error(fixtureLedgerFatal);
      throw new Error("Timed out waiting for " + description);
    };

    // Independent hand-written expected footprint table for the PUBLIC analysis snapshot
    // oracle (price -> [buyVolume, sellVolume, totalVolume, delta, tradeCount,
    // buyTradeCount, sellTradeCount]) — literal values, never the aggregation output.
    const expectedFootprintByMarket = new Map([
      ["BINANCE:BTCUSDT", new Map([
        [99, [0, 1, 1, -1, 1, 0, 1]],
        [100, [1, 0, 1, 1, 1, 1, 0]],
        [101, [1, 0, 1, 1, 1, 1, 0]],
        [102, [1, 0, 1, 1, 1, 1, 0]],
      ])],
      ["BINANCE:ETHUSDT", new Map([
        [199.99, [0, 1, 1, -1, 1, 0, 1]],
        [200, [1, 0, 1, 1, 1, 1, 0]],
        [200.01, [1, 0, 1, 1, 1, 1, 0]],
        [200.02, [1, 0, 1, 1, 1, 1, 0]],
      ])],
    ]);
    const matchesLiteralBar = (candle, owner) => {
      if (!candle) return false;
      if (candle.open !== owner.open || candle.high !== owner.high || candle.low !== owner.low || candle.close !== owner.close) return false;
      if (candle.volume !== 4 || candle.delta !== 2 || candle.count !== 4) return false;
      const cells = candle.footprint;
      if (!Array.isArray(cells) || cells.length !== 4) return false;
      const expectedMap = expectedFootprintByMarket.get(owner.market);
      for (const cell of cells) {
        const expected = expectedMap.get(cell.price);
        if (!expected) return false;
        if (cell.buyVolume !== expected[0] || cell.sellVolume !== expected[1] || cell.totalVolume !== expected[2]) return false;
        if (cell.delta !== expected[3] || cell.tradeCount !== expected[4] || cell.buyTradeCount !== expected[5] || cell.sellTradeCount !== expected[6]) return false;
      }
      // Independent union oracle: exactly the four expected DISTINCT prices — a duplicated
      // cell price can never produce a passing result.
      const seenPrices = new Set(cells.map((cell) => cell.price));
      if (seenPrices.size !== cells.length || seenPrices.size !== expectedMap.size) return false;
      return true;
    };
    // Correction A: closed-anchor EXACT one-bar public snapshot oracle. The anchor is an
    // ACTUAL closed bar chosen from the runtime BEFORE the pending race; the scoped public
    // call uses the source semantics bucketEnd > from && start <= to, so
    // {from: anchor.time, to: anchor.time} selects exactly that one closed bar. The oracle
    // is the independent literal table, never a before-vs-after parity.
    const closedAnchorFor = (runtime, owner) => {
      const full = runtime.getAnalysisSnapshot();
      const anchor = (full.candles ?? []).filter((candle) => candle.endTime <= Date.now()).at(-1);
      return anchor ? { time: anchor.time } : null;
    };
    const exactScopedBarOk = (runtime, owner, anchor) => {
      if (!anchor) return false;
      const scoped = runtime.getAnalysisSnapshot({ visibleTimeRange: { from: anchor.time, to: anchor.time } });
      if (!scoped || scoped.market !== owner.market) return false;
      if (!Array.isArray(scoped.candles) || scoped.candles.length !== 1) return false;
      const candle = scoped.candles[0];
      if (candle.time !== anchor.time || candle.endTime !== anchor.time + interval) return false;
      if (!matchesLiteralBar(candle, owner)) return false;
      const cellTotals = candle.footprint.reduce((sum, cell) => ({
        volume: sum.volume + cell.totalVolume, delta: sum.delta + cell.delta, count: sum.count + cell.tradeCount,
      }), { volume: 0, delta: 0, count: 0 });
      if (candle.volume !== 4 || cellTotals.volume !== 4) return false;
      if (candle.delta !== 2 || cellTotals.delta !== 2) return false;
      if (candle.count !== 4 || cellTotals.count !== 4) return false;
      const warnings = (scoped.warnings ?? []).map((warning) => String(warning));
      if (warnings.some((warning) => warning.includes("No closed candles intersect the visible time range"))) return false;
      if (warnings.some((warning) => /truncat|omit|missing|incomplete/i.test(warning))) return false;
      return true;
    };
    // Candle-body colors are the public theme constants buy #3fe0a0 / sell #e06c75; PNG
    // decode + pixel scan proves real drawn candle pixels, independent of PNG byte size.
    const candleColors = [[63, 224, 160], [224, 108, 117]];
    const scanCandlePixels = async (blob) => {
      const bitmap = await createImageBitmap(blob);
      try {
        const width = bitmap.width;
        const height = bitmap.height;
        if (!(width > 0 && height > 0)) return 0;
        const scratchCanvas = document.createElement("canvas");
        scratchCanvas.width = width;
        scratchCanvas.height = height;
        const ctx = scratchCanvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return 0;
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, width, height).data;
        let hits = 0;
        for (let offset = 0; offset < data.length; offset += 4) {
          if (data[offset + 3] !== 255) continue;
          for (const color of candleColors) {
            if (Math.abs(data[offset] - color[0]) <= 14 && Math.abs(data[offset + 1] - color[1]) <= 14 && Math.abs(data[offset + 2] - color[2]) <= 14) { hits++; break; }
          }
          if (hits >= 64) break;
        }
        return hits;
      } finally {
        bitmap.close();
      }
    };

    let popup = null;
    let popupControlId = null;
    let popupControlFired = false;
    const runtimeA = { current: null };
    const runtimeB = { current: null };
    const handles = { A: null, B: null };
    const panelIds = { A: "native-pending-A-" + Date.now(), B: "native-pending-B-" + Date.now() };
    const primary = { thrown: false, value: undefined };
    const makeState = (owner) => ({
      type: "chart",
      market: owners[owner].market,
      timeframe: "1m",
      scaleMode: "linear",
      chartType: "candlestick",
      candles: true,
      heat: false,
      cellNumbers: false,
      poc: false,
      stackedImbalance: false,
    });

    try {
      // Correction B: EVERY installed side effect (main-realm RAF ledger + GL draw ledger)
      // lives inside this outer try, so a partial-setup throw still runs the finally
      // cleanup; each restorer was registered BEFORE its mutation above.
      installRafLedger(window, "main");
      installDrawLedger(window);
      handles.A = mountChart(roots.A, makeState("A"), servicesFor("A"), panelIds.A, createChartSurfaceModel());
      handles.B = mountChart(roots.B, makeState("B"), servicesFor("B"), panelIds.B, createChartSurfaceModel());
      await waitFor(() => getChartRuntime(panelIds.A) && getChartRuntime(panelIds.B), "two actual registered Runtimes");
      runtimeA.current = getChartRuntime(panelIds.A);
      runtimeB.current = getChartRuntime(panelIds.B);
      // Warm/settle BOTH owners via public readiness/DOM diagnostics, far outside the pending race.
      await waitFor(() => runtimeA.current.getCaptureReadiness().ready && runtimeB.current.getCaptureReadiness().ready, "capture-ready actual Worker-transport history and canonical analysis", 45_000);
      runtimeA.current.goLatest();
      runtimeB.current.goLatest();
      const canvasA = roots.A.querySelector('canvas[data-chart-surface="gpu-scene"]');
      const canvasB = roots.B.querySelector('canvas[data-chart-surface="gpu-scene"]');
      if (!canvasA || !canvasB) throw new Error("actual Runtime GPU canvases were not mounted");

      // (6) Real PUBLIC closed-anchor oracles for A and B: each anchor is an ACTUAL closed
      // bar captured BEFORE the pending race and re-read through the EXACT one-bar scoped
      // public snapshot. The SAME anchors are re-verified after adoption (A) and after the
      // A dispose (B, before the live fill); the oracle is the independent literal table,
      // never a before-vs-after parity.
      const anchorA = closedAnchorFor(runtimeA.current, owners.A);
      const anchorB = closedAnchorFor(runtimeB.current, owners.B);
      const aAnchorExactBefore = exactScopedBarOk(runtimeA.current, owners.A, anchorA);
      const bAnchorExactBefore = exactScopedBarOk(runtimeB.current, owners.B, anchorB);
      // Root BDD financial gate BEFORE the popup and the pending race: with a bad
      // financial fixture the exact-anchor premise must fail HERE as an explicit
      // FIXTURE_FINANCIAL_PREMISE error, never masquerade as the source-behavior RED.
      if (!aAnchorExactBefore || !bAnchorExactBefore) {
        throw new Error("FIXTURE_FINANCIAL_PREMISE: the pre-race closed anchors did not match the independent literal single-bar + time + OHLCV/delta/count cells oracle through the exact one-bar scoped public snapshot (aAnchorExactBefore=" + aAnchorExactBefore + ", bAnchorExactBefore=" + bAnchorExactBefore + "); missing or wrong fixture financial data cannot produce a proper source RED");
      }

      // Pre-create, style and ledger the SAME-ORIGIN popup host realm; A stays active the
      // whole time (no runtime.deactivate anywhere in this test).
      popup = window.open("about:blank", "native-pending-red-owner");
      if (!popup || !popup.document.body) return { blocked: "POPUP_UNAVAILABLE" };
      popup.document.body.style.cssText = "margin:0;background:#101010;";
      installRafLedger(popup, "popup");
      installDrawLedger(popup);

      // Quiescent native schedulers in both realms before the pending race (warm, settled,
      // no coalesced pending frame from A or anything else).
      await waitFor(() => realmPending("main").length === 0 && realmPending("popup").length === 0, "quiescent native RAF schedulers before the pending race", 30_000);
      const popupPendingBeforeRace = new Set(realmPending("popup"));
      // Correction C observation fence: every ledger entry created at/after this monotonic
      // sequence is protected evidence; only settled entries from strictly before it may
      // ever be evicted, and the cap fails closed instead of hiding anything.
      observationFenceSeq = rafSequence;

      // Bounded unrelated popup control frame: scheduled just before the race, must fire and
      // never be cancelled — proves the producer does not perform a blanket owner cancel.
      popupControlId = popup.requestAnimationFrame(() => { popupControlFired = true; });
      ensureLedgerUsable("unrelated popup control frame ledgered before testOwned"); // overflow cannot TypeError
      pinEntry(entryFor("popup", popupControlId)).testOwned = true;

      // THE pending race: ONE synchronous JS turn, no await between the three public steps.
      const runAdoptionRace = () => {
        const before = realmPending("main");
        runtimeA.current.invalidate();
        ensureLedgerUsable("adoption race A.invalidate new-id isolation");
        const newIds = realmPending("main").filter((id) => !before.includes(id));
        if (newIds.length !== 1) {
          throw new Error("PREMISE_NOT_ISOLATED: expected exactly one NEW actual main-realm native RAF after public A.invalidate(), saw " + newIds.length + " — no source-RED claim from a premise failure");
        }
        const isolatedA = newIds[0];
        pinEntry(entryFor("main", isolatedA));
        popup.document.body.appendChild(popup.document.adoptNode(roots.A));
        runtimeA.current.refreshHostLifecycle();
        ensureLedgerUsable("adoption race adoptNode+refreshHostLifecycle cancel predicate");
        // Correct-behavior assertion, evaluated BEFORE any wait for the later new-owner
        // frame: the OLD main owner window must have ACTUALLY cancelled the isolated id.
        const entry = entryFor("main", isolatedA);
        if (!entry || entry.state !== "canceled") {
          throw new Error("RED old-owner-cancel: isolated pending native RAF id " + isolatedA + " on the OLD main owner window was not cancelled across adoptNode + refreshHostLifecycle in the same JS turn (state=" + (entry ? entry.state : "missing") + ", actual cancellation=false)");
        }
        return isolatedA;
      };
      const isolatedA = runAdoptionRace();
      const raceTurnSeq = rafSequence; // monotonic ledger sequence fence for the race turn

      // A's OWN adoption-turn popup frames: the exact ids that appeared in the popup realm
      // during the race turn. In a fixed runtime refreshHostLifecycle itself queues a fresh
      // A frame here, so the already-queued popup queue is NOT required to be empty;
      // instead each adoption-turn frame is pinned and its ACTUAL native callback awaited
      // outside the race.
      const adoptionFrameEntries = realmPending("popup")
        .filter((id) => !popupPendingBeforeRace.has(id) && id !== popupControlId)
        .map((id) => pinEntry(entryFor("popup", id)));
      await twoFramesChecked(window, "main");
      await twoFramesChecked(popup, "popup");
      for (const frame of adoptionFrameEntries) {
        await waitFor(() => frame.state === "fired" || frame.state === "late-fired", "an adoption-turn popup-owner frame actual callback", 10_000);
      }
      const adoptionFramesFired = adoptionFrameEntries.every((frame) => frame.state === "fired" || frame.state === "late-fired");
      // No future callback from the old owner: the main realm drains, the isolated id never
      // fired (a post-cancel late callback would be recorded as "late-fired") and nothing
      // non-test was rescheduled on the old owner after the race turn.
      await waitFor(() => realmPending("main").length === 0, "the old main owner realm drained after adoption", 10_000);
      const oldOwnerEntry = entryFor("main", isolatedA);
      const oldOwnerNotFired = oldOwnerEntry.state !== "fired" && oldOwnerEntry.state !== "late-fired";
      const oldOwnerLateFired = oldOwnerEntry.state === "late-fired";
      const oldOwnerCancelCalls = oldOwnerEntry.cancelCalls;
      // Monotonic ledger sequence fence (never Date.now equality across clocks): nothing
      // non-test was scheduled on the old owner window at/after the race-turn sequence.
      const oldOwnerNoReschedule = ![...rafLedger.values()].some((entry) => entry.realm === "main" && !entry.testOwned && entry.seq >= raceTurnSeq && entry.id !== isolatedA);
      if (!oldOwnerNotFired || !oldOwnerNoReschedule) {
        throw new Error("old main owner fired/rescheduled after adoption: state=" + oldOwnerEntry.state + " rescheduledAfterRace=" + (!oldOwnerNoReschedule));
      }

      // Future GREEN path — A's OWN fresh new-owner frame, isolated by id DIFF around the
      // public invalidate (beforeNewOwner IS used; the unrelated control/test frames are
      // excluded). Firing is asserted on the exact pinned entry, never on any popup entry.
      const beforeNewOwner = new Set(realmPending("popup").filter((id) => id !== popupControlId));
      const drawsBeforeNewOwner = drawCounts.A;
      runtimeA.current.invalidate();
      ensureLedgerUsable("A new-owner invalidate new-id isolation");
      const newOwnerIds = realmPending("popup").filter((id) => !beforeNewOwner.has(id));
      if (newOwnerIds.length !== 1) {
        throw new Error("PREMISE_NOT_ISOLATED: expected exactly one fresh popup-owner native RAF after public A.invalidate(), saw " + newOwnerIds.length);
      }
      const newOwnerEntry = pinEntry(entryFor("popup", newOwnerIds[0]));
      await waitFor(() => newOwnerEntry.state === "fired" || newOwnerEntry.state === "late-fired", "the isolated fresh A new-owner frame actual callback", 10_000);
      const newOwnerFired = newOwnerEntry.state === "fired";
      const aNewOwnerDrawCalls = drawCounts.A - drawsBeforeNewOwner;
      await waitFor(() => runtimeA.current.getCaptureReadiness().ready, "A capture-ready in the new popup owner realm", 15_000);
      // capture.bytes is a NUMBER on the source API; PNG dims/bytes are metadata positivity
      // only — candle pixels come from the decoded PNG scan below.
      const newOwnerCapture = await awaitLedgerChecked("A captureNativePng", () => runtimeA.current.captureNativePng());
      const aCandlePixelHits = await awaitLedgerChecked("A scanCandlePixels", () => scanCandlePixels(newOwnerCapture.blob));
      const controlEntry = entryFor("popup", popupControlId);
      // Correction D: the unrelated popup control frame must have ACTUALLY fired and carry a
      // STRICT zero cumulative cancelCalls history (state alone can overwrite cancel history).
      const controlCancelCalls = controlEntry ? controlEntry.cancelCalls : -1;
      const controlNotCancelled = popupControlFired && controlCancelCalls === 0;
      // (6) A public snapshot AFTER adoption (before dispose) — the SAME pre-race anchor,
      // re-verified through the exact one-bar scoped public snapshot.
      const aAfterAdoptionAnchorOk = exactScopedBarOk(runtimeA.current, owners.A, anchorA);
      // (3)/(5) B subscriber identity/set/count captured while A+B are BOTH alive, BEFORE
      // the A dispose — closing A must never touch B's shared-stream subscription.
      const bSubBefore = new Set(subscriptions.get(owners.B.market) ?? []);
      const bSubCountBefore = bSubBefore.size;

      // Second pending race, same JS turn: fresh popup-owner A frame cancelled by public dispose.
      const runDisposeRace = () => {
        const before = realmPending("popup");
        runtimeA.current.invalidate();
        ensureLedgerUsable("dispose race A.invalidate new-id isolation");
        const newIds = realmPending("popup").filter((id) => !before.includes(id));
        if (newIds.length !== 1) {
          throw new Error("PREMISE_NOT_ISOLATED: expected exactly one NEW actual popup-realm native RAF before dispose, saw " + newIds.length);
        }
        const isolatedDispose = newIds[0];
        pinEntry(entryFor("popup", isolatedDispose));
        handles.A.dispose();
        ensureLedgerUsable("dispose race public dispose cancel predicate");
        const entry = entryFor("popup", isolatedDispose);
        if (!entry || entry.state !== "canceled") {
          throw new Error("RED dispose-cancel: fresh popup-owner pending native RAF id " + isolatedDispose + " was not cancelled by public dispose (state=" + (entry ? entry.state : "missing") + ", actual cancellation=false)");
        }
        return isolatedDispose;
      };
      const isolatedDispose = runDisposeRace();
      await twoFramesChecked(window, "main");
      await twoFramesChecked(popup, "popup");
      const disposeEntry = entryFor("popup", isolatedDispose);
      const disposeFrameNotFired = disposeEntry.state !== "fired" && disposeEntry.state !== "late-fired";
      const disposeEntryLateFired = disposeEntry.state === "late-fired";
      const disposeCancelCalls = disposeEntry.cancelCalls;
      const popupQuiescent = realmPending("popup").length === 0;
      if (!disposeFrameNotFired || !popupQuiescent) {
        throw new Error("disposed popup-owner frame fired/rescheduled: state=" + disposeEntry.state + " pending=" + realmPending("popup").length);
      }

      // B stays healthy on its own shared stream; closing A never unsubscribed B. The
      // identity snapshot bSubBefore was taken BEFORE the dispose, while A+B were alive.
      const bSubAfter = subscriptions.get(owners.B.market) ?? new Set();
      const bSubscriptionIdentityStable = bSubCountBefore > 0
        && bSubAfter.size === bSubBefore.size
        && [...bSubBefore].every((callback) => bSubAfter.has(callback));
      if (!bSubscriptionIdentityStable) {
        throw new Error("B shared-stream subscription identity/set/count changed across the A dispose (before=" + bSubCountBefore + " after=" + bSubAfter.size + ")");
      }

      // B's OWN fresh main-realm frame, isolated by id DIFF around public B.invalidate()
      // (never an old-main sentinel and never a test frame).
      const beforeB = new Set(realmPending("main"));
      const drawsBeforeB = drawCounts.B;
      runtimeB.current.invalidate();
      ensureLedgerUsable("B invalidate new-id isolation");
      const bNewIds = realmPending("main").filter((id) => !beforeB.has(id));
      if (bNewIds.length < 1) {
        throw new Error("PREMISE_NOT_ISOLATED: expected at least one NEW actual main-realm native RAF after public B.invalidate(), saw 0");
      }
      const bFrameEntries = bNewIds.map((id) => pinEntry(entryFor("main", id)));
      for (const frame of bFrameEntries) {
        await waitFor(() => frame.state === "fired" || frame.state === "late-fired", "B's own isolated native frame actual callback", 10_000);
      }
      const bOwnFrameFired = bFrameEntries.length > 0 && bFrameEntries.every((frame) => frame.state === "fired");
      const bDrawCalls = drawCounts.B - drawsBeforeB;

      // (6) Live B leg — four coherent PUBLIC trades through the runtime's own subscription
      // callbacks; the oracle is the Runtime-APPLIED bar read back through the PUBLIC
      // snapshot (AnalysisSnapshotOptions.now closes the live bucket), never the number of
      // callback invocations.
      const fillBucket = Math.floor(Date.now() / interval) * interval;
      // The SAME pre-race B anchor, re-verified after the A dispose and BEFORE the live
      // fill, through the exact one-bar scoped public snapshot.
      const bAfterDisposeAnchorOk = exactScopedBarOk(runtimeB.current, owners.B, anchorB);
      // Explicit one-bucket LIVE read scope: the implicit runtime viewport
      // (syncController visibleTimeRange, ChartRuntime.getAnalysisSnapshot
      // default) may exclude or crop the still-current fill bucket, so every
      // live-leg public read pins {from: fillBucket, to: fillBucket} plus the
      // literal B price range (published as snapshot.viewport). The prefill
      // read keeps the proper public closed-now exclusion semantics: implicit
      // now === Date.now, so the still-open current bucket can never appear
      // as a closed candle here.
      const liveReadScope = { from: fillBucket, to: fillBucket };
      const liveReadOptions = { now: fillBucket + interval, visibleTimeRange: liveReadScope, visiblePriceRange: { low: owners.B.low, high: owners.B.high } };
      const bPrefillSnapshot = runtimeB.current.getAnalysisSnapshot({ visibleTimeRange: liveReadScope });
      const bBeforeExcludedLiveBar = !bPrefillSnapshot.candles.some((candle) => candle.time === fillBucket);
      // Bounded diagnostic ONLY (never an oracle): one prospective scoped
      // snapshot of the current bucket BEFORE the fills, at the same closing
      // now the live wait uses, to distinguish a pre-existing open-bucket
      // baseline from the four applied literal fills.
      let bPrefillProspectiveSample = null;
      try {
        const prospective = runtimeB.current.getAnalysisSnapshot(liveReadOptions);
        const prospectiveBar = (prospective.candles ?? []).find((candle) => candle.time === fillBucket) ?? null;
        bPrefillProspectiveSample = prospectiveBar ? {
          time: prospectiveBar.time, endTime: prospectiveBar.endTime,
          open: prospectiveBar.open, high: prospectiveBar.high, low: prospectiveBar.low, close: prospectiveBar.close,
          volume: prospectiveBar.volume ?? null, delta: prospectiveBar.delta ?? null, count: prospectiveBar.count ?? null,
          footprintCells: Array.isArray(prospectiveBar.footprint) ? prospectiveBar.footprint.length : 0,
        } : { absent: true };
      } catch { bPrefillProspectiveSample = { error: true }; }
      const fillsB = [
        { price: owners.B.open, side: "buy" },
        { price: owners.B.high, side: "buy" },
        { price: owners.B.low, side: "sell" },
        { price: owners.B.close, side: "buy" },
      ];
      const fillBase = Math.min(Math.max(Date.now(), fillBucket + 1), fillBucket + interval - fillsB.length - 1);
      for (const [index, fill] of fillsB.entries()) {
        for (const callback of [...(subscriptions.get(owners.B.market) ?? [])]) {
          callback({ time: fillBase + index, price: fill.price, qty: 1, tradeCount: 1, isBuy: fill.side === "buy", market: owners.B.market, source: "live" });
        }
      }
      let appliedCandle = null;
      let bLastLiveSample = null;
      try {
        await waitFor(() => {
          const snap = runtimeB.current.getAnalysisSnapshot(liveReadOptions);
          bLastLiveSample = snap;
          appliedCandle = snap.candles.find((candle) => candle.time === fillBucket) ?? null;
          return Boolean(appliedCandle) && matchesLiteralBar(appliedCandle, owners.B);
        }, "the four live B fills applied to the Runtime-observed bar (V=4, delta=2, count=4, literal cells)", 15_000);
      } catch (error) {
        // Bounded PUBLIC-snapshot evidence distinguishing (a) no applied
        // target bar, (b) visible-range/detail cropping, (c) literal field
        // mismatch. The ORIGINAL wait error stays primary and is rethrown
        // unchanged; the existing LedgerFatal classification in the outer
        // catch keeps its priority. Guarded so a diagnostic failure can
        // never mask the original native/frame error.
        try {
          const cap = (value) => String(value).slice(0, 160);
          const encoder = new TextEncoder();
          const byteLen = (text) => encoder.encode(text).length;
          const fallbackLine = '{"kind":"diagnostic-fallback","cause":"UNKNOWN","truncatedForBound":true}';
          const line = (payload) => {
            try {
              const json = JSON.stringify(payload);
              if (typeof json === "string" && byteLen(json) <= 1500) return json;
              const fallback = JSON.stringify({
                kind: payload && typeof payload.kind === "string" ? payload.kind : "diagnostic-fallback",
                cause: payload && typeof payload.cause === "string" ? payload.cause : "UNKNOWN",
                truncatedForBound: true,
              });
              return typeof fallback === "string" && byteLen(fallback) <= 1500 ? fallback : fallbackLine;
            } catch {
              return fallbackLine;
            }
          };
          const snap = bLastLiveSample ?? runtimeB.current.getAnalysisSnapshot(liveReadOptions);
          const targetBar = (snap.candles ?? []).find((candle) => candle.time === fillBucket) ?? null;
          const cells = targetBar && Array.isArray(targetBar.footprint)
            ? targetBar.footprint.slice(0, 8).map((cell) => ({
              price: cell.price, buyVolume: cell.buyVolume, sellVolume: cell.sellVolume,
              totalVolume: cell.totalVolume, delta: cell.delta, tradeCount: cell.tradeCount,
              buyTradeCount: cell.buyTradeCount, sellTradeCount: cell.sellTradeCount,
            }))
            : null;
          const fieldMismatch = targetBar ? [
            targetBar.open !== owners.B.open && "open",
            targetBar.high !== owners.B.high && "high",
            targetBar.low !== owners.B.low && "low",
            targetBar.close !== owners.B.close && "close",
            targetBar.volume !== 4 && "volume",
            targetBar.delta !== 2 && "delta",
            targetBar.count !== 4 && "count",
            !Array.isArray(targetBar.footprint) && "footprint-missing",
            Array.isArray(targetBar.footprint) && targetBar.footprint.length !== 4 && "footprint-length",
          ].filter(Boolean) : null;
          // Ambiguous snapshot-only states stay UNKNOWN: this evidence cannot
          // causally prove a missing applied bar or a visible-range cropping cause.
          const cause = fieldMismatch && fieldMismatch.length ? "literal-field-mismatch" : "UNKNOWN";
          console.warn(line({
            kind: "native-b-live-wait-diagnostic", cause,
            requested: { bucket: fillBucket, bucketEnd: fillBucket + interval, interval, now: fillBucket + interval, from: fillBucket, to: fillBucket },
            snapshot: {
              targetReturned: Boolean(targetBar),
              hasFootprint: Boolean(targetBar) && Array.isArray(targetBar.footprint),
              detailsPresent: Boolean(targetBar) && targetBar.delta !== undefined && targetBar.count !== undefined,
              viewport: snap.viewport ?? null,
              candleCount: (snap.candles ?? []).length,
              lastClosedBarEnd: snap.lastClosedBarEnd ?? null,
              historyStatus: snap.historyStatus ?? null,
              warnings: (snap.warnings ?? []).slice(0, 4).map(cap),
            },
          }));
          console.warn(line({
            kind: "native-b-live-wait-target-bar",
            diagnostics: runtimeB.current.getDiagnostics(),
            targetBar: targetBar ? {
              time: targetBar.time, endTime: targetBar.endTime,
              open: targetBar.open, high: targetBar.high, low: targetBar.low, close: targetBar.close,
              volume: targetBar.volume ?? null, delta: targetBar.delta ?? null, count: targetBar.count ?? null,
              footprintCells: cells, fieldMismatch,
            } : null,
            prefillProspective: bPrefillProspectiveSample,
          }));
        } catch { /* diagnostic guard: never masks the original wait error */ }
        throw error;
      }
      const bAfterLiveApplied = matchesLiteralBar(appliedCandle, owners.B);
      const bLiveBarFootprintCells = appliedCandle?.footprint?.length ?? 0;

      const bAlive = getChartRuntime(panelIds.B) === runtimeB.current;
      await waitFor(() => runtimeB.current.getCaptureReadiness().ready, "B capture-ready after the live leg", 15_000);
      const bReadiness = runtimeB.current.getCaptureReadiness().ready;
      const bCapture = await awaitLedgerChecked("B captureNativePng", () => runtimeB.current.captureNativePng());
      const bCandlePixelHits = await awaitLedgerChecked("B scanCandlePixels", () => scanCandlePixels(bCapture.blob));

      // The RAF ledger itself stays bounded without ever evicting proof/control entries.
      const ledgerCapped = rafLedger.size <= RAF_LEDGER_CAP;

      // The evidence tuple never leaves the page with an unreported overflow: the final B
      // capture/decode awaits are covered above and this synchronous checkpoint guarantees
      // the FIXTURE_LEDGER_OVERFLOW classification before the posthoc ledger oracle runs.
      ensureLedgerUsable("evidence tuple return");
      return {
        blocked: null,
        isolatedA,
        adoptionFramesFired,
        oldOwnerNotFired,
        oldOwnerNoReschedule,
        oldOwnerLateFired,
        newOwnerFired,
        aNewOwnerDrawCalls,
        aCaptureBytesIsNumber: typeof newOwnerCapture.bytes === "number",
        aCaptureBytes: newOwnerCapture.bytes,
        aCaptureWidth: newOwnerCapture.width,
        aCaptureHeight: newOwnerCapture.height,
        aCandlePixelHits,
        controlFired: popupControlFired,
        controlNotCancelled,
        aAnchorExactBefore,
        bAnchorExactBefore,
        aAfterAdoptionAnchorOk,
        bAfterDisposeAnchorOk,
        oldOwnerCancelCalls,
        controlCancelCalls,
        disposeCancelCalls,
        bSubCountBefore,
        bSubscriptionIdentityStable,
        isolatedDispose,
        disposeFrameNotFired,
        disposeEntryLateFired,
        popupQuiescent,
        bOwnFrameFired,
        bDrawCalls,
        bBeforeExcludedLiveBar,
        bAfterLiveApplied,
        bLiveBarFootprintCells,
        bAlive,
        bReadiness,
        bCaptureBytesIsNumber: typeof bCapture.bytes === "number",
        bCaptureBytes: bCapture.bytes,
        bCandlePixelHits,
        ledgerSize: rafLedger.size,
        ledgerCapped,
        ledgerOverflow,
      };
    } catch (error) {
      primary.thrown = true;
      primary.value = error;
      // Explicit fatal classification wins ONLY when the flag is actually set; every other
      // original exception (including a proper source RED) is preserved unchanged.
      if (fixtureLedgerFatal) throw new Error(fixtureLedgerFatal);
      throw error;
    } finally {
      const secondary = [];
      const attempt = (label, fn) => { try { fn(); } catch (error) { secondary.push(label + ": " + String(error?.message || error)); } };
      // Test-owned leftovers only, AFTER the behavior assertions above. The unrelated popup
      // control frame is NEVER cancelled as cleanup (Correction D): its zero-cancelCalls
      // history is evidence, and it fires on its own within one native frame.
      attempt("disposeA", () => handles.A?.dispose());
      attempt("disposeB", () => handles.B?.dispose());
      for (const restoreFn of rafRestorers.reverse()) attempt("restoreRaf", restoreFn);
      for (const restoreFn of glRestorers.reverse()) attempt("restoreGl", restoreFn);
      attempt("removeRootA", () => roots.A.remove());
      attempt("removeRootB", () => roots.B.remove());
      attempt("closePopup", () => { if (popup && !popup.closed) popup.close(); });
      if (secondary.length) {
        if (!primary.thrown) throw new Error("native-pending-red cleanup failed with no primary error: " + secondary.join(" | "));
        console.warn("native-pending-red cleanup secondary errors (primaryThrown=true):", secondary.join(" | "));
      }
    }
  }, { owners, interval, priceStep });

  if (evidence.blocked) {
    test.skip(true, "BLOCKED: " + evidence.blocked + " (mandatory native case, never counted green)");
  }

  // Closed financial snapshot evidence (real HTTP JSON envelope + Worker stream transport).
  expect(historyEvidence.queries).toBeGreaterThan(0);
  expect(historyEvidence.returned).toBeGreaterThan(0);
  expect(historyEvidence.populatedCells).toBeGreaterThan(0);
  for (const key of ["aligned", "ohlc", "volume", "delta", "count", "cells", "order", "closedBars"]) {
    expect(historyEvidence[key]).toBe(true);
  }
  // Public before/adoption/dispose financial oracles: the SAME pre-race closed anchors,
  // re-verified through the exact one-bar scoped public snapshot (independent literals).
  expect(evidence.aAnchorExactBefore).toBe(true);
  expect(evidence.bAnchorExactBefore).toBe(true);
  expect(evidence.aAfterAdoptionAnchorOk).toBe(true);
  expect(evidence.bAfterDisposeAnchorOk).toBe(true);
  expect(evidence.bBeforeExcludedLiveBar).toBe(true);
  // Behavior oracle (expected GREEN after the production fix; proper specific RED before).
  expect(evidence.adoptionFramesFired).toBe(true);
  expect(evidence.oldOwnerNotFired).toBe(true);
  expect(evidence.oldOwnerNoReschedule).toBe(true);
  expect(evidence.oldOwnerLateFired).toBe(false);
  expect(evidence.newOwnerFired).toBe(true);
  expect(evidence.aNewOwnerDrawCalls).toBeGreaterThan(0);
  expect(evidence.aCaptureBytesIsNumber).toBe(true);
  expect(evidence.aCaptureBytes).toBeGreaterThan(0);
  expect(evidence.aCaptureWidth).toBeGreaterThan(0);
  expect(evidence.aCaptureHeight).toBeGreaterThan(0);
  expect(evidence.aCandlePixelHits).toBeGreaterThan(0);
  expect(evidence.controlFired).toBe(true);
  expect(evidence.controlNotCancelled).toBe(true);
  expect(evidence.controlCancelCalls).toBe(0);
  expect(evidence.disposeFrameNotFired).toBe(true);
  expect(evidence.disposeEntryLateFired).toBe(false);
  expect(evidence.popupQuiescent).toBe(true);
  // B health: own fired frame, native GL draws, real candle pixels, stable subscription
  // identity captured BEFORE the A dispose, and the live leg applied to the actual bar.
  expect(evidence.bSubCountBefore).toBeGreaterThan(0);
  expect(evidence.bSubscriptionIdentityStable).toBe(true);
  expect(evidence.bOwnFrameFired).toBe(true);
  expect(evidence.bDrawCalls).toBeGreaterThan(0);
  expect(evidence.bAfterLiveApplied).toBe(true);
  expect(evidence.bLiveBarFootprintCells).toBe(4);
  expect(evidence.bAlive).toBe(true);
  expect(evidence.bReadiness).toBe(true);
  expect(evidence.bCaptureBytesIsNumber).toBe(true);
  expect(evidence.bCaptureBytes).toBeGreaterThan(0);
  expect(evidence.bCandlePixelHits).toBeGreaterThan(0);
  // Cumulative cancel history: the old-owner and dispose races really called the native
  // cancel through the wrapper for their isolated frames.
  expect(evidence.oldOwnerCancelCalls).toBeGreaterThanOrEqual(1);
  expect(evidence.disposeCancelCalls).toBeGreaterThanOrEqual(1);
  // The RAF ledger itself stays bounded without ever evicting proof/control entries and
  // never fails open: a protected-entry overflow surfaces here instead of hiding evidence.
  expect(evidence.ledgerCapped).toBe(true);
  expect(evidence.ledgerOverflow).toBe(false);
  } finally {
    page.off("console", forwardNativeDiagnosticConsole);
  }
});

// Issue 325 — native DPR lifecycle qualification (BDD, test-only; Platform scope: shared).
// Source-only rewrite of this appended region: every earlier test above stays byte-exact; no
// - Closed anchors A/B keep the literal four-fill oracle (open buy, high buy, low sell, close
//   buy -> V=4, delta=2, count=4, literal OHLC), asserted on the PUBLIC getAnalysisSnapshot
//   candles AND their footprint cells (real field types per src/features/chart/
//   analysisSnapshot.ts footprintCell/fullFootprintCells; liquidation volumes are emitted
//   conditionally by that public mapper, so they are not claimed here).
// - B live fills are phase-aware: this fixture emits at most three four-fill batches into the
//   actual current minute bucket and resets to phase 1 whenever the real minute bucket changes.
//   The cumulative expectation is a handwritten fixed table (phase 1/2/3 -> V 4/8/12, delta
//   2/4/6, count 4/8/12; price 1999 sell-only and 2000/2001/2002 buy-only; per-level counts and
//   quantities scaled 1/2/3; OHLC constant 2000/2002/1999/2001), never derived from the observed
//   snapshot or the serving helper, and re-asserted in Node from independently written
//   literals. The live bucket stays a whole number of intervals past the served anchor. No
//   clock faking, no dedupe/prune/reset hooks, no long sleeps. B trades near 2000 so each
//   live fill stays inside the reference-price outlier band (0.3%) of the one before it; at
//   ~200 a one-unit step is 0.5% and production rightly drops it from the candle OHLC.
// - S1: actual Chromium CDP Emulation.setDeviceMetricsOverride 1 -> 1.5 -> 2 (no
//   devicePixelRatio writes, no fake matchMedia); reported DPR checked; all THREE bitmap
//   canvases of BOTH owners at Math.round(css*dpr); every public captureNativePng() returns
//   positive bytes, backing-store dimensions, a matching Blob byteLength, and a truly decoded
//   PNG with positive alpha and the literal candle color.
// - S2/S3/S4: hidden zero-geometry retention with fail-closed capture and reactivation; B's
//   own live bar, renders, and captures across all A phases; at most three A create/dispose
//   cycles; canvases leaving the DOM on dispose; and a stale A trade callback proven
//   ineffective by effect (A registry still absent, no new A GL creates or draws, B subscriber
//   identities and literal served anchor unchanged).
// - Ledger discipline: exact original window/prototype descriptors are captured and their
//   restorers registered BEFORE the first mutation; restoration reuses the original identity
//   (binding only ever CALLS a native). The RAF ledger delegates genuinely under every native
//   fire including the cancelled-late path (callback still invoked, record never erased,
//   cumulative late fires asserted 0); only fired records are evictable under the 256 cap and
//   a non-evictable overflow is a persisted fatal. The GL ledger keys real WebGL handle
//   identity with owner+context+kind captured at creation (DOM removal cannot lose the owner);
//   null and duplicate deletes never decrement unrelated live handles; unknown non-null
//   deletes are retained fail-closed diagnostics; final own A/B alive is 0 with positive
//   creates and zero wrong-kind/wrong-context/unknown deletes. Listener balance covers
//   owner-global types plus real MediaQueryList "change" targets via the actual EventTarget
//   prototype; { once } auto-removal is not observable in-page, so once entries are counted
//   and reported, never filtered away, never claimed zero. renderLayers counts are render
//   CALL counts only, never a presentation SLO.
// - Teardown runs on all paths: setup failure restores intrinsics before rethrowing; CDP
//   clear/detach and page teardown each run without swallowing; the first cleanup error is
//   retained; a primary thrown value (even null/undefined) is never masked; with no primary,
//   any cleanup failure fails. A fixture-owned control timer outlives every chart dispose
//   (fixture timers only; no global timer-count claim).
// - Scope: this case does not qualify issue 325's timer-budget, stale-analysis, endurance, or
//   physical-GPU dimensions, nor any 327/330 readiness.
test("real Runtime native DPR lifecycle: device-scale sweep, hidden zero-geometry retention, and repeated create/dispose stay balanced (issue 325)", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const interval = 60_000;
  const priceStep = 0.01;
  const owners = {
    A: { market: "BINANCE:BTCUSDT", open: 100, high: 102, low: 99, close: 101, left: 8, width: 560 },
    B: { market: "BINANCE:ETHUSDT", open: 2000, high: 2002, low: 1999, close: 2001, left: 590, width: 620 },
  };
  const fixtureOwner = new Map(Object.values(owners).map((owner) => [owner.market, owner]));
  const fixtureTrades = (owner) => [
    { price: owner.open, side: "buy" }, { price: owner.high, side: "buy" },
    { price: owner.low, side: "sell" }, { price: owner.close, side: "buy" },
  ];
  for (const owner of fixtureOwner.values()) {
    const fills = fixtureTrades(owner);
    if (fills[0].price !== owner.open || fills[fills.length - 1].price !== owner.close
      || Math.min(...fills.map((fill) => fill.price)) !== owner.low
      || Math.max(...fills.map((fill) => fill.price)) !== owner.high
      || fills.some((fill) => fill.price < owner.low || fill.price > owner.high)) {
      throw new Error("BLOCKED: fixture fills inconsistent with owner OHLC for " + owner.market);
    }
  }
  const expectedCells = new Map([
    ["BINANCE:BTCUSDT", [[99, 0, 1, 0, 0, 1, 0, 1], [100, 1, 0, 0, 0, 1, 1, 0], [101, 1, 0, 0, 0, 1, 1, 0], [102, 1, 0, 0, 0, 1, 1, 0]]],
    ["BINANCE:ETHUSDT", [[1999, 0, 1, 0, 0, 1, 0, 1], [2000, 1, 0, 0, 0, 1, 1, 0], [2001, 1, 0, 0, 0, 1, 1, 0], [2002, 1, 0, 0, 0, 1, 1, 0]]],
  ]);
  const historyEvidence = { aligned: true, queries: 0, returned: 0, ohlc: true, volume: true, delta: true, count: true, cells: true, order: true, closedBars: true };
  await page.route(/\/history(?:\?|$)/, (route) => {
    const params = new URL(route.request().url()).searchParams;
    const market = (params.get("markets") ?? "").split(",")[0] ?? "";
    const owner = fixtureOwner.get(market);
    const from = Number(params.get("from"));
    const to = Number(params.get("to"));
    historyEvidence.queries++;
    if (!owner || Number(params.get("interval")) !== interval || !(Number(params.get("priceStep")) > 0)) {
      historyEvidence.aligned = false;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars: [] } }) });
    }
    const firstBar = Math.ceil(from / interval) * interval;
    const lastBar = Math.min(Math.floor(to / interval) * interval, Math.floor(Date.now() / interval) * interval - interval);
    const bars = [];
    for (let startTime = firstBar; startTime <= lastBar; startTime += interval) {
      const cells = fixtureTrades(owner)
        .map((fill) => [fill.price, fill.side === "buy" ? 1 : 0, fill.side === "sell" ? 1 : 0, 0, 0, 1, fill.side === "buy" ? 1 : 0, fill.side === "sell" ? 1 : 0])
        .sort((left, right) => left[0] - right[0]);
      bars.push({ t: startTime, o: owner.open, h: owner.high, l: owner.low, c: owner.close, v: 4, d: 2, n: 4, cells, completeness: "complete", updatedAt: startTime + interval - 1 });
    }
    let previousStart = -Infinity;
    for (const bar of bars) {
      historyEvidence.returned++;
      if (bar.t % interval !== 0 || bar.t < from || bar.t > to) historyEvidence.aligned = false;
      if (bar.t <= previousStart) historyEvidence.order = false;
      previousStart = bar.t;
      if (bar.t + interval > Date.now()) historyEvidence.closedBars = false;
      if (bar.o !== owner.open || bar.h !== owner.high || bar.l !== owner.low || bar.c !== owner.close) historyEvidence.ohlc = false;
      if (bar.v !== 4) historyEvidence.volume = false;
      if (bar.d !== 2) historyEvidence.delta = false;
      if (bar.n !== 4) historyEvidence.count = false;
      const expectedBarCells = expectedCells.get(owner.market);
      if (!expectedBarCells || bar.cells.length !== expectedBarCells.length
        || bar.cells.some((cell, index) => cell.length !== 8 || cell.some((value, slot) => value !== expectedBarCells[index][slot]))
        || bar.cells.some(([price, buyQty, sellQty, , , count, buyCount, sellCount]) => price < owner.low || price > owner.high || buyQty + sellQty !== count || buyCount + sellCount !== count)
        || bar.cells.reduce((sum, cell) => sum + cell[1] + cell[2], 0) !== bar.v
        || bar.cells.reduce((sum, cell) => sum + cell[1] - cell[2], 0) !== bar.d
        || bar.cells.reduce((sum, cell) => sum + cell[5], 0) !== bar.n) historyEvidence.cells = false;
    }
    const meta = { schemaVersion: 1, generatedAt: Date.now(), provenance: [{ source: "native-dpr-route-fixture", completeness: "complete" }], footprintCoverage: { schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: market, authority: "provisional", status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to, reasonCode: null, authorityToken: "native-dpr-route-fixture", projectionThroughId: "0" } };
    const format = params.get("format");
    if (format === "ndjson-v1" || format === "binary-v2") {
      return route.fulfill({ status: 200, contentType: "application/x-ndjson; charset=utf-8", body: [JSON.stringify({ type: "header", schemaVersion: 1, interval, meta }), JSON.stringify({ type: "bars", sequence: 0, bars }), JSON.stringify({ type: "complete", count: bars.length, cellCount: bars.reduce((sum, bar) => sum + bar.cells.length, 0) }), ""].join("\n") });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars }, meta }) });
  });
  const fixtureDocumentPath = "/__pactolis-native-dpr-lifecycle-fixture__";
  const fixtureSentinel = "pactolis-native-dpr-lifecycle-fixture";
  await page.route(fixtureDocumentPath, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${fixtureSentinel}</title></head>\n<body data-fixture="${fixtureSentinel}">\n<!-- ${fixtureSentinel}: app-shell-free native DPR lifecycle fixture; no entry script -->\n</body>\n</html>\n` });
  });
  let gotoThrown = false;
  let gotoError = undefined;
  try {
    await page.goto(fixtureDocumentPath);
  } catch (error) {
    gotoThrown = true;
    gotoError = error;
  } finally {
    try {
      await page.unroute(fixtureDocumentPath);
    } catch (cleanupError) {
      if (!gotoThrown) throw cleanupError;
    }
  }
  if (gotoThrown) throw gotoError;
  const fixtureBaseURL = testInfo.project.use.baseURL;
  expect(fixtureBaseURL, "project baseURL must be configured for the same-origin fixture comparison").toBeTruthy();
  const fixtureState = await page.evaluate(({ sentinel, expectedOrigin, expectedPath }) => ({ navigated: location.pathname === expectedPath, sameOrigin: location.origin === expectedOrigin, sentinel: document.documentElement.outerHTML.includes(sentinel), entryScripts: document.querySelectorAll("script").length }), { sentinel: fixtureSentinel, expectedOrigin: new URL(fixtureBaseURL).origin, expectedPath: fixtureDocumentPath });
  expect([fixtureState.navigated, fixtureState.sameOrigin, fixtureState.sentinel]).toEqual([true, true, true]);
  expect(fixtureState.entryScripts).toBe(0);
  if (!(await page.evaluate(() => Boolean(document.createElement("canvas").getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: false }))))) {
    test.skip(true, "BLOCKED: native WebGL2 unavailable in this runtime (mandatory case, never counted green)");
  }
  let setup: any = null;
  let setupThrown = false;
  let setupPrimary: unknown = undefined;
  try {
    setup = await page.evaluate(async (spec) => {
    const owners = spec.owners;
    const interval = spec.interval;
    const priceStep = spec.priceStep;
    const [{ mountChart }, { createChartSurfaceModel }, { getChartRuntime }, { DrawingManager }, { DEFAULT_VOLUME_PROFILE_SETTINGS }, { normalizePreviousWeekStrategySettings }, { normalizeMondayRangeSettings }, { FootprintRenderer }] = await Promise.all([
      import("/harness/chart.ts"), import("/harness/chart.ts"),
      import("/harness/chart.ts"), import("/src/features/drawings/drawingManager.ts"),
      import("/src/core/analysis/volumeProfile.ts"), import("/src/core/analysis/previousWeekStrategy.ts"),
      import("/src/core/analysis/mondayRange.ts"), import("/src/core/render/footprintRenderer.ts"),
    ]);
    const rootFor = (owner) => {
      const root = document.createElement("div");
      root.dataset.nativeRuntimeOwner = owner;
      root.style.cssText = "position:fixed;top:16px;height:360px;overflow:hidden;background:#101010;";
      root.style.left = owners[owner].left + "px";
      root.style.width = owners[owner].width + "px";
      document.body.appendChild(root);
      return root;
    };
    const roots = { A: rootFor("A"), B: rootFor("B") };
    const subscriptions = new Map();
    const analysisListeners = new Set();
    const revisionListeners = new Set();
    const revisions = new Map();
    const contexts = new Map(Object.keys(owners).map((key) => {
      const owner = owners[key];
      return [owner.market, { market: owner.market, profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false }, previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }), previousWeekStrategyLevels: [], mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }), mondayRangeLevels: [], nakedPocs: [], referenceLevels: [], drawings: new DrawingManager(() => {}) }];
    }));
    const snapshot = (market) => {
      const revision = revisions.get(market) || 1;
      return { market, revision, canonical: { status: "complete", market, runKey: market + "|" + priceStep, generation: revision, revision, failedPeriods: [] } };
    };
    const servicesFor = (ownerKey) => ({
      subscribeToTrades(market, callback) {
        let set = subscriptions.get(market);
        if (!set) subscriptions.set(market, set = new Set());
        set.add(callback);
        return () => set.delete(callback);
      },
      fetchHistory() { return Promise.resolve([]); },
      fetchPriceStep: async () => priceStep,
      fetchPricePrecision: async () => 2,
      getAnalysisContext: (market) => contexts.get(market ?? owners[ownerKey].market),
      getAnalysisRevisionSnapshot: (market) => snapshot(market ?? owners[ownerKey].market),
      subscribeAnalysis(listener) { analysisListeners.add(listener); return () => analysisListeners.delete(listener); },
      subscribeAnalysisRevision(listener) { revisionListeners.add(listener); return () => revisionListeners.delete(listener); },
      updateAnalysisFromSeries(market) {
        revisions.set(market, (revisions.get(market) || 1) + 1);
        for (const listener of revisionListeners) listener();
        for (const listener of analysisListeners) listener({ kind: "automatic-data", market, dataRevision: revisions.get(market), visibilityRevision: 1 });
      },
      fetchNpocSnapshot(market, signal) {
        if (signal && signal.aborted) return Promise.reject(new DOMException("NPOC aborted", "AbortError"));
        return new Promise((resolve, reject) => {
          const timer = window.setTimeout(() => resolve({ schemaVersion: 3, market, levels: [], valueAreas: [] }), 0);
          signal?.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("NPOC aborted", "AbortError")); }, { once: true });
        });
      },
      notifyActiveMarket() {}, notifyInteractiveCandlesReady() {}, notifyInteractiveHistorySettled() {}, triggerAutoSync() {}, notifyBarClose() {}, notify() {}, isFootprintSyncBusy: () => false,
    });
    const makeState = (owner) => ({ type: "chart", market: owners[owner].market, timeframe: "1m", scaleMode: "linear", chartType: "candlestick", candles: true, heat: false, cellNumbers: false, poc: false, stackedImbalance: false });
    const waitFor = async (predicate, description, timeout = 12_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      throw new Error("Timed out waiting for " + description);
    };
    const nativeRaf = window.requestAnimationFrame.bind(window); // bound CALL helper only; restoration never uses it
    const twoFrames = () => new Promise((resolve) => nativeRaf(() => nativeRaf(() => resolve())));
    const restorers = [];
    const wrap = (prototype, name, wrapper) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor || typeof descriptor.value !== "function") throw new Error("BLOCKED: missing native observer method " + name);
      restorers.push(() => Object.defineProperty(prototype, name, descriptor));
      Object.defineProperty(prototype, name, { ...descriptor, value: wrapper(descriptor.value) });
    };
    const renderCounts = { A: 0, B: 0 }; // renderLayers delegation counts: render CALLS, never a presentation SLO
    const canvasOwnerCache = new WeakMap(); // canvas -> owner, captured with the GL context; survives later DOM removal
    const ownerOfCanvas = (canvas) => canvas?.closest?.("[data-native-runtime-owner]")?.dataset.nativeRuntimeOwner ?? (canvas ? canvasOwnerCache.get(canvas) : undefined);
    const glHandles = new Map(); // real WebGL handle identity -> { owner, context, kind, deleted }
    const glLedger = { A: { creates: 0, alive: 0, matchedDeletes: 0, duplicateDeletes: 0 }, B: { creates: 0, alive: 0, matchedDeletes: 0, duplicateDeletes: 0 }, foreign: { creates: 0, alive: 0, matchedDeletes: 0, duplicateDeletes: 0 }, nullDeletes: 0, wrongKindDeletes: 0, wrongContextDeletes: 0, unknownHandleDeletes: 0 };
    const ownerGlobalTypes = new Set(["keydown", "keyup", "blur", "pointerup", "visibilitychange"]);
    const registrations = [];
    const removalCounts = { "owner-global": { unmatched: 0, captureMismatched: 0, knownRepeatRemovals: 0 }, canvas: { unmatched: 0, captureMismatched: 0, knownRepeatRemovals: 0 }, mql: { unmatched: 0, captureMismatched: 0, knownRepeatRemovals: 0 } };
    const RAF_LEDGER_CAP = 256;
    const rafLedger = new Map();
    let rafSeq = 0;
    let rafLedgerFatal = null;
    let rafLateFires = 0;
    let rafEvictedFired = 0;
    let controlTimer = null;
    let controlTicks = 0;
    const handles = { A: null, B: null };
    const runtimes = {};
    const panelIds = { A: "native-dpr-A-" + Date.now(), B: "native-dpr-B-" + Date.now() };
    const liveBatchesByBucket = new Map();
    const liveBuckets = new Set();
    const livePhaseLog = [];
    let tornDown = false;
    try {
      wrap(FootprintRenderer.prototype, "renderLayers", (original) => function (view, series, activeLayers) {
        const owner = ownerOfCanvas(this?.gl?.canvas);
        try {
          return Reflect.apply(original, this, [view, series, activeLayers]);
        } finally {
          if (owner && owner in renderCounts) renderCounts[owner]++;
        }
      });
      for (const [createName, deleteName, kind] of [["createBuffer", "deleteBuffer", "buffer"], ["createVertexArray", "deleteVertexArray", "vertexArray"], ["createProgram", "deleteProgram", "program"], ["createShader", "deleteShader", "shader"], ["createTexture", "deleteTexture", "texture"]]) {
        wrap(WebGL2RenderingContext.prototype, createName, (original) => function (...args) {
          const result = Reflect.apply(original, this, args);
          if (result === null || result === undefined) return result;
          const owner = ownerOfCanvas(this.canvas);
          if (owner && this.canvas) canvasOwnerCache.set(this.canvas, owner);
          const scoped = glLedger[owner] ? owner : "foreign";
          glHandles.set(result, { owner: scoped, context: this, kind, deleted: false });
          glLedger[scoped].creates++;
          glLedger[scoped].alive++;
          return result;
        });
        wrap(WebGL2RenderingContext.prototype, deleteName, (original) => function (...args) {
          const handle = args[0];
          const entry = handle === null || handle === undefined ? null : (glHandles.has(handle) ? glHandles.get(handle) : null);
          if (entry === null && handle !== null && handle !== undefined) glLedger.unknownHandleDeletes++;
          if (handle === null || handle === undefined) glLedger.nullDeletes++;
          if (entry && entry.context !== this) glLedger.wrongContextDeletes++;
          if (entry && entry.kind !== kind) glLedger.wrongKindDeletes++;
          const result = Reflect.apply(original, this, args); // actual native call and any exception preserved
          if (entry && !entry.deleted && entry.context === this && entry.kind === kind) {
            entry.deleted = true;
            glLedger[entry.owner].alive--;
            glLedger[entry.owner].matchedDeletes++;
          } else if (entry && entry.deleted) {
            glLedger[entry.owner].duplicateDeletes++;
          }
          return result;
        });
      }
      const normalizedCapture = (options) => (typeof options === "boolean" ? options : Boolean(options?.capture));
      const isOwnerGlobalTargetLedger = (target) => Boolean(target) && (target.self === target || target.defaultView !== undefined);
      const scopeOfTarget = (target) => (typeof MediaQueryList === "function" && target instanceof MediaQueryList ? "mql" : (isOwnerGlobalTargetLedger(target) ? "owner-global" : "canvas"));
      const isLedgerType = (target, type) => ownerGlobalTypes.has(type) || (type === "change" && typeof MediaQueryList === "function" && target instanceof MediaQueryList);
      wrap(EventTarget.prototype, "addEventListener", (original) => function (type, callback, options) {
        if (isLedgerType(this, type)) {
          const capture = normalizedCapture(options);
          const once = typeof options === "object" && options !== null && Boolean(options.once);
          const duplicate = registrations.some((entry) => !entry.removed && entry.target === this && entry.type === type && entry.callback === callback && entry.capture === capture);
          if (!duplicate) registrations.push({ target: this, type, callback, capture, once, removed: false, captureAtRemove: null, scope: scopeOfTarget(this) });
        }
        return Reflect.apply(original, this, [type, callback, options]);
      });
      wrap(EventTarget.prototype, "removeEventListener", (original) => function (type, callback, options) {
        if (isLedgerType(this, type)) {
          const capture = normalizedCapture(options);
          const scope = scopeOfTarget(this);
          const sameSignature = (entry) => entry.target === this && entry.type === type && entry.callback === callback && entry.capture === capture;
          const record = registrations.find((entry) => !entry.removed && sameSignature(entry)) ?? registrations.find(sameSignature);
          if (record && !record.removed) { record.removed = true; record.captureAtRemove = capture; }
          else if (record) removalCounts[scope].knownRepeatRemovals++; // known idempotent repeat of the exact same (target,type,callback,capture)
          else if (registrations.some((entry) => entry.target === this && entry.type === type && entry.callback === callback)) removalCounts[scope].captureMismatched++;
          else removalCounts[scope].unmatched++;
        }
        return Reflect.apply(original, this, [type, callback, options]);
      });
      const rafDescriptor = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
      const cafDescriptor = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
      if (!rafDescriptor || typeof rafDescriptor.value !== "function" || !cafDescriptor || typeof cafDescriptor.value !== "function") throw new Error("BLOCKED: native window RAF intrinsics unavailable");
      const originalRaf = rafDescriptor.value;
      const originalCancelRaf = cafDescriptor.value;
      restorers.push(() => Object.defineProperty(window, "requestAnimationFrame", rafDescriptor));
      restorers.push(() => Object.defineProperty(window, "cancelAnimationFrame", cafDescriptor));
      window.requestAnimationFrame = function (callback) {
        if (typeof callback !== "function") return Reflect.apply(originalRaf, window, [callback]);
        const key = "raf:" + (rafSeq++);
        const entry = { key, state: "pending", nativeId: undefined };
        const nativeId = Reflect.apply(originalRaf, window, [function (timestamp) {
          if (entry.state === "cancelled") {
            entry.state = "cancelled-late-fired"; // kept until the end; late evidence is never erased
            rafLateFires++;
            if (!rafLedgerFatal) rafLedgerFatal = "RAF_CANCELLED_LATE_FIRE: a native frame fired after its cancellation";
          } else {
            entry.state = "fired";
          }
          return callback.call(this, timestamp); // genuine delegation under EVERY native fire
        }]);
        entry.nativeId = nativeId;
        if (rafLedger.size >= RAF_LEDGER_CAP) {
          let evicted = false;
          for (const [evictKey, candidate] of rafLedger) {
            if (candidate.state === "fired") { rafLedger.delete(evictKey); rafEvictedFired++; evicted = true; break; }
          }
          if (!evicted && !rafLedgerFatal) rafLedgerFatal = "RAF_LEDGER_OVERFLOW: no evictable fired entry under the hard cap " + RAF_LEDGER_CAP;
        }
        if (!rafLedgerFatal) rafLedger.set(key, entry); // fail closed: the persisted fatal is asserted null at the end
        return nativeId;
      };
      window.cancelAnimationFrame = function (id) {
        for (const [, candidate] of rafLedger) {
          if (candidate.nativeId === id) {
            if (candidate.state === "pending") candidate.state = "cancelled"; // record kept until the end
            break;
          }
        }
        return Reflect.apply(originalCancelRaf, window, [id]);
      };
      // Unrelated control timer: never owned by the charts; must survive every chart dispose
      // and still fire at teardown (fixture timers only; no global timer-count claim).
      controlTimer = window.setInterval(() => { controlTicks++; }, 25);
      handles.A = mountChart(roots.A, makeState("A"), servicesFor("A"), panelIds.A, createChartSurfaceModel());
      handles.B = mountChart(roots.B, makeState("B"), servicesFor("B"), panelIds.B, createChartSurfaceModel());
      await waitFor(() => getChartRuntime(panelIds.A) && getChartRuntime(panelIds.B), "two actual registered Runtimes");
      runtimes.A = getChartRuntime(panelIds.A);
      runtimes.B = getChartRuntime(panelIds.B);
      await waitFor(() => runtimes.A.getCaptureReadiness().ready && runtimes.B.getCaptureReadiness().ready, "capture-ready actual Worker-transport history and canonical analysis", 45_000);
      runtimes.A.goLatest();
      runtimes.B.goLatest();
      const surfacesFor = (key) => Array.from(roots[key].querySelectorAll("canvas[data-chart-surface]")).map((canvas) => canvas.dataset.chartSurface).sort();
      const measureCanvases = (key) => Array.from(roots[key].querySelectorAll("canvas[data-chart-surface]")).map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return { surface: canvas.dataset.chartSurface, cssW: rect.width, cssH: rect.height, bw: canvas.width, bh: canvas.height };
      });
      const backingOk = (key, dpr) => measureCanvases(key).length === 3 && measureCanvases(key).every((c) => c.cssW > 0 && c.cssH > 0 && c.bw === Math.round(c.cssW * dpr) && c.bh === Math.round(c.cssH * dpr));
      const captureAndDecode = async (key) => {
        const capture = await runtimes[key].captureNativePng();
        if (!Number.isFinite(capture.bytes) || !(capture.bytes > 0)) throw new Error("owner " + key + " capture bytes not positive: " + capture.bytes);
        if (!Number.isInteger(capture.width) || !(capture.width > 0) || !Number.isInteger(capture.height) || !(capture.height > 0)) throw new Error("owner " + key + " capture dimensions not positive integers");
        if (capture.market !== owners[key].market || capture.timeframe !== "1m" || capture.priceStep !== priceStep) throw new Error("owner " + key + " capture state token mismatch");
        const gpuCanvas = roots[key].querySelector('canvas[data-chart-surface="gpu-scene"]');
        if (!gpuCanvas || capture.width !== gpuCanvas.width || capture.height !== gpuCanvas.height) throw new Error("owner " + key + " capture dimensions != measured gpu-scene backing store");
        const buffer = await capture.blob.arrayBuffer();
        if (buffer.byteLength !== capture.bytes) throw new Error("owner " + key + " blob byteLength != numeric bytes");
        if (capture.blob.type !== "image/png") throw new Error("owner " + key + " capture blob type is not image/png: " + String(capture.blob.type));
        if (buffer.byteLength < 8) throw new Error("owner " + key + " capture is shorter than the 8-byte PNG signature");
        const signature = new Uint8Array(buffer, 0, 8);
        if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].some((byte, index) => signature[index] !== byte)) throw new Error("owner " + key + " capture bytes do not start with the literal PNG signature");
        const bitmap = await createImageBitmap(capture.blob);
        try {
        if (bitmap.width !== capture.width || bitmap.height !== capture.height) throw new Error("owner " + key + " decoded PNG bitmap is " + bitmap.width + "x" + bitmap.height + " but the capture/backing dimensions are " + capture.width + "x" + capture.height);
        const scratch = document.createElement("canvas");
        scratch.width = capture.width;
        scratch.height = capture.height;
        const ctx = scratch.getContext("2d");
        if (!ctx) throw new Error("scratch 2d context unavailable for genuine PNG decode");
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, capture.width, capture.height).data;
        let alphaPositive = 0;
        let candlePixels = 0;
        for (let offset = 0; offset < data.length; offset += 4) {
          if (data[offset + 3] > 0) {
            alphaPositive++;
            if (Math.abs(data[offset] - 69) <= 2 && Math.abs(data[offset + 1] - 219) <= 2 && Math.abs(data[offset + 2] - 158) <= 2) candlePixels++;
          }
        }
        if (!(alphaPositive > 0)) throw new Error("owner " + key + " decoded capture has no positive-alpha pixels");
        if (!(candlePixels > 0)) throw new Error("owner " + key + " decoded capture has no literal candle-color pixels");
        return { width: capture.width, height: capture.height, bytes: capture.bytes, alphaPositive, candlePixels };
        } finally { bitmap.close(); } // closed on ALL paths, success or failure
      };
      // Snapshot-side handwritten oracles (independent of expectedCells/fixtureTrades): the
      // public footprint cell fields asserted per cell, projected from the ACTUAL snapshot.
      const CELL_FIELDS = ["price", "buyVolume", "sellVolume", "totalVolume", "delta", "tradeCount", "buyTradeCount", "sellTradeCount"];
      const projectCell = (cell) => { const out = {}; for (const field of CELL_FIELDS) out[field] = cell[field]; return out; };
      const cellsMatchOracle = (actualCells, oracleCells) => Array.isArray(actualCells) && actualCells.length === oracleCells.length && oracleCells.every((expected, index) => { const actual = projectCell(actualCells[index]); return CELL_FIELDS.every((field) => actual[field] === expected[field]); });
      const anchorCellsOracle = (owner) => [
        { price: owner.low, buyVolume: 0, sellVolume: 1, totalVolume: 1, delta: -1, tradeCount: 1, buyTradeCount: 0, sellTradeCount: 1 },
        { price: owner.open, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1, buyTradeCount: 1, sellTradeCount: 0 },
        { price: owner.close, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1, buyTradeCount: 1, sellTradeCount: 0 },
        { price: owner.high, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1, buyTradeCount: 1, sellTradeCount: 0 },
      ];
      // Handwritten fixed cumulative tables for B's live minute bucket: phase 1/2/3 -> V
      // 4/8/12, delta 2/4/6, count 4/8/12; price 1999 sell-only and 2000/2001/2002 buy-only;
      // per-level counts and quantities scaled 1/2/3; OHLC constant 2000/2002/1999/2001.
      const livePhaseOracle = [
        { volume: 4, delta: 2, count: 4, cells: [
          { price: 1999, buyVolume: 0, sellVolume: 1, totalVolume: 1, delta: -1, tradeCount: 1, buyTradeCount: 0, sellTradeCount: 1 },
          { price: 2000, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1, buyTradeCount: 1, sellTradeCount: 0 },
          { price: 2001, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1, buyTradeCount: 1, sellTradeCount: 0 },
          { price: 2002, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1, buyTradeCount: 1, sellTradeCount: 0 } ] },
        { volume: 8, delta: 4, count: 8, cells: [
          { price: 1999, buyVolume: 0, sellVolume: 2, totalVolume: 2, delta: -2, tradeCount: 2, buyTradeCount: 0, sellTradeCount: 2 },
          { price: 2000, buyVolume: 2, sellVolume: 0, totalVolume: 2, delta: 2, tradeCount: 2, buyTradeCount: 2, sellTradeCount: 0 },
          { price: 2001, buyVolume: 2, sellVolume: 0, totalVolume: 2, delta: 2, tradeCount: 2, buyTradeCount: 2, sellTradeCount: 0 },
          { price: 2002, buyVolume: 2, sellVolume: 0, totalVolume: 2, delta: 2, tradeCount: 2, buyTradeCount: 2, sellTradeCount: 0 } ] },
        { volume: 12, delta: 6, count: 12, cells: [
          { price: 1999, buyVolume: 0, sellVolume: 3, totalVolume: 3, delta: -3, tradeCount: 3, buyTradeCount: 0, sellTradeCount: 3 },
          { price: 2000, buyVolume: 3, sellVolume: 0, totalVolume: 3, delta: 3, tradeCount: 3, buyTradeCount: 3, sellTradeCount: 0 },
          { price: 2001, buyVolume: 3, sellVolume: 0, totalVolume: 3, delta: 3, tradeCount: 3, buyTradeCount: 3, sellTradeCount: 0 },
          { price: 2002, buyVolume: 3, sellVolume: 0, totalVolume: 3, delta: 3, tradeCount: 3, buyTradeCount: 3, sellTradeCount: 0 } ] },
      ];
      // Anchors are scoped to the last SERVED closed bar (live-filled minutes are excluded), so
      const lastServedAnchor = (key) => {
        const candles = runtimes[key].getAnalysisSnapshot().candles;
        for (let index = candles.length - 1; index >= 0; index--) {
          if (!liveBuckets.has(candles[index].time)) return candles[index].time;
        }
        return null;
      };
      const anchorSnapshot = (key) => {
        const owner = owners[key];
        const anchorTime = lastServedAnchor(key);
        if (anchorTime === null) throw new Error("owner " + key + " has no served closed anchor candle for the scoped literal oracle");
        const scoped = runtimes[key].getAnalysisSnapshot({ visibleTimeRange: { from: anchorTime, to: anchorTime } });
        if (scoped.candles.length !== 1 || scoped.candles[0].time !== anchorTime) throw new Error("owner " + key + " scoped one-bar snapshot did not isolate the served closed anchor");
        const bar = scoped.candles[0];
        if (bar.open !== owner.open || bar.high !== owner.high || bar.low !== owner.low || bar.close !== owner.close || bar.volume !== 4 || bar.delta !== 2 || bar.count !== 4) {
          throw new Error("owner " + key + " closed anchor mismatch vs the independent literal OHLCV/delta/count oracle");
        }
        if (!cellsMatchOracle(bar.footprint, anchorCellsOracle(owner))) throw new Error("owner " + key + " closed anchor footprint cells mismatch vs the independent literal cell oracle");
        return { time: anchorTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, delta: bar.delta, count: bar.count, footprint: (bar.footprint ?? []).map(projectCell) };
      };
      let staleCallback = [...(subscriptions.get(owners.A.market) ?? [])][0] ?? null;
      // Stale-A ineffectiveness is proven BY EFFECT (not "checked: true") across a CONTROLLED
      const staleCallbackIneffective = async (observeB) => {
        const bSubscribers = () => subscriptions.get(owners.B.market) ?? new Set();
        const before = { registryA: Boolean(getChartRuntime(panelIds.A)), aCreates: glLedger.A.creates, aRenders: renderCounts.A, bSubscribers: [...bSubscribers()], bAnchor: observeB ? anchorSnapshot("B") : null };
        let threw = false;
        if (staleCallback) {
          try {
            staleCallback({ time: Date.now(), price: owners.A.close + 0.25, qty: 0.25, tradeCount: 1, isBuy: true, market: owners.A.market, source: "live" });
          } catch { threw = true; }
        }
        await twoFrames(); // real native frame/microtask frontier AFTER the callback, BEFORE any measurement
        const afterAnchor = observeB ? anchorSnapshot("B") : null;
        const afterSubscribers = bSubscribers();
        const after = { registryA: Boolean(getChartRuntime(panelIds.A)), aCreates: glLedger.A.creates, aRenders: renderCounts.A };
        return {
          checked: staleCallback !== null,
          threw,
          registryStillAbsent: before.registryA === false && after.registryA === false,
          aCreatesUnchanged: after.aCreates === before.aCreates,
          aRendersUnchanged: after.aRenders === before.aRenders,
          bSubscriberIdentitiesUnchanged: before.bSubscribers.length === afterSubscribers.size && before.bSubscribers.every((callback) => afterSubscribers.has(callback)),
          bAnchorUnchanged: observeB ? JSON.stringify(afterAnchor) === JSON.stringify(before.bAnchor) : null,
          bAnchorLiteral: afterAnchor,
        };
      };
      // Phase-aware live emission: at most three four-fill batches per ACTUAL minute bucket
      const bLiveFill = async () => {
        const owner = owners.B;
        let fillBucket = Math.floor(Date.now() / interval) * interval;
        let anchorTime = lastServedAnchor("B");
        if (anchorTime === null || fillBucket - anchorTime <= 0 || (fillBucket - anchorTime) % interval !== 0) {
          fillBucket = Math.floor(Date.now() / interval) * interval; // one bounded re-read if the real minute rolled in between
          anchorTime = lastServedAnchor("B");
        }
        if (anchorTime === null || fillBucket - anchorTime <= 0 || (fillBucket - anchorTime) % interval !== 0 || fillBucket - anchorTime > 3 * interval) {
          throw new Error("BLOCKED: B live bucket is not a whole number of intervals (1..3) past the served anchor (" + anchorTime + " -> " + fillBucket + ")");
        }
        const prior = liveBatchesByBucket.get(fillBucket) ?? 0;
        if (prior >= livePhaseOracle.length) throw new Error("BLOCKED: this fixture allows at most " + livePhaseOracle.length + " four-fill batches per actual minute bucket");
        const expected = livePhaseOracle[prior];
        liveBatchesByBucket.set(fillBucket, prior + 1);
        liveBuckets.add(fillBucket);
        livePhaseLog.push({ bucket: fillBucket, phase: prior + 1 });
        const options = { now: fillBucket + interval, visibleTimeRange: { from: fillBucket, to: fillBucket }, visiblePriceRange: { low: owner.low, high: owner.high } };
        const fills = [{ price: owner.open, side: "buy" }, { price: owner.high, side: "buy" }, { price: owner.low, side: "sell" }, { price: owner.close, side: "buy" }];
        const fillBase = Math.min(Math.max(Date.now(), fillBucket + 1), fillBucket + interval - fills.length - 1);
        for (const [index, fill] of fills.entries()) {
          for (const callback of [...(subscriptions.get(owner.market) ?? [])]) {
            callback({ time: fillBase + index, price: fill.price, qty: 1, tradeCount: 1, isBuy: fill.side === "buy", market: owner.market, source: "live" });
          }
        }
        let applied = null;
        await waitFor(() => {
          applied = runtimes.B.getAnalysisSnapshot(options).candles.find((candle) => candle.time === fillBucket) ?? null;
          return Boolean(applied) && applied.open === owner.open && applied.high === owner.high && applied.low === owner.low && applied.close === owner.close
            && applied.volume === expected.volume && applied.delta === expected.delta && applied.count === expected.count
            && cellsMatchOracle(applied.footprint, expected.cells);
        }, "the cumulative four-fill B batches applied financially to the Runtime-observed live minute (phase " + (prior + 1) + ": V=" + expected.volume + ", delta=" + expected.delta + ", count=" + expected.count + ", literal OHLC and literal cells)", 15_000);
        return { bucket: fillBucket, phase: prior + 1, anchorTime, liveAheadOfAnchor: fillBucket - anchorTime, actual: { open: applied.open, high: applied.high, low: applied.low, close: applied.close, volume: applied.volume, delta: applied.delta, count: applied.count, footprint: (applied.footprint ?? []).map(projectCell) } };
      };
      const teardownPhase = async (forced) => {
        if (tornDown) return { alreadyTornDown: true };
        tornDown = true;
        const primary = { thrown: false, value: undefined, label: null };
        const cleanupFirst = { thrown: false, value: undefined, label: null };
        const attempt = (label, action) => { try { action(); return true; } catch (error) { if (!cleanupFirst.thrown) { cleanupFirst.thrown = true; cleanupFirst.value = error; cleanupFirst.label = label; } return false; } };
        const gate = async (label, action) => { try { await action(); return true; } catch (error) { if (!primary.thrown) { primary.thrown = true; primary.value = error; primary.label = label; } return false; } };
        const evidence = { forced };
        try {
          evidence.disposedA = attempt("disposeA", () => handles.A.dispose());
          evidence.disposedB = attempt("disposeB", () => handles.B.dispose());
          evidence.registryEmpty = await gate("registryTeardown", () => waitFor(() => !getChartRuntime(panelIds.A) && !getChartRuntime(panelIds.B), "both runtime registry teardowns", 10_000));
          await gate("quiescentFrames", twoFrames);
          evidence.pendingOwnerGlobalNonOnce = registrations.filter((entry) => entry.scope === "owner-global" && !entry.removed && !entry.once).length;
          evidence.pendingOwnerGlobalOnce = registrations.filter((entry) => entry.scope === "owner-global" && !entry.removed && entry.once).length; // once auto-removal is not observable in-page: reported, never claimed zero
          evidence.pendingMqlNonOnce = registrations.filter((entry) => entry.scope === "mql" && !entry.removed && !entry.once).length;
          evidence.pendingMqlOnce = registrations.filter((entry) => entry.scope === "mql" && !entry.removed && entry.once).length;
          evidence.pendingRaf = [...rafLedger.values()].filter((entry) => entry.state === "pending").length;
          evidence.cancelledRecords = [...rafLedger.values()].filter((entry) => entry.state === "cancelled" || entry.state === "cancelled-late-fired").length;
          evidence.rafLateFires = rafLateFires;
          evidence.rafEvictedFired = rafEvictedFired;
          evidence.rafLedgerFatal = rafLedgerFatal;
          evidence.glLedger = glLedger;
          evidence.removalCounts = removalCounts;
          evidence.livePhaseLog = livePhaseLog.map((entry) => ({ ...entry }));
          evidence.controlTicksAtTeardown = controlTicks;
          evidence.staleAAfterFinalDispose = await staleCallbackIneffective(false);
          evidence.analysisListenersEmpty = analysisListeners.size === 0;
          evidence.revisionListenersEmpty = revisionListeners.size === 0;
          evidence.tradeSubscriptionsEmpty = [...subscriptions.values()].every((set) => set.size === 0);
        } finally {
          attempt("clearControlTimer", () => window.clearInterval(controlTimer));
          for (let index = restorers.length - 1; index >= 0; index--) attempt("restore:" + index, restorers[index]);
          attempt("deleteDpr325", () => { delete window.__dpr325; });
        }
        if (primary.thrown) throw primary.value;
        if (cleanupFirst.thrown) throw cleanupFirst.value;
        return evidence;
      };
      window.__dpr325 = {
        teardownPhase,
        sweepStep: async (dpr) => {
          const actual = window.devicePixelRatio;
          if (actual !== dpr) throw new Error("actual devicePixelRatio " + actual + " did not reach the overridden " + dpr);
          await waitFor(() => backingOk("A", actual) && backingOk("B", actual), "all three bitmap canvases of both owners re-sized to Math.round(css*dpr) at dpr " + dpr, 20_000);
          const canvases = { A: measureCanvases("A"), B: measureCanvases("B") };
          const aCapture = await captureAndDecode("A");
          return { dpr, canvases, aCapture };
        },
        hiddenPhase: async () => {
          const gpuA = roots.A.querySelector('canvas[data-chart-surface="gpu-scene"]');
          if (!gpuA) throw new Error("gpu-scene canvas missing before the hidden phase");
          const retained = { w: gpuA.width, h: gpuA.height };
          const dprBefore = window.devicePixelRatio;
          const bRenderBaseline = renderCounts.B; // cumulative baseline read immediately before A is hidden
          runtimes.A.deactivate();
          roots.A.style.display = "none";
          await twoFrames();
          const rect = roots.A.getBoundingClientRect();
          if (!(rect.width === 0 && rect.height === 0)) throw new Error("hidden owner still reports non-zero DOM geometry");
          if (!(gpuA.width === retained.w && gpuA.height === retained.h && gpuA.width > 0)) throw new Error("hidden owner did not retain its last valid bitmap");
          let hiddenCaptureError = null;
          try {
            await runtimes.A.captureNativePng();
          } catch (error) {
            hiddenCaptureError = { code: error?.code, message: String(error?.message || error) };
          }
          if (!hiddenCaptureError) throw new Error("hidden capture resolved; expected a fail-closed rejection");
          if (hiddenCaptureError.code !== "CAPTURE_FAILED") throw new Error("hidden capture rejected with unexpected code " + JSON.stringify(hiddenCaptureError));
          const bAppliedDuringHidden = await bLiveFill();
          await twoFrames(); // native frame frontier so B's render delegation is counted before reading the counter
          const bRendersDuringHidden = renderCounts.B - bRenderBaseline; // actual B rendering DELTA while A was hidden
          roots.A.style.display = "block";
          runtimes.A.activate();
          await waitFor(() => backingOk("A", dprBefore), "re-activated A backing store back at Math.round(css*dpr)", 20_000);
          runtimes.A.invalidate();
          const redrawCapture = await captureAndDecode("A");
          const bCaptureAfterReactivate = await captureAndDecode("B");
          return { bAppliedDuringHidden, bRendersDuringHidden, hiddenCaptureError, redrawCapture, bCaptureAfterReactivate };
        },
        cyclesPhase: async () => {
          const cycles = [];
          const dpr = window.devicePixelRatio;
          for (let cycle = 0; cycle < 2; cycle++) {
            handles.A.dispose();
            await waitFor(() => !getChartRuntime(panelIds.A), "cycle " + cycle + " A runtime registry teardown");
            const stale = await staleCallbackIneffective(true);
            cycles.push({ cycle, phase: "disposed", canvasesLeftDom: roots.A.querySelectorAll("canvas").length === 0, stale });
            handles.A = mountChart(roots.A, makeState("A"), servicesFor("A"), panelIds.A, createChartSurfaceModel());
            await waitFor(() => getChartRuntime(panelIds.A)?.getCaptureReadiness().ready, "cycle " + cycle + " recreated A capture readiness over the real transport", 45_000);
            runtimes.A = getChartRuntime(panelIds.A);
            await waitFor(() => backingOk("A", dpr), "cycle " + cycle + " recreated A backing store at Math.round(css*dpr)", 20_000);
            const capture = await captureAndDecode("A");
            const bRenderBefore = renderCounts.B;
            const bApplied = await bLiveFill();
            await twoFrames(); // native frame frontier so B's render delegation is counted before reading the counter
            cycles.push({ cycle, phase: "recreated", capture, bRenders: renderCounts.B - bRenderBefore, bApplied });
          }
          return { cycles, anchorA: anchorSnapshot("A"), anchorB: anchorSnapshot("B") };
        },
        diagnosticSnapshot: () => { try {
          const mm = (q) => { try { return window.matchMedia(q).matches; } catch { return null; } };
          const mc = (k) => measureCanvases(k).map((c) => ({ surface: c.surface, cssW: c.cssW, cssH: c.cssH, bw: c.bw, bh: c.bh, expW: Math.round(c.cssW * window.devicePixelRatio), expH: Math.round(c.cssH * window.devicePixelRatio) }));
          return { dpr: window.devicePixelRatio, innerW: window.innerWidth, innerH: window.innerHeight, dppx1: mm("(resolution: 1dppx)"), dppx15: mm("(resolution: 1.5dppx)"), dppx2: mm("(resolution: 2dppx)"), A: mc("A"), B: mc("B"), renderCounts: { A: renderCounts.A, B: renderCounts.B } };
        } catch { return null; } },      };
      return { surfaces: surfacesFor("A"), ready: runtimes.A.getCaptureReadiness().ready && runtimes.B.getCaptureReadiness().ready, anchorA: anchorSnapshot("A"), anchorB: anchorSnapshot("B") };
    } catch (caughtError) {
      // All-path setup cleanup: every dispose/restore attempt continues; the first cleanup
      // error is retained and reported via a bounded page-side console.error only — there is
      // no global diagnostic transport — and the primary is rethrown exactly, even when the
      // thrown value is undefined, null, or a primitive.
      const cleanupFirst = { thrown: false, value: undefined };
      const attempt = (action) => { try { action(); } catch (error) { if (!cleanupFirst.thrown) { cleanupFirst.thrown = true; cleanupFirst.value = error; } } };
      if (handles.A) attempt(() => handles.A.dispose());
      if (handles.B) attempt(() => handles.B.dispose());
      if (controlTimer !== null) attempt(() => window.clearInterval(controlTimer));
      for (let index = restorers.length - 1; index >= 0; index--) attempt(restorers[index]);
      attempt(() => { delete window.__dpr325; });
      if (cleanupFirst.thrown) {
        // Cleanup error is reported ONLY via this bounded page-side console.error; there is no
        // global diagnostic transport. Every property access, String conversion and log call is
        // guarded so reporting can never mask the primary throw below.
        try {
          let text = "<unreportable cleanup error>";
          try {
            const value = cleanupFirst.value;
            const raw = value instanceof Error ? ((value.stack ?? value.message) ?? String(value)) : String(value);
            text = raw.length <= 300 ? raw : raw.slice(0, 300);
          } catch { /* keep the constant bounded fallback */ }
          console.error("issue 325 setup failed; first cleanup error: " + text);
        } catch { /* bounded diagnostics logging never masks the primary throw */ }
      }
      throw caughtError;
    }
  }, { owners, interval, priceStep });
  } catch (evaluateError) {
    setupThrown = true;
    setupPrimary = evaluateError;
  }
  if (setupThrown) throw setupPrimary; // the ACTUAL primary throw is preserved exactly, including undefined/null/primitive values
  // Single cleanup ownership: every post-setup Node assertion AND the CDP creation run inside
  type CDPSessionLike = { send: (method: string, params?: Record<string, unknown>) => Promise<unknown>; detach: () => Promise<void> };
  let cdp: CDPSessionLike | null = null;
  let primaryThrown = false;
  let primaryValue: unknown = undefined;
  const cleanupFirst = { thrown: false, value: undefined, label: null };
  const attemptCleanup = async (label: string, action: () => Promise<unknown> | unknown) => {
    try { await action(); } catch (error) { if (!cleanupFirst.thrown) { cleanupFirst.thrown = true; cleanupFirst.value = error; cleanupFirst.label = label; } }
  };
  try {
    expect(setup.surfaces).toEqual(["annotation", "gpu-scene", "interaction"]);
    expect(setup.ready).toBe(true);
  const nodeAnchorCells = (low: number, open: number, close: number, high: number) => [
    { price: low, buyVolume: 0, sellVolume: 1, totalVolume: 1, delta: -1, tradeCount: 1, buyTradeCount: 0, sellTradeCount: 1 },
    { price: open, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1, buyTradeCount: 1, sellTradeCount: 0 },
    { price: close, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1, buyTradeCount: 1, sellTradeCount: 0 },
    { price: high, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1, buyTradeCount: 1, sellTradeCount: 0 },
  ];
  const nodeLiveCells = (phase: number) => [1999, 2000, 2001, 2002].map((price) => price === 1999
    ? { price: 1999, buyVolume: 0, sellVolume: phase, totalVolume: phase, delta: -phase, tradeCount: phase, buyTradeCount: 0, sellTradeCount: phase }
    : { price, buyVolume: phase, sellVolume: 0, totalVolume: phase, delta: phase, tradeCount: phase, buyTradeCount: phase, sellTradeCount: 0 });
  const assertLiveApplied = (applied: { bucket: number; phase: number; anchorTime: number; liveAheadOfAnchor: number; actual: { open: number; high: number; low: number; close: number; volume: number; delta: number; count: number; footprint: Array<Record<string, number>> } }) => {
    expect(applied.phase, "live phase must index a handwritten cumulative table").toBeGreaterThanOrEqual(1);
    expect(applied.phase).toBeLessThanOrEqual(3);
    expect(applied.actual.volume).toBe([4, 8, 12][applied.phase - 1]);
    expect(applied.actual.delta).toBe([2, 4, 6][applied.phase - 1]);
    expect(applied.actual.count).toBe([4, 8, 12][applied.phase - 1]);
    expect([applied.actual.open, applied.actual.high, applied.actual.low, applied.actual.close]).toEqual([2000, 2002, 1999, 2001]);
    expect(applied.bucket % interval).toBe(0);
    expect([applied.liveAheadOfAnchor % interval, applied.liveAheadOfAnchor, applied.liveAheadOfAnchor <= 3 * interval]).toEqual([0, expect.any(Number), true]);
    expect(applied.liveAheadOfAnchor).toBeGreaterThan(0);
    expect(applied.actual.footprint).toEqual(nodeLiveCells(applied.phase));
  };
  expect(setup.anchorA).toMatchObject({ open: 100, high: 102, low: 99, close: 101, volume: 4, delta: 2, count: 4 });
  expect(setup.anchorA.footprint).toEqual(nodeAnchorCells(99, 100, 101, 102));
  expect(setup.anchorB).toMatchObject({ open: 2000, high: 2002, low: 1999, close: 2001, volume: 4, delta: 2, count: 4 });
  expect(setup.anchorB.footprint).toEqual(nodeAnchorCells(1999, 2000, 2001, 2002));
    cdp = await page.context().newCDPSession(page);
    const session = cdp as CDPSessionLike;
    const sweep = [];
    // Each step also moves the emulated viewport by one CSS pixel. Chromium (seen on 153)
    // re-evaluates media queries only for the first scale-only override, so a later
    // scale-only step never fires the (resolution) MediaQueryList "change" that a real
    // display switch does. The chart containers have fixed CSS sizes, so this nudge cannot
    // resize them; the bitmaps can only follow the DPR through the production watcher.
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    for (const [index, deviceScaleFactor] of [1, 1.5, 2].entries()) {
      await session.send("Emulation.setDeviceMetricsOverride", { width: viewport.width + index + 1, height: viewport.height, deviceScaleFactor, mobile: false });
      sweep.push(await page.evaluate((dpr) => window.__dpr325.sweepStep(dpr), deviceScaleFactor));
    }
    expect(sweep.map((step) => step.dpr)).toEqual([1, 1.5, 2]);
    for (const step of sweep) {
      expect(step.canvases.A.map((canvas) => canvas.surface)).toEqual(["gpu-scene", "annotation", "interaction"]);
      expect(step.canvases.B.map((canvas) => canvas.surface)).toEqual(["gpu-scene", "annotation", "interaction"]);
      expect([step.aCapture.bytes, step.aCapture.alphaPositive, step.aCapture.candlePixels]).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
      expect(step.aCapture.bytes).toBeGreaterThan(0);
      expect(step.aCapture.alphaPositive).toBeGreaterThan(0);
      expect(step.aCapture.candlePixels).toBeGreaterThan(0);
    }
    expect(sweep[2].aCapture.width).toBeGreaterThan(sweep[0].aCapture.width);
    const hidden = await page.evaluate(() => window.__dpr325.hiddenPhase());
    expect(hidden.hiddenCaptureError.code).toBe("CAPTURE_FAILED");
    assertLiveApplied(hidden.bAppliedDuringHidden);
    expect([hidden.bRendersDuringHidden, hidden.redrawCapture.candlePixels, hidden.bCaptureAfterReactivate.candlePixels]).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect(hidden.bRendersDuringHidden).toBeGreaterThan(0);
    expect(hidden.redrawCapture.candlePixels).toBeGreaterThan(0);
    expect(hidden.bCaptureAfterReactivate.candlePixels).toBeGreaterThan(0);
    const cycles = await page.evaluate(() => window.__dpr325.cyclesPhase());
    expect(cycles.cycles).toHaveLength(4);
    for (const entry of cycles.cycles) {
      if (entry.phase === "disposed") {
        expect(entry.canvasesLeftDom).toBe(true);
        expect([entry.stale.checked, entry.stale.registryStillAbsent, entry.stale.aCreatesUnchanged, entry.stale.aRendersUnchanged, entry.stale.bSubscriberIdentitiesUnchanged, entry.stale.bAnchorUnchanged]).toEqual([true, true, true, true, true, true]);
        expect(entry.stale.bAnchorLiteral).toMatchObject({ open: 2000, high: 2002, low: 1999, close: 2001, volume: 4, delta: 2, count: 4 });
        expect(entry.stale.bAnchorLiteral.footprint).toEqual(nodeAnchorCells(1999, 2000, 2001, 2002));
      } else {
        expect(entry.capture.bytes).toBeGreaterThan(0);
        expect(entry.capture.candlePixels).toBeGreaterThan(0);
        expect(entry.bRenders).toBeGreaterThan(0);
        assertLiveApplied(entry.bApplied);
      }
    }
    expect(cycles.anchorA).toMatchObject({ open: 100, high: 102, low: 99, close: 101, volume: 4, delta: 2, count: 4 });
    expect(cycles.anchorA.footprint).toEqual(nodeAnchorCells(99, 100, 101, 102));
    expect(cycles.anchorB).toMatchObject({ open: 2000, high: 2002, low: 1999, close: 2001, volume: 4, delta: 2, count: 4 });
    expect(cycles.anchorB.footprint).toEqual(nodeAnchorCells(1999, 2000, 2001, 2002));
    const final = await page.evaluate(() => window.__dpr325.teardownPhase(false));
    expect([final.disposedA, final.disposedB, final.registryEmpty, final.analysisListenersEmpty, final.revisionListenersEmpty, final.tradeSubscriptionsEmpty]).toEqual([true, true, true, true, true, true]);
    expect([final.pendingOwnerGlobalNonOnce, final.pendingMqlNonOnce, final.pendingRaf, final.rafLateFires, final.removalCounts["owner-global"].unmatched, final.removalCounts["owner-global"].captureMismatched, final.removalCounts.canvas.unmatched, final.removalCounts.canvas.captureMismatched, final.removalCounts.mql.unmatched, final.removalCounts.mql.captureMismatched, final.glLedger.A.alive, final.glLedger.B.alive, final.glLedger.wrongKindDeletes, final.glLedger.wrongContextDeletes, final.glLedger.unknownHandleDeletes]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(final.glLedger.A.creates).toBeGreaterThan(0);
    expect(final.glLedger.B.creates).toBeGreaterThan(0);
    expect(final.rafLedgerFatal).toBeNull();
    expect(final.controlTicksAtTeardown).toBeGreaterThan(0);
    expect([final.staleAAfterFinalDispose.checked, final.staleAAfterFinalDispose.registryStillAbsent, final.staleAAfterFinalDispose.aCreatesUnchanged, final.staleAAfterFinalDispose.aRendersUnchanged]).toEqual([true, true, true, true]);
    expect(final.livePhaseLog).toHaveLength(3);
    const phasesByBucket = new Map();
    for (const entry of final.livePhaseLog) {
      const list = phasesByBucket.get(entry.bucket) ?? [];
      list.push(entry.phase);
      phasesByBucket.set(entry.bucket, list);
    }
    for (const [bucket, phases] of phasesByBucket) {
      expect(bucket % interval).toBe(0);
      expect(phases).toEqual(phases.map((_, index) => index + 1));
      expect(phases.length).toBeLessThanOrEqual(3);
    }
    expect(historyEvidence.queries).toBeGreaterThan(0);
    expect(historyEvidence.returned).toBeGreaterThan(0);
    for (const key of ["aligned", "ohlc", "volume", "delta", "count", "cells", "order", "closedBars"]) {
      expect(historyEvidence[key]).toBe(true);
    }
  } catch (error) {
    primaryThrown = true;
    primaryValue = error;
    try {
      const raw = await page.evaluate(() => { const api = (window as unknown as { __dpr325?: { diagnosticSnapshot?: () => unknown } }).__dpr325; return api && typeof api.diagnosticSnapshot === "function" ? api.diagnosticSnapshot() : null; });
      let text = "<unserializable dpr325 diagnostic snapshot>";
      try { text = JSON.stringify(raw) ?? "null"; } catch { /* guarded */ }
      if (text.length > 3400) text = text.slice(0, 3400) + "...<truncated>";
      console.error("[dpr325-diagnostic]", text);
    } catch { /* diagnostic reporting must never mask the primary rethrow */ }  } finally {
    if (cdp !== null) {
      await attemptCleanup("cdp.clearDeviceMetricsOverride", () => (cdp as CDPSessionLike).send("Emulation.clearDeviceMetricsOverride"));
      await attemptCleanup("cdp.detach", () => (cdp as CDPSessionLike).detach());
    }
    await attemptCleanup("page.teardownPhase", () => page.evaluate(() => window.__dpr325?.teardownPhase(true)));
  }
  if (primaryThrown) throw primaryValue;
  if (cleanupFirst.thrown) throw cleanupFirst.value;
});

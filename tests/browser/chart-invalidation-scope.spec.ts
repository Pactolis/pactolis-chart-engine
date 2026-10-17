import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { installHistory, openHarness } from "./support/history.js";
import { buildBars, FROZEN_NOW } from "./support/history.js";

/**
 * Issue #316 (T05-A) - invalidation scope vocabulary on the real ChartRuntime, sampled natively.
 *
 * Given one real mountChart footprint chart with a price-overlay MA, fed by the mock bridge
 * history (frozen fixture epoch) and a trade callback the test owns;
 * When style, visibility, viewport, layout, live tail and non-tail history updates arrive;
 * Then every update reaches ChartSession with its own named change (oracle: the issue's list,
 * not the implementation), every frame that carries a non-interaction change still redraws all
 * three surfaces, and the natively screenshotted root compositor output (GPU scene + annotation
 * + interaction stacked, memory-only PNG hashed in Node) after each update is byte-identical to
 * a forced full redraw of the same state.
 *
 * The legacy runtime capture (captureCompositePng) is deliberately NOT used: it forces
 * GpuScene|Annotation dirty before capturing, so a helper that redraws before sampling erases
 * exactly the stale pixels the ghost negative control below must catch.
 *
 * ORACLE_SOURCE=base runs the same fixture against the immutable pre-PR base source (the CI
 * workflow injects this file into the base tree): HEAD-only vocabulary expectations are skipped,
 * while the real state/frame/negative-control/native visual assertions stay enforced, and the
 * workflow compares the recorded native hashes case-by-case against the HEAD run.
 */

const FUNCTIONAL_WEBGL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader-webgl",
  "--enable-unsafe-swiftshader",
];

const ROOT_SELECTOR = '[data-native-oracle-root="1"]';
const CHART_ID = "invalidation-scope-native-oracle";
const SOURCE = process.env.ORACLE_SOURCE === "base" ? "base" : "head";
const SOURCE_SHA = process.env.ORACLE_SOURCE_SHA ?? "local";
const RECORD_PATH = process.env.ORACLE_RECORD_PATH ?? "";

// History this spec owns end to end: only /history and /fillcells are overridden (registered
// after the bridge, so they win) so the non-tail correction reloads a genuinely different
// closed bar instead of an identical reply that would self-heal the scene.
const INITIAL_BARS = buildBars(60);
const CORRECTED_INDEX = 10; // a genuinely closed, non-tail, dynamic fixture bar
const CORRECTED_TIME = INITIAL_BARS[CORRECTED_INDEX].t;
// Literals derived independently from the buildBars generator at index 10:
// open=60000+10*18=60180, wave=+90 -> close=60270, high=max(open,close)+180=60450,
// v=1+1.5+2.05+1.9=6.45, n=20+10=30.
const INITIAL_CLOSE_10 = 60_270;
const CORRECTED_CLOSE_10 = 60_440;
const CORRECTED_HIGH_10 = 60_560;
const BAR10_VOLUME = 6.45;
const BAR10_COUNT = 30;
// Tail literals: the last bar is a fixedHudBar (v 12.5, d 3.25, n 42, c 60200) at the
// 15-minute-aligned FROZEN_NOW; one buy trade of qty 1 adds volume 1, delta 1, count 1.
const TAIL_TIME = FROZEN_NOW;
const TAIL_CLOSE = 60_200;
const TAIL_VOLUME = 13.5;
const TAIL_DELTA = 4.25;
const TAIL_COUNT = 43;
const CORRECTED_BARS = INITIAL_BARS.map((bar, index) =>
  index === CORRECTED_INDEX ? { ...bar, c: CORRECTED_CLOSE_10, h: CORRECTED_HIGH_10 } : bar);

interface HashRecord {
  caseName: string; kind: "scoped" | "full" | "ghost" | "clean"; dpr: number; mode: string;
  sourceSHA: string; width: number; height: number; hash: string;
}
const records: HashRecord[] = [];
test.afterAll(() => {
  if (RECORD_PATH) {
    writeFileSync(RECORD_PATH, JSON.stringify({ mode: SOURCE, sourceSHA: SOURCE_SHA, records }, null, 2) + "\n");
  }
});

interface NativeSample { hash: string; width: number; height: number }
interface ScenarioEvidence {
  name: string;
  invalidations: number[];
  frames: { surfaces: number; changes: number | null }[];
  scoped: NativeSample;
  full: NativeSample;
  state: unknown;
  geometry: unknown;
}
interface RangeProbe { autoScale: boolean; min: number; max: number }
interface TailProbe { time: number; close: number; volume: number; delta: number; count: number }
interface CorrectedProbe { close: number; volume: number; count: number }

// Worker-scoped browser launch options belong to the whole file, not to one DPR group.
test.use({ launchOptions: { args: FUNCTIONAL_WEBGL_ARGS } });

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`native compositor DPR=${deviceScaleFactor}`, () => {
    test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor });

    test("each update names its invalidation scope while native composed output stays a full redraw's", async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      // Node-side sampling binding: Playwright screenshots the exact marked root element from
      // the native compositor into a memory buffer; node:crypto hashes it. No file is written,
      // no runtime capture API runs, and the binding lives only in this test's own page context.
      const bindingName = "__nativeCompositeHash";
      await page.exposeBinding(bindingName, async (_source: unknown, selector: string) => {
        const root = page.locator(selector);
        const box = await root.boundingBox();
        if (!box || box.x !== 16 || box.y !== 16 || Math.round(box.width) !== 900) {
          throw new Error(`native sampling: root drifted from its fixed viewport box: ${JSON.stringify(box)}`);
        }
        if (await page.evaluate(() => `${window.scrollX},${window.scrollY}`) !== "0,0") {
          throw new Error("native sampling: page scrolled during capture");
        }
        const png = await root.screenshot({ timeout: 15_000, caret: "initial", animations: "allow", scale: "device" });
        return { hash: createHash("sha256").update(png).digest("hex"), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      });
      let serveCorrected = false;
      await page.exposeBinding("__serveCorrectedHistory", () => { serveCorrected = true; });
      await installHistory(page);
      const fixtureBody = () => JSON.stringify({ ok: true, data: { bars: serveCorrected ? CORRECTED_BARS : INITIAL_BARS } });
      await page.route(/\/history(?:\?|$)/, (route) => route.fulfill({ contentType: "application/json", body: fixtureBody() }));
      await page.route("**/fillcells", (route) => route.fulfill({ contentType: "application/json", body: fixtureBody() }));
      // Real-wall-clock determinism: only Date construction/now is pinned to the fixture
      // epoch. performance.now, RAF and native timers stay real so render and settle
      // deadlines keep running; the override is page-scoped and disposed with the page.
      await page.addInitScript((frozenNow: number) => {
        const RealDate = Date;
        class FrozenDate extends RealDate {
          constructor(...args: unknown[]) { super(...((args.length ? args : [frozenNow]) as [value?: number])); }
          static now() { return frozenNow; }
        }
        (window as unknown as Record<string, unknown>).Date = FrozenDate;
      }, FROZEN_NOW);
      await openHarness(page);

      const result = await page.evaluate(async (opts: { source: string; bindingName: string; rootSelector: string; frozenNow: number; chartId: string; correctedTime: number; commonRange: { from: number; to: number } }) => {
        const isBase = opts.source === "base";
        const engineModule = (path: string) => import(/* @vite-ignore */ `/src/${path}`);
        const [
          { mountChart },
          { createChartSurfaceModel },
          { getChartRuntime },
          { ChartSession },
          { ChartChange, ChartSurfaceDirty },
          { DrawingManager },
          { DEFAULT_VOLUME_PROFILE_SETTINGS },
          { normalizePreviousWeekStrategySettings },
          { normalizeMondayRangeSettings },
          { PriceRange },
        ] = await Promise.all([
          // The native oracle runs this spec against the PR base too, which may
          // predate the chartEngine.ts entry, the move into src/chart-engine/ and the engine package.
          import("/harness/chart.ts"),
          import("/harness/chart.ts"),
          import("/harness/chart.ts"),
          engineModule("features/chart/ChartSession.ts"),
          engineModule("core/render/scene/chartScene.ts"),
          engineModule("features/drawings/drawingManager.ts"),
          engineModule("core/analysis/volumeProfile.ts"),
          engineModule("core/analysis/previousWeekStrategy.ts"),
          engineModule("core/analysis/mondayRange.ts"),
          engineModule("core/model/priceRange.ts"),
        ]);
        const BTC = "BINANCE_FUTURES:btcusdt";
        const root = document.createElement("div");
        root.style.cssText = "position:fixed;left:16px;top:16px;width:900px;height:520px;overflow:hidden;z-index:2147483647;isolation:isolate;";
        root.setAttribute("data-native-oracle-root", "1");
        document.body.appendChild(root);

        // Every invalidation and every drawn frame of this chart, read on the real session.
        let invalidations: number[] = [];
        let frames: { surfaces: number; changes: number | null }[] = [];
        type SessionLike = { container: Element; needsRender: boolean } & Record<string, unknown>;
        const proto = ChartSession.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
        const originalInvalidate = proto.invalidate;
        const originalRender = proto.renderDirtySurfaces;
        // Base (pre-#404) ChartSession has no `pendingInvalidation` getter; its private
        // `dirtySurfaces` is still readable at renderDirtySurfaces entry, which is the pinned
        // base semantic for "surfaces of the frame about to draw". The change mask is unknown
        // there (null), so BASE mode only enforces the real surface/native assertions.
        const hasPendingScope = Object.getOwnPropertyDescriptor(proto, "pendingInvalidation") !== undefined;
        const scopeOf = (session: SessionLike): { surfaces: number; changes: number | null } =>
          hasPendingScope
            ? { ...(session.pendingInvalidation as { surfaces: number; changes: number }) }
            : { surfaces: session.dirtySurfaces as number, changes: null };
        proto.invalidate = function (this: SessionLike, ...args: unknown[]) {
          if (this.container === root) invalidations.push((args[0] as number | undefined) ?? ChartChange.All);
          return originalInvalidate.apply(this, args);
        };
        proto.renderDirtySurfaces = function (this: SessionLike, ...args: unknown[]) {
          if (this.container === root && this.needsRender) frames.push(scopeOf(this));
          return originalRender.apply(this, args);
        };

        let pushTrade: ((trade: unknown) => void) | null = null;
        let historySettled = false;
        const services = {
          subscribeToTrades: (_market: string, cb: (trade: unknown) => void) => { pushTrade = cb; return () => { pushTrade = null; }; },
          fetchPriceStep: async () => 50,
          fetchPricePrecision: async () => 1,
          getAnalysisContext: (market: string) => ({
            market,
            profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
            previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
            mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
            nakedPocs: [],
            drawings: new DrawingManager(() => {}),
            previousWeekStrategyLevels: [],
            mondayRangeLevels: [],
            referenceLevels: [],
          }),
          getAnalysisRevisionSnapshot: (market: string) => ({
            market, revision: 1,
            canonical: { status: "complete", market, runKey: `${market}|50`, generation: 1, revision: 1, failedPeriods: [] },
          }),
          subscribeAnalysis: () => () => {},
          subscribeAnalysisRevision: () => () => {},
          updateAnalysisFromSeries() {},
          fetchNpocSnapshot: () => new Promise(() => {}),
          notifyActiveMarket() {},
          notifyInteractiveCandlesReady() {},
          notifyInteractiveHistorySettled() { historySettled = true; },
          triggerAutoSync() {},
          notifyBarClose() {},
          notify() {},
          isFootprintSyncBusy: () => false,
        };

        const realSetTimeout = window.setTimeout;
        const waitFor = async (predicate: () => boolean, description: string) => {
          const deadline = performance.now() + 20_000;
          while (performance.now() < deadline) {
            if (predicate()) return;
            await new Promise((resolve) => realSetTimeout(resolve, 20));
          }
          throw new Error(`Timed out waiting for ${description}`);
        };
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        const settle = async () => {
          // Quiet means: nothing pending on the session and two frames in a row without a draw.
          // Monotonic performance.now deadline; exhaustion throws instead of silently returning.
          const deadline = performance.now() + 20_000;
          for (let quiet = 0; quiet < 2;) {
            if (performance.now() >= deadline) throw new Error("settle guard deadline exhausted before the chart became quiet");
            const drawn = frames.length;
            await nextFrame();
            quiet = frames.length === drawn && !runtime.session.needsRender ? quiet + 1 : 0;
          }
        };
        const sampleNative = async () => {
          // Native root-compositor sample via the Node binding; proves it triggered no redraw,
          // invalidation or pending dirty state while capturing.
          const invalidationsBefore = invalidations.length;
          const framesBefore = frames.length;
          const sample = await (window as unknown as Record<string, (selector: string) => Promise<NativeSample>>)[opts.bindingName](opts.rootSelector);
          if (invalidations.length !== invalidationsBefore || frames.length !== framesBefore || runtime.session.needsRender) {
            throw new Error("native sampling changed the render state (redraw/invalidation during capture)");
          }
          return sample;
        };

        const state = {
          type: "chart", market: BTC, timeframe: "1m", scaleMode: "linear", chartType: "footprint",
          clusterCellData: "bidask", candles: true,
          indicators: [{
            id: "ma-scope", type: "moving-average", title: "MA / EMA", visible: true, paneId: "pane_ma_scope",
            order: 0, placement: "price-overlay",
            settings: {
              lines: [{ id: "line-5", method: "sma", period: 5, timeframe: "chart", color: "#ff00ff", enabled: true }],
              lineWidth: 2, showLastValueLabel: false, showPlotLabel: false, showChartLabels: false,
            },
            style: {},
          }],
        };
        const handle = mountChart(root, state as never, services as never, opts.chartId, createChartSurfaceModel());
        type Bar = { startTime: number; open: number; high: number; low: number; close: number; volume: number; delta: number; count: number };
        type Runtime = {
          session: { needsRender: boolean; invalidate(changes?: number): void };
          pipeline: { series: { length: number; at(index: number): Bar | undefined; get(time: number): Bar | undefined }; loadHistory(opts: { from: number; to: number }): Promise<void>; };
          setVisibleTimeRange(range: { from: number; to: number }): void;
          getVisibleTimeRange(): { from: number; to: number } | null;
          timeViewport: { followsLatest(): boolean };
          setCellData(mode: string): void;
          setIndicatorVisible(id: string, visible: boolean): void;
          setPriceAutoScaleFromControl(autoScale: boolean): void;
          resetPriceScale(): void;
          getState(): { clusterCellData: string };
          listIndicators(): { id: string; visible: boolean }[];
          isPriceAutoScale(): boolean;
          view: { colWidth: number; offsetX: number; area: { left: number; top: number; width: number; height: number }; priceRange(): { minValue(): number; maxValue(): number }; setPriceRange(range: unknown): void };
        };
        let runtime = null as unknown as Runtime;
        const scenarios: ScenarioEvidence[] = [];
        let ghostControl = { ghostDrawn: false, frameQuiet: false, sentinelDiffers: false, cleanBefore: null as NativeSample | null, ghostSample: null as NativeSample | null, cleanRef: null as NativeSample | null, width: 0, height: 0 };
        let fixtureProbes: { tailBefore: TailProbe | null; correctedBefore: CorrectedProbe | null; indicatorVisibleBefore: boolean } = { tailBefore: null, correctedBefore: null, indicatorVisibleBefore: false };
        let viewportEvidence: { baseline: RangeProbe; zoomed: RangeProbe; after: RangeProbe } | null = null;
        const geometryProbe = () => {
          const price = runtime.view.priceRange();
          const box = root.getBoundingClientRect();
          return {
            root: { x: box.x, y: box.y, width: box.width, height: box.height },
            plot: { ...runtime.view.area }, seriesLength: runtime.pipeline.series.length,
            spacing: runtime.view.colWidth, offset: runtime.view.offsetX,
            visibleRange: runtime.getVisibleTimeRange(), followLatest: runtime.timeViewport.followsLatest(),
            price: { autoScale: runtime.isPriceAutoScale(), min: price.minValue(), max: price.maxValue() },
          };
        };
        let commonGeometry: ReturnType<typeof geometryProbe> | null = null;
        try {
          await waitFor(() => Boolean(getChartRuntime(opts.chartId)), "the chart runtime");
          runtime = getChartRuntime(opts.chartId) as unknown as Runtime;
          const hook = () => root.querySelector("[data-series-len]") as HTMLElement | null;
          await waitFor(() => historySettled && Number(hook()?.dataset.seriesLen ?? 0) === 60 && hook()?.dataset.historyLoading === "false", "all 60 history bars to settle");
          await waitFor(() => pushTrade !== null, "the live trade subscription");
          await settle();

          // Normalize the common fixture, not either source's default/reset policy. This
          // public sync path owns the horizontal viewport and auto-fits Y on both sources.
          // Two future 1m slots keep the complete tail and a next append inside the plot.
          runtime.setVisibleTimeRange(opts.commonRange);
          await settle();
          commonGeometry = geometryProbe();

          // Fixture probes: prove the real pipeline actually loaded this spec's fixed data.
          const barAt = (index: number): TailProbe | null => {
            const bar = runtime.pipeline.series.at(index);
            return bar ? { time: bar.startTime, close: bar.close, volume: bar.volume, delta: bar.delta, count: bar.count } : null;
          };
          const seriesLen = () => runtime.pipeline.series.length;
          fixtureProbes.tailBefore = barAt(seriesLen() - 1);
          const correctedInitial = runtime.pipeline.series.get(opts.correctedTime);
          fixtureProbes.correctedBefore = correctedInitial ? { close: correctedInitial.close, volume: correctedInitial.volume, count: correctedInitial.count } : null;
          fixtureProbes.indicatorVisibleBefore = runtime.listIndicators().find((indicator) => indicator.id === "ma-scope")?.visible === true;

          const run = async (name: string, act: () => unknown | Promise<unknown>, done: () => boolean = () => true, read: () => unknown = () => null) => {
            await settle();
            invalidations = [];
            frames = [];
            await act();
            await waitFor(done, `${name} to land`);
            await settle();
            const scenarioState = read();
            const scoped = await sampleNative();
            runtime.session.invalidate(ChartChange.All);
            await settle();
            const full = await sampleNative();
            scenarios.push({ name, invalidations: [...invalidations], frames: [...frames], scoped, full, state: scenarioState, geometry: geometryProbe() });
          };

          await run("style", () => runtime.setCellData("volume"), undefined, () => ({ cellMode: runtime.getState().clusterCellData }));
          await run("visibility", () => runtime.setIndicatorVisible("ma-scope", false), undefined, () => ({ visible: runtime.listIndicators().find((indicator) => indicator.id === "ma-scope")?.visible }));
          // Deterministic non-default viewport: disable auto-scale and apply an explicit
          // real-price range so the reset below restores a transform that provably moved.
          const rangeProbe = (): RangeProbe => {
            const range = runtime.view.priceRange();
            return { autoScale: runtime.isPriceAutoScale(), min: range.minValue(), max: range.maxValue() };
          };
          const baseline = rangeProbe();
          runtime.setPriceAutoScaleFromControl(false);
          runtime.view.setPriceRange(new PriceRange(59_000, 61_000));
          await settle();
          const zoomed = rangeProbe();
          await run("viewport", () => runtime.resetPriceScale(), undefined, rangeProbe);
          viewportEvidence = { baseline, zoomed, after: scenarios[scenarios.length - 1].state as RangeProbe };
          await run("layout", () => { root.style.height = "480px"; }, () =>
            isBase ? frames.length > 0 : frames.some((frame) => frame.changes !== null && (frame.changes & ChartChange.Layout) !== 0),
            () => ({ height: Math.round(root.getBoundingClientRect().height) }));
          await run("tail data", () => {
            const series = runtime.pipeline.series;
            const last = series.at(series.length - 1)!;
            pushTrade!({ time: opts.frozenNow, price: last.close, qty: 1, isBuy: true, market: BTC });
          }, () => isBase ? invalidations.length > 0 : invalidations.some((change) => (change & ChartChange.DataTail) !== 0), () => barAt(seriesLen() - 1));
          await run("non-tail correction", async () => {
            await (window as unknown as Record<string, () => Promise<void>>).__serveCorrectedHistory();
            const series = runtime.pipeline.series;
            const first = series.at(0)!;
            const middle = series.at(Math.floor(series.length / 2))!;
            await runtime.pipeline.loadHistory({ from: first.startTime, to: middle.startTime });
            // The reload re-places the latest bar with the source's own padding policy;
            // restore the common fixture viewport so only the corrected bar differs.
            runtime.setVisibleTimeRange(opts.commonRange);
          }, () => isBase ? invalidations.length > 0 : invalidations.some((change) => (change & ChartChange.DataNonTail) !== 0), () => {
            const bar = runtime.pipeline.series.get(opts.correctedTime);
            return bar ? { close: bar.close, volume: bar.volume, count: bar.count } : null;
          });
          // Negative control (issue #316 T05-A): a stale annotation pixel must survive sampling.
          // Given a quiet frame, a natural clean native sample, then an independent ghost pixel
          // drawn on the annotation canvas at the unoccluded plot centre, a native ghost sample,
          // an explicit full-redraw cleanup and a final clean reference sample;
          // Then ghost != healthy/full, healthy == natural clean reference, and the sentinel
          // pixel provably changed - a helper that redraws before every capture fails here.
          await settle();
          const annotationCanvas = root.querySelector('canvas[data-chart-surface="annotation"]') as HTMLCanvasElement | null;
          if (!annotationCanvas) throw new Error("ghost setup: annotation canvas (exact surface owner) not found");
          const annotationCtx = annotationCanvas.getContext("2d")!;
          ghostControl.width = annotationCanvas.width;
          ghostControl.height = annotationCanvas.height;
          // Physical, DPR-independent coordinates: the plot-area centre is never behind the
          // chart's opaque DOM header, and the identity transform makes fillRect and
          // getImageData agree on the same physical point at any devicePixelRatio.
          const ghostX = Math.floor(annotationCanvas.width / 2) - 4;
          const ghostY = Math.floor(annotationCanvas.height / 2) - 4;
          const ghostSize = 8;
          if (annotationCanvas.width < ghostX + ghostSize + 1 || annotationCanvas.height < ghostY + ghostSize + 1) {
            throw new Error("ghost setup: annotation canvas too small for the sentinel");
          }
          // Test-only native stacking proof (identical on HEAD and BASE, before any capture;
          // no CSS is changed during capture, no silent fallback): map the ghost's physical
          // centre to CSS coordinates from the live root/annotation bounding rects, then hit
          // test the real document. The fixture root must own the point, and the topmost
          // in-root surface must be the interaction canvas (z3, pointer-events:auto) sitting
          // above the annotation (z2, pointer-events:none) — proving the compositor sample of
          // the ghost point cannot be occluded by unrelated app DOM.
          const rootRect = root.getBoundingClientRect();
          const annotationRect = annotationCanvas.getBoundingClientRect();
          const dprNow = window.devicePixelRatio || 1;
          const probeCssX = annotationRect.left + (ghostX + ghostSize / 2) / dprNow;
          const probeCssY = annotationRect.top + (ghostY + ghostSize / 2) / dprNow;
          const topmost = document.elementFromPoint(probeCssX, probeCssY);
          if (!topmost || !root.contains(topmost)) {
            throw new Error(`ghost guard: sample point (${probeCssX},${probeCssY}) not owned by the fixture root: ${topmost ? topmost.outerHTML.slice(0, 120) : "no hit"}`);
          }
          const interactionSurface = root.querySelector('canvas[data-chart-surface="interaction"]');
          if (topmost !== interactionSurface) {
            throw new Error(`ghost guard: topmost surface at the ghost sample point is not the interaction canvas (z3 over annotation z2): ${topmost.outerHTML.slice(0, 120)}`);
          }
          const physicalPixelAt = (x: number, y: number) => {
            annotationCtx.save();
            annotationCtx.setTransform(1, 0, 0, 1, 0, 0);
            try {
              return [...annotationCtx.getImageData(x, y, 1, 1).data].join(",");
            } finally {
              annotationCtx.restore();
            }
          };
          const background = physicalPixelAt(ghostX, ghostY);
          const drawnBeforeGhost = frames.length;
          await nextFrame();
          const frameQuiet = !runtime.session.needsRender && frames.length === drawnBeforeGhost;
          if (!frameQuiet) throw new Error("ghost setup: chart was not quiet before the ghost draw");
          const cleanBefore = await sampleNative();
          annotationCtx.save();
          annotationCtx.setTransform(1, 0, 0, 1, 0, 0);
          try {
            annotationCtx.fillStyle = "#00ffff";
            annotationCtx.fillRect(ghostX, ghostY, ghostSize, ghostSize);
          } finally {
            annotationCtx.restore();
          }
          const sentinelDiffers = physicalPixelAt(ghostX, ghostY) !== background;
          if (!sentinelDiffers) throw new Error("ghost setup: sentinel pixel did not change");
          const ghostSample = await sampleNative();
          runtime.session.invalidate(ChartChange.All);
          await settle();
          const cleanRef = await sampleNative();
          ghostControl = { ghostDrawn: true, frameQuiet, sentinelDiffers, cleanBefore, ghostSample, cleanRef, width: annotationCanvas.width, height: annotationCanvas.height };
        } finally {
          handle.dispose();
          proto.invalidate = originalInvalidate;
          proto.renderDirtySurfaces = originalRender;
          root.remove();
        }
        return {
          scenarios,
          ghostControl,
          fixtureProbes,
          commonGeometry,
          viewportEvidence,
          names: {
            All: ChartChange.All, Style: ChartChange.Style, Visibility: ChartChange.Visibility,
            Viewport: ChartChange.Viewport, Layout: ChartChange.Layout, DataTail: ChartChange.DataTail,
            DataNonTail: ChartChange.DataNonTail, Interaction: ChartChange.Interaction,
          },
          allSurfaces: ChartSurfaceDirty.All,
          interactionSurface: ChartSurfaceDirty.Interaction,
          hasPendingScope,
        };
      }, { source: SOURCE, bindingName, rootSelector: ROOT_SELECTOR, frozenNow: FROZEN_NOW, chartId: CHART_ID, correctedTime: CORRECTED_TIME, commonRange: { from: INITIAL_BARS[0].t, to: TAIL_TIME + 2 * 60_000 } });

      const isBase = SOURCE === "base";
      const { names } = result;
      const byName = new Map<string, ScenarioEvidence>(result.scenarios.map((scenario) => [scenario.name, scenario]));
      expect([...byName.keys()]).toEqual(["style", "visibility", "viewport", "layout", "tail data", "non-tail correction"]);

      const common = result.commonGeometry!;
      console.log("native common fixture", JSON.stringify({ source: SOURCE, sourceSHA: SOURCE_SHA, dpr: deviceScaleFactor, commonGeometry: common, scenarios: result.scenarios.map(({ name, geometry }) => ({ name, geometry })) }));
      expect(common, "common fixture: settled geometry is available").not.toBeNull();
      expect(common.root, "common fixture: fixed native root box").toEqual({ x: 16, y: 16, width: 900, height: 520 });
      expect(common.seriesLength, "common fixture: all owned history bars loaded").toBe(60);
      expect(common.plot.width, "common fixture: real plot has positive width").toBeGreaterThan(0);
      expect(common.plot.height, "common fixture: real plot has positive height").toBeGreaterThan(0);
      expect(common.plot.left, "common fixture: plot starts inside root").toBeGreaterThanOrEqual(0);
      expect(common.plot.top, "common fixture: plot starts inside root").toBeGreaterThanOrEqual(0);
      expect(common.plot.left + common.plot.width, "common fixture: plot fits root width").toBeLessThanOrEqual(900);
      expect(common.plot.top + common.plot.height, "common fixture: plot fits root height").toBeLessThanOrEqual(520);
      // The sparse 15m history occupies indices 0..59; the 1m runtime extrapolates
      // the two requested future slots to index 61. This is NOT the first-fit policy oracle.
      expect(common.spacing, "common fixture: explicit 61-column span").toBeCloseTo(common.plot.width / 61, 9);
      expect(common.offset, "common fixture: first history bar anchored at plot left").toBeCloseTo(0, 9);
      expect(common.visibleRange, "common fixture: public range is available").not.toBeNull();
      expect(common.visibleRange!.from, "common fixture: requested first history time").toBeCloseTo(INITIAL_BARS[0].t, 0);
      expect(common.visibleRange!.to, "common fixture: requested two future 1m slots").toBeCloseTo(TAIL_TIME + 2 * 60_000, 0);
      expect(common.followLatest, "common fixture: explicit public range is user-owned").toBe(false);
      expect(common.price.autoScale, "common fixture: public range auto-fits price").toBe(true);
      expect(Number.isFinite(common.price.min) && Number.isFinite(common.price.max), "common fixture: finite live price transform").toBe(true);
      expect(common.price.min, "common fixture: auto-fit includes fixed history low").toBeLessThanOrEqual(59_800);
      expect(common.price.max, "common fixture: auto-fit includes fixed history high").toBeGreaterThanOrEqual(60_500);
      expect(common.price.max, "common fixture: non-degenerate price transform").toBeGreaterThan(common.price.min);

      // Fixture probes derive their expectations independently
      // from the fixed fixtures (not from values the runtime happens to report after a mask).
      expect(result.fixtureProbes.indicatorVisibleBefore, "fixture probe: overlay indicator starts visible").toBe(true);
      expect(result.fixtureProbes.tailBefore, "fixture probe: initial tail bar matches the fixed fixture").toEqual({ time: TAIL_TIME, close: TAIL_CLOSE, volume: 12.5, delta: 3.25, count: 42 });
      expect(result.fixtureProbes.correctedBefore!.close, "fixture probe: initial corrected bar close").toBe(INITIAL_CLOSE_10);
      expect(result.fixtureProbes.correctedBefore!.volume, "fixture probe: initial corrected bar volume").toBeCloseTo(BAR10_VOLUME, 9);
      expect(result.fixtureProbes.correctedBefore!.count, "fixture probe: initial corrected bar count").toBe(BAR10_COUNT);
      const scenarioState = (name: string) => byName.get(name)!.state;
      expect(scenarioState("style"), "style: cluster cell mode really switched to volume").toEqual({ cellMode: "volume" });
      expect(scenarioState("visibility"), "visibility: indicator really hidden in its live instance").toEqual({ visible: false });
      const viewport = result.viewportEvidence!;
      expect(viewport.baseline.autoScale, "viewport: deterministic baseline is auto-scaled").toBe(true);
      expect(viewport.zoomed.autoScale, "viewport: non-default zoom disabled auto-scale").toBe(false);
      expect(viewport.zoomed.min !== viewport.baseline.min || viewport.zoomed.max !== viewport.baseline.max, "viewport: zoom provably moved the live transform").toBe(true);
      expect(viewport.after, "viewport: reset restored the exact baseline transform").toEqual(viewport.baseline);
      expect(scenarioState("layout"), "layout: root really resized to 480px").toEqual({ height: 480 });
      expect(scenarioState("tail data"), "tail: raw last bar really mutated by the owned trade").toEqual({ time: TAIL_TIME, close: TAIL_CLOSE, volume: TAIL_VOLUME, delta: TAIL_DELTA, count: TAIL_COUNT });
      const correctedAfter = scenarioState("non-tail correction") as CorrectedProbe;
      expect(correctedAfter!.close, "non-tail: corrected closed bar really replaced").toBe(CORRECTED_CLOSE_10);
      expect(correctedAfter!.volume, "non-tail: corrected bar volume coherent").toBeCloseTo(BAR10_VOLUME, 9);
      expect(correctedAfter!.count, "non-tail: corrected bar trade count coherent").toBe(BAR10_COUNT);

      if (!isBase) {
        const expected: Record<string, number> = {
          style: names.Style,
          visibility: names.Visibility,
          viewport: names.Viewport,
          "tail data": names.DataTail,
          "non-tail correction": names.DataNonTail,
        };
        for (const [name, change] of Object.entries(expected)) {
          const scenario = byName.get(name)!;
          // The update's own invalidation names its change and is not a bare full invalidation.
          expect(scenario.invalidations.some((mask) => (mask & change) !== 0 && mask !== names.All), `${name}: ${JSON.stringify(scenario.invalidations)}`).toBe(true);
        }
        // A tail update never claims a non-tail correction and vice versa.
        for (const [name, other] of [["tail data", names.DataNonTail], ["non-tail correction", names.DataTail]] as const) {
          const masks = byName.get(name)!.invalidations;
          expect(masks.every((mask) => mask === names.All || (mask & other) === 0), `${name}: ${JSON.stringify(masks)}`).toBe(true);
        }
        expect(byName.get("layout")!.frames.some((frame) => frame.changes !== null && (frame.changes & names.Layout) !== 0)).toBe(true);
      }

      for (const scenario of result.scenarios) {
        expect(scenario.frames.length, `${scenario.name}: drew at least one frame`).toBeGreaterThan(0);
        for (const frame of scenario.frames) {
          // Interaction-only frames keep their narrow surface; anything else redraws every
          // surface. In BASE mode the change mask is unknown, and this spec never issues
          // interaction updates, so the full-surface redraw is asserted directly.
          const expectedSurfaces = !isBase && frame.changes === names.Interaction ? result.interactionSurface : result.allSurfaces;
          if (frame.changes === 0) continue;
          expect(frame.surfaces, `${scenario.name}: frame ${JSON.stringify(frame)}`).toBe(expectedSurfaces);
        }
        expect(scenario.scoped.width, `${scenario.name}: real sample width`).toBeGreaterThan(0);
        expect(scenario.scoped.height, `${scenario.name}: real sample height`).toBeGreaterThan(0);
        expect(scenario.scoped.width, `${scenario.name}: scoped/full sample width stable`).toBe(scenario.full.width);
        expect(scenario.scoped.height, `${scenario.name}: scoped/full sample height stable`).toBe(scenario.full.height);
        expect(scenario.scoped.hash, `${scenario.name}: native composed output equals a full redraw`).toBe(scenario.full.hash);
      }

      const ghost = result.ghostControl;
      expect(ghost.ghostDrawn, "ghost setup: annotation canvas present and quiet").toBe(true);
      expect(ghost.frameQuiet, "ghost setup: no natural pending frame").toBe(true);
      expect(ghost.sentinelDiffers, "ghost setup: sentinel pixel differs from background").toBe(true);
      expect(ghost.ghostSample!.hash, "ghost sample must differ from the clean full redraw after cleanup").not.toBe(ghost.cleanRef!.hash);
      expect(ghost.ghostSample!.hash, "ghost sample must differ from the natural clean state").not.toBe(ghost.cleanBefore!.hash);
      expect(ghost.cleanRef!.hash, "healthy redraw must reproduce the natural clean sample").toBe(ghost.cleanBefore!.hash);
      expect(ghost.cleanRef!.width, "healthy redraw keeps the natural sample width").toBe(ghost.cleanBefore!.width);
      expect(ghost.cleanRef!.height, "healthy redraw keeps the natural sample height").toBe(ghost.cleanBefore!.height);

      for (const scenario of result.scenarios) {
        records.push({ caseName: scenario.name, kind: "scoped", dpr: deviceScaleFactor, mode: SOURCE, sourceSHA: SOURCE_SHA, width: scenario.scoped.width, height: scenario.scoped.height, hash: scenario.scoped.hash });
        records.push({ caseName: scenario.name, kind: "full", dpr: deviceScaleFactor, mode: SOURCE, sourceSHA: SOURCE_SHA, width: scenario.full.width, height: scenario.full.height, hash: scenario.full.hash });
      }
      records.push({ caseName: "ghost-control", kind: "ghost", dpr: deviceScaleFactor, mode: SOURCE, sourceSHA: SOURCE_SHA, width: ghost.ghostSample!.width, height: ghost.ghostSample!.height, hash: ghost.ghostSample!.hash });
      records.push({ caseName: "ghost-control", kind: "clean", dpr: deviceScaleFactor, mode: SOURCE, sourceSHA: SOURCE_SHA, width: ghost.cleanRef!.width, height: ghost.cleanRef!.height, hash: ghost.cleanRef!.hash });

      await testInfo.attach("invalidation-scope-hashes.json", {
        body: JSON.stringify({ mode: SOURCE, sourceSHA: SOURCE_SHA, dpr: deviceScaleFactor, hasPendingScope: result.hasPendingScope, commonGeometry: result.commonGeometry, scenarios: result.scenarios.map(({ name, scoped, full, state, geometry }) => ({ name, state, geometry, scoped, full })), ghostControl: ghost }, null, 2),
        contentType: "application/json",
      });
    });
  });
}
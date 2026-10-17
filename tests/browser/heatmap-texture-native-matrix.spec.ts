import { expect, test, type Page } from "@playwright/test";
import type { ChartCaptureReadiness } from "../../src/features/chart/captureReadiness.js";
import type { View } from "../../src/core/engine/view.js";
import type { FootprintSeries } from "../../src/core/model/footprint.js";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

/**
 * Given real BTCUSDT perp OHLC and acknowledged HTTP books, default-false keeps
 * literal density cells in annotation only. Empty books are a negative control.
 * When ONLY the approved temporary TS-private instance flag becomes true,
 * Then the SAME Session-owned native capture must contain GPU density cells,
 * with no annotation double paint and with candle/axes/background retained.
 * No production/public/settings/config/DTO seam is introduced by this spec.
 */
type RuntimeProbe = {
  heatmapTexturePrototypeEnabled?: boolean;
  view: View;
  pipeline: { series: FootprintSeries };
  getState(): ChartPanelState;
  updateState(state: ChartPanelState): void;
  getCaptureReadiness(): ChartCaptureReadiness;
  subscribeCaptureReadiness(cb: (snapshot: ChartCaptureReadiness) => void): () => void;
  setVisibleTimeRange(range: { from: number; to: number }): void;
  invalidate(): void;
  orderbookHeatmap: {
    bars: Map<number, { t: number; cells: number[][] }>;
    chunks: Map<number, { status: string }>;
    inFlight: Set<AbortController>;
  };
  session: {
    gl: WebGL2RenderingContext;
    pendingCapture: unknown;
    captureCompositePng(): Promise<{ blob: Blob; width: number; height: number }>;
  };
};
type Frame = {
  enabled: boolean; reads: number; preserve: boolean | undefined;
  gpu: number[][]; annotation: number[][]; composite: number[][]; nativeOracle: number[][];
  candle: number[]; axes: number[]; geometry: number[];
};
const hookSelector = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

async function prepare(page: Page, empty: boolean, log = false): Promise<string> {
  await page.setViewportSize({ width: 1800, height: 1000 });
  // Four unit trades: open 250 (buy), low 50 (sell), high 350 (buy), close 260 (sell).
  const bars = buildBars(500).map((bar) => ({
    ...bar, o: 250, h: 350, l: 50, c: 260, v: 4, d: 0, n: 4,
    // Wire rows: price bin, buy/sell qty, liquidation qty, total/buy/sell counts.
    // The close 260 shares the canonical 50 USD bin with the open 250.
    cells: [[50, 0, 1, 0, 0, 1, 0, 1], [250, 1, 1, 0, 0, 2, 1, 1], [350, 1, 0, 0, 0, 1, 1, 0]], lb: 0, ls: 0,
  }));
  let historyQueries = 0;
  await page.route(/\/history(?:\?.*)?$/, (route) => {
    if (historyQueries++ < 8) console.log("native-matrix-history-query " + new URL(route.request().url()).search.slice(0, 1200));
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from")), to = Number(q.get("to"));
    const candleOnly = q.get("includeFootprint") === "0";
    // Match the backend envelope: the served canonical grid is reported only
    // when footprint was requested; candle-only history cannot adopt a grid.
    const meta = candleOnly ? { schemaVersion: 1, generatedAt: FROZEN_NOW } : {
      schemaVersion: 1, generatedAt: FROZEN_NOW,
      footprint: { available: true, allowed: true, priceStep: 25 },
      footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to,
        coveredFrom: from, coveredThrough: to },
    };
    return route.fulfill({
      contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars }, meta }),
    });
  });
  let acknowledgements = 0;
  await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, async (route) => {
    const q = new URL(route.request().url()).searchParams;
    expect(q.get("base")).toBe("BTC");
    expect(q.get("source")).toBe("single");
    expect(q.get("resolution")).toBe("15m");
    expect(q.get("bucketStep")).toBe("50");
    expect(q.get("minBtc")).toBe("16");
    const from = Number(q.get("from")), to = Number(q.get("to"));
    expect(Number.isFinite(from) && to >= from).toBe(true);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      ok: true, data: {
        schemaVersion: 1, generatedAt: FROZEN_NOW, base: "BTC", source: "single",
        resolution: "15m", bucketStep: 50, from, to,
        bars: bars.filter((bar) => bar.t >= from && bar.t <= to).map((bar) => ({
          t: bar.t,
          // Independent numeric oracle: 4000/125=32 BTC; 14400/225=64 BTC.
          // The explicit zero cell is PRESENT, not an absent bucket.
          cells: empty ? [] : [[50, 0, 0], [100, 2000, 2000], [200, 7200, 7200]],
        })),
      },
    }) });
    acknowledgements++;
  });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0");
  const hook = page.locator(hookSelector);
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  await expect(hook).toHaveAttribute("data-series-len", "500");
  const id = await hook.getAttribute("data-panel-id");
  if (!id) throw new Error("Fixture: missing actual panel id");
  await page.evaluate(async ({ id, log }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const { updateOrderbookHeatmapSettings, setOrderbookHeatmapModeFor } =
      await import("/harness/chart.ts");
    const { settings } = await import("/src/core/settings.ts");
    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    if (!r || !r.session || typeof r.session.captureCompositePng !== "function"
        || typeof r.invalidate !== "function" || !r.orderbookHeatmap
        || typeof r.getCaptureReadiness !== "function"
        || typeof r.subscribeCaptureReadiness !== "function") {
      throw new Error("Fixture: current runtime/capture contracts unavailable");
    }
    if (r.getState().market !== "BINANCE_FUTURES:btcusdt") throw new Error("Fixture: wrong market");
    if (r.heatmapTexturePrototypeEnabled === true) throw new Error("Private opt-in must default false");
    settings.grid = false;
    r.updateState({ ...r.getState(), chartType: "candlestick", scaleMode: log ? "log" : "linear" });
    // The history-loading hook can turn false before loadHistory's final latest
    // placement. Public history-settled emits inside that same synchronous tail
    // (ChartHistoryController:221-270); awaiting it resumes AFTER the placement.
    // No geometry retry, private controller write or arbitrary frame delay.
    const selection = r.getState();
    let stopReadiness: (() => void) | undefined;
    let readinessDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        readinessDeadline = setTimeout(() => reject(new Error(
          "Fixture: public history-settled deadline exceeded",
        )), 10_000);
        stopReadiness = r.subscribeCaptureReadiness((snapshot) => {
          if (snapshot.disposed || snapshot.market !== selection.market
              || snapshot.timeframe !== selection.timeframe) {
            reject(new Error("Fixture: history readiness selection changed"));
          } else if (snapshot.history.market === selection.market
              && snapshot.history.timeframe === selection.timeframe) {
            if (snapshot.history.status === "settled" && snapshot.ready && snapshot.priceStep === 25) resolve();
            else if (snapshot.history.status === "failed") {
              reject(new Error("Fixture: public history readiness failed"));
            }
          }
        });
      });
    } finally {
      if (readinessDeadline !== undefined) clearTimeout(readinessDeadline);
      stopReadiness?.();
    }
    const settled = r.getCaptureReadiness();
    if (settled.disposed || !settled.ready || settled.priceStep !== 25
        || settled.market !== selection.market || settled.timeframe !== selection.timeframe
        || settled.history.status !== "settled"
        || settled.history.market !== selection.market
        || settled.history.timeframe !== selection.timeframe) {
      throw new Error("Fixture: public history settlement was superseded");
    }
    const s = r.pipeline.series;
    const root = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`)?.parentElement;
    const gpu = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="gpu-scene"]');
    const annotation = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
    if (s.length !== 500 || !gpu || !annotation || gpu.width <= 1 || gpu.height <= 1
        || annotation.width !== gpu.width || annotation.height !== gpu.height
        || r.view.area.width <= 1 || r.view.area.height <= 1) {
      throw new Error("Fixture: nonempty history and valid owned surfaces required");
    }
    // Public history-settled is not first-paint-ready: Session consumes deferred
    // initial fit/latest placement. This owned warm-up precedes every read observer
    // and is deliberately excluded from the ONE-read measured captures below.
    r.invalidate();
    const firstPaint = await r.session.captureCompositePng();
    if (firstPaint.width !== gpu.width || firstPaint.height !== gpu.height
        || firstPaint.blob.size === 0 || r.session.pendingCapture) {
      throw new Error("Fixture: initial owned first paint did not complete");
    }
    r.setVisibleTimeRange({ from: s.timeOfIndex(455), to: s.timeOfIndex(505) });
    // Public range establishes user ownership and Y fit, but its controller clamps
    // offsetX: it does NOT promise xOfIndex(505) == right. Consume that frame first.
    await r.session.captureCompositePng();
    // Renderer fixture inputs only, after deferred initial placement was consumed.
    // View.xOfIndex(i) = left + offsetX + i * colWidth.
    // Solve xOfIndex(last) = right - 3 * 32, hence MAIN ends at right - 64.
    const v = r.view, last = s.length - 1;
    if (32 < v.minimumBarSpacing() || 32 > v.timeScaleOptions.maxBarSpacing) {
      throw new Error("Fixture: calibrated spacing outside existing view bounds");
    }
    v.fitPriceRange(50, 350, 0.1);
    v.colWidth = 32;
    v.offsetX = v.area.width - (last + 3) * v.colWidth;
    r.invalidate();
    const calibratedPaint = await r.session.captureCompositePng();
    const right = v.area.left + v.area.width;
    if (calibratedPaint.width !== gpu.width || calibratedPaint.height !== gpu.height
        || calibratedPaint.blob.size === 0 || r.session.pendingCapture || v.colWidth <= 12
        || v.colWidth !== 32 || Math.abs(v.xOfIndex(last) - (right - 96)) > 0.01
        || Math.abs(v.xOfIndex(last) + v.colWidth - (right - 64)) > 0.01) {
      throw new Error("Fixture: calibrated owned native frame geometry is not stable");
    }
    updateOrderbookHeatmapSettings({
      unit: "btc", bucketStep: 50,
      single: { usd: 0, btc: 16 },
    });
    setOrderbookHeatmapModeFor(r.getState().market, "single");
    r.invalidate();
  }, { id, log });
  await expect.poll(() => acknowledgements).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(async ({ id, empty }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    const book = r.orderbookHeatmap, s = r.pipeline.series;
    const tail = book.bars.get(s.timeOfIndex(s.length - 1));
    return !!tail && (empty ? tail.cells.length === 0 : tail.cells.length === 3)
      && book.inFlight.size === 0 && book.chunks.size > 0
      && [...book.chunks.values()].every((chunk) => chunk.status === "ready");
  }, { id, empty })).toBe(true);
  return id;
}


/**
 * Fixed BDD matrix; source qualification is software ANGLE only.
 * A/B: Given acknowledged fixture and default-off reference, When private opt-in,
 * Then native GPU owns density, annotation is empty, other layers survive.
 * C/D: Given subpixel CSS columns, Then native final image matches independent
 * Canvas coverage (CPU fallback allowed); next CW32 frame recovers GPU, no toggle.
 * Literal fixture: present zero; 32 BTC at 125; 64 BTC at 225; threshold 16.
 * LOG(32/16)/LOG(64/16)=.5 => fixed CSS alpha .615, EXT .277; zero .28.
 * Frozen source: 0637839fc2ba1e8ee9c07f9a8d13a6ca9209464e / aa45c97d9a4f71beeb9f090a4d6d7e1edb1395d3.
 */
const scenarios = [
  { title: "A DPR2 linear CW32 acknowledged MAIN EXT native GPU", dpr: 2, log: false, narrow: false },
  { title: "B DPR2 LOG CW32 positive-price native GPU", dpr: 2, log: true, narrow: false },
  { title: "C DPR1 linear CW0.5 native coverage and CW32 GPU recovery", dpr: 1, log: false, narrow: true },
  { title: "D DPR2 linear CW0.5 native coverage and CW32 GPU recovery", dpr: 2, log: false, narrow: true },
] as const;

async function spacing(page: Page, id: string, width: number): Promise<void> {
  await page.evaluate(async ({ id, width }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    const v = r.view;
    if (width < v.minimumBarSpacing() || width > v.timeScaleOptions.maxBarSpacing)
      throw new Error("HARNESS_NOTRUN: requested spacing outside public view bounds");
    console.log("native-matrix-spacing-before " + JSON.stringify({ width, readiness: r.getCaptureReadiness(), seriesLength: r.pipeline.series.length }));
    v.colWidth = width;
    v.offsetX = v.area.width - 96 - (r.pipeline.series.length - 1) * width;
    r.invalidate();
    // Consume the public renderer-input frame before instrumenting any capture.
    await r.session.captureCompositePng();
    console.log("native-matrix-spacing-after " + JSON.stringify({ width, readiness: r.getCaptureReadiness(), seriesLength: r.pipeline.series.length }));
    if (v.colWidth !== width) throw new Error("HARNESS_NOTRUN: spacing changed");
  }, { id, width });
}

async function freezeOracle(page: Page, id: string, narrow: boolean, log: boolean) {
  return page.evaluate(async ({ id, narrow, log }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    const v = r.view, s = r.pipeline.series, dpr = devicePixelRatio;
    const last = s.length - 1, x = v.xOfIndex(last), right = v.area.left + v.area.width;
    if (s.length !== 500 || v.colWidth !== (narrow ? .5 : 32)
        || v.scaleMode !== (log ? "log" : "linear") || Math.abs(x - (right - 96)) > .01)
      throw new Error("HARNESS_NOTRUN: oracle placement contract");
    // Public projection, independent literal log contract, NOT View.yOfPrice output.
    // This fixture spans hundreds of dollars: default log offsets are 4 and .0001.
    const y = (price: number) => v.area.top
      + (v.priceTop - (log ? Math.log10(price + .0001) + 4 : price)) / v.pricePerPx;
    for (const price of [50, 75, 100, 125, 150, 175, 200, 225, 250])
      if (Math.abs(y(price) - v.yOfPrice(price)) > .00001)
        throw new Error("HARNESS_NOTRUN: literal public projection mismatch");
    const expectedCells = JSON.stringify([[50, 0, 0], [100, 2000, 2000], [200, 7200, 7200]]);
    // Five literal neighboring fixture columns cover the complete narrow ROI.
    // No unacknowledged book, invented timestamp, production collector or color helper.
    for (let k = -4; k <= 0; k++)
      if (JSON.stringify(r.orderbookHeatmap.bars.get(s.timeOfIndex(last + k))?.cells) !== expectedCells)
        throw new Error("HARNESS_NOTRUN: ROI requires actual acknowledged fixture books");
    const ext = (x + v.colWidth + right) / 2;
    const raw = narrow
      ? [[x - .25, y(125)], [x - .25, y(75)], [x - .25, y(225)], [x - .25, y(175)]]
      : [[x + 6.4, y(125)], [ext, y(125)], [x + 6.4, y(75)], [ext, y(175)], [x + 6.4, y(225)]];
    const points = raw.map(([px, py]) => [Math.floor(px * dpr), Math.floor(py * dpr)]);
    if (points.some(([px, py]) => (px + .5) / dpr <= v.area.left
        || (px + .5) / dpr >= right || (py + .5) / dpr <= v.area.top
        || (py + .5) / dpr >= v.area.top + v.area.height))
      throw new Error("HARNESS_NOTRUN: no physically valid ROI");
    const rects: { x: number; y: number; w: number; h: number; css: string }[] = [];
    // Independent TEST fixture painting, not a copy of the production business model.
    // Fixed literal numeric values/colors; no observed ON color feeds this oracle.
    for (let k = -4; k <= 0; k++) {
      for (const cell of [
        { lo: 50, hi: 100, css: "rgba(125, 211, 252, 0.28)", ext: "rgba(125, 211, 252, 0.126)" },
        { lo: 100, hi: 150, css: "rgba(77, 145, 234, 0.615)", ext: "rgba(77, 145, 234, 0.277)" },
        { lo: 200, hi: 250, css: "rgba(29, 78, 216, 0.95)", ext: "rgba(29, 78, 216, 0.427)" },
      ]) {
        rects.push({ x: x + k * v.colWidth, y: y(cell.hi), w: narrow ? 1 : 32,
          h: y(cell.lo) - y(cell.hi), css: cell.css });
        // Only wide EXT is qualified; narrow ROI is strictly left of live MAIN.
        if (!narrow && k === 0) rects.push({ x: x + 32, y: y(cell.hi),
          w: right - x - 32, h: y(cell.lo) - y(cell.hi), css: cell.ext });
      }
    }
    const annotation = points.map(([px, py]) => {
      const c = document.createElement("canvas"); c.width = 1; c.height = 1;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, -px, -py);
      for (const rect of rects) { ctx.fillStyle = rect.css; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    });
    return { points, rects, annotation, dpr, narrow, log,
      geometry: [v.colWidth, v.offsetX, v.priceTop, v.pricePerPx, x, right, v.area.top, v.area.height],
      candle: [Math.floor((x + v.colWidth / 2) * dpr), Math.floor(y(255) * dpr)] };
  }, { id, narrow, log });
}
type Oracle = Awaited<ReturnType<typeof freezeOracle>>;

async function nativeFrame(page: Page, id: string, oracle: Oracle, enable?: boolean) {
  return page.evaluate(async ({ id, oracle, enable }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    if (enable !== undefined) r.heatmapTexturePrototypeEnabled = enable;
    const root = document.querySelector('[data-testid="chart-hook"][data-panel-id="' + id + '"]')?.parentElement;
    const gpu = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="gpu-scene"]');
    const ann = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
    const before = r.getCaptureReadiness();
    if (!gpu || !ann || before.disposed || before.history.status !== "settled")
      throw new Error("HARNESS_NOTRUN: owned settled surfaces unavailable " + JSON.stringify({
        gpu: !!gpu, annotation: !!ann, readiness: before, seriesLength: r.pipeline.series.length,
      }));
    const session = r.session, gl = session.gl;
    const descriptor = Object.getOwnPropertyDescriptor(gl, "readPixels"), original = gl.readPixels;
    let pixels: Uint8Array | undefined, reads = 0;
    gl.readPixels = function (...args: Parameters<WebGL2RenderingContext["readPixels"]>) {
      const result = original.apply(this, args);
      if (session.pendingCapture) {
        if (!(args[6] instanceof Uint8Array)) throw new Error("HARNESS_NOTRUN: native buffer contract");
        pixels = args[6].slice(); reads++;
      }
      return result;
    } as WebGL2RenderingContext["readPixels"];
    try {
      r.invalidate();
      const frame = await session.captureCompositePng();
      const after = r.getCaptureReadiness(), v = r.view;
      const geometry = [v.colWidth, v.offsetX, v.priceTop, v.pricePerPx,
        v.xOfIndex(r.pipeline.series.length - 1), v.area.left + v.area.width, v.area.top, v.area.height];
      if (!pixels || reads !== 1 || frame.width !== gpu.width || frame.height !== gpu.height
          || ann.width !== gpu.width || ann.height !== gpu.height || frame.blob.size === 0
          || frame.blob.size > 4 * 1024 * 1024 || devicePixelRatio !== oracle.dpr
          || JSON.stringify(geometry) !== JSON.stringify(oracle.geometry)
          || after.disposed || after.history.status !== "settled"
          || after.selectionGeneration !== before.selectionGeneration
          || after.history.generation !== before.history.generation
          || after.market !== before.market || after.timeframe !== before.timeframe
          || r.orderbookHeatmap.inFlight.size !== 0)
        throw new Error("HARNESS_NOTRUN: unstable or missing single native frame");
      const pixel = (px: number, py: number) => Array.from(pixels!.slice(
        ((gpu.height - 1 - py) * gpu.width + px) * 4,
        ((gpu.height - 1 - py) * gpu.width + px) * 4 + 4));
      const annotation = ann.getContext("2d")!;
      const bitmap = await createImageBitmap(frame.blob);
      const canvas = document.createElement("canvas"); canvas.width = frame.width; canvas.height = frame.height;
      const composite = canvas.getContext("2d")!; composite.drawImage(bitmap, 0, 0); bitmap.close();
      const image = annotation.getImageData(0, 0, ann.width, ann.height);
      let rightInk = 0, bottomInk = 0;
      for (let py = 0; py < ann.height; py++) for (let px = 0; px < ann.width; px++) {
        const o = (py * ann.width + px) * 4;
        if (image.data[o + 3] && Math.max(image.data[o], image.data[o + 1], image.data[o + 2]) > 80) {
          if (px > (v.area.left + v.area.width) * oracle.dpr) rightInk++;
          if (py > (v.area.top + v.area.height) * oracle.dpr) bottomInk++;
        }
      }
      return { enabled: r.heatmapTexturePrototypeEnabled === true, reads,
        preserve: gl.getContextAttributes()?.preserveDrawingBuffer, geometry, dpr: devicePixelRatio,
        gpu: oracle.points.map(([px, py]) => pixel(px, py)),
        annotation: oracle.points.map(([px, py]) => Array.from(annotation.getImageData(px, py, 1, 1).data)),
        composite: oracle.points.map(([px, py]) => Array.from(composite.getImageData(px, py, 1, 1).data)),
        candle: pixel(oracle.candle[0], oracle.candle[1]), axes: [rightInk, bottomInk],
        browser: navigator.userAgent, renderer: String(gl.getParameter(gl.RENDERER)),
        png: Array.from(new Uint8Array(await frame.blob.arrayBuffer())) };
    } finally {
      if (descriptor) Object.defineProperty(gl, "readPixels", descriptor);
      else delete (gl as Partial<WebGL2RenderingContext>).readPixels;
    }
  }, { id, oracle, enable });
}
type NativeFrame = Awaited<ReturnType<typeof nativeFrame>>;

async function expectedComposite(page: Page, oracle: Oracle, baseline: NativeFrame) {
  return page.evaluate(({ oracle, base }) => oracle.points.map(([px, py], index) => {
    const c = document.createElement("canvas"); c.width = 1; c.height = 1;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(" + base[index].slice(0, 3).join(",") + ",1)"; ctx.fillRect(0, 0, 1, 1);
    ctx.setTransform(oracle.dpr, 0, 0, oracle.dpr, -px, -py);
    for (const rect of oracle.rects) { ctx.fillStyle = rect.css; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  }), { oracle, base: baseline.gpu });
}
function pixelsNear(actual: number[][], expected: number[][], tolerance: number, message: string) {
  expect(actual.length, message).toBe(expected.length);
  actual.forEach((pixel, index) => pixel.forEach((channel, c) =>
    expect(Math.abs(channel - expected[index][c]), message + " point=" + index + " channel=" + c
      + " actual=" + JSON.stringify(pixel) + " expected=" + JSON.stringify(expected[index])).toBeLessThanOrEqual(tolerance)));
}
for (const scenario of scenarios) {
  test.describe(scenario.title, () => {
    test.use({ deviceScaleFactor: scenario.dpr });
    test(scenario.title, async ({ page }, testInfo) => {
      const id = await prepare(page, false, scenario.log);
      const wide = await freezeOracle(page, id, false, scenario.log);
      let frameCount = 0;
      const read = async (stage: string, oracle: Oracle, enable?: boolean) => {
        const raw = await nativeFrame(page, id, oracle, enable);
        const { png, ...frame } = raw;
        await testInfo.attach(stage + ".png", { body: Buffer.from(png), contentType: "image/png" });
        console.log("native-matrix-frame " + JSON.stringify({ stage, ...frame, oracle }));
        frameCount++;
        expect(frame.reads, "HARNESS_NOTRUN: exactly one existing native read").toBe(1);
        expect(frame.preserve, "HARNESS_NOTRUN: native context contract").toBe(false);
        frame.axes.forEach((ink) => expect(ink, "HARNESS_NOTRUN: axes control").toBeGreaterThan(20));
        return { ...frame, png: [] } as NativeFrame;
      };
      const wideOff = await read("wide-default-off", wide);
      expect(wideOff.enabled, "HARNESS_NOTRUN: actual default-off").toBe(false);
      const wideExpected = await expectedComposite(page, wide, wideOff);
      // Oracle is frozen BEFORE any ON pixels or assertions are consulted.
      pixelsNear(wideOff.annotation, wide.annotation, 2, "HARNESS_NOTRUN: literal wide CPU control");
      pixelsNear(wideOff.composite, wideExpected, 3, "HARNESS_NOTRUN: literal wide composite control");
      pixelsNear([wideOff.gpu[3]], [[18, 20, 26, 255]], 1, "HARNESS_NOTRUN: native background control");
      pixelsNear([wideOff.candle], [[69, 219, 158, 255]], 1, "HARNESS_NOTRUN: native candle control");
      const qualify = (frame: NativeFrame, baseline: NativeFrame, oracle: Oracle, expected: number[][], requireGpu: boolean) => {
        expect(frame.enabled, "NATIVE_ASSERT: opt-in must remain true").toBe(true);
        pixelsNear(frame.composite, expected, 3, "NATIVE_ASSERT: independent native final coverage");
        const gpuOwns = frame.annotation.every((p) => p[3] === 0);
        if (requireGpu) expect(gpuOwns, "NATIVE_ASSERT: eligible wide frame requires GPU ownership").toBe(true);
        if (gpuOwns) pixelsNear(frame.gpu, expected, 3, "NATIVE_ASSERT: GPU density owning valid cells");
        else {
          pixelsNear(frame.annotation, oracle.annotation, 2, "NATIVE_ASSERT: CPU fallback density must be real");
          pixelsNear(frame.gpu, baseline.gpu, 1, "NATIVE_ASSERT: CPU fallback cannot leave stale GPU density");
        }
        pixelsNear([frame.candle], [baseline.candle], 1, "NATIVE_ASSERT: candle retained");
        expect(frame.axes, "NATIVE_ASSERT: axes retained").toEqual(baseline.axes);
        return gpuOwns ? "GPU" : "CPU_FALLBACK";
      };
      let policy: string;
      if (scenario.narrow) {
        await spacing(page, id, .5);
        const narrow = await freezeOracle(page, id, true, false);
        const off = await read("narrow-default-off", narrow);
        const expected = await expectedComposite(page, narrow, off);
        pixelsNear(off.annotation, narrow.annotation, 2, "HARNESS_NOTRUN: literal narrow Canvas coverage control");
        pixelsNear(off.composite, expected, 3, "HARNESS_NOTRUN: literal narrow final control");
        console.log("native-matrix-oracle " + JSON.stringify({ title: scenario.title, oracle: narrow, expected }));
        const on = await read("narrow-private-on", narrow, true);
        policy = qualify(on, off, narrow, expected, false);
        await spacing(page, id, 32); // NO opt-in toggle, no private recovery mutation.
        const recovered = await read("wide-recovery-still-on", wide);
        qualify(recovered, wideOff, wide, wideExpected, true);
      } else {
        console.log("native-matrix-oracle " + JSON.stringify({ title: scenario.title, oracle: wide, expected: wideExpected }));
        const on = await read("wide-private-on", wide, true);
        policy = qualify(on, wideOff, wide, wideExpected, true);
      }
      console.log("native-matrix-qualified " + JSON.stringify({ title: scenario.title, oracle: true,
        dpr: scenario.dpr, log: scenario.log, policy, frameCount, softwareOnly: true }));
    });
  });
}


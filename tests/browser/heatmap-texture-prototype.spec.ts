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

async function prepare(page: Page, empty: boolean): Promise<string> {
  await page.setViewportSize({ width: 1800, height: 1000 });
  // Four unit trades: open 250 (buy), low 50 (sell), high 350 (buy), close 260 (sell).
  const bars = buildBars(500).map((bar) => ({
    ...bar, o: 250, h: 350, l: 50, c: 260, v: 4, d: 0, n: 4,
    // Wire rows: price bin, buy/sell qty, liquidation qty, total/buy/sell counts.
    // The close 260 shares the canonical 50 USD bin with the open 250.
    cells: [[50, 0, 1, 0, 0, 1, 0, 1], [250, 1, 1, 0, 0, 2, 1, 1], [350, 1, 0, 0, 0, 1, 1, 0]], lb: 0, ls: 0,
  }));
  await page.route(/\/history(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars } }),
  }));
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
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50");
  const hook = page.locator(hookSelector);
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  await expect(hook).toHaveAttribute("data-series-len", "500");
  const id = await hook.getAttribute("data-panel-id");
  if (!id) throw new Error("Fixture: missing actual panel id");
  await page.evaluate(async (id) => {
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
    r.updateState({ ...r.getState(), chartType: "candlestick" });
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
            if (snapshot.history.status === "settled") resolve();
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
    if (settled.disposed || settled.history.status !== "settled"
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
  }, id);
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

async function capture(page: Page, id: string, enable?: boolean): Promise<Frame> {
  return page.evaluate(async ({ id, enable }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    if (enable !== undefined) r.heatmapTexturePrototypeEnabled = enable;
    const hook = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`);
    const root = hook?.parentElement;
    const gpu = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="gpu-scene"]');
    const annotation = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
    if (!gpu || !annotation) throw new Error("Fixture: missing owned surfaces");
    const history = r.getCaptureReadiness();
    if (history.disposed || history.history.status !== "settled"
        || history.history.market !== r.getState().market
        || history.history.timeframe !== r.getState().timeframe) {
      throw new Error("Fixture: capture requires public settled history");
    }
    const session = r.session, gl = session.gl;
    const preserve = gl.getContextAttributes()?.preserveDrawingBuffer;
    let ownedPixels: Uint8Array | undefined, reads = 0;
    // Bounded failure evidence: native read turn versus later PNG continuation.
    // No render, cache mutation or additional pixel read.
    const diagnostic = () => {
      const v = r.view, s = r.pipeline.series, book = r.orderbookHeatmap;
      const last = s.length - 1, x = v.xOfIndex(last), right = v.area.left + v.area.width;
      return {
        colWidth: v.colWidth, offsetX: v.offsetX, last, time: s.timeOfIndex(last),
        area: { ...v.area }, x, mainEnd: x + v.colWidth, right, gap: right - x - v.colWidth,
        inFlight: book.inFlight.size, bars: book.bars.size,
        chunks: [...book.chunks.entries()].slice(0, 4), chunkCount: book.chunks.size,
        tailCells: book.bars.get(s.timeOfIndex(last))?.cells.length,
        current: r.getState().market, historyLoading: hook?.getAttribute("data-history-loading"),
        seriesLen: hook?.getAttribute("data-series-len"), enabled: r.heatmapTexturePrototypeEnabled === true,
      };
    };
    let ownerFrame: ReturnType<typeof diagnostic> | undefined;
    const descriptor = Object.getOwnPropertyDescriptor(gl, "readPixels");
    const original = gl.readPixels;
    // Observe ONLY the existing Session-owned capture read, never issue a GL read.
    gl.readPixels = function (...args: Parameters<WebGL2RenderingContext["readPixels"]>) {
      const result = original.apply(this, args);
      if (session.pendingCapture) {
        const target = args[6];
        if (!(target instanceof Uint8Array)) throw new Error("Fixture: unexpected native snapshot buffer");
        ownedPixels = target.slice(); reads++; ownerFrame = diagnostic();
      }
      return result;
    } as WebGL2RenderingContext["readPixels"];
    try {
      r.invalidate(); // Existing full GPU+annotation invalidation, not a custom draw.
      const frame = await session.captureCompositePng();
      if (!ownedPixels || reads !== 1 || frame.width !== gpu.width || frame.height !== gpu.height) {
        throw new Error("Fixture: no single owned in-frame snapshot");
      }
      const postHistory = r.getCaptureReadiness();
      if (postHistory.disposed || postHistory.history.status !== "settled"
          || postHistory.selectionGeneration !== history.selectionGeneration
          || postHistory.history.generation !== history.history.generation
          || postHistory.market !== history.market || postHistory.timeframe !== history.timeframe) {
        throw new Error("Fixture: history changed during owned capture");
      }
      const dpr = annotation.ownerDocument.defaultView!.devicePixelRatio;
      const v = r.view, s = r.pipeline.series, i = s.length - 1;
      if (v.colWidth <= 12) throw new Error("Fixture: main-cell interior is not resolvable");
      const x = v.xOfIndex(i), right = v.area.left + v.area.width;
      const mainEnd = x + v.colWidth;
      // Validate actual post-native-frame geometry BEFORE consulting any pixels.
      if (v.colWidth !== 32 || Math.abs(x - (right - 96)) > 0.01
          || !(mainEnd < right - 32) || right - mainEnd < 64 - 0.01
          || r.orderbookHeatmap.inFlight.size !== 0) {
        throw new Error("Fixture: quiet calibrated MAIN and genuine future gap required; texture-heatmap-diagnostic " + JSON.stringify({ ownerFrame, continuation: diagnostic() }));
      }
      const extensionX = (mainEnd + right) / 2;
      const points = [
        [x + v.colWidth * 0.2, v.yOfPrice(125)],
        [extensionX, v.yOfPrice(125)],
        [x + v.colWidth * 0.2, v.yOfPrice(75)],
        [extensionX, v.yOfPrice(175)], // ABSENT bucket, unlike the explicit zero.
      ].map(([px, py]) => [Math.floor(px * dpr), Math.floor(py * dpr)]);
      for (const [px, py] of points) {
        if (px < v.area.left * dpr + 2 || px >= right * dpr - 2
            || py < v.area.top * dpr + 2 || py >= (v.area.top + v.area.height) * dpr - 2) {
          throw new Error("Fixture: sample outside plot inset");
        }
      }
      const gpuPixel = (px: number, py: number) =>
        Array.from(ownedPixels!.slice(((gpu.height - 1 - py) * gpu.width + px) * 4,
          ((gpu.height - 1 - py) * gpu.width + px) * 4 + 4));
      const ctx = annotation.getContext("2d");
      if (!ctx) throw new Error("Fixture: missing actual annotation");
      const image = ctx.getImageData(0, 0, annotation.width, annotation.height);
      const annPixel = (px: number, py: number) =>
        Array.from(image.data.slice((py * annotation.width + px) * 4, (py * annotation.width + px) * 4 + 4));
      const bitmap = await createImageBitmap(frame.blob);
      const scratch = document.createElement("canvas");
      scratch.width = frame.width; scratch.height = frame.height;
      const composite = scratch.getContext("2d")!;
      composite.drawImage(bitmap, 0, 0); bitmap.close();
      const candle = gpuPixel(Math.floor((x + v.colWidth / 2) * dpr), Math.floor(v.yOfPrice(255) * dpr));
      let rightInk = 0, bottomInk = 0;
      for (let py = 0; py < annotation.height; py++) for (let px = 0; px < annotation.width; px++) {
        const o = (py * annotation.width + px) * 4;
        if (image.data[o + 3] > 0 && Math.max(image.data[o], image.data[o + 1], image.data[o + 2]) > 80) {
          if (px > (v.area.left + v.area.width) * dpr) rightInk++;
          if (py > (v.area.top + v.area.height) * dpr) bottomInk++;
        }
      }
      // Independent storage-representation oracle, NEVER application pixels/model.
      // CSS is straight RGB + float alpha. Canvas stores quantized premultiplied
      // channels and getImageData unpremultiplies them (low-alpha RGB can move >1).
      // Ideal round8 model: A=round(255*a), P=round(C*a), U=round(255*P/A).
      // For .277: A=71, P=[21,40,65], U=[75,144,233], NOT CSS [77,145,234].
      // This literal 1px control also accounts for browser alpha/premul rounding.
      const literalCanvas = document.createElement("canvas");
      literalCanvas.width = 1; literalCanvas.height = 1;
      const literalCtx = literalCanvas.getContext("2d")!;
      const nativeOracle = [
        "rgba(77, 145, 234, 0.615)",
        "rgba(77, 145, 234, 0.277)",
        "rgba(125, 211, 252, 0.28)",
      ].map((css) => {
        literalCtx.clearRect(0, 0, 1, 1);
        literalCtx.fillStyle = css;
        literalCtx.fillRect(0, 0, 1, 1);
        return Array.from(literalCtx.getImageData(0, 0, 1, 1).data);
      });
      return {
        enabled: r.heatmapTexturePrototypeEnabled === true, reads, preserve, nativeOracle,
        gpu: points.map(([px, py]) => gpuPixel(px, py)),
        annotation: points.map(([px, py]) => annPixel(px, py)),
        composite: points.map(([px, py]) => Array.from(composite.getImageData(px, py, 1, 1).data)),
        candle, axes: [rightInk, bottomInk],
        geometry: [gpu.width, gpu.height, dpr, v.colWidth, x, right, v.yOfPrice(125), mainEnd, extensionX, v.offsetX],
      };
    } finally {
      if (descriptor) Object.defineProperty(gl, "readPixels", descriptor);
      else delete (gl as Partial<WebGL2RenderingContext>).readPixels;
    }
  }, { id, enable });
}

function near(actual: number[], expected: number[], tolerance: number): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, channel) => expect(Math.abs(actual[channel] - value)).toBeLessThanOrEqual(tolerance));
}
function controls(frame: Frame): void {
  expect(frame.reads).toBe(1);
  expect(frame.preserve).toBe(false);
  near(frame.gpu[3], [18, 20, 26, 255], 1);
  near(frame.candle, [69, 219, 158, 255], 1);
  frame.axes.forEach((ink) => expect(ink).toBeGreaterThan(20));
}
function cpuCells(frame: Frame): void {
  // LOG(32/16)/LOG(64/16)=.5; density is bid+ask, not dominant side.
  // Independent round8 premul math verifies the literal scratch representation.
  const premultiplied = [[47, 89, 144], [21, 40, 65], [35, 59, 71]];
  const alpha = [0.615, 0.277, 0.28];
  frame.nativeOracle.forEach((rgba, index) => {
    near(rgba.slice(0, 3).map((c) => Math.round(c * rgba[3] / 255)), premultiplied[index], 1);
    expect(Math.abs(rgba[3] - alpha[index] * 255)).toBeLessThanOrEqual(2);
  });
  near(frame.annotation[0].slice(0, 3), frame.nativeOracle[0].slice(0, 3), 1);
  expect(Math.abs(frame.annotation[0][3] - 0.615 * 255)).toBeLessThanOrEqual(2);
  near(frame.annotation[1].slice(0, 3), frame.nativeOracle[1].slice(0, 3), 1);
  expect(Math.abs(frame.annotation[1][3] - 0.277 * 255)).toBeLessThanOrEqual(2);
  near(frame.annotation[2].slice(0, 3), frame.nativeOracle[2].slice(0, 3), 1);
  expect(Math.abs(frame.annotation[2][3] - 0.28 * 255)).toBeLessThanOrEqual(2);
  expect(frame.annotation[3][3]).toBe(0);
}

test("Given EMPTY acknowledged books, private opt-in cannot invent GPU density", async ({ page }) => {
  const id = await prepare(page, true);
  const legacy = await capture(page, id);
  expect(legacy.enabled).toBe(false);
  const optedIn = await capture(page, id, true);
  for (const frame of [legacy, optedIn]) {
    controls(frame);
    frame.gpu.forEach((pixel) => near(pixel, [18, 20, 26, 255], 1));
    frame.annotation.forEach((pixel) => expect(pixel[3]).toBe(0));
  }
});

test("Given literal CPU density, When private prototype opts in, Then SAME native GPU frame owns cells [RED phase]", async ({ page }) => {
  const id = await prepare(page, false);
  const legacy = await capture(page, id);
  expect(legacy.enabled).toBe(false);
  controls(legacy); cpuCells(legacy);
  legacy.gpu.forEach((pixel) => near(pixel, [18, 20, 26, 255], 1));
  near(legacy.composite[0], [54, 97, 154, 255], 3);
  near(legacy.composite[1], [34, 55, 84, 255], 3);
  near(legacy.composite[2], [48, 73, 89, 255], 3);
  // First feature assertion follows all fixture, real CPU and native GPU controls.
  const prototype = await capture(page, id, true);
  expect(prototype.enabled).toBe(true);
  controls(prototype);
  console.log("texture-heatmap-owned-frame", JSON.stringify({ legacy, prototype }));
  expect(Math.max(...prototype.gpu[0].map((value, channel) => Math.abs(value - [54, 97, 154, 255][channel]))),
    "FEATURE_ABSENCE: density must move into Session-owned native GPU snapshot").toBeLessThanOrEqual(3);
  near(prototype.gpu[1], [34, 55, 84, 255], 3);
  near(prototype.gpu[2], [48, 73, 89, 255], 3);
  prototype.annotation.forEach((pixel) => expect(pixel[3], "GPU density must not double paint annotation").toBe(0));
  prototype.composite.forEach((pixel, index) => near(pixel, prototype.gpu[index], 1));
  expect(prototype.geometry).toEqual(legacy.geometry);
  expect(prototype.axes).toEqual(legacy.axes);
  expect(prototype.candle).toEqual(legacy.candle);
  const restored = await capture(page, id, false);
  controls(restored); cpuCells(restored);
  restored.gpu.forEach((pixel) => near(pixel, [18, 20, 26, 255], 1));
  expect(restored.geometry).toEqual(legacy.geometry);
  expect(restored.nativeOracle).toEqual(legacy.nativeOracle);
  restored.annotation.forEach((pixel, index) => near(pixel, legacy.annotation[index], 1));
  near(restored.composite[0], [54, 97, 154, 255], 3);
  near(restored.composite[1], [34, 55, 84, 255], 3);
  near(restored.composite[2], [48, 73, 89, 255], 3);
});

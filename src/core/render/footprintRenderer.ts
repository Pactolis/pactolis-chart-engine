// WebGL layer: draws footprint cell heat (buy/sell halves) and POC highlight.
import { QuadBatch } from "../engine/quadBatch.js";
import type { GpuFrame, GpuSurface, QuadSink } from "../gpu/gpuBackend.js";

function isGpuSurface(value: unknown): value is GpuSurface {
  return Boolean(
    value
    && typeof value === "object"
    && "kind" in (value as object)
    && ((value as any).kind === "webgl2" || (value as any).kind === "canvas2d" || (value as any).kind === "webgpu")
    && typeof (value as GpuSurface).beginFrame === "function"
  );
}
import type { RGBA } from "../engine/gl.js";
import type { View } from "../engine/view.js";
import type { FootprintSeries } from "../model/footprint.js";
import { neighbourBin } from "../priceStep.js";
import { TimeScaleModel } from "../model/timeScale.js";
import { drawTimeGrid } from "./gridRenderer.js";
import type { FootprintBar, FootprintCell } from "../types.js";
import { settings, type FootprintCellData, type ChartViewConfig } from "../settings.js";
import {
  buildPixelCandleBuckets,
  buildPixelCellBuckets,
  CELL_PIXEL_MERGE_HEIGHT,
  chartLodForSpacing,
  type OhlcBarLike,
} from "./chartLod.js";
import { resolveBuiltInLayerPreset, type BuiltInChartType } from "./scene/chartLayerPreset.js";
import { measurePerformance } from "../performanceTelemetry.js";
import {
  cellAverageTradeSize,
  cellAverageTradeSizes,
  cellDelta,
  cellDeltaPercent,
  cellTotalVolume,
  cellTradeCounts,
} from "../model/footprintCellMetrics.js";

const BUY: RGBA = { r: 0.13, g: 0.62, b: 0.45, a: 1 }; // green
const SELL: RGBA = { r: 0.85, g: 0.25, b: 0.3, a: 1 }; // red
const POC: RGBA = { r: 1.0, g: 0.78, b: 0.2, a: 0.18 }; // point of control row
const CANDLE_UP: RGBA = { r: 0.27, g: 0.86, b: 0.62, a: 1 };
const CANDLE_DOWN: RGBA = { r: 1.0, g: 0.42, b: 0.45, a: 1 };
const IMB_BUY: RGBA = { r: 0.25, g: 0.95, b: 0.6, a: 0.95 }; // stacked buy imbalance
const IMB_SELL: RGBA = { r: 1.0, g: 0.3, b: 0.35, a: 0.95 }; // stacked sell imbalance
const IMB_RATIO = 3; // diagonal buy/sell ratio to count as an imbalance
const IMB_STACK = 3; // consecutive imbalances to highlight as "stacked"
const DEBUG_RENDER = false;

/** Scratch RGBA reused across heat-path draw calls within a single frame.
 *  Safe because QuadBatch.rect() copies r/g/b/a into its Float32Array
 *  synchronously and never retains the object reference (see quadBatch.ts). */
const scratchColor: RGBA = { r: 0, g: 0, b: 0, a: 1 };

/** Writes `color` with alpha `a` into `scratchColor` and returns it, so hot
 *  per-cell paths can pass a tinted colour without allocating. Pass the result
 *  straight to `QuadBatch.rect()`; it is overwritten by the next call. */
function withAlpha(color: RGBA, a: number): RGBA {
  scratchColor.r = color.r; scratchColor.g = color.g; scratchColor.b = color.b; scratchColor.a = a;
  return scratchColor;
}

/** Per-bar derived data that only depends on the bar's cells and `step`.
 *  Invalidated via `bar.cellRevision` (a monotonic counter bumped on every cell
 *  mutation) plus `step`, so a stale cache is never read after the bar's cells
 *  change. `updatedAt` cannot serve here: it is a wall clock taken from the trade,
 *  so a burst inside one millisecond leaves it unchanged. */
interface BarHeatCache {
  cellRevision: number;
  step: number;
  maxVol: number;
  pocBin: number;
}

interface BarImbalanceCache {
  cellRevision: number;
  step: number;
  cells: FootprintCell[];
  buyImb: boolean[];
  sellImb: boolean[];
}

/** Same cellRevision invalidation contract as BarHeatCache, but for the profile
 *  mode's max-volume/POC/peak-metric scan (the metric depends on profileCellData). */
interface BarProfileCache {
  cellRevision: number;
  mode: FootprintCellData;
  maxVol: number;
  pocBin: number;
  maxMetric: number;
}

export class FootprintRenderer {
  private batch: QuadSink;
  private rawBatch: QuadBatch | null = null;
  private surface: GpuSurface | null = null;
  private currentFrame: GpuFrame | null = null;
  private gl?: WebGL2RenderingContext;
  private readonly heatCache = new WeakMap<FootprintBar, BarHeatCache>();
  private readonly imbalanceCache = new WeakMap<FootprintBar, BarImbalanceCache>();
  private readonly scratchCellRect = { yTop: 0, height: 0 };
  private readonly scratchClipRect = { yTop: 0, height: 0 };
  private static readonly LAYER_PRESET_CACHE = new Map<BuiltInChartType, ReadonlySet<string>>();

  private static getLayerPreset(chartType: BuiltInChartType): ReadonlySet<string> {
    let cached = FootprintRenderer.LAYER_PRESET_CACHE.get(chartType);
    if (!cached) {
      cached = new Set(resolveBuiltInLayerPreset(chartType).gpu);
      FootprintRenderer.LAYER_PRESET_CACHE.set(chartType, cached);
    }
    return cached;
  }
  private readonly profileCache = new WeakMap<FootprintBar, BarProfileCache>();
  /** Per-chart görünüm config'i (runtime set eder); null ise global settings. */
  private chartConfig: ChartViewConfig | null = null;

  constructor(glOrSurface: WebGL2RenderingContext | GpuSurface) {
    if (isGpuSurface(glOrSurface)) {
      this.surface = glOrSurface;
      if (glOrSurface.kind === "webgl2" && typeof (glOrSurface as any).getGlContext === "function") {
        this.gl = (glOrSurface as any).getGlContext();
      }
      this.batch = { rect: () => {} };
    } else {
      this.gl = glOrSurface;
      this.rawBatch = new QuadBatch(glOrSurface);
      this.batch = this.rawBatch;
    }
  }

  setSurface(surface: GpuSurface): void {
    this.surface = surface;
    if (surface.kind === "webgl2" && typeof (surface as any).getGlContext === "function") {
      this.gl = (surface as any).getGlContext();
    }
  }

  /** ChartRuntime her state değişiminde effective config'i buraya iter. */
  setChartConfig(config: ChartViewConfig): void {
    this.chartConfig = config;
  }

  /** Effective view config for this panel; global `settings` until one is pushed. */
  private cfg(): ChartViewConfig {
    return this.chartConfig ?? settings;
  }

  dispose(): void {
    (this.batch as any).dispose?.();
    this.currentFrame = null;
  }

  /**
   * Pixel ratio the canvas was sized at: the session's measurement when the view carries one (it may sit
   * below the window's ratio under a host cap), else the DPR of the window that owns the canvas (a popout
   * can differ from the main window).
   */
  private devicePixelRatio(view: View): number {
    if (view.pixelRatio !== null && view.pixelRatio > 0) return view.pixelRatio;
    const canvas = (this.surface?.canvas ?? this.gl?.canvas) as Partial<HTMLCanvasElement> | undefined;
    const owner = canvas?.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null);
    return owner?.devicePixelRatio || 1;
  }

  clear(): void {
    if (this.surface) return;
    const gl = this.gl;
    if (!gl) return;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0.07, 0.08, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private flushCurrent(dpr: number): void {
    const gl = this.gl;
    const w = gl ? gl.drawingBufferWidth / dpr : (this.surface?.canvas.width ?? 0) / dpr;
    const h = gl ? gl.drawingBufferHeight / dpr : (this.surface?.canvas.height ?? 0) / dpr;
    if (this.currentFrame) {
      this.currentFrame.flushQuads(w, h);
      this.currentFrame.end();
      this.currentFrame = null;
    } else if (gl) {
      (this.batch as any).flush?.(w, h);
    }
  }

  /**
   * Index range [from, to) of bars to draw. Includes one bar past the right
   * edge so geometry that reaches into the next bar (e.g. line segments) is
   * not cut short at the edge.
   */
  visibleRange(view: View, total: number): [number, number] {
    const from = Math.max(0, Math.floor(view.indexOfX(view.area.left)));
    const to = Math.min(total, Math.ceil(view.indexOfX(view.area.left + view.area.width)) + 1);
    return [from, to];
  }

  /**
   * Index range [from, to) of bars that overlap the plot area, used for price
   * autoscale. Bar i occupies [i, i + 1), so a bar starting at or past the
   * right edge is off screen and must not widen the price range.
   */
  autoscaleRange(view: View, total: number): [number, number] {
    const from = Math.max(0, Math.floor(view.indexOfX(view.area.left)));
    const to = Math.min(total, Math.ceil(view.indexOfX(view.area.left + view.area.width)));
    return [from, to];
  }

  render(view: View, series: FootprintSeries): void {
    const chartType = this.cfg().chartType;
    this.renderLayers(view, series, FootprintRenderer.getLayerPreset(chartType));
  }

  /**
   * Render the semantic GPU layers for the current built-in chart preset.
   * Layers share one QuadBatch and one flush boundary; semantic decomposition
   * must not turn into a draw-call-per-layer architecture.
   */
  renderLayers(view: View, series: FootprintSeries, activeLayers: ReadonlySet<string>): void {
    const dpr = this.devicePixelRatio(view);
    if (view.area.width <= 0 || view.area.height <= 0) return;

    if (this.surface) {
      const frame = this.surface.beginFrame({ r: 0.07, g: 0.08, b: 0.1, a: 1 });
      this.currentFrame = frame;
      this.batch = frame.quads;
    } else {
      measurePerformance("chart.gpu.clear.ms", () => this.clear());
      (this.batch as any).begin?.();
    }

    const step = series.config.priceStep;
    const [from, to] = this.visibleRange(view, series.length);
    const timeScale = TimeScaleModel.fromSeries(series);
    if (DEBUG_RENDER) {
      const firstBar = series.at(from);
      const lastBar = series.at(Math.max(from, to - 1));
      const newestBar = series.at(series.length - 1);
      const newestIndex = series.length - 1;
      console.debug("[chart-render]", {
        len: series.length, from, to, newestIndex,
        visibleFirstTime: firstBar?.startTime, visibleLastTime: lastBar?.startTime,
        newestTime: newestBar?.startTime, newestVisible: from <= newestIndex && newestIndex < to,
        offsetX: view.offsetX, colWidth: view.colWidth, area: { ...view.area },
      });
    }

    // Global grid toggle: the vertical time-grid layer is skipped entirely when off.
    // Read from global `settings`, not per-chart cfg — grid is an app-wide preference.
    if (settings.grid && activeLayers.has("grid")) measurePerformance("chart.gpu.grid.ms", () => drawTimeGrid(this.batch, view, timeScale.marks(view)));

    if (to <= from) {
      measurePerformance("chart.gpu.flush.ms", () => this.flushCurrent(dpr));
      return;
    }

    const candleW = view.candleStripWidth();
    const cfg = this.cfg();
    const chartType = cfg.chartType;
    const lod = chartLodForSpacing(view.colWidth);

    if (activeLayers.has("candles")) {
      measurePerformance("chart.gpu.candles.ms", () => {
        if (lod === "pixel-bucket") {
          const buckets = buildPixelCandleBuckets(
            from, to,
            (index) => series.at(index),
            (index) => view.xOfIndex(index),
          );
          for (const bucket of buckets) this.drawPixelBucketCandle(view, bucket);
        } else {
          for (let i = from; i < to; i++) {
            const bar = series.at(i);
            if (!bar) continue;
            const xLeft = view.xOfIndex(i);
            const colW = view.colWidth;
            if (lod === "candlestick" || chartType === "candlestick") {
              this.drawFullCandle(view, bar, xLeft, colW);
            } else if ((chartType === "footprint" || chartType === "footprintProfile") && cfg.candles) {
              this.drawCandle(view, bar, xLeft, candleW);
            }
          }
        }
      });
    }

    if (lod === "footprint" && chartType === "footprint" && activeLayers.has("footprint")) {
      measurePerformance("chart.gpu.footprint.ms", () => {
        for (let i = from; i < to; i++) {
          const bar = series.at(i);
          if (!bar) continue;
          this.drawFootprintCells(view, bar, view.xOfIndex(i), view.colWidth, candleW, step);
        }
      });
    }

    if (lod === "footprint" && chartType === "footprintProfile" && activeLayers.has("footprint-profile")) {
      measurePerformance("chart.gpu.footprint-profile.ms", () => {
        for (let i = from; i < to; i++) {
          const bar = series.at(i);
          if (!bar) continue;
          this.drawProfile(view, bar, view.xOfIndex(i), view.colWidth, candleW, step);
        }
      });
    }

    measurePerformance("chart.gpu.flush.ms", () => this.flushCurrent(dpr));
  }

  private drawFootprintCells(
    view: View,
    bar: FootprintBar,
    xLeft: number,
    colW: number,
    candleW: number,
    step: number,
  ): void {
    const fpLeft = xLeft + candleW;
    const fpW = colW - candleW;
    const halfW = fpW / 2;
    const cfg = this.cfg();
    const { maxVol, pocBin } = this.heatStats(bar, step);
    if (maxVol <= 0) return;

    // Vertical LOD: at sub-pixel row heights, thousands of clamped 1px rects per column
    // is pure overdraw that reads as a solid block. Merge per screen pixel instead.
    // POC and imbalance are skipped there — a single row is not resolvable anyway.
    const rowHeight = this.rowHeight(view, step);
    if (rowHeight < CELL_PIXEL_MERGE_HEIGHT) {
      if (cfg.heat) this.drawMergedCells(view, bar, step, fpLeft, halfW);
      return;
    }

    const pTop = view.priceOfY(view.area.top);
    const pBot = view.priceOfY(view.area.top + view.area.height);
    const minVisPrice = Math.min(pTop, pBot) - step;
    const maxVisPrice = Math.max(pTop, pBot) + step;

    for (const cell of bar.cells.values()) {
      if (cell.priceBin + step < minVisPrice || cell.priceBin > maxVisPrice) continue;
      const rect = this.clippedCellRect(view, bar, cell.priceBin, step);
      if (!rect) continue;
      const { yTop, height: h } = rect;
      if (yTop > view.area.top + view.area.height || yTop + h < view.area.top) continue;

      if (cfg.poc && cell.priceBin === pocBin) this.batch.rect(fpLeft, yTop, fpW, h, POC);
      if (cfg.heat) {
        const sellA = 0.12 + 0.7 * (cell.sellVol / maxVol);
        const buyA = 0.12 + 0.7 * (cell.buyVol / maxVol);
        const rowH = h > 1 ? h - 1 : h;
        scratchColor.r = SELL.r; scratchColor.g = SELL.g; scratchColor.b = SELL.b; scratchColor.a = sellA;
        this.batch.rect(fpLeft, yTop, halfW, rowH, scratchColor);
        scratchColor.r = BUY.r; scratchColor.g = BUY.g; scratchColor.b = BUY.b; scratchColor.a = buyA;
        this.batch.rect(fpLeft + halfW, yTop, halfW, rowH, scratchColor);
      }
    }

    if (cfg.stackedImbalance) {
      this.drawStackedImbalance(view, bar, step, fpLeft, fpW, halfW);
    }
  }

  /** Representative price-row height in CSS pixels at the screen midpoint. */
  private rowHeight(view: View, step: number): number {
    const midPrice = view.priceOfY(view.area.top + view.area.height / 2);
    return Math.abs(view.yOfPrice(midPrice) - view.yOfPrice(midPrice + step));
  }

  /** Restrict one logical price bucket to the candle's actual traded high/low span. */
  private clippedCellRect(
    view: View,
    bar: FootprintBar,
    priceBin: number,
    step: number,
  ): { yTop: number; height: number } | null {
    let low = Math.max(priceBin, bar.low);
    let high = Math.min(priceBin + step, bar.high);
    if (!(high > low)) {
      // A single-price bar, or a high sitting exactly on this bin's lower edge, leaves no span to
      // clip to; the cell still holds traded volume, so it keeps its whole bucket row.
      if (!(priceBin <= bar.high && priceBin + step > bar.low)) return null;
      low = priceBin;
      high = priceBin + step;
    }
    const yHigh = view.yOfPrice(high);
    const yLow = view.yOfPrice(low);
    const yTop = Math.min(yHigh, yLow);
    const height = Math.abs(yLow - yHigh);
    if (!(height > 0)) return null;
    this.scratchCellRect.yTop = yTop;
    this.scratchCellRect.height = height;
    return this.scratchCellRect;
  }

  /** Clip an already pixel-merged row to the candle wick without changing its totals. */
  private clipPixelSpanToBar(
    view: View,
    bar: FootprintBar,
    yTop: number,
    height: number,
  ): { yTop: number; height: number } | null {
    const yHigh = view.yOfPrice(bar.high);
    const yLow = view.yOfPrice(bar.low);
    const barTop = Math.min(yHigh, yLow);
    // A single-price bar still spans its pixel row.
    const barBottom = Math.max(yHigh, yLow, barTop + 1);
    const top = Math.max(yTop, barTop);
    const bottom = Math.min(yTop + height, barBottom);
    if (!(bottom > top)) return null;
    this.scratchClipRect.yTop = top;
    this.scratchClipRect.height = bottom - top;
    return this.scratchClipRect;
  }

  /** Heat path for sub-pixel rows: one shaded rect per screen pixel. */
  private drawMergedCells(
    view: View,
    bar: FootprintBar,
    step: number,
    fpLeft: number,
    halfW: number,
  ): void {
    const buckets = buildPixelCellBuckets(bar.cells.values(), step, (price) => view.yOfPrice(price));
    // A merged row sums several cells, so scale against the busiest merged row rather
    // than the busiest single cell or every row would saturate.
    let mergedMax = 0;
    for (const bucket of buckets) {
      mergedMax = Math.max(mergedMax, bucket.buyVol, bucket.sellVol);
    }
    if (mergedMax <= 0) return;
    for (const bucket of buckets) {
      const rect = this.clipPixelSpanToBar(view, bar, bucket.yTop, bucket.height);
      if (!rect) continue;
      if (rect.yTop > view.area.top + view.area.height) continue;
      if (rect.yTop + rect.height < view.area.top) continue;
      scratchColor.r = SELL.r; scratchColor.g = SELL.g; scratchColor.b = SELL.b;
      scratchColor.a = 0.12 + 0.7 * (bucket.sellVol / mergedMax);
      this.batch.rect(fpLeft, rect.yTop, halfW, rect.height, scratchColor);
      scratchColor.r = BUY.r; scratchColor.g = BUY.g; scratchColor.b = BUY.b;
      scratchColor.a = 0.12 + 0.7 * (bucket.buyVol / mergedMax);
      this.batch.rect(fpLeft + halfW, rect.yTop, halfW, rect.height, scratchColor);
    }
  }


  /** Compute (and cache) the busiest-cell volume/POC bin for a bar. */
  private heatStats(bar: FootprintBar, step: number): { maxVol: number; pocBin: number } {
    const cached = this.heatCache.get(bar);
    if (cached && cached.cellRevision === (bar.cellRevision ?? 0) && cached.step === step) {
      return cached;
    }
    let maxVol = 0;
    let pocBin = 0;
    for (const cell of bar.cells.values()) {
      const v = cell.buyVol + cell.sellVol;
      if (v > maxVol) {
        maxVol = v;
        pocBin = cell.priceBin;
      }
    }
    const entry: BarHeatCache = { cellRevision: bar.cellRevision ?? 0, step, maxVol, pocBin };
    this.heatCache.set(bar, entry);
    return entry;
  }

  /**
   * Diagonal buy/sell imbalance with stacking. Buy imbalance: buyVol[P] >= ratio
   * * sellVol[P-step]. Sell imbalance: sellVol[P] >= ratio * buyVol[P+step]. A run
   * of >= IMB_STACK consecutive same-direction imbalances is highlighted with an
   * edge strip (buy = right/green, sell = left/red).
   */
  private drawStackedImbalance(
    view: View,
    bar: FootprintBar,
    step: number,
    fpLeft: number,
    fpW: number,
    halfW: number
  ): void {
    const cache = this.imbalanceStats(bar, step);
    if (!cache) return;
    this.markRuns(view, bar, cache.cells, step, cache.buyImb, fpLeft + fpW - 2, 2, IMB_BUY);
    this.markRuns(view, bar, cache.cells, step, cache.sellImb, fpLeft, 2, IMB_SELL);
    void halfW;
  }

  /** Compute (and cache) sorted cells + stacked imbalance flag arrays for a bar. */
  private imbalanceStats(bar: FootprintBar, step: number): BarImbalanceCache | null {
    const cached = this.imbalanceCache.get(bar);
    if (cached && cached.cellRevision === (bar.cellRevision ?? 0) && cached.step === step) {
      return cached.cells.length < IMB_STACK ? null : cached;
    }
    const cells = [...bar.cells.values()].sort((a, b) => a.priceBin - b.priceBin);
    const entry: BarImbalanceCache = {
      cellRevision: bar.cellRevision ?? 0,
      step,
      cells,
      buyImb: [],
      sellImb: [],
    };
    this.imbalanceCache.set(bar, entry);
    if (cells.length < IMB_STACK) return null;

    for (const c of cells) {
      // neighbourBin (not raw +/- step) -- fractional steps miss the quantized Map key on
      // ~20-30% of lookups with plain arithmetic, wrongly zeroing the neighbour and
      // producing spurious/mispositioned imbalance highlighting. See its doc comment.
      const below = bar.cells.get(neighbourBin(c.priceBin, step, -1));
      const above = bar.cells.get(neighbourBin(c.priceBin, step, 1));
      entry.buyImb.push(c.buyVol >= IMB_RATIO * (below ? below.sellVol : 0) && c.buyVol > 0);
      entry.sellImb.push(c.sellVol >= IMB_RATIO * (above ? above.buyVol : 0) && c.sellVol > 0);
    }
    return entry;
  }

  /** Highlight edge strips for runs of >= IMB_STACK consecutive flagged cells. */
  private markRuns(
    view: View,
    bar: FootprintBar,
    cells: { priceBin: number }[],
    step: number,
    flags: boolean[],
    x: number,
    w: number,
    color: RGBA
  ): void {
    const flushRun = (end: number, run: number): void => {
      if (run < IMB_STACK) return;
      for (let j = end - run; j < end; j++) {
        const rect = this.clippedCellRect(view, bar, cells[j].priceBin, step);
        if (!rect) continue;
        const rowH = rect.height > 1 ? rect.height - 1 : rect.height;
        this.batch.rect(x, rect.yTop, w, rowH, color);
      }
    };
    let run = 0;
    for (let k = 0; k < flags.length; k++) {
      if (!flags[k]) {
        flushRun(k, run);
        run = 0;
        continue;
      }
      // A price gap (no cell at the next level) ends a stack: the levels are not consecutive.
      if (run > 0 && cells[k].priceBin !== neighbourBin(cells[k - 1].priceBin, step, 1)) {
        flushRun(k, run);
        run = 0;
      }
      run++;
    }
    flushRun(flags.length, run);
  }

  /** Draw a mini candlestick (wick + body) within the left strip of a column. */
  private drawCandle(view: View, bar: FootprintBar, xLeft: number, candleW: number): void {
    const color = bar.close >= bar.open ? CANDLE_UP : CANDLE_DOWN;
    const cx = xLeft + candleW / 2;

    // wick: high -> low
    const yHigh = view.yOfPrice(bar.high);
    const yLow = view.yOfPrice(bar.low);
    this.batch.rect(cx - 0.5, yHigh, 1, Math.max(yLow - yHigh, 1), color);

    // body: open -> close
    const yOpen = view.yOfPrice(bar.open);
    const yClose = view.yOfPrice(bar.close);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(Math.abs(yClose - yOpen), 1);
    const bodyW = Math.max(candleW - 3, 2);
    this.batch.rect(cx - bodyW / 2, bodyTop, bodyW, bodyH, color);
  }

  /**
   * Draw a Footprint Profile bar: a horizontal volume histogram inside the
   * column (one bar per price level, length ∝ total volume, color = delta
   * sign). Candle geometry is owned by the separate candle semantic layer.
   */
  private drawProfile(
    view: View,
    bar: FootprintBar,
    xLeft: number,
    colW: number,
    candleW: number,
    step: number,
  ): void {
    const fpLeft = xLeft + candleW;
    const fpW = colW - candleW;
    const cfg = this.cfg();
    const mode = cfg.profileCellData;

    const { pocBin, maxMetric } = this.profileStats(bar, mode);

    if (maxMetric > 0 && fpW > 0) {
      const pTop = view.priceOfY(view.area.top);
      const pBot = view.priceOfY(view.area.top + view.area.height);
      const minVisPrice = Math.min(pTop, pBot) - step;
      const maxVisPrice = Math.max(pTop, pBot) + step;

      for (const cell of bar.cells.values()) {
        if (cell.priceBin + step < minVisPrice || cell.priceBin > maxVisPrice) continue;
        const rect = this.clippedCellRect(view, bar, cell.priceBin, step);
        if (!rect) continue;
        const { yTop, height: h } = rect;
        if (yTop > view.area.top + view.area.height || yTop + h < view.area.top) {
          continue; // off-screen vertically
        }

        // POC row highlight remains volume-based: it marks the busiest price row.
        if (cfg.poc && cell.priceBin === pocBin) {
          this.batch.rect(fpLeft, yTop, fpW, h, POC);
        }

        this.drawProfileCell(cell, yTop, h, fpLeft, fpW, mode, maxMetric);
      }
    }

  }

  /** Compute (and cache) the profile-mode peak scan for a bar, mirroring heatStats. */
  private profileStats(bar: FootprintBar, mode: FootprintCellData): BarProfileCache {
    const cached = this.profileCache.get(bar);
    if (cached && cached.cellRevision === (bar.cellRevision ?? 0) && cached.mode === mode) {
      return cached;
    }
    let maxVol = 0;
    let pocBin = 0;
    let maxMetric = mode === "deltaPct" ? 100 : 0;
    for (const cell of bar.cells.values()) {
      const volume = cellTotalVolume(cell);
      if (volume > maxVol) {
        maxVol = volume;
        pocBin = cell.priceBin;
      }
      maxMetric = Math.max(maxMetric, this.profileCellMagnitude(cell, mode));
    }
    const entry: BarProfileCache = { cellRevision: bar.cellRevision ?? 0, mode, maxVol, pocBin, maxMetric };
    this.profileCache.set(bar, entry);
    return entry;
  }

  private profileCellMagnitude(cell: FootprintCell, mode: FootprintCellData): number {
    const counts = cellTradeCounts(cell);
    switch (mode) {
      case "bidask":
        return Math.max(cell.sellVol, cell.buyVol);
      case "volume":
        return cellTotalVolume(cell);
      case "delta":
        return Math.abs(cellDelta(cell));
      case "deltaPct":
        return Math.min(100, Math.abs(cellDeltaPercent(cell)));
      case "count":
        return counts.total;
      case "countBidask":
        return Math.max(counts.sell, counts.buy);
      case "avgTradeSize":
        return cellAverageTradeSize(cell);
      case "avgTradeSizeBidask": {
        const averages = cellAverageTradeSizes(cell);
        return Math.max(averages.sell, averages.buy);
      }
      default: {
        const exhaustive: never = mode;
        return exhaustive;
      }
    }
  }

  private drawProfileCell(
    cell: FootprintCell,
    yTop: number,
    h: number,
    fpLeft: number,
    fpW: number,
    mode: FootprintCellData,
    maxMetric: number,
  ): void {
    const rowH = h > 1 ? h - 1 : h;
    const halfW = fpW / 2;
    const center = fpLeft + halfW;

    if (mode === "bidask" || mode === "countBidask" || mode === "avgTradeSizeBidask") {
      const counts = cellTradeCounts(cell);
      const averages = mode === "avgTradeSizeBidask" ? cellAverageTradeSizes(cell) : null;
      const sell = mode === "bidask" ? cell.sellVol : mode === "countBidask" ? counts.sell : averages?.sell ?? 0;
      const buy = mode === "bidask" ? cell.buyVol : mode === "countBidask" ? counts.buy : averages?.buy ?? 0;
      if (sell > 0) {
        const w = Math.max((sell / maxMetric) * halfW, 1);
        const a = 0.25 + 0.65 * (sell / maxMetric);
        this.batch.rect(center - w, yTop, w, rowH, withAlpha(SELL, a));
      }
      if (buy > 0) {
        const w = Math.max((buy / maxMetric) * halfW, 1);
        const a = 0.25 + 0.65 * (buy / maxMetric);
        this.batch.rect(center, yTop, w, rowH, withAlpha(BUY, a));
      }
      return;
    }

    if (mode === "delta" || mode === "deltaPct") {
      const value = mode === "delta" ? cellDelta(cell) : cellDeltaPercent(cell);
      const magnitude = Math.min(maxMetric, Math.abs(value));
      if (magnitude <= 0) return;
      const w = Math.max((magnitude / maxMetric) * halfW, 1);
      const color = value >= 0 ? BUY : SELL;
      const x = value >= 0 ? center : center - w;
      const a = 0.25 + 0.65 * (magnitude / maxMetric);
      this.batch.rect(x, yTop, w, rowH, withAlpha(color, a));
      return;
    }

    const value = this.profileCellMagnitude(cell, mode);
    if (value <= 0) return;
    const w = Math.max((value / maxMetric) * fpW, 1);
    const color = cellDelta(cell) >= 0 ? BUY : SELL;
    const a = 0.25 + 0.65 * (value / maxMetric);
    this.batch.rect(fpLeft, yTop, w, rowH, withAlpha(color, a));
  }


  /**
   * Draw a full-width candlestick centered in the whole column (plain
   * candlestick chart type, no footprint). Body fills ~70% of the column.
   */
  private drawFullCandle(view: View, bar: FootprintBar, xLeft: number, colW: number): void {
    const color = bar.close >= bar.open ? CANDLE_UP : CANDLE_DOWN;
    const cx = xLeft + colW / 2;

    // wick: high -> low
    const yHigh = view.yOfPrice(bar.high);
    const yLow = view.yOfPrice(bar.low);
    const wickW = Math.max(Math.min(colW * 0.12, 3), 1);
    this.batch.rect(cx - wickW / 2, yHigh, wickW, Math.max(yLow - yHigh, 1), color);

    // body: open -> close
    const yOpen = view.yOfPrice(bar.open);
    const yClose = view.yOfPrice(bar.close);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(Math.abs(yClose - yOpen), 1);
    const bodyW = Math.max(colW * 0.7, 1);
    this.batch.rect(cx - bodyW / 2, bodyTop, bodyW, bodyH, color);
  }

  private drawPixelBucketCandle(view: View, bar: OhlcBarLike & { x: number }): void {
    const color = bar.close >= bar.open ? CANDLE_UP : CANDLE_DOWN;
    const cx = bar.x + 0.5;
    const yHigh = view.yOfPrice(bar.high);
    const yLow = view.yOfPrice(bar.low);
    this.batch.rect(bar.x, yHigh, 1, Math.max(yLow - yHigh, 1), color);

    const yOpen = view.yOfPrice(bar.open);
    const yClose = view.yOfPrice(bar.close);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(Math.abs(yClose - yOpen), 1);
    this.batch.rect(cx - 0.5, bodyTop, 1, bodyH, color);
  }
}
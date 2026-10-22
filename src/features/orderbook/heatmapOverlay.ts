// Chart overlay that draws stored orderbook walls as a heatmap under the candles
// and a 5x5 hover table of bucket amounts around the cursor. BTCUSDT perp only.
import type { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type { Crosshair } from "../../core/render/overlay.js";
import {
  activeOrderbookHeatmapThreshold,
  isOrderbookHeatmapMarket,
  type OrderbookHeatmapSettings,
} from "../../core/orderbookHeatmap/settings.js";
import { isPerformanceTelemetryEnabled, recordPerformanceDuration } from "../../core/performanceTelemetry.js";
import { orderbookHeatmapSettingsSource } from "./heatmapSettingsSource.js";
import type { OrderbookHeatmapBar, OrderbookHeatmapRequest, OrderbookHeatmapResponse } from "./heatmapContracts.js";
import {
  HEATMAP_HOVER_SPAN,
  HEATMAP_WINDOW_MAX_BARS,
  formatHeatmapValue,
  heatmapCellUsd,
  heatmapChunkEnd,
  heatmapCellColor,
  heatmapChunksFor,
  heatmapIntensity,
  heatmapTierFor,
  heatmapValueInUnit,
  lastHeatmapSubBar,
  liveHeatmapSubBar,
  mergeHeatmapBars,
  type HeatmapTier,
} from "./heatmapModel.js";
import type { HeatmapGpuCellFrame } from "../chart/heatmap/gpu/heatmapGpuRenderer.js";

export type OrderbookHeatmapFetch = (
  request: OrderbookHeatmapRequest,
  signal?: AbortSignal,
) => Promise<OrderbookHeatmapResponse>;

/** How often the chunk holding "now" is refreshed; the backend fills the bar in progress from the current books. */
const LIVE_REFRESH_MS = 20_000;
/** How often a quiet chart is redrawn so a due live refresh goes out. */
const LIVE_TICK_MS = 5_000;
/** A failed chunk is retried after this long. */
const RETRY_MS = 30_000;
/** Chunk requests in flight at once. */
const MAX_PARALLEL_CHUNKS = 2;
const HOVER_DEBOUNCE_MS = 120;
const HOVER_CACHE_LIMIT = 40;
/**
 * Known CPU payload per prepared GPU cell (visible entry + main/extension
 * rect objects + their instance floats), charged against the per-chart
 * prototype budget. The GPU prepared lists are bounded BEFORE allocation:
 * larger frames stream the legacy annotation path instead of staging a
 * giant list the budgets cannot cover.
 */
const GPU_PREPARED_CELL_PAYLOAD_BYTES = 352;
const GPU_MAX_PREPARED_CELLS = Math.floor((32 * 1024 * 1024) / GPU_PREPARED_CELL_PAYLOAD_BYTES);
/**
 * Documented conservative upper bounds for the KNOWN logical payload the
 * production prepare allocates per cell, computed BEFORE any allocation:
 * - collection entry object {x, yTop, cellHeight, value, live} + array slot
 * - main rect object {x, yTop, width, height, value} + array slot
 * - extension rect object (adds sourceMainIndex) + array slot
 * - 7 Float32 instance attributes (7 * 4 bytes) per main/extension rect
 * These are logical per-component upper estimates for the objects the
 * prepare path itself creates, not physical heap or VRAM measurements.
 * Renderer-owned staging, GPU copies and retained replacement peaks stay
 * charged inside the renderer's own ledger and are never double-accounted
 * here. A main cell charges 128 + 128 + 28 = 284 bytes and an extension
 * 160 + 28 = 188 bytes, both below the legacy 352-byte per-cell charge.
 */
const PREPARED_ENTRY_PAYLOAD_BYTES = 128;
const PREPARED_MAIN_RECT_PAYLOAD_BYTES = 128;
const PREPARED_EXT_RECT_PAYLOAD_BYTES = 160;
const PREPARED_INSTANCE_PAYLOAD_BYTES = 7 * 4;

interface ChunkState {
  status: "loading" | "ready" | "error";
  /** When the chunk (or its live tail) was last fetched. */
  fetchedAt: number;
}

/** What `beginFrame` resolves for an active frame: settings, tier, threshold and the visible bar window. */
interface HeatmapFramePreamble {
  settings: OrderbookHeatmapSettings;
  tier: HeatmapTier;
  threshold: number;
  first: number;
  last: number;
}

interface HoverWindow {
  status: "loading" | "ready" | "error";
  bars: Map<number, OrderbookHeatmapBar>;
}

export interface OrderbookHeatmapOverlayOptions {
  fetch: OrderbookHeatmapFetch;
  invalidate: () => void;
  /** The chart's current market; the overlay only draws on the BTCUSDT perp chart. */
  getMarket: () => string;
  now?: () => number;
}

export class OrderbookHeatmapOverlay {
  private readonly fetchHeatmap: OrderbookHeatmapFetch;
  private readonly invalidate: () => void;
  private readonly now: () => number;
  private readonly getMarket: () => string;
  /** Identifies what the cached bars were fetched for; any change drops the cache. */
  private dataKey = "";
  private bars = new Map<number, OrderbookHeatmapBar>();
  private chunks = new Map<number, ChunkState>();
  private inFlight = new Set<AbortController>();
  private hoverWindows = new Map<string, HoverWindow>();
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingHoverKey = "";
  /** Largest value drawn on the last frame; the hover table shades against it like the chart does. */
  private visibleCeiling = 0;
  private readonly liveTimer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;

  constructor(options: OrderbookHeatmapOverlayOptions) {
    this.fetchHeatmap = options.fetch;
    this.invalidate = options.invalidate;
    this.getMarket = options.getMarket;
    this.now = options.now ?? Date.now;
    this.unsubscribe = orderbookHeatmapSettingsSource().onChange(() => this.invalidate());
    // Redraws pull the live tail; this keeps it moving on a quiet chart.
    this.liveTimer = setInterval(() => {
      if (this.active()) this.invalidate();
    }, LIVE_TICK_MS);
  }

  /** Shared settings with the mode saved for the chart's current pair. */
  private get settings(): OrderbookHeatmapSettings {
    return orderbookHeatmapSettingsSource().settingsFor(this.getMarket());
  }

  dispose(): void {
    clearInterval(this.liveTimer);
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.unsubscribe();
    this.reset("");
  }

  private active(): boolean {
    return this.settings.mode !== "off" && isOrderbookHeatmapMarket(this.getMarket());
  }

  private reset(key: string): void {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.dataKey = key;
    this.bars = new Map();
    this.chunks = new Map();
    this.hoverWindows = new Map();
    // Dropping the data identity also releases the owned same-frame visible list.
    this.lastCollectedKey = "";
    this.lastCollected = null;
  }

  private baseRequest(tier: HeatmapTier): Pick<OrderbookHeatmapRequest, "source" | "resolution" | "bucketStep"> {
    return {
      source: this.settings.mode === "single" ? "single" : "aggregated",
      resolution: tier.name,
      bucketStep: this.settings.bucketStep,
    };
  }

  private thresholdParams(): Pick<OrderbookHeatmapRequest, "minUsd" | "minBtc"> {
    const threshold = activeOrderbookHeatmapThreshold(this.settings);
    return this.settings.unit === "btc" ? { minBtc: threshold } : { minUsd: threshold };
  }

  /** Draws cells for the visible bars and requests any chunk they still need. */
  draw(ctx: CanvasRenderingContext2D, view: View, series: FootprintSeries, range: [number, number]): void {
    const frame = this.beginFrame(series, range);
    if (!frame) return;
    // Streaming CPU path: two passes (ceiling, then paint) with an O(1)-held
    // payload. It never builds or reuses the whole-visible collection list.
    let cells = 0;
    const ceiling = this.forEachVisibleCell(view, series, frame, null, () => { cells++; });
    this.visibleCeiling = ceiling;
    this.visibleThreshold = frame.threshold;
    if (cells === 0) return;
    const { left, top, width, height } = view.area;
    const right = left + width;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();
    this.forEachVisibleCell(view, series, frame, null, ({ x, yTop, cellHeight, value, live }) => {
      const intensity = heatmapIntensity(value, this.visibleThreshold, this.visibleCeiling);
      ctx.fillStyle = heatmapCellColor(intensity);
      ctx.fillRect(x, yTop, Math.max(1, view.colWidth), cellHeight);
      // The live bar's walls continue across the empty space right of the last candle.
      if (live && x + view.colWidth < right) {
        ctx.fillStyle = heatmapCellColor(intensity, 0.45);
        ctx.fillRect(x + view.colWidth, yTop, right - x - view.colWidth, cellHeight);
      }
    });
    ctx.restore();
  }

  /**
   * Shared frame preamble for the streaming draw and the bounded collection:
   * activity check, tier/settings/threshold resolution, data-key reset, the
   * visible bar window and chunk scheduling. Returns null when nothing can
   * be drawn.
   */
  private beginFrame(
    series: FootprintSeries,
    range: [number, number],
  ): HeatmapFramePreamble | null {
    if (!this.active() || series.length === 0) return null;
    const tier = heatmapTierFor(series.config.intervalMs);
    const settings = this.settings;
    const threshold = activeOrderbookHeatmapThreshold(settings);
    const key = `${settings.mode}|${tier.name}|${settings.bucketStep}|${settings.unit}:${threshold}`;
    if (key !== this.dataKey) this.reset(key);
    const first = Math.max(0, Math.floor(range[0]));
    const last = Math.min(series.length - 1, Math.ceil(range[1]));
    if (last < first) return null;
    // Chunk scheduling runs every frame so a quiet chart still honors the
    // live-refresh TTL and error retries.
    this.ensureChunks(series.timeOfIndex(first), series.timeOfIndex(last + 1) - 1, tier);
    return { settings, tier, threshold, first, last };
  }

  /**
   * Streams the visible density cells through `visit` without retaining a
   * whole-visible list; only the transient per-cell object exists. Returns
   * the visible ceiling. With `cellLimit` the scan stops as soon as the
   * limit is reached (bounded known payload before any list allocation).
   */
  private forEachVisibleCell(
    view: View,
    series: FootprintSeries,
    frame: { settings: OrderbookHeatmapSettings; tier: HeatmapTier; first: number; last: number },
    cellLimit: number | null,
    visit: (cell: { x: number; yTop: number; cellHeight: number; value: number; live: boolean }) => void,
  ): number {
    const step = frame.settings.bucketStep;
    const { top, height } = view.area;
    let ceiling = 0;
    let emitted = 0;
    for (let index = frame.first; index <= frame.last; index++) {
      const live = index === series.length - 1;
      const bar = (live ? liveHeatmapSubBar : lastHeatmapSubBar)(
        this.bars, series.timeOfIndex(index), series.timeOfIndex(index + 1), frame.tier);
      if (!bar || bar.cells.length === 0) continue;
      const x = view.xOfIndex(index);
      for (const cell of bar.cells) {
        const yTop = view.yOfPrice(cell[0] + step);
        const yBottom = view.yOfPrice(cell[0]);
        if (yBottom < top || yTop > top + height) continue;
        const value = heatmapValueInUnit(heatmapCellUsd(cell), cell[0], step, frame.settings.unit);
        if (value > ceiling) ceiling = value;
        if (cellLimit !== null && emitted >= cellLimit) return ceiling;
        visit({ x, yTop, cellHeight: Math.max(1, yBottom - yTop), value, live });
        emitted++;
      }
    }
    return ceiling;
  }
  /**
   * CPU prepare for the private GPU density prototype: the exact cells, values
   * and ceiling the canvas path would draw, as GPU instance geometry (main
   * columns plus the live bar's extension). No new fetch: it reuses the same
   * acknowledged cache and chunk scheduling as `draw`.
   *
   * Legacy three-argument form (no `reserve`): bounded collection first and
   * no lease; the renderer charges the prepared lists transiently around its
   * draw. Production four-argument form: a primitive precount (O(1) held
   * payload, no collected list, no emitted cell objects) runs BEFORE the
   * single reservation; a denial returns null without building any prepared
   * payload or cache allocation, and the returned frame carries the lease
   * until its owner drops the last reference.
   *
   * With performance telemetry enabled, the production form records its time
   * as `chart.gpu.heatmap.prepare.ms`; the legacy form is not timed.
   */
  prepareGpuCells(
    view: View,
    series: FootprintSeries,
    range: [number, number],
    reserve?: (logicalBytes: number) => { release(): void } | null,
  ): HeatmapGpuCellFrame | null {
    if (!reserve) {
      const visible = this.collectVisibleCells(view, series, range, GPU_MAX_PREPARED_CELLS);
      // Bounded known-payload prepare: a frame at or past the cap (or an
      // incomplete bounded collection) streams the legacy annotation path
      // instead of staging GPU lists the budgets cannot cover.
      if (!visible || visible.length >= GPU_MAX_PREPARED_CELLS) return null;
      return this.buildGpuFrame(visible, view);
    }
    const preamble = this.beginFrame(series, range);
    if (!preamble) return null;
    // Timed once the heatmap is active: an inactive chart records nothing, while
    // a frame that ends at the cell cap or in a denied reservation did pay for
    // its precount and is recorded. No closure, so the frame path allocates
    // nothing extra; disabled telemetry costs one flag read.
    const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
    try {
      return this.prepareReservedGpuCells(preamble, view, series, range, reserve);
    } finally {
      if (startedAt !== null) recordPerformanceDuration("chart.gpu.heatmap.prepare.ms", performance.now() - startedAt);
    }
  }

  /** The production (reserved) prepare after the shared frame preamble; see `prepareGpuCells`. */
  private prepareReservedGpuCells(
    preamble: HeatmapFramePreamble,
    view: View,
    series: FootprintSeries,
    range: [number, number],
    reserve: (logicalBytes: number) => { release(): void } | null,
  ): HeatmapGpuCellFrame | null {
    const right = view.area.left + view.area.width;
    const { top, height } = view.area;
    const step = preamble.settings.bucketStep;
    // Primitive precount only: no list allocation, no emitted cell objects,
    // identical visibility/live/extension predicates as the real scan below.
    let mainCount = 0;
    let extCount = 0;
    let ceiling = 0;
    for (let index = preamble.first; index <= preamble.last; index++) {
      const live = index === series.length - 1;
      const bar = (live ? liveHeatmapSubBar : lastHeatmapSubBar)(
        this.bars, series.timeOfIndex(index), series.timeOfIndex(index + 1), preamble.tier);
      if (!bar || bar.cells.length === 0) continue;
      const x = view.xOfIndex(index);
      for (const cell of bar.cells) {
        const yTop = view.yOfPrice(cell[0] + step);
        const yBottom = view.yOfPrice(cell[0]);
        if (yBottom < top || yTop > top + height) continue;
        const value = heatmapValueInUnit(heatmapCellUsd(cell), cell[0], step, preamble.settings.unit);
        if (value > ceiling) ceiling = value;
        mainCount++;
        if (live && x + view.colWidth < right) extCount++;
      }
    }
    this.visibleCeiling = ceiling;
    this.visibleThreshold = preamble.threshold;
    if (mainCount === 0) {
      // Successful empty frame (e.g. acknowledged empty books): nothing is
      // allocated, so no reservation is taken.
      return {
        main: [],
        extension: [],
        ceiling,
        threshold: preamble.threshold,
        dataKey: this.dataKey,
      };
    }
    if (mainCount >= GPU_MAX_PREPARED_CELLS) return null;
    const logicalBytes = mainCount * (PREPARED_ENTRY_PAYLOAD_BYTES + PREPARED_MAIN_RECT_PAYLOAD_BYTES
      + PREPARED_INSTANCE_PAYLOAD_BYTES)
      + extCount * (PREPARED_EXT_RECT_PAYLOAD_BYTES + PREPARED_INSTANCE_PAYLOAD_BYTES);
    if (!Number.isSafeInteger(logicalBytes) || logicalBytes <= 0) return null;
    const lease = reserve(logicalBytes);
    if (!lease) return null;
    // Reserved: build the exact same geometry/values the legacy path builds.
    // The lease is adopted onto the returned frame only; a throw from the
    // bounded collection or the frame build after the grant must drop the
    // owned references and release the idempotent lease exactly once,
    // rethrowing the original error instead of leaking the reservation.
    try {
      const visible = this.collectVisibleCells(view, series, range, GPU_MAX_PREPARED_CELLS);
      if (!visible || visible.length !== mainCount || visible.length >= GPU_MAX_PREPARED_CELLS) {
        lease.release();
        return null;
      }
      const frame = this.buildGpuFrame(visible, view);
      frame.preparedLease = lease;
      return frame;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  /** Builds the GPU instance frame from an already collected visible list. */
  private buildGpuFrame(
    visible: Array<{ x: number; yTop: number; cellHeight: number; value: number; live: boolean }>,
    view: View,
  ): HeatmapGpuCellFrame {
    const right = view.area.left + view.area.width;
    const mainWidth = Math.max(1, view.colWidth);
    const main: HeatmapGpuCellFrame["main"] = [];
    const extension: HeatmapGpuCellFrame["extension"] = [];
    for (const cell of visible) {
      // Explicit source index: the extension repaints its own main cell's
      // scalar into its own EXT texel; MAIN scalars are never overwritten.
      const sourceMainIndex = main.length;
      main.push({ x: cell.x, yTop: cell.yTop, width: mainWidth, height: cell.cellHeight, value: cell.value });
      if (cell.live && cell.x + view.colWidth < right) {
        extension.push({
          x: cell.x + view.colWidth,
          yTop: cell.yTop,
          width: right - cell.x - view.colWidth,
          height: cell.cellHeight,
          value: cell.value,
          sourceMainIndex,
        });
      }
    }
    return {
      main,
      extension,
      ceiling: this.visibleCeiling,
      threshold: this.visibleThreshold,
      dataKey: this.dataKey,
    };
  }

  /** Identifies what the cached bars were fetched for; used for GPU/annotation frame agreement. */
  currentDataKey(): string {
    return this.dataKey;
  }

  /** Threshold of the last collected frame; 0 before the first draw/prepare. */
  private visibleThreshold = 0;
  /** Bumped whenever acknowledged book data merges; part of the collection memo key. */
  private barsRevision = 0;
  /** Same-frame collection memo: one visible list per frame shared by the GPU prepare and the legacy draw. */
  private lastCollectedKey = "";
  private lastCollected: Array<{ x: number; yTop: number; cellHeight: number; value: number; live: boolean }> | null = null;

  /** Collects the visible density cells and refreshes chunk requests/ceiling. */
  private collectVisibleCells(
    view: View,
    series: FootprintSeries,
    range: [number, number],
    cellLimit: number | null = null,
  ): Array<{ x: number; yTop: number; cellHeight: number; value: number; live: boolean }> | null {
    const frame = this.beginFrame(series, range);
    if (!frame) return null;
    // Same-frame memo: only the unbounded legacy collection is memoized; a
    // bounded request is always a fresh pure scan, so the cap applies even
    // after a previous unbounded collection in the same frame.
    // The memo key includes the full price projection (priceTop/pricePerPx/
    // scaleMode): a Y pan, price zoom or scale-mode flip must not reuse the
    // previous frame's cell rows.
    const collectKey = `${this.dataKey}|${this.barsRevision}|${series.length}|${frame.first}|${frame.last}|${view.colWidth}|${view.offsetX}|${view.area.left}|${view.area.top}|${view.area.width}|${view.area.height}|${view.priceTop}|${view.pricePerPx}|${view.priceScaleMode}`;
    if (cellLimit === null && this.lastCollectedKey === collectKey && this.lastCollected) return this.lastCollected;
    const visible: Array<{ x: number; yTop: number; cellHeight: number; value: number; live: boolean }> = [];
    const ceiling = this.forEachVisibleCell(view, series, frame, cellLimit, (cell) => visible.push(cell));
    this.visibleCeiling = ceiling;
    this.visibleThreshold = frame.threshold;
    if (cellLimit === null) {
      this.lastCollectedKey = collectKey;
      this.lastCollected = visible;
    }
    return visible;
  }
  private ensureChunks(from: number, to: number, tier: HeatmapTier): void {
    const now = this.now();
    const key = this.dataKey;
    for (const chunkStart of heatmapChunksFor(from, Math.min(to, now), tier)) {
      const chunkEnd = heatmapChunkEnd(chunkStart, tier);
      const state = this.chunks.get(chunkStart);
      const live = now <= chunkEnd + tier.periodMs;
      if (state?.status === "loading") continue;
      if (state?.status === "error" && now - state.fetchedAt < RETRY_MS) continue;
      if (state?.status === "ready" && (!live || now - state.fetchedAt < LIVE_REFRESH_MS)) continue;
      if (this.inFlight.size >= MAX_PARALLEL_CHUNKS) return;
      // A live chunk that is already loaded only re-reads its last few bars.
      const refreshFrom = state?.status === "ready"
        ? Math.max(chunkStart, Math.floor(now / tier.periodMs) * tier.periodMs - 2 * tier.periodMs)
        : chunkStart;
      this.chunks.set(chunkStart, { status: "loading", fetchedAt: state?.fetchedAt ?? 0 });
      const controller = new AbortController();
      this.inFlight.add(controller);
      this.fetchHeatmap({
        ...this.baseRequest(tier),
        ...this.thresholdParams(),
        from: refreshFrom,
        to: chunkEnd,
      }, controller.signal).then((response) => {
        if (key !== this.dataKey || controller.signal.aborted) return;
        mergeHeatmapBars(this.bars, response.bars);
        this.barsRevision++;
        this.chunks.set(chunkStart, { status: "ready", fetchedAt: this.now() });
        this.invalidate();
      }, () => {
        if (key !== this.dataKey || controller.signal.aborted) return;
        this.chunks.set(chunkStart, { status: state?.status === "ready" ? "ready" : "error", fetchedAt: this.now() });
      }).finally(() => {
        this.inFlight.delete(controller);
      });
    }
  }

  /** Draws the hover table: bid+ask per bucket around the cursor, colored or not. */
  drawHover(ctx: CanvasRenderingContext2D, view: View, series: FootprintSeries, crosshair: Crosshair): void {
    if (!this.active() || !crosshair.visible || series.length === 0) return;
    const { left, top, width, height } = view.area;
    if (crosshair.x < left || crosshair.x > left + width || crosshair.y < top || crosshair.y > top + height) return;
    const tier = heatmapTierFor(series.config.intervalMs);
    const settings = this.settings;
    const step = settings.bucketStep;
    const center = Math.floor(view.indexOfX(crosshair.x));
    if (center < 0 || center > series.length - 1) return;
    const bucket = Math.floor(view.priceOfY(crosshair.y) / step) * step;
    if (!(bucket > 0)) return;
    const half = Math.floor(HEATMAP_HOVER_SPAN / 2);
    const columns = Array.from({ length: HEATMAP_HOVER_SPAN }, (_, offset) => center - half + offset)
      .filter((index) => index >= 0 && index <= series.length - 1);
    const rows = Array.from({ length: HEATMAP_HOVER_SPAN }, (_, offset) => bucket + (half - offset) * step);
    const windowFrom = series.timeOfIndex(columns[0]);
    const windowTo = series.timeOfIndex(columns[columns.length - 1] + 1);
    // The live bar's book keeps changing, so a window over it expires with each live refresh.
    const liveSlot = columns[columns.length - 1] === series.length - 1 ? Math.floor(this.now() / LIVE_REFRESH_MS) : 0;
    const hoverKey = `${this.dataKey}|${windowFrom}|${windowTo}|${bucket}|${liveSlot}`;
    const hover = this.hoverWindows.get(hoverKey);
    if (!hover) this.scheduleHover(hoverKey, series, columns, rows, tier);

    const threshold = activeOrderbookHeatmapThreshold(settings);
    const values = rows.map((price) => columns.map((index) => {
      if (hover?.status !== "ready") return null;
      const bar = (index === series.length - 1 ? liveHeatmapSubBar : lastHeatmapSubBar)(
        hover.bars, series.timeOfIndex(index), series.timeOfIndex(index + 1), tier);
      const cell = bar?.cells.find((candidate) => candidate[0] === price);
      return heatmapValueInUnit(cell ? heatmapCellUsd(cell) : 0, price, step, settings.unit);
    }));
    drawHoverTable(ctx, view, crosshair, {
      rows,
      values,
      centerColumn: columns.indexOf(center),
      centerRow: half,
      threshold,
      ceiling: this.visibleCeiling,
      unit: settings.unit,
      failed: hover?.status === "error",
    });
  }

  private scheduleHover(
    hoverKey: string,
    series: FootprintSeries,
    columns: number[],
    rows: number[],
    tier: HeatmapTier,
  ): void {
    if (this.pendingHoverKey === hoverKey) return;
    this.pendingHoverKey = hoverKey;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    const ranges = hoverRanges(series, columns, tier);
    const step = this.settings.bucketStep;
    const priceFrom = rows[rows.length - 1];
    const priceTo = rows[0] + step - 1;
    const base = this.baseRequest(tier);
    const key = this.dataKey;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      const hover: HoverWindow = { status: "loading", bars: new Map() };
      this.rememberHover(hoverKey, hover);
      Promise.all(ranges.map(([from, to]) => this.fetchHeatmap({ ...base, from, to, priceFrom, priceTo })))
        .then((responses) => {
          for (const response of responses) mergeHeatmapBars(hover.bars, response.bars);
          hover.status = "ready";
        }, () => {
          hover.status = "error";
        })
        .finally(() => {
          if (this.pendingHoverKey === hoverKey) this.pendingHoverKey = "";
          if (key === this.dataKey) this.invalidate();
        });
    }, HOVER_DEBOUNCE_MS);
  }

  private rememberHover(key: string, hover: HoverWindow): void {
    this.hoverWindows.set(key, hover);
    while (this.hoverWindows.size > HOVER_CACHE_LIMIT) {
      const oldest = this.hoverWindows.keys().next().value;
      if (oldest === undefined) break;
      this.hoverWindows.delete(oldest);
    }
  }
}

/**
 * Tier-bar ranges for the hover columns: one request when they fit the
 * backend's unthresholded bar cap, else one per chart bar (e.g. monthly bars).
 */
function hoverRanges(series: FootprintSeries, columns: number[], tier: HeatmapTier): Array<[number, number]> {
  const from = series.timeOfIndex(columns[0]);
  const to = series.timeOfIndex(columns[columns.length - 1] + 1) - 1;
  if ((to - from) / tier.periodMs < HEATMAP_WINDOW_MAX_BARS) return [[from, to]];
  return columns.map((index) => [series.timeOfIndex(index), series.timeOfIndex(index + 1) - 1]);
}

interface HoverTable {
  rows: number[];
  values: Array<Array<number | null>>;
  centerColumn: number;
  centerRow: number;
  threshold: number;
  ceiling: number;
  unit: "usd" | "btc";
  failed: boolean;
}

const HOVER_CELL_W = 62;
const HOVER_PRICE_W = 70;
const HOVER_ROW_H = 20;
const HOVER_OFFSET = 18;

function drawHoverTable(ctx: CanvasRenderingContext2D, view: View, crosshair: Crosshair, table: HoverTable): void {
  const columns = table.values[0]?.length ?? 0;
  const tableW = columns * HOVER_CELL_W + HOVER_PRICE_W;
  const tableH = table.rows.length * HOVER_ROW_H;
  const { left, top, width, height } = view.area;
  let x = crosshair.x + HOVER_OFFSET;
  if (x + tableW > left + width) x = crosshair.x - HOVER_OFFSET - tableW;
  let y = crosshair.y + HOVER_OFFSET;
  if (y + tableH > top + height) y = crosshair.y - HOVER_OFFSET - tableH;
  x = Math.max(left, x);
  y = Math.max(top, y);

  ctx.save();
  ctx.fillStyle = "rgba(11, 16, 24, 0.95)";
  ctx.strokeStyle = "rgba(148, 163, 184, 0.28)";
  ctx.lineWidth = 1;
  if (typeof ctx.roundRect === "function" && typeof ctx.fill === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, tableW, tableH, 6);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, Math.max(0, tableW - 1), Math.max(0, tableH - 1), 5.5);
    ctx.stroke();
  } else {
    ctx.fillRect(x, y, tableW, tableH);
    ctx.strokeRect(x + 0.5, y + 0.5, tableW - 1, tableH - 1);
  }
  const priceColX = x + columns * HOVER_CELL_W;
  ctx.strokeStyle = "rgba(148, 163, 184, 0.18)";
  ctx.beginPath();
  ctx.moveTo(priceColX + 0.5, y + 1);
  ctx.lineTo(priceColX + 0.5, y + tableH - 1);
  ctx.stroke();
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  table.rows.forEach((price, row) => {
    const rowY = y + row * HOVER_ROW_H;
    table.values[row].forEach((value, column) => {
      const cellX = x + column * HOVER_CELL_W;
      if (value !== null && table.threshold > 0 && value >= table.threshold) {
        ctx.fillStyle = heatmapCellColor(heatmapIntensity(value, table.threshold, Math.max(table.ceiling, value)));
        ctx.fillRect(cellX + 1, rowY + 1, HOVER_CELL_W - 2, HOVER_ROW_H - 2);
      }
      if (row === table.centerRow && column === table.centerColumn) {
        ctx.strokeStyle = "rgba(56, 189, 248, 0.92)";
        ctx.strokeRect(cellX + 1.5, rowY + 1.5, HOVER_CELL_W - 3, HOVER_ROW_H - 3);
      }
      ctx.fillStyle = "#eef2fb";
      const text = value === null ? (table.failed ? "–" : "…") : formatHeatmapValue(value, table.unit);
      ctx.fillText(text, cellX + HOVER_CELL_W / 2, rowY + HOVER_ROW_H / 2);
    });
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(price.toFixed(1), priceColX + HOVER_PRICE_W / 2, rowY + HOVER_ROW_H / 2);
  });
  ctx.restore();
}

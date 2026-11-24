// Chart overlay that draws stored orderbook walls as a heatmap under the candles
// and a 5x5 hover table of bucket amounts around the cursor. BTCUSDT perp only.
import type { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type { Crosshair } from "../../core/render/overlay.js";
import { parseMarket } from "../../core/domain/market.js";
import {
  activeOrderbookHeatmapThreshold,
  isOrderbookHeatmapMarket,
  normalizeOrderbookHeatmapSources,
  resolveOrderbookHeatmapOpacity,
  resolveOrderbookHeatmapPalette,
  type OrderbookHeatmapPalette,
  type OrderbookHeatmapSettings,
  type OrderbookHeatmapUnit,
} from "../../core/orderbookHeatmap/settings.js";
import {
  incrementPerformanceCounter,
  isPerformanceTelemetryEnabled,
  recordPerformanceDuration,
} from "../../core/performanceTelemetry.js";
import { orderbookHeatmapSettingsSource } from "./heatmapSettingsSource.js";
import type {
  CanonicalHeatmapTailBar,
  LiveHeatmapTailEvent,
  LiveHeatmapTailRequest,
  OrderbookHeatmapBar,
  OrderbookHeatmapCell,
  OrderbookHeatmapRequest,
  OrderbookHeatmapResponse,
  OrderbookHeatmapRuntimeStatus,
} from "./heatmapContracts.js";
import {
  HEATMAP_HOVER_SPAN,
  HEATMAP_MIN_CEILING_RATIO,
  HEATMAP_WINDOW_MAX_BARS,
  blendPackedRgbaOver,
  formatHeatmapValue,
  getHeatmapColorLut,
  getHeatmapPackedRgbaLut,
  getHeatmapThresholdSparseBar,
  heatmapCellUsd,
  heatmapChunkEnd,
  heatmapChunkStart,
  heatmapCellColor,
  heatmapChunksFor,
  heatmapIntensity,
  heatmapTierFor,
  heatmapValueInUnit,
  lastHeatmapSubBar,
  liveHeatmapSubBar,
  mergeHeatmapBars,
  mergeHeatmapBarsWithDiff,
  projectCanonicalHeatmapTailBar,
  resolveHeatmapColorRange,
  resolveHeatmapColorRangeFromTwoSorted,
  visibleHeatmapCellBounds,
  type HeatmapTier,
} from "./heatmapModel.js";
import type { HeatmapGpuCellFrame } from "../chart/heatmap/gpu/heatmapGpuRenderer.js";
import type { GpuNativeHeatmapResidentCell, GpuNativeHeatmapResidentFrame } from "../../core/gpu/gpuBackend.js";

export type { LiveHeatmapTailEvent, LiveHeatmapTailRequest, OrderbookHeatmapRuntimeStatus } from "./heatmapContracts.js";

export type OrderbookHeatmapFetch = (
  request: OrderbookHeatmapRequest,
  signal?: AbortSignal,
) => Promise<OrderbookHeatmapResponse>;

export interface OrderbookHeatmapCoverage {
  requestedSources: string[];
  observedSources: string[];
  missingSources: string[];
}

/** Maximum RGBA byte footprint for a single chart's CPU heatmap offscreen raster cache (32 MiB). */
export const HEATMAP_CPU_RASTER_CHART_BUDGET_BYTES = 32 * 1024 * 1024;
/** Maximum combined RGBA byte footprint across all concurrent CPU heatmap raster caches (128 MiB). */
export const HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES = 128 * 1024 * 1024;

/** Rebuild once after a viewport has been quiet for 150 ms; motion paints directly. */
export const HEATMAP_CPU_RASTER_QUIET_MS = 150;

let moduleCpuRasterReservedBytes = 0;
let nextSeriesIdentityId = 1;
const seriesIdentityIds = new WeakMap<object, number>();

function seriesIdentityId(series: object): number {
  let id = seriesIdentityIds.get(series);
  if (id === undefined) {
    id = nextSeriesIdentityId++;
    seriesIdentityIds.set(series, id);
  }
  return id;
}

/** Computes RGBA8 backing-store byte size (`width * height * 4`) for valid positive dimensions. */
export function heatmapRasterByteSize(width: number, height: number): number | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  const bytes = width * height * 4;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
  return bytes;
}

/** Returns total RGBA bytes currently reserved across all active CPU heatmap offscreen raster caches. */
export function getHeatmapCpuRasterModuleReservedBytes(): number {
  return moduleCpuRasterReservedBytes;
}

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
/** Maximum number of live-pushed 1m tail bars retained outside visible history. */
const MAX_LIVE_TAIL_BARS = 1_000;
/** Maximum total cell records retained across live-pushed tail bars before evicting oldest non-visible bars. */
const MAX_LIVE_TAIL_CELLS = 250_000;
/** Bounded live tail invalidation coalescing window (ms). */
const DEFAULT_LIVE_DEBOUNCE_MS = 200;
/** Timeout after which an idle/silent live-tail subscription falls back to timer refreshes (ms). */
const LIVE_TAIL_IDLE_FALLBACK_MS = 90_000;

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
const PREPARED_INSTANCE_PAYLOAD_BYTES = 7 * 4;

interface ChunkState {
  status: "loading" | "ready" | "error";
  /** When the chunk (or its live tail) was last fetched. */
  fetchedAt: number;
  /** Minimum value requested from the backend for the tail or full chunk. */
  threshold: number;
  /** The unit for `threshold`. */
  unit: OrderbookHeatmapUnit;
  /** Minimum value requested for full-chunk coverage (from chunkStart). */
  fullThreshold: number;
  /** The unit for `fullThreshold`. */
  fullUnit: OrderbookHeatmapUnit;
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

interface HoverRangeRequest {
  key: string;
  controller: AbortController;
  promise: Promise<OrderbookHeatmapResponse>;
  consumers: Set<string>;
}

export interface OrderbookHeatmapOverlayOptions {
  fetch: OrderbookHeatmapFetch;
  invalidate: () => void;
  /** The chart's current market; the overlay only draws on the BTCUSDT perp chart. */
  getMarket: () => string;
  /** Optional stable panel identifier for panel-scoped heatmap settings and live-tail routing. */
  getPanelId?: () => string | undefined;
  /** Reads replay state from the owning chart coordinator so the live tail stays out of replay. */
  isReplayActive?: () => boolean;
  now?: () => number;
  /**
   * Optional live-tail invalidation or push subscription.
   * Transport-agnostic: frontend WS service or data pipeline delivers events.
   * Returns an unsubscribe function.
   */
  subscribeLiveTail?: (
    listener: (event?: LiveHeatmapTailEvent) => void,
    request?: LiveHeatmapTailRequest,
  ) => () => void;
  /** Bounded coalescing / debounce for live tail invalidations (default 200ms). */
  liveDebounceMs?: number;
}

export class OrderbookHeatmapOverlay {
  private static readonly MAX_CACHED_CHUNKS = 12;
  private static readonly MAX_EMPTY_CHUNK_KEYS = 64;
  private readonly fetchHeatmap: OrderbookHeatmapFetch;
  private readonly invalidate: () => void;
  private readonly now: () => number;
  private readonly getMarket: () => string;
  private readonly getPanelId?: () => string | undefined;
  private readonly isReplayActive: () => boolean;
  private readonly subscribeLiveTail?: (
    listener: (event?: LiveHeatmapTailEvent) => void,
    request?: LiveHeatmapTailRequest,
  ) => () => void;
  private readonly liveDebounceMs: number;
  private unsubscribeLiveTail: (() => void) | null = null;
  private liveTailRequestKey = "";
  private liveTailGeneration = 0;
  private disposed = false;
  private lastMarket = "";
  private liveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLiveEventAt = 0;
  private currentTier: HeatmapTier | null = null;
  private lastVisibleFromMs = 0;
  private lastVisibleToMs = 0;

  /** Identifies what the cached bars were fetched for; any change drops the cache. */
  private dataKey = "";
  private bars = new Map<number, OrderbookHeatmapBar>();
  private liveBarTimes = new Set<number>();
  private canonicalTailBars = new Map<number, CanonicalHeatmapTailBar>();
  private canonicalProjectionKey = "";
  private chunks = new Map<number, ChunkState>();
  private readonly emptyChunkKeys = new Set<string>();
  private chunkCoverage = new Map<number, OrderbookHeatmapCoverage>();
  private lastErrorCode: string | undefined = undefined;
  private lastErrorMessage: string | undefined = undefined;
  private lastActiveOnChange = false;
  private readonly statusListeners = new Set<(status: OrderbookHeatmapRuntimeStatus) => void>();
  private inFlight = new Set<AbortController>();
  private hoverWindows = new Map<string, HoverWindow>();
  private hoverRangeRequests = new Map<string, HoverRangeRequest>();
  private hoverConsumerRanges = new Map<string, Set<string>>();
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingHoverKey = "";
  /** Resolved floor and ceiling of the last drawn/prepared frame. */
  private visibleFloor = 0;
  private visibleCeiling = 0;
  private visibleOpacity = 0.85;
  private scratchValues = new Float64Array(1024);
  private scratchValueCount = 0;
  private liveScratchValues = new Float64Array(256);
  private liveScratchValueCount = 0;
  private explicitVisible = true;
  private needsRedrawOnVisible = false;
  private rasterCacheDisabledForTest = false;
  private pointerDragging = false;
  private lastRasterViewportKey = "";
  private rasterViewportChangedAt = Number.NEGATIVE_INFINITY;
  private visibilityObservedDoc: Document | null = null;
  private visibilityObservedCanvas: HTMLCanvasElement | null = null;
  private visibilityObserver: IntersectionObserver | null = null;
  private visibilityObservedIntersecting: boolean | null = null;
  private readonly handleDocumentVisibilityChange = (): void => {
    if (this.disposed) return;
    if (this.visibilityObservedDoc?.visibilityState === "hidden") {
      this.releaseRasterCache();
    } else if (
      this.needsRedrawOnVisible
      && !this.isVisibilityHidden(this.visibilityObservedCanvas ?? undefined)
    ) {
      this.needsRedrawOnVisible = false;
      this.invalidate();
    }
  };
  private readonly liveTimer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;

  constructor(options: OrderbookHeatmapOverlayOptions) {
    this.fetchHeatmap = options.fetch;
    this.invalidate = options.invalidate;
    this.getMarket = options.getMarket;
    this.getPanelId = options.getPanelId;
    this.isReplayActive = options.isReplayActive ?? (() => false);
    this.now = options.now ?? Date.now;
    this.subscribeLiveTail = options.subscribeLiveTail;
    this.liveDebounceMs = Math.max(50, options.liveDebounceMs ?? DEFAULT_LIVE_DEBOUNCE_MS);
    this.lastMarket = this.getMarket();
    this.lastActiveOnChange = this.isCurrentlyActive();
    this.unsubscribe = orderbookHeatmapSettingsSource().onChange(() => {
      const nextSettings = this.trySettings();
      const isActive = nextSettings !== null && this.activeFor(nextSettings);
      const wasActive = this.lastActiveOnChange;
      this.lastActiveOnChange = isActive;

      if (!isActive) {
        if (nextSettings?.mode === "custom") {
          if (this.dataKey !== "") this.reset("");
          else this.releaseRasterCache();
        } else {
          for (const controller of this.inFlight) controller.abort();
          this.inFlight.clear();
          this.abortAllHoverRequests();
          for (const [chunkStart, state] of this.chunks) {
            if (state.status !== "ready") this.chunks.delete(chunkStart);
          }
          this.lastErrorCode = undefined;
          this.lastErrorMessage = undefined;
          this.releaseRasterCache();
        }
        this.syncLiveTailSubscription();
        if (wasActive) {
          this.invalidate();
          this.emitStatus();
        }
        return;
      }

      if (this.currentTier) {
        const nextKey = this.dataKeyFor(nextSettings, this.currentTier);
        if (nextKey !== this.dataKey) this.reset(nextKey);
        this.syncCanonicalTailProjection(nextSettings, this.currentTier);
      }
      this.syncLiveTailSubscription();
      this.invalidate();
      this.emitStatus();
    });

    this.syncLiveTailSubscription();

    // Redraws pull the live tail; this keeps it moving on a quiet chart when live tail subscription is inactive/idle.
    this.liveTimer = setInterval(() => {
      if (!this.active()) return;
      const now = this.now();
      // If live-tail push/invalidation is active and healthy, suppress unconditional timer redraws
      if (this.isLiveTailHealthy(now)) return;
      this.invalidate();
    }, LIVE_TICK_MS);
  }

  /** Shared settings with the mode saved for the chart's current pair (and panel, if any). */
  private get settings(): OrderbookHeatmapSettings {
    return orderbookHeatmapSettingsSource().settingsFor(this.getMarket(), this.getPanelId?.());
  }

  private trySettings(): OrderbookHeatmapSettings | null {
    try {
      return orderbookHeatmapSettingsSource().settingsFor(this.getMarket(), this.getPanelId?.());
    } catch {
      return null;
    }
  }

  private isCurrentlyActive(): boolean {
    const settings = this.trySettings();
    return settings !== null && this.activeFor(settings);
  }

  private liveTailKeyFor(market: string, settings: OrderbookHeatmapSettings | null): string {
    if (!settings) return `${market}|unconfigured`;
    if (settings.mode === "custom") return `${market}|canonical`;
    return `${market}|${settings.mode}|${settings.unit}|${settings.bucketStep}|${activeOrderbookHeatmapThreshold(settings)}`;
  }

  /** Synchronizes the active live-tail subscription with current market and heatmap settings. */
  private syncLiveTailSubscription(): void {
    if (this.disposed) return;
    const market = this.getMarket();
    const settings = this.trySettings();
    const customSources = settings?.mode === "custom"
      ? normalizeOrderbookHeatmapSources(settings.customSources ?? [])
      : [];
    const customDisabled = settings?.mode === "custom" && customSources.length === 0;
    const modeDisabled = settings?.mode === "off" || customDisabled;
    if (!settings || modeDisabled || !isOrderbookHeatmapMarket(market)) {
      this.releaseRasterCache();
    }
    if (settings?.mode !== "custom" || customDisabled) {
      this.canonicalTailBars.clear();
      this.canonicalProjectionKey = "";
    }
    if (!this.subscribeLiveTail) return;
    if (modeDisabled) {
      this.liveTailGeneration++;
      this.unsubscribeLiveTail?.();
      this.unsubscribeLiveTail = null;
      if (this.liveDebounceTimer) {
        clearTimeout(this.liveDebounceTimer);
        this.liveDebounceTimer = null;
      }
      this.lastLiveEventAt = 0;
      this.liveTailRequestKey = "";
      return;
    }
    const key = this.liveTailKeyFor(market, settings);
    if (key === this.liveTailRequestKey && this.unsubscribeLiveTail !== null) return;

    this.canonicalTailBars.clear();
    this.canonicalProjectionKey = "";
    this.liveTailGeneration++;
    const generation = this.liveTailGeneration;
    this.unsubscribeLiveTail?.();
    this.unsubscribeLiveTail = null;
    if (this.liveDebounceTimer) {
      clearTimeout(this.liveDebounceTimer);
      this.liveDebounceTimer = null;
    }
    this.lastLiveEventAt = 0;
    this.liveTailRequestKey = key;

    const parsed = parseMarket(market);
    const panelId = this.getPanelId?.();
    const request: LiveHeatmapTailRequest = settings?.mode === "custom"
      ? {
          market,
          ...(panelId ? { panelId } : {}),
          ...(parsed.base ? { base: parsed.base } : {}),
          source: "canonical",
          bucketStep: 25,
        }
      : {
          market,
          ...(panelId ? { panelId } : {}),
          ...(parsed.base ? { base: parsed.base } : {}),
        };
    if (settings && settings.mode !== "custom") {
      request.bucketStep = settings.bucketStep;
      if (settings.mode !== "off" && settings.unit === "usd") {
        request.minQuantityUsd = activeOrderbookHeatmapThreshold(settings);
      }
    }

    const listener = (event?: LiveHeatmapTailEvent): void => {
      if (generation !== this.liveTailGeneration || this.disposed) return;
      if (event?.market && event.market !== market) return;
      this.handleLiveTailEvent(event);
    };
    this.unsubscribeLiveTail = this.subscribeLiveTail(listener, request);
  }

  /** Resets cached data and immediately re-subscribes when the chart switches markets. */
  handleMarketChange(): void {
    if (this.disposed) return;
    this.lastMarket = this.getMarket();
    this.currentTier = null;
    this.canonicalTailBars.clear();
    this.reset("");
    this.syncLiveTailSubscription();
  }

  /** Whether the live-tail subscription is actively receiving events. */
  private isLiveTailHealthy(now: number): boolean {
    return Boolean(this.subscribeLiveTail && this.lastLiveEventAt > 0 && now - this.lastLiveEventAt < LIVE_TAIL_IDLE_FALLBACK_MS);
  }

  private canonicalProjectionKeyFor(settings: OrderbookHeatmapSettings, tier: HeatmapTier): string {
    return `${this.dataKeyFor(settings, tier)}|${settings.unit}|${activeOrderbookHeatmapThreshold(settings)}`;
  }

  private projectCanonicalBar(bar: CanonicalHeatmapTailBar, settings: OrderbookHeatmapSettings): OrderbookHeatmapBar {
    const threshold = activeOrderbookHeatmapThreshold(settings);
    const source = settings.mode === "custom" ? "custom" : settings.mode === "single" ? "single" : "aggregated";
    return projectCanonicalHeatmapTailBar(bar, {
      source,
      customSources: settings.customSources,
      bucketStep: settings.bucketStep,
      ...(settings.unit === "btc" ? { minBtc: threshold } : { minUsd: threshold }),
    });
  }

  private mergeIntoBars(bars: readonly OrderbookHeatmapBar[]): OrderbookHeatmapBar[] {
    const prevSize = this.bars.size;
    const changed = mergeHeatmapBarsWithDiff(this.bars, bars);
    if (this.bars.size !== prevSize) {
      this.barKeysRevision++;
    }
    return changed;
  }

  private bumpBarsRevision(bars?: readonly OrderbookHeatmapBar[], allowLiveOnly = false): void {
    if (bars !== undefined && bars.length === 0) return;
    let minChangedTime = Number.POSITIVE_INFINITY;
    if (bars !== undefined) {
      for (const bar of bars) {
        if (bar.t < minChangedTime) minChangedTime = bar.t;
      }
    }
    if (
      allowLiveOnly &&
      this.lastSeriesLiveBarTime > Number.NEGATIVE_INFINITY &&
      bars !== undefined
    ) {
      this.barsRevision++;
      if (bars.every((bar) => bar.t >= this.lastSeriesLiveBarTime)) {
        this.residentDirtyFromTime = Math.min(this.residentDirtyFromTime, minChangedTime);
        this.liveTailSyncRevision++;
        return;
      }
      if (
        this.currentTier &&
        minChangedTime >= this.lastSeriesLiveBarTime - 8 * this.currentTier.periodMs
      ) {
        this.residentDirtyFromTime = Math.min(this.residentDirtyFromTime, minChangedTime);
        this.historicalBarsRevision++;
        this.liveTailSyncRevision++;
        return;
      }
    }
    this.barsRevision++;
    this.historicalBarsRevision++;
    this.gpuSyncGeneration++;
    this.residentDirtyFromTime = Number.POSITIVE_INFINITY;
  }

  private reprojectCanonicalTailBars(
    settings: OrderbookHeatmapSettings,
    tier: HeatmapTier,
    extraChangedBars: readonly OrderbookHeatmapBar[] = [],
    allowLiveOnly = true,
  ): void {
    if (this.canonicalTailBars.size === 0) {
      this.bumpBarsRevision(extraChangedBars, allowLiveOnly);
      return;
    }
    const projected: OrderbookHeatmapBar[] = [];
    for (const bar of this.canonicalTailBars.values()) {
      projected.push(this.projectCanonicalBar(bar, settings));
    }
    const reprojectedChanged = this.mergeIntoBars(projected);
    this.canonicalProjectionKey = this.canonicalProjectionKeyFor(settings, tier);
    const threshold = activeOrderbookHeatmapThreshold(settings);
    if (Number.isFinite(this.residentCoverageThreshold) && threshold > this.residentCoverageThreshold) {
      this.residentCoverageThreshold = threshold;
    }
    let combinedChanged: readonly OrderbookHeatmapBar[];
    if (extraChangedBars.length === 0) {
      combinedChanged = reprojectedChanged;
    } else if (reprojectedChanged.length === 0) {
      combinedChanged = extraChangedBars;
    } else {
      const seenTimes = new Set<number>();
      const merged: OrderbookHeatmapBar[] = [];
      for (const bar of extraChangedBars) {
        if (seenTimes.has(bar.t)) continue;
        seenTimes.add(bar.t);
        merged.push(bar);
      }
      for (const bar of reprojectedChanged) {
        if (seenTimes.has(bar.t)) continue;
        seenTimes.add(bar.t);
        merged.push(bar);
      }
      combinedChanged = merged;
    }
    this.bumpBarsRevision(combinedChanged, allowLiveOnly);
  }

  private syncCanonicalTailProjection(settings: OrderbookHeatmapSettings, tier: HeatmapTier): void {
    if (settings.mode !== "custom" || tier.name !== "1m" || this.canonicalTailBars.size === 0) return;
    const nextKey = this.canonicalProjectionKeyFor(settings, tier);
    if (nextKey === this.canonicalProjectionKey) return;
    this.reprojectCanonicalTailBars(settings, tier);
  }

  /** Handles incoming transport-agnostic live-tail invalidation or bars push. */
  handleLiveTailEvent(event?: LiveHeatmapTailEvent): void {
    if (this.disposed || !this.active()) return;
    const currentMarket = this.getMarket();
    if (event?.market && event.market !== currentMarket) return;

    // Direct push: only the 1m tier accepts 1m live-tail bars so coarse tiers (>= 5m) stay uncontaminated.
    if (event?.bars !== undefined || event?.canonicalBars !== undefined) {
      if (this.currentTier?.name !== "1m") return;
      const now = this.now();
      this.lastLiveEventAt = now;
      if (this.liveDebounceTimer) {
        clearTimeout(this.liveDebounceTimer);
        this.liveDebounceTimer = null;
      }
      let barsToMerge = event.bars;
      if (barsToMerge === undefined && event.canonicalBars !== undefined) {
        for (const bar of event.canonicalBars) {
          this.canonicalTailBars.set(bar.t, bar);
        }
        while (this.canonicalTailBars.size > 1000) {
          const oldest = this.canonicalTailBars.keys().next().value;
          if (oldest === undefined) break;
          this.canonicalTailBars.delete(oldest);
        }
        const settings = this.settings;
        barsToMerge = event.canonicalBars.map((bar) => this.projectCanonicalBar(bar, settings));
        this.canonicalProjectionKey = this.canonicalProjectionKeyFor(settings, this.currentTier);
      }
      if (barsToMerge && barsToMerge.length > 0) {
        const changed = this.mergeIntoBars(barsToMerge);
        for (const bar of barsToMerge) {
          this.liveBarTimes.add(bar.t);
        }
        this.bumpBarsRevision(changed, true);
        const evicted = this.evictStaleLiveBars(this.currentTier);
        // Mark current live chunk as refreshed if loaded
        const liveChunkStart = heatmapChunkStart(now, this.currentTier);
        const existing = this.chunks.get(liveChunkStart);
        if (existing && existing.status === "ready") {
          existing.fetchedAt = now;
        }
        if (changed.length > 0 || evicted) this.invalidate();
      }
      return;
    }

    // Invalidation signal without bars (Stage 1 health ping): coalesce and refresh only the live tail
    this.lastLiveEventAt = this.now();
    this.scheduleLiveTailRefresh();
  }

  /** Public seam: triggers a live-tail invalidation or push. */
  invalidateLiveTail(event?: LiveHeatmapTailEvent): void {
    this.handleLiveTailEvent(event);
  }

  /** Public seam: directly merges live-tail bars. */
  applyLiveTailBars(bars: OrderbookHeatmapBar[], market?: string): void {
    this.handleLiveTailEvent({ market, bars });
  }

  private scheduleLiveTailRefresh(): void {
    if (this.liveDebounceTimer) return;
    this.liveDebounceTimer = setTimeout(() => {
      this.liveDebounceTimer = null;
      if (!this.active()) return;
      this.refreshLiveTailOnly();
    }, this.liveDebounceMs);
  }

  /** Re-fetches only the newest tail of the live chunk holding "now"; never drops or re-reads historical chunks. */
  private refreshLiveTailOnly(): void {
    if (!this.active() || !this.currentTier) return;
    const tier = this.currentTier;
    const now = this.now();
    const chunkStart = heatmapChunkStart(now, tier);
    const chunkEnd = heatmapChunkEnd(chunkStart, tier);
    const state = this.chunks.get(chunkStart);
    if (state?.status === "loading") return;
    if (this.inFlight.size >= MAX_PARALLEL_CHUNKS) return;
    const threshold = activeOrderbookHeatmapThreshold(this.settings);
    const unit = this.settings.unit;
    const isSameUnit = state?.unit === unit;
    const needsFullRefetch = state?.status === "ready" && (!isSameUnit || state.fullThreshold > threshold);

    const refreshFrom = state?.status === "ready" && !needsFullRefetch
      ? Math.max(chunkStart, Math.floor(now / tier.periodMs) * tier.periodMs - 2 * tier.periodMs)
      : chunkStart;

    const key = this.dataKey;
    const fullThreshold = refreshFrom === chunkStart ? threshold : (state?.fullThreshold ?? threshold);
    const fullUnit = refreshFrom === chunkStart ? unit : (state?.fullUnit ?? unit);
    this.chunks.set(chunkStart, {
      status: "loading",
      fetchedAt: state?.fetchedAt ?? 0,
      threshold,
      unit,
      fullThreshold,
      fullUnit,
    });
    const controller = new AbortController();
    this.inFlight.add(controller);
    this.fetchHeatmap({
      ...this.baseRequest(tier),
      ...this.thresholdParams(),
      from: refreshFrom,
      to: chunkEnd,
    }, controller.signal).then((response) => {
      if (key !== this.dataKey || controller.signal.aborted) return;
      const changed = this.mergeIntoBars(response.bars);
      this.recordChunkCoverage(chunkStart, response);
      const liveSettings = this.settings;
      let dataChanged = changed.length > 0;
      if (liveSettings.mode === "custom" && tier.name === "1m" && this.canonicalTailBars.size > 0 && this.isLiveTailHealthy(this.now())) {
        const prevRev = this.barsRevision;
        this.reprojectCanonicalTailBars(liveSettings, tier, changed, refreshFrom > chunkStart);
        dataChanged = dataChanged || this.barsRevision !== prevRev;
      } else {
        this.bumpBarsRevision(changed, refreshFrom > chunkStart);
      }
      this.chunks.set(chunkStart, {
        status: "ready",
        fetchedAt: this.now(),
        threshold,
        unit,
        fullThreshold,
        fullUnit,
      });
      this.evictStaleChunks(tier);
      if (dataChanged || state?.status !== "ready") this.invalidate();
    }, () => {
      if (key !== this.dataKey || controller.signal.aborted) return;
      this.chunks.set(chunkStart, {
        status: state?.status === "ready" ? "ready" : "error",
        fetchedAt: this.now(),
        threshold: state?.threshold ?? threshold,
        unit: state?.unit ?? unit,
        fullThreshold: state?.fullThreshold ?? fullThreshold,
        fullUnit: state?.fullUnit ?? fullUnit,
      });
    }).finally(() => {
      this.inFlight.delete(controller);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.liveTailGeneration++;
    clearInterval(this.liveTimer);
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.liveDebounceTimer) clearTimeout(this.liveDebounceTimer);
    if (this.scaleSettleTimer) {
      clearTimeout(this.scaleSettleTimer);
      this.scaleSettleTimer = null;
    }
    this.unsubscribe();
    this.unsubscribeLiveTail?.();
    this.unsubscribeLiveTail = null;
    this.liveTailRequestKey = "";
    this.releaseVisibilityTracking();
    this.canonicalTailBars.clear();
    this.scratchValueCount = 0;
    if (this.scratchValues.length > 65_536) {
      this.scratchValues = new Float64Array(1024);
    }
    this.reset("");
    this.statusListeners.clear();
  }

  private activeFor(settings: OrderbookHeatmapSettings): boolean {
    if (settings.mode === "off") return false;
    if (settings.mode === "custom" && normalizeOrderbookHeatmapSources(settings.customSources ?? []).length === 0) {
      return false;
    }
    return isOrderbookHeatmapMarket(this.getMarket());
  }

  private active(): boolean {
    return this.activeFor(this.settings);
  }

  private dataKeyFor(settings: OrderbookHeatmapSettings, tier: HeatmapTier): string {
    const sourceKey = settings.mode === "custom"
      ? normalizeOrderbookHeatmapSources(settings.customSources ?? []).join(",")
      : "";
    return `${settings.mode}|${sourceKey}|${tier.name}|${settings.bucketStep}`;
  }

  private reset(key: string): void {
    if (this.liveDebounceTimer) {
      clearTimeout(this.liveDebounceTimer);
      this.liveDebounceTimer = null;
    }
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (this.scaleSettleTimer) {
      clearTimeout(this.scaleSettleTimer);
      this.scaleSettleTimer = null;
    }
    this.scaleViewportKey = "";
    this.scaleViewportChangedAt = Number.NEGATIVE_INFINITY;
    this.autoScaleCache = null;
    this.autoScaleHistCache = null;
    this.autoScaleInputSig = "";
    this.autoScaleViewportKey = "";
    this.autoScaleBarsRevision = -1;
    this.residentDirtyFromTime = Number.POSITIVE_INFINITY;
    this.sortedBarTimes = [];
    this.barKeysRevision++;
    this.sortedBarTimesKeysRevision = -1;
    this.residentCoverageThreshold = Number.NaN;
    this.lastResidentSeries = null;
    this.lastResidentSeriesStructureRevision = -1;
    this.lastResidentPrevLastBarTime = Number.NaN;
    this.pendingHoverKey = "";
    this.lastLiveEventAt = 0;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.abortAllHoverRequests();
    this.dataKey = key;
    this.bars = new Map();
    this.liveBarTimes.clear();
    this.canonicalProjectionKey = "";
    this.chunks = new Map();
    this.emptyChunkKeys.clear();
    this.chunkCoverage = new Map();
    this.lastErrorCode = undefined;
    this.lastErrorMessage = undefined;
    this.hoverWindows = new Map();
    // Dropping the data identity also releases the owned same-frame visible list.
    this.lastCollectedKey = "";
    this.lastCollected = null;
    this.lastCollectedRange = null;
    this.lastSeriesLiveBarTime = Number.NEGATIVE_INFINITY;
    this.residentPriceOrigin = Number.NaN;
    this.residentPriceOriginInitializedFromBars = false;
    this.releaseRasterCache();
    this.bumpBarsRevision();
    this.emitStatus();
  }

  private baseRequest(tier: HeatmapTier): Pick<OrderbookHeatmapRequest, "source" | "sources" | "resolution" | "bucketStep"> {
    const settings = this.settings;
    if (settings.mode === "custom") {
      return {
        source: "custom",
        sources: normalizeOrderbookHeatmapSources(settings.customSources ?? []),
        resolution: tier.name,
        bucketStep: settings.bucketStep,
      };
    }
    return {
      source: settings.mode === "single" ? "single" : "aggregated",
      resolution: tier.name,
      bucketStep: settings.bucketStep,
    };
  }

  private recordChunkCoverage(chunkStart: number, response: OrderbookHeatmapResponse): void {
    const hasCoverage = response.requestedSources !== undefined
      || response.observedSources !== undefined
      || response.missingSources !== undefined;
    if (!hasCoverage) {
      this.chunkCoverage.delete(chunkStart);
      return;
    }
    this.chunkCoverage.set(chunkStart, {
      requestedSources: normalizeOrderbookHeatmapSources(response.requestedSources ?? []),
      observedSources: normalizeOrderbookHeatmapSources(response.observedSources ?? []),
      missingSources: normalizeOrderbookHeatmapSources(response.missingSources ?? []),
    });
  }

  /** Summarizes requested, observed, and missing sources across active chunk responses. */
  getCoverage(): OrderbookHeatmapCoverage {
    const requested = new Set<string>();
    const observed = new Set<string>();
    const explicitMissing = new Set<string>();
    for (const coverage of this.chunkCoverage.values()) {
      for (const source of coverage.requestedSources) requested.add(source);
      for (const source of coverage.observedSources) observed.add(source);
      for (const source of coverage.missingSources) explicitMissing.add(source);
    }
    const missing = new Set<string>();
    for (const source of requested) {
      if (!observed.has(source)) missing.add(source);
    }
    for (const source of explicitMissing) {
      if (!observed.has(source)) missing.add(source);
    }
    return {
      requestedSources: Array.from(requested).sort(),
      observedSources: Array.from(observed).sort(),
      missingSources: Array.from(missing).sort(),
    };
  }

  /** Returns current loading, error, and source-coverage status for this overlay instance. */
  getStatus(): OrderbookHeatmapRuntimeStatus {
    if (!this.isCurrentlyActive()) {
      return {
        state: "idle",
        requestedSources: [],
        observedSources: [],
        missingSources: [],
        hasBars: false,
      };
    }
    let hasLoading = false;
    let hasReady = false;
    let hasError = false;
    for (const chunk of this.chunks.values()) {
      if (chunk.status === "loading") hasLoading = true;
      else if (chunk.status === "ready") hasReady = true;
      else if (chunk.status === "error") hasError = true;
    }
    const state: OrderbookHeatmapRuntimeStatus["state"] = hasLoading
      ? "loading"
      : hasError && !hasReady
        ? "error"
        : hasReady || this.bars.size > 0
          ? "ready"
          : hasError
            ? "error"
            : "idle";
    const coverage = this.getCoverage();
    return {
      state,
      ...(hasError && this.lastErrorCode ? { errorCode: this.lastErrorCode } : {}),
      ...(hasError && this.lastErrorMessage ? { errorMessage: this.lastErrorMessage } : {}),
      requestedSources: coverage.requestedSources,
      observedSources: coverage.observedSources,
      missingSources: coverage.missingSources,
      hasBars: this.bars.size > 0,
    };
  }

  /** Subscribes to status transitions (`loading`, `ready`, `error`, `idle`) and returns an unsubscribe function. */
  subscribeStatus(listener: (status: OrderbookHeatmapRuntimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return;
    const snapshot = this.getStatus();
    for (const listener of [...this.statusListeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener errors must not disrupt overlay state transitions.
      }
    }
  }

  private thresholdParams(): Pick<OrderbookHeatmapRequest, "minUsd" | "minBtc"> {
    const threshold = activeOrderbookHeatmapThreshold(this.settings);
    return this.settings.unit === "btc" ? { minBtc: threshold } : { minUsd: threshold };
  }

  /** Updates explicit panel visibility; hiding immediately releases the CPU raster cache. */
  setVisible(visible: boolean): void {
    this.explicitVisible = visible;
    if (!visible) {
      this.releaseRasterCache();
    } else if (
      this.needsRedrawOnVisible
      && !this.isVisibilityHidden(this.visibilityObservedCanvas ?? undefined)
    ) {
      this.needsRedrawOnVisible = false;
      this.invalidate();
    }
  }

  /** Test-only seam: bypasses CPU raster caching so direct painting can be measured on identical viewports. */
  setRasterCacheDisabledForTest(disabled: boolean): void {
    this.rasterCacheDisabledForTest = disabled;
    if (disabled) {
      this.releaseRasterCache();
    }
  }

  /** Suppresses hover fetches while the pointer is actively dragging the chart. */
  setPointerDragging(active: boolean): void {
    this.pointerDragging = active;
    if (active && this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
      this.pendingHoverKey = "";
    }
  }

  private isViewportMoving(): boolean {
    return this.now() - this.rasterViewportChangedAt < HEATMAP_CPU_RASTER_QUIET_MS;
  }

  /** Releases this overlay's offscreen CPU raster canvas and returns reserved bytes once. */
  releaseRasterCache(): void {
    this.lastRasterKey = "";
    this.lastRasterViewportKey = "";
    this.rasterViewportChangedAt = Number.NEGATIVE_INFINITY;
    this.rasterCacheHasCells = false;
    this.rasterCacheFloor = 0;
    this.rasterCacheCeiling = 0;
    this.rasterCacheThreshold = 0;
    this.rasterCacheOpacity = 0.85;
    this.rasterCacheDataSig = "";
    this.rasterCacheView = null;
    this.rasterCacheHistRightCss = 0;
    this.rasterCacheOriginX = 0;
    this.rasterCacheOriginY = 0;
    this.rasterCacheBlitBounds = null;
    this.rasterImageData = null;
    this.rasterImageDataU32 = null;
    if (this.rasterCacheCanvas) {
      try {
        this.rasterCacheCanvas.width = 0;
        this.rasterCacheCanvas.height = 0;
      } catch {
        // Ignore mock canvases with readonly dimensions on teardown.
      }
      this.rasterCacheCanvas = null;
    }
    if (this.rasterReservedBytes > 0) {
      moduleCpuRasterReservedBytes = Math.max(0, moduleCpuRasterReservedBytes - this.rasterReservedBytes);
      this.rasterReservedBytes = 0;
    }
  }

  private syncVisibilityTracking(canvas: HTMLCanvasElement | undefined): void {
    if (this.disposed) return;
    const nextDoc = canvas?.ownerDocument ?? null;
    if (nextDoc !== this.visibilityObservedDoc) {
      if (this.visibilityObservedDoc && typeof this.visibilityObservedDoc.removeEventListener === "function") {
        this.visibilityObservedDoc.removeEventListener("visibilitychange", this.handleDocumentVisibilityChange);
      }
      this.visibilityObservedDoc = nextDoc;
      if (nextDoc && typeof nextDoc.addEventListener === "function") {
        nextDoc.addEventListener("visibilitychange", this.handleDocumentVisibilityChange);
      }
    }

    const nextCanvas = canvas ?? null;
    if (nextCanvas !== this.visibilityObservedCanvas) {
      if (this.visibilityObserver) {
        try {
          this.visibilityObserver.disconnect();
        } catch {
          // Ignore mock observer teardown failures.
        }
        this.visibilityObserver = null;
      }
      this.visibilityObservedCanvas = nextCanvas;
      this.visibilityObservedIntersecting = null;
      if (nextCanvas) {
        const ObserverCtor =
          (nextDoc as { defaultView?: { IntersectionObserver?: typeof IntersectionObserver } | null } | null)
            ?.defaultView?.IntersectionObserver
          ?? (typeof IntersectionObserver === "function" ? IntersectionObserver : undefined);
        if (typeof ObserverCtor === "function") {
          try {
            const observer = new ObserverCtor((entries) => {
              if (this.disposed || this.visibilityObserver !== observer) return;
              const entry = entries[entries.length - 1];
              if (!entry) return;
              this.visibilityObservedIntersecting = entry.isIntersecting;
              if (!entry.isIntersecting) {
                this.releaseRasterCache();
              } else if (
                this.needsRedrawOnVisible
                && !this.isVisibilityHidden(this.visibilityObservedCanvas ?? undefined)
              ) {
                this.needsRedrawOnVisible = false;
                this.invalidate();
              }
            });
            observer.observe(nextCanvas);
            this.visibilityObserver = observer;
          } catch {
            // Non-Element mock targets are ignored when native IntersectionObserver exists.
            this.visibilityObserver = null;
          }
        }
      }
    }
  }

  private isVisibilityHidden(canvas: HTMLCanvasElement | undefined): boolean {
    if (!this.explicitVisible) return true;
    const doc = canvas?.ownerDocument ?? this.visibilityObservedDoc;
    if (doc?.visibilityState === "hidden") return true;
    if ((canvas as { isConnected?: boolean } | undefined)?.isConnected === false) return true;
    if (canvas && canvas === this.visibilityObservedCanvas && this.visibilityObservedIntersecting === false) {
      return true;
    }
    return false;
  }

  private releaseVisibilityTracking(): void {
    if (this.visibilityObserver) {
      try {
        this.visibilityObserver.disconnect();
      } catch {
        // Ignore mock observer teardown failures.
      }
      this.visibilityObserver = null;
    }
    this.visibilityObservedCanvas = null;
    this.visibilityObservedIntersecting = null;
    if (this.visibilityObservedDoc && typeof this.visibilityObservedDoc.removeEventListener === "function") {
      this.visibilityObservedDoc.removeEventListener("visibilitychange", this.handleDocumentVisibilityChange);
    }
    this.visibilityObservedDoc = null;
  }

  /** Draws cells for the visible bars and requests any chunk they still need. */
  draw(ctx: CanvasRenderingContext2D, view: View, series: FootprintSeries, range: [number, number]): void {
    this.syncVisibilityTracking(ctx.canvas);
    const hidden = this.isVisibilityHidden(ctx.canvas);
    if (hidden) {
      this.releaseRasterCache();
      this.needsRedrawOnVisible = true;
      this.beginFrame(series, range);
      return;
    }
    this.needsRedrawOnVisible = false;
    const frame = this.beginFrame(series, range);
    if (!frame) return;
    const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
    try {
      const canvasWidth = ctx.canvas?.width ?? 0;
      const canvasHeight = ctx.canvas?.height ?? 0;
      const rasterKey = `${this.frameCacheKey(view, series, frame)}|${canvasWidth}|${canvasHeight}`;
      const rasterDataSig = this.rasterDataSignature(view, series, frame, canvasWidth, canvasHeight);
      const viewportKey = `${view.offsetX}|${view.colWidth}|${view.priceTop}|${view.pricePerPx}`;
      const now = this.now();
      if (this.lastRasterViewportKey && this.lastRasterViewportKey !== viewportKey) {
        this.rasterViewportChangedAt = now;
      }
      this.lastRasterViewportKey = viewportKey;
      const viewportMoving = now - this.rasterViewportChangedAt < HEATMAP_CPU_RASTER_QUIET_MS;
      const rasterEligible =
        !this.rasterCacheDisabledForTest &&
        !hidden &&
        canvasWidth > 0 &&
        canvasHeight > 0 &&
        typeof ctx.canvas?.ownerDocument?.createElement === "function" &&
        typeof ctx.drawImage === "function";

      const canUseRasterCache = rasterEligible && !viewportMoving;
      if (rasterEligible && viewportMoving) {
        incrementPerformanceCounter("chart.cpu.heatmap.raster.skip");
        const transform = this.resolveCtxTransform(ctx, view);
        if (this.tryMotionRasterReuse(ctx, view, series, frame, rasterDataSig, canvasWidth, canvasHeight, transform)) {
          return;
        }
      }
      if (!rasterEligible && (this.rasterCacheCanvas || this.rasterReservedBytes > 0)) {
        this.releaseRasterCache();
      }

      if (
        canUseRasterCache &&
        this.lastRasterKey === rasterKey &&
        (!this.rasterCacheHasCells || this.rasterCacheCanvas)
      ) {
        this.visibleFloor = this.rasterCacheFloor;
        this.visibleCeiling = this.rasterCacheCeiling;
        this.visibleThreshold = this.rasterCacheThreshold;
        this.visibleOpacity = this.rasterCacheOpacity;
        if (this.rasterCacheHasCells) {
          this.blitRasterCache(ctx);
        }
        incrementPerformanceCounter("chart.cpu.heatmap.raster.hit");
        return;
      }

      // Streaming CPU path: reuse frozen/settled range when available (1 pass),
      // otherwise resolve Auto P96 incrementally from cached history + live tail.
      const fixedCeiling = this.resolveFixedCeiling(frame.settings);
      const replayActive = this.isReplayActive();
      const scalePlan = this.evaluateAutoScale(view, series, frame.settings, frame.threshold, fixedCeiling, replayActive);
      let resolved: { floor: number; ceiling: number; opacity: number };
      let knownCellCount: number | null = null;
      if (scalePlan.needsScan) {
        const scanned = this.resolveAutoScaleValues(
          view,
          series,
          frame,
          scalePlan,
          fixedCeiling,
          replayActive,
        );
        resolved = scanned.resolved;
        knownCellCount = scanned.knownCellCount;
      } else {
        resolved = {
          floor: scalePlan.floor,
          ceiling: scalePlan.ceiling,
          opacity: resolveOrderbookHeatmapOpacity(frame.settings.opacity),
        };
      }
      this.visibleFloor = resolved.floor;
      this.visibleCeiling = resolved.ceiling;
      this.visibleThreshold = frame.threshold;
      this.visibleOpacity = resolved.opacity;
      if (knownCellCount === 0) {
        this.releaseRasterCache();
        if (canUseRasterCache) {
          this.lastRasterKey = rasterKey;
          this.rasterCacheHasCells = false;
          this.rasterCacheFloor = resolved.floor;
          this.rasterCacheCeiling = resolved.ceiling;
          this.rasterCacheThreshold = frame.threshold;
          this.rasterCacheOpacity = resolved.opacity;
        }
        return;
      }

      if (rasterEligible) {
        const transform = this.resolveCtxTransform(ctx, view);
        if (
          canUseRasterCache &&
          this.tryStaticLiveTailPatch(
            ctx,
            view,
            series,
            frame,
            rasterKey,
            rasterDataSig,
            canvasWidth,
            canvasHeight,
            transform,
            resolved,
          )
        ) {
          return;
        }
        let budgetExceeded = false;
        const offCtx = this.ensureRasterCacheCanvas(
          ctx.canvas.ownerDocument,
          canvasWidth,
          canvasHeight,
          true,
          () => { budgetExceeded = true; },
        );
        const canMotionImageDataReanchor =
          !viewportMoving
          || (
            offCtx !== null
            && view.colWidth >= 1
            && transform.b === 0
            && transform.c === 0
            && transform.a > 0
            && transform.d > 0
            && typeof offCtx.createImageData === "function"
            && typeof offCtx.putImageData === "function"
          );
        if (offCtx && canMotionImageDataReanchor) {
          const paintBounds = {
            minX: Number.POSITIVE_INFINITY,
            minY: Number.POSITIVE_INFINITY,
            maxX: Number.NEGATIVE_INFINITY,
            maxY: Number.NEGATIVE_INFINITY,
          };
          offCtx.save();
          offCtx.setTransform?.(1, 0, 0, 1, 0, 0);
          offCtx.clearRect(0, 0, canvasWidth, canvasHeight);
          offCtx.setTransform?.(
            transform.a,
            transform.b,
            transform.c,
            transform.d,
            transform.e,
            transform.f,
          );
          const paintedCells = this.paintCellsToContext(
            offCtx,
            view,
            series,
            frame,
            frame.first,
            frame.last,
            undefined,
            paintBounds,
            transform,
          );
          offCtx.restore();
          if (paintedCells === 0) {
            this.releaseRasterCache();
            if (canUseRasterCache) {
              this.lastRasterKey = rasterKey;
              this.rasterCacheHasCells = false;
              this.rasterCacheFloor = resolved.floor;
              this.rasterCacheCeiling = resolved.ceiling;
              this.rasterCacheThreshold = frame.threshold;
              this.rasterCacheOpacity = resolved.opacity;
            }
            return;
          }
          this.rasterCacheOriginX = 0;
          this.rasterCacheOriginY = 0;
          if (
            transform.b === 0
            && transform.c === 0
            && Number.isFinite(paintBounds.minX)
            && Number.isFinite(paintBounds.maxX)
          ) {
            const bx = Math.max(0, Math.floor(paintBounds.minX * transform.a + transform.e));
            const by = Math.max(0, Math.floor(paintBounds.minY * transform.d + transform.f));
            const br = Math.min(canvasWidth, Math.ceil(paintBounds.maxX * transform.a + transform.e));
            const bb = Math.min(canvasHeight, Math.ceil(paintBounds.maxY * transform.d + transform.f));
            this.rasterCacheBlitBounds = br > bx && bb > by ? { x: bx, y: by, w: br - bx, h: bb - by } : null;
          } else {
            this.rasterCacheBlitBounds = null;
          }
          this.recordRasterCacheMeta(
            view,
            series,
            viewportMoving ? "" : rasterKey,
            rasterDataSig,
            resolved,
            frame.threshold,
            transform,
          );
          this.blitRasterCache(ctx);
          incrementPerformanceCounter(
            viewportMoving ? "chart.cpu.heatmap.raster.direct" : "chart.cpu.heatmap.raster.miss",
          );
          return;
        }
        if (budgetExceeded && transform.b === 0 && transform.c === 0) {
          const denseThreshold = 256;
          let denseCount = knownCellCount;
          if (denseCount === null) {
            let count = 0;
            this.forEachVisibleCell(view, series, frame, denseThreshold, () => {
              count++;
            });
            denseCount = count;
          }
          if (denseCount >= denseThreshold) {
            const drawWidth = Math.max(1, view.colWidth);
            const xStart = view.xOfIndex(frame.first);
            const xEnd = view.xOfIndex(frame.last) + drawWidth;
            const occLeft = Math.max(view.area.left, Math.min(xStart, xEnd));
            const occRight = Math.min(view.area.left + view.area.width, Math.max(xStart, xEnd));
            const occTop = view.area.top;
            const occBottom = view.area.top + view.area.height;
            const rx = Math.max(0, Math.floor(occLeft * transform.a + transform.e));
            const ry = Math.max(0, Math.floor(occTop * transform.d + transform.f));
            const rr = Math.min(canvasWidth, Math.ceil(occRight * transform.a + transform.e));
            const rb = Math.min(canvasHeight, Math.ceil(occBottom * transform.d + transform.f));
            const rw = rr - rx;
            const rh = rb - ry;
            if (rw > 0 && rh > 0 && (rw < canvasWidth || rh < canvasHeight)) {
              const croppedCtx = this.ensureRasterCacheCanvas(ctx.canvas.ownerDocument, rw, rh, true);
              if (croppedCtx) {
                croppedCtx.save();
                croppedCtx.setTransform?.(1, 0, 0, 1, 0, 0);
                croppedCtx.clearRect(0, 0, rw, rh);
                const croppedTransform = {
                  a: transform.a,
                  b: transform.b,
                  c: transform.c,
                  d: transform.d,
                  e: transform.e - rx,
                  f: transform.f - ry,
                };
                croppedCtx.setTransform?.(
                  croppedTransform.a,
                  croppedTransform.b,
                  croppedTransform.c,
                  croppedTransform.d,
                  croppedTransform.e,
                  croppedTransform.f,
                );
                const paintedCells = this.paintCellsToContext(
                  croppedCtx,
                  view,
                  series,
                  frame,
                  frame.first,
                  frame.last,
                  undefined,
                  undefined,
                  croppedTransform,
                );
                croppedCtx.restore();
                if (paintedCells === 0) {
                  this.releaseRasterCache();
                  if (canUseRasterCache) {
                    this.lastRasterKey = rasterKey;
                    this.rasterCacheHasCells = false;
                    this.rasterCacheFloor = resolved.floor;
                    this.rasterCacheCeiling = resolved.ceiling;
                    this.rasterCacheThreshold = frame.threshold;
                    this.rasterCacheOpacity = resolved.opacity;
                  }
                  return;
                }
                this.rasterCacheOriginX = rx;
                this.rasterCacheOriginY = ry;
                this.rasterCacheBlitBounds = null;
                this.recordRasterCacheMeta(view, series, rasterKey, rasterDataSig, resolved, frame.threshold, transform);
                this.blitRasterCache(ctx);
                incrementPerformanceCounter("chart.cpu.heatmap.raster.miss");
                return;
              }
            }
          }
          incrementPerformanceCounter("chart.cpu.heatmap.raster.budgetFallback");
        } else if (budgetExceeded) {
          incrementPerformanceCounter("chart.cpu.heatmap.raster.budgetFallback");
        }
      }

      incrementPerformanceCounter("chart.cpu.heatmap.raster.direct");
      const paintedCells = this.paintCellsToContext(ctx, view, series, frame);
      if (paintedCells === 0) {
        this.releaseRasterCache();
      }
    } finally {
      if (startedAt !== null) recordPerformanceDuration("chart.cpu.heatmap.draw.ms", performance.now() - startedAt);
    }
  }

  private resolveCtxTransform(ctx: CanvasRenderingContext2D, view: View): {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  } {
    const transform = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
    if (
      transform &&
      Number.isFinite(transform.a) &&
      Number.isFinite(transform.b) &&
      Number.isFinite(transform.c) &&
      Number.isFinite(transform.d) &&
      Number.isFinite(transform.e) &&
      Number.isFinite(transform.f)
    ) {
      return {
        a: transform.a,
        b: transform.b,
        c: transform.c,
        d: transform.d,
        e: transform.e,
        f: transform.f,
      };
    }
    const dpr = view.pixelRatio !== null && view.pixelRatio !== undefined && view.pixelRatio > 0
      ? view.pixelRatio
      : 1;
    return { a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 };
  }

  private rasterDataSignature(
    view: View,
    series: FootprintSeries,
    frame: HeatmapFramePreamble,
    canvasWidth: number,
    canvasHeight: number,
  ): string {
    const opacity = resolveOrderbookHeatmapOpacity(frame.settings.opacity);
    const scaleMode = frame.settings.scaleMode ?? "auto";
    const fixedCeiling = scaleMode === "fixed" ? (frame.settings.fixedCeiling?.[frame.settings.unit] ?? 0) : 0;
    const contrast = frame.settings.contrast ?? "medium";
    const palette = resolveOrderbookHeatmapPalette(frame.settings.palette);
    const replayActive = this.isReplayActive();
    const priceScaleMode = view.priceScaleMode ?? 0;
    const seriesStructRev = (series as { structureRevision?: number }).structureRevision ?? 0;
    return `${this.dataKey}|${frame.settings.unit}|${frame.threshold}|${opacity}|${scaleMode}|${fixedCeiling}|${contrast}|${palette}|${this.historicalBarsRevision}|${seriesIdentityId(series)}|${seriesStructRev}|${series.length}|${replayActive}|${priceScaleMode}|${canvasWidth}|${canvasHeight}`;
  }

  private recordRasterCacheMeta(
    view: View,
    series: FootprintSeries,
    rasterKey: string,
    rasterDataSig: string,
    resolved: { floor: number; ceiling: number; opacity: number },
    threshold: number,
    transform: { a: number; d: number; e: number; f: number },
  ): void {
    const replayActive = this.isReplayActive();
    const areaRight = view.area.left + view.area.width;
    const oldLiveX = series.length > 0 ? view.xOfIndex(series.length - 1) : areaRight;
    this.lastRasterKey = rasterKey;
    this.rasterCacheHasCells = true;
    this.rasterCacheFloor = resolved.floor;
    this.rasterCacheCeiling = resolved.ceiling;
    this.rasterCacheThreshold = threshold;
    this.rasterCacheOpacity = resolved.opacity;
    this.rasterCacheDataSig = rasterDataSig;
    this.rasterCacheHistRightCss = !replayActive && series.length > 0 ? Math.min(areaRight, oldLiveX) : areaRight;
    this.rasterCacheView = {
      offsetX: view.offsetX,
      colWidth: view.colWidth,
      priceTop: view.priceTop,
      pricePerPx: view.pricePerPx,
      areaLeft: view.area.left,
      areaTop: view.area.top,
      areaWidth: view.area.width,
      areaHeight: view.area.height,
      transformA: transform.a,
      transformD: transform.d,
      transformE: transform.e,
      transformF: transform.f,
    };
  }

  private rasterCacheViewMatches(
    view: View,
    transform: { a: number; b: number; c: number; d: number; e: number; f: number },
  ): boolean {
    const cached = this.rasterCacheView;
    if (!cached || transform.b !== 0 || transform.c !== 0) return false;
    return (
      cached.offsetX === view.offsetX &&
      cached.colWidth === view.colWidth &&
      cached.priceTop === view.priceTop &&
      cached.pricePerPx === view.pricePerPx &&
      cached.areaLeft === view.area.left &&
      cached.areaTop === view.area.top &&
      cached.areaWidth === view.area.width &&
      cached.areaHeight === view.area.height &&
      cached.transformA === transform.a &&
      cached.transformD === transform.d &&
      cached.transformE === transform.e &&
      cached.transformF === transform.f
    );
  }

  /**
   * Reuses the cached historical raster during pan/zoom (`viewportMoving === true`).
   * Trade-offs while moving:
   * - In Auto (P96) mode, cached `floor`/`ceiling` are held until motion settles and full redraw updates them.
   * - `0.5-2x` zoom blitting (`imageSmoothingEnabled = false`) is transient until the post-quiet full rebuild runs.
   */
  private tryMotionRasterReuse(
    ctx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    frame: HeatmapFramePreamble,
    rasterDataSig: string,
    canvasWidth: number,
    canvasHeight: number,
    transform: { a: number; b: number; c: number; d: number; e: number; f: number },
  ): boolean {
    const cachedView = this.rasterCacheView;
    const isLog = typeof view.isLogScale === "function" && view.isLogScale();
    const hasCroppedOrigin = this.rasterCacheOriginX !== 0 || this.rasterCacheOriginY !== 0;
    if (
      !this.rasterCacheCanvas ||
      !this.rasterCacheHasCells ||
      isLog ||
      this.rasterCacheDataSig !== rasterDataSig ||
      !cachedView ||
      transform.b !== 0 ||
      transform.c !== 0 ||
      !(transform.a > 0 && transform.d > 0) ||
      !(cachedView.colWidth > 0 && view.colWidth > 0) ||
      !(cachedView.pricePerPx > 0 && view.pricePerPx > 0) ||
      (!hasCroppedOrigin && (
        this.rasterCacheCanvas.width !== canvasWidth ||
        this.rasterCacheCanvas.height !== canvasHeight
      )) ||
      cachedView.transformA !== transform.a ||
      cachedView.transformD !== transform.d ||
      cachedView.transformE !== transform.e ||
      cachedView.transformF !== transform.f
    ) {
      return false;
    }

    const scaleX = view.colWidth / cachedView.colWidth;
    const scaleY = cachedView.pricePerPx / view.pricePerPx;
    if (
      !Number.isFinite(scaleX) ||
      !Number.isFinite(scaleY) ||
      scaleX < 0.5 ||
      scaleX > 2.0 ||
      scaleY < 0.5 ||
      scaleY > 2.0
    ) {
      return false;
    }

    const { left: areaLeft, top: areaTop, width: areaWidth, height: areaHeight } = view.area;
    if (!(areaWidth > 0 && areaHeight > 0)) return false;
    const areaRight = areaLeft + areaWidth;
    const areaBottom = areaTop + areaHeight;
    const oldHistLeft = cachedView.areaLeft;
    const oldHistRight = this.rasterCacheHistRightCss;
    if (!(oldHistRight > oldHistLeft)) return false;

    const mappedLeftCss = areaLeft + view.offsetX + ((oldHistLeft - cachedView.areaLeft - cachedView.offsetX) / cachedView.colWidth) * view.colWidth;
    const mappedRightCss = areaLeft + view.offsetX + ((oldHistRight - cachedView.areaLeft - cachedView.offsetX) / cachedView.colWidth) * view.colWidth;
    const mappedTopCss = areaTop + (view.priceTop - cachedView.priceTop) / view.pricePerPx;
    const mappedBottomCss = areaTop + (view.priceTop - (cachedView.priceTop - cachedView.areaHeight * cachedView.pricePerPx)) / view.pricePerPx;

    const rawDestLeft = Math.max(areaLeft, mappedLeftCss);
    const rawDestRight = Math.min(areaRight, mappedRightCss);
    const rawDestTop = Math.max(areaTop, mappedTopCss);
    const rawDestBottom = Math.min(areaBottom, mappedBottomCss);

    const { a, d, e, f } = transform;
    const pxLeft = Math.ceil(rawDestLeft * a + e);
    const pxRight = Math.floor(rawDestRight * a + e);
    const pxTop = Math.ceil(rawDestTop * d + f);
    const pxBottom = Math.floor(rawDestBottom * d + f);
    const pxWidth = pxRight - pxLeft;
    const pxHeight = pxBottom - pxTop;
    if (!(pxWidth > 0 && pxHeight > 0)) return false;

    const destLeft = (pxLeft - e) / a;
    const destRight = (pxRight - e) / a;
    const destTop = (pxTop - f) / d;
    const destBottom = (pxBottom - f) / d;
    const destWidth = destRight - destLeft;
    const destHeight = destBottom - destTop;
    if (destWidth < areaWidth * 0.25 || destHeight < areaHeight * 0.25) return false;

    const srcLeftCss = cachedView.areaLeft + cachedView.offsetX + (destLeft - areaLeft - view.offsetX) / scaleX;
    const srcRightCss = cachedView.areaLeft + cachedView.offsetX + (destRight - areaLeft - view.offsetX) / scaleX;
    const srcTopCss = cachedView.areaTop + (cachedView.priceTop - view.priceTop) / cachedView.pricePerPx + (destTop - areaTop) / scaleY;
    const srcBottomCss = cachedView.areaTop + (cachedView.priceTop - view.priceTop) / cachedView.pricePerPx + (destBottom - areaTop) / scaleY;

    const sxRaw = srcLeftCss * cachedView.transformA + cachedView.transformE - this.rasterCacheOriginX;
    const syRaw = srcTopCss * cachedView.transformD + cachedView.transformF - this.rasterCacheOriginY;
    const swRaw = (srcRightCss - srcLeftCss) * cachedView.transformA;
    const shRaw = (srcBottomCss - srcTopCss) * cachedView.transformD;
    if (!(swRaw > 0 && shRaw > 0)) return false;
    const cacheWidth = this.rasterCacheCanvas.width;
    const cacheHeight = this.rasterCacheCanvas.height;
    const sx = Math.max(0, sxRaw);
    const sy = Math.max(0, syRaw);
    const sw = Math.min(cacheWidth - sx, swRaw - (sx - sxRaw));
    const sh = Math.min(cacheHeight - sy, shRaw - (sy - syRaw));
    if (!(sw > 0 && sh > 0)) return false;

    const fixedCeiling = this.resolveFixedCeiling(frame.settings);
    if (
      frame.settings.scaleMode === "fixed" &&
      frame.threshold > 0 &&
      fixedCeiling !== undefined &&
      Number.isFinite(fixedCeiling) &&
      fixedCeiling > 0
    ) {
      this.visibleFloor = frame.threshold;
      this.visibleCeiling = Math.max(fixedCeiling, frame.threshold * HEATMAP_MIN_CEILING_RATIO);
    } else {
      this.visibleFloor = this.rasterCacheFloor;
      this.visibleCeiling = this.rasterCacheCeiling;
    }
    this.visibleThreshold = frame.threshold;
    this.visibleOpacity = this.rasterCacheOpacity;

    const areaMatches =
      cachedView.areaLeft === areaLeft &&
      cachedView.areaTop === areaTop &&
      cachedView.areaWidth === areaWidth &&
      cachedView.areaHeight === areaHeight;
    const rawShiftXPx = (view.offsetX - cachedView.offsetX) * a;
    const rawShiftYPx = ((view.priceTop - cachedView.priceTop) / view.pricePerPx) * d;
    const isIntegerPan =
      !hasCroppedOrigin &&
      scaleX === 1 &&
      scaleY === 1 &&
      areaMatches &&
      Math.abs(rawShiftXPx - Math.round(rawShiftXPx)) < 1e-4 &&
      Math.abs(rawShiftYPx - Math.round(rawShiftYPx)) < 1e-4;
    const offCtx = isIntegerPan ? (this.rasterCacheCanvas.getContext?.("2d") ?? null) : null;
    const canScrollInPlace = Boolean(
      offCtx && typeof offCtx.drawImage === "function" && typeof offCtx.clearRect === "function",
    );

    const drawWidth = Math.max(1, view.colWidth);
    const colPad = view.colWidth < 1 ? 1 : 0;
    const leftFirst = Math.max(frame.first, Math.floor(view.indexOfX(areaLeft - colPad)) - 1);
    let leftLast = Math.min(frame.last, Math.ceil(view.indexOfX(destLeft)));
    while (leftLast >= leftFirst && view.xOfIndex(leftLast) >= destLeft) leftLast--;

    let rightFirst = Math.max(frame.first, Math.floor(view.indexOfX(destRight - colPad)) - 1);
    while (rightFirst <= frame.last && view.xOfIndex(rightFirst) + drawWidth <= destRight) rightFirst++;
    const rightLast = frame.last;

    const topFirst = Math.max(frame.first, Math.floor(view.indexOfX(destLeft - colPad)) - 1);
    const topLast = Math.min(frame.last, Math.ceil(view.indexOfX(destRight)));

    if (canScrollInPlace && offCtx) {
      offCtx.save();
      offCtx.setTransform?.(1, 0, 0, 1, 0, 0);
      offCtx.beginPath();
      offCtx.rect(pxLeft, pxTop, pxWidth, pxHeight);
      offCtx.clip();
      offCtx.globalCompositeOperation = "copy";
      offCtx.imageSmoothingEnabled = false;
      offCtx.drawImage(this.rasterCacheCanvas, sx, sy, sw, sh, pxLeft, pxTop, pxWidth, pxHeight);
      offCtx.restore();

      const clearDeviceStrip = (cssLeft: number, cssTop: number, cssWidth: number, cssHeight: number): void => {
        const dx = Math.floor(cssLeft * a + e);
        const dy = Math.floor(cssTop * d + f);
        const dr = Math.ceil((cssLeft + cssWidth) * a + e);
        const db = Math.ceil((cssTop + cssHeight) * d + f);
        offCtx.save();
        offCtx.setTransform?.(1, 0, 0, 1, 0, 0);
        offCtx.clearRect(dx, dy, Math.max(0, dr - dx), Math.max(0, db - dy));
        offCtx.restore();
      };

      offCtx.save();
      offCtx.setTransform?.(a, 0, 0, d, e, f);
      if (destLeft > areaLeft) {
        clearDeviceStrip(areaLeft, areaTop, destLeft - areaLeft, areaHeight);
        this.paintCellsToContext(offCtx, view, series, frame, leftFirst, leftLast, {
          left: areaLeft,
          top: areaTop,
          width: destLeft - areaLeft,
          height: areaHeight,
        });
      }
      if (destRight < areaRight) {
        clearDeviceStrip(destRight, areaTop, areaRight - destRight, areaHeight);
        this.paintCellsToContext(offCtx, view, series, frame, rightFirst, rightLast, {
          left: destRight,
          top: areaTop,
          width: areaRight - destRight,
          height: areaHeight,
        });
      }
      if (destTop > areaTop) {
        clearDeviceStrip(destLeft, areaTop, destRight - destLeft, destTop - areaTop);
        this.paintCellsToContext(offCtx, view, series, frame, topFirst, topLast, {
          left: destLeft,
          top: areaTop,
          width: destRight - destLeft,
          height: destTop - areaTop,
        });
      }
      if (destBottom < areaBottom) {
        clearDeviceStrip(destLeft, destBottom, destRight - destLeft, areaBottom - destBottom);
        this.paintCellsToContext(offCtx, view, series, frame, topFirst, topLast, {
          left: destLeft,
          top: destBottom,
          width: destRight - destLeft,
          height: areaBottom - destBottom,
        });
      }
      offCtx.restore();

      const replayActive = this.isReplayActive();
      const liveX = series.length > 0 ? view.xOfIndex(series.length - 1) : areaRight;
      cachedView.offsetX = view.offsetX;
      cachedView.priceTop = view.priceTop;
      this.rasterCacheHistRightCss = !replayActive && series.length > 0 ? Math.min(areaRight, liveX) : areaRight;
      const plotPxX = Math.max(0, Math.floor(areaLeft * a + e));
      const plotPxY = Math.max(0, Math.floor(areaTop * d + f));
      const plotPxR = Math.min(canvasWidth, Math.ceil(areaRight * a + e));
      const plotPxB = Math.min(canvasHeight, Math.ceil(areaBottom * d + f));
      this.rasterCacheBlitBounds = plotPxR > plotPxX && plotPxB > plotPxY
        ? { x: plotPxX, y: plotPxY, w: plotPxR - plotPxX, h: plotPxB - plotPxY }
        : null;
      this.blitRasterCache(ctx);

      incrementPerformanceCounter("chart.cpu.heatmap.raster.direct");
      incrementPerformanceCounter("chart.cpu.heatmap.raster.motionReuse");
      return true;
    }

    ctx.save();
    ctx.setTransform?.(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(pxLeft, pxTop, pxWidth, pxHeight);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.rasterCacheCanvas, sx, sy, sw, sh, pxLeft, pxTop, pxWidth, pxHeight);
    ctx.restore();

    if (destLeft > areaLeft) {
      this.paintCellsToContext(ctx, view, series, frame, leftFirst, leftLast, {
        left: areaLeft,
        top: areaTop,
        width: destLeft - areaLeft,
        height: areaHeight,
      });
    }
    if (destRight < areaRight) {
      this.paintCellsToContext(ctx, view, series, frame, rightFirst, rightLast, {
        left: destRight,
        top: areaTop,
        width: areaRight - destRight,
        height: areaHeight,
      });
    }
    if (destTop > areaTop) {
      this.paintCellsToContext(ctx, view, series, frame, topFirst, topLast, {
        left: destLeft,
        top: areaTop,
        width: destRight - destLeft,
        height: destTop - areaTop,
      });
    }
    if (destBottom < areaBottom) {
      this.paintCellsToContext(ctx, view, series, frame, topFirst, topLast, {
        left: destLeft,
        top: destBottom,
        width: destRight - destLeft,
        height: areaBottom - destBottom,
      });
    }

    incrementPerformanceCounter("chart.cpu.heatmap.raster.direct");
    incrementPerformanceCounter("chart.cpu.heatmap.raster.motionReuse");
    return true;
  }

  private tryStaticLiveTailPatch(
    ctx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    frame: HeatmapFramePreamble,
    rasterKey: string,
    rasterDataSig: string,
    canvasWidth: number,
    canvasHeight: number,
    transform: { a: number; b: number; c: number; d: number; e: number; f: number },
    resolved: { floor: number; ceiling: number; opacity: number },
  ): boolean {
    if (
      !this.rasterCacheCanvas ||
      !this.rasterCacheHasCells ||
      this.rasterCacheOriginX !== 0 ||
      this.rasterCacheOriginY !== 0 ||
      this.isReplayActive() ||
      series.length === 0 ||
      this.rasterCacheDataSig !== rasterDataSig ||
      !this.rasterCacheViewMatches(view, transform) ||
      this.rasterCacheCanvas.width !== canvasWidth ||
      this.rasterCacheCanvas.height !== canvasHeight
    ) {
      return false;
    }
    if (
      Math.abs(resolved.floor - this.rasterCacheFloor) > 1e-6 ||
      Math.abs(resolved.ceiling - this.rasterCacheCeiling) > 1e-6
    ) {
      return false;
    }

    const liveIndex = series.length - 1;
    const { left, top, width, height } = view.area;
    const right = left + width;
    const liveX = view.xOfIndex(liveIndex);
    if (liveX < left) return false;

    this.visibleFloor = this.rasterCacheFloor;
    this.visibleCeiling = this.rasterCacheCeiling;

    if (liveX < right) {
      const offCtx = this.ensureRasterCacheCanvas(ctx.canvas.ownerDocument, canvasWidth, canvasHeight);
      if (!offCtx) return false;
      const { a, d, e, f } = transform;
      const pxClearLeft = Math.max(Math.floor(left * a + e), Math.floor(liveX * a + e));
      const clearLeftCss = (pxClearLeft - e) / a;
      const clearWidthCss = right - clearLeftCss;
      if (clearWidthCss > 0) {
        const patchFirst = liveIndex > frame.first && (clearLeftCss < liveX || view.colWidth < 1)
          ? liveIndex - 1
          : liveIndex;
        offCtx.save();
        offCtx.setTransform?.(a, 0, 0, d, e, f);
        offCtx.beginPath();
        offCtx.rect(clearLeftCss, top, clearWidthCss, height);
        offCtx.clip();
        offCtx.clearRect(clearLeftCss, top, clearWidthCss, height);
        this.paintCellsToContext(offCtx, view, series, frame, patchFirst, liveIndex, {
          left: clearLeftCss,
          top,
          width: clearWidthCss,
          height,
        });
        offCtx.restore();
      }
    }

    this.lastRasterKey = rasterKey;
    this.blitRasterCache(ctx);
    incrementPerformanceCounter("chart.cpu.heatmap.raster.tailPatch");
    return true;
  }

  private ensureRasterCacheCanvas(
    doc: Document,
    width: number,
    height: number,
    suppressBudgetCounter = false,
    onBudgetExceeded?: () => void,
  ): CanvasRenderingContext2D | null {
    const requiredBytes = heatmapRasterByteSize(width, height);
    if (requiredBytes === null) {
      this.releaseRasterCache();
      return null;
    }
    if (requiredBytes > HEATMAP_CPU_RASTER_CHART_BUDGET_BYTES) {
      this.releaseRasterCache();
      if (!suppressBudgetCounter) incrementPerformanceCounter("chart.cpu.heatmap.raster.budgetFallback");
      onBudgetExceeded?.();
      return null;
    }

    const otherModuleBytes = Math.max(0, moduleCpuRasterReservedBytes - this.rasterReservedBytes);
    if (otherModuleBytes + requiredBytes > HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES) {
      this.releaseRasterCache();
      if (!suppressBudgetCounter) incrementPerformanceCounter("chart.cpu.heatmap.raster.budgetFallback");
      onBudgetExceeded?.();
      return null;
    }

    const existing = this.rasterCacheCanvas;
    if (
      existing &&
      existing.width === width &&
      existing.height === height &&
      this.rasterReservedBytes === requiredBytes
    ) {
      const existingCtx = existing.getContext?.("2d") ?? null;
      if (existingCtx) return existingCtx;
      this.releaseRasterCache();
      return null;
    }

    // Release prior reservation before resizing/creating so module byte accounting
    // stays exact and a failed resize/context acquisition never leaks bytes.
    if (this.rasterReservedBytes > 0) {
      moduleCpuRasterReservedBytes = Math.max(0, moduleCpuRasterReservedBytes - this.rasterReservedBytes);
      this.rasterReservedBytes = 0;
    }
    this.lastRasterKey = "";
    this.rasterCacheHasCells = false;
    this.rasterCacheDataSig = "";
    this.rasterCacheView = null;
    this.rasterCacheHistRightCss = 0;
    this.rasterCacheOriginX = 0;
    this.rasterCacheOriginY = 0;
    this.rasterCacheBlitBounds = null;

    let canvas = this.rasterCacheCanvas;
    if (!canvas) {
      try {
        canvas = doc.createElement("canvas");
      } catch {
        return null;
      }
      if (!canvas) return null;
      this.rasterCacheCanvas = canvas;
    }

    let offCtx: CanvasRenderingContext2D | null = null;
    try {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      offCtx = canvas.getContext?.("2d") ?? null;
    } catch {
      offCtx = null;
    }
    if (!offCtx) {
      this.releaseRasterCache();
      return null;
    }

    this.rasterReservedBytes = requiredBytes;
    moduleCpuRasterReservedBytes += requiredBytes;
    return offCtx;
  }

  private blitRasterCache(ctx: CanvasRenderingContext2D): void {
    const cache = this.rasterCacheCanvas;
    if (!cache) return;
    ctx.save();
    ctx.setTransform?.(1, 0, 0, 1, 0, 0);
    if (this.rasterCacheOriginX !== 0 || this.rasterCacheOriginY !== 0) {
      ctx.drawImage(
        cache,
        0,
        0,
        cache.width,
        cache.height,
        this.rasterCacheOriginX,
        this.rasterCacheOriginY,
        cache.width,
        cache.height,
      );
    } else if (
      this.rasterCacheBlitBounds
      && cache.width > 0
      && cache.height > 0
      && this.rasterCacheBlitBounds.w * this.rasterCacheBlitBounds.h < cache.width * cache.height * 0.85
    ) {
      const { x, y, w, h } = this.rasterCacheBlitBounds;
      ctx.drawImage(cache, x, y, w, h, x, y, w, h);
    } else {
      ctx.drawImage(cache, 0, 0);
    }
    ctx.restore();
  }

  private pushScratchValue(value: number): void {
    if (this.scratchValueCount === this.scratchValues.length) {
      const next = new Float64Array(this.scratchValues.length * 2);
      next.set(this.scratchValues);
      this.scratchValues = next;
    }
    this.scratchValues[this.scratchValueCount++] = value;
  }

  private resolveFixedCeiling(settings: OrderbookHeatmapSettings): number | undefined {
    return settings.scaleMode === "fixed" ? settings.fixedCeiling?.[settings.unit] : undefined;
  }

  private needsRangeValues(threshold: number, fixedCeiling: number | undefined): boolean {
    return !(threshold > 0 && fixedCeiling !== undefined && Number.isFinite(fixedCeiling) && fixedCeiling > 0);
  }

  private resolveRangeForValues(
    values: ArrayLike<number>,
    settings: OrderbookHeatmapSettings,
    threshold: number,
    fixedCeiling: number | undefined = this.resolveFixedCeiling(settings),
    contrast: OrderbookHeatmapSettings["contrast"] = settings.contrast,
  ): { floor: number; ceiling: number; opacity: number } {
    const { floor, ceiling } = resolveHeatmapColorRange({
      values,
      threshold,
      scaleMode: settings.scaleMode,
      fixedCeiling,
      contrast,
      inPlace: true,
    });
    return {
      floor,
      ceiling,
      opacity: resolveOrderbookHeatmapOpacity(settings.opacity),
    };
  }

  private paintCellsToContext(
    targetCtx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    frame: HeatmapFramePreamble,
    barFirst = frame.first,
    barLast = frame.last,
    clipRect?: { left: number; top: number; width: number; height: number },
    outBounds?: { minX: number; minY: number; maxX: number; maxY: number },
    imageDataTransform?: { a: number; b: number; c: number; d: number; e: number; f: number },
  ): number {
    const { left, top, width, height } = view.area;
    const clipLeft = clipRect ? clipRect.left : left;
    const clipTop = clipRect ? clipRect.top : top;
    const clipWidth = clipRect ? clipRect.width : width;
    const clipHeight = clipRect ? clipRect.height : height;
    if (!(clipWidth > 0 && clipHeight > 0) || barLast < barFirst) return 0;

    const palette = resolveOrderbookHeatmapPalette(frame.settings.palette);
    const floor = this.visibleFloor;
    const ceiling = this.visibleCeiling;
    const colWidth = view.colWidth;
    const drawWidth = Math.max(1, colWidth);
    const hasPositiveFloor = floor > 0;
    const effectiveCeiling = hasPositiveFloor ? Math.max(ceiling, floor * HEATMAP_MIN_CEILING_RATIO) : ceiling;
    const logSpan = hasPositiveFloor ? Math.log10(effectiveCeiling / floor) : 0;
    const log10_101 = Math.log10(101);
    let lastFillStyle = "";
    let paintedCount = 0;

    const canvasW = targetCtx.canvas?.width ?? 0;
    const canvasH = targetCtx.canvas?.height ?? 0;
    let imgData: ImageData | null = null;
    let u32: Uint32Array | null = null;
    let ta = 1;
    let td = 1;
    let te = 0;
    let tf = 0;
    let clipPxLeft = 0;
    let clipPxTop = 0;
    let clipPxRight = 0;
    let clipPxBottom = 0;
    // Narrow overlapping columns (colWidth < 1, where drawWidth = 1 > colWidth) fall back
    // to fillRect to preserve exact Skia 8-bit premultiplied multi-layer coverage parity.
    if (
      imageDataTransform &&
      colWidth >= 1 &&
      imageDataTransform.b === 0 &&
      imageDataTransform.c === 0 &&
      imageDataTransform.a > 0 &&
      imageDataTransform.d > 0 &&
      canvasW > 0 &&
      canvasH > 0 &&
      typeof targetCtx.createImageData === "function" &&
      typeof targetCtx.putImageData === "function"
    ) {
      let cached = this.rasterImageData;
      if (!cached || cached.width !== canvasW || cached.height !== canvasH) {
        try {
          cached = targetCtx.createImageData(canvasW, canvasH);
        } catch {
          cached = null;
        }
        if (cached && cached.data && cached.data.buffer) {
          this.rasterImageData = cached;
          this.rasterImageDataU32 = new Uint32Array(
            cached.data.buffer,
            cached.data.byteOffset,
            cached.data.byteLength >>> 2,
          );
        } else {
          cached = null;
        }
      }
      if (cached && this.rasterImageDataU32) {
        imgData = cached;
        u32 = this.rasterImageDataU32;
        u32.fill(0);
        ta = imageDataTransform.a;
        td = imageDataTransform.d;
        te = imageDataTransform.e;
        tf = imageDataTransform.f;
        clipPxLeft = Math.max(0, Math.floor(clipLeft * ta + te));
        clipPxTop = Math.max(0, Math.floor(clipTop * td + tf));
        clipPxRight = Math.min(canvasW, Math.ceil((clipLeft + clipWidth) * ta + te));
        clipPxBottom = Math.min(canvasH, Math.ceil((clipTop + clipHeight) * td + tf));
      }
    }

    const packedLut = u32 ? getHeatmapPackedRgbaLut(1, this.visibleOpacity, palette) : null;
    const mainLut = u32 ? null : getHeatmapColorLut(1, this.visibleOpacity, palette);

    if (!u32) {
      targetCtx.save();
      targetCtx.beginPath();
      targetCtx.rect(clipLeft, clipTop, clipWidth, clipHeight);
      targetCtx.clip();
    }
    this.forEachVisibleCell(
      view,
      series,
      frame,
      null,
      (x, yTop, cellHeight, value) => {
        let k = 0;
        if (value > 0) {
          if (hasPositiveFloor) {
            if (logSpan > 0) {
              const ratio = Math.log10(value / floor) / logSpan;
              k = ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
            }
          } else if (ceiling > 0) {
            const ratio = Math.log10(1 + (value / ceiling) * 100) / log10_101;
            k = ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
          } else {
            const ratio = Math.log10(1 + value) / 8;
            k = ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
          }
        }
        const q = Math.round(k * 1000);
        if (u32 && packedLut) {
          const srcPacked = packedLut[q];
          if (srcPacked !== 0) {
            const px0 = x * ta + te;
            const px1 = (x + drawWidth) * ta + te;
            const py0 = yTop * td + tf;
            const py1 = (yTop + cellHeight) * td + tf;
            let ix0 = Math.round(px0);
            let ix1 = Math.round(px1);
            let iy0 = Math.round(py0);
            let iy1 = Math.round(py1);
            if (ix1 <= ix0 && px1 > px0) ix1 = ix0 + 1;
            if (iy1 <= iy0 && py1 > py0) iy1 = iy0 + 1;
            if (ix0 < clipPxLeft) ix0 = clipPxLeft;
            if (ix1 > clipPxRight) ix1 = clipPxRight;
            if (iy0 < clipPxTop) iy0 = clipPxTop;
            if (iy1 > clipPxBottom) iy1 = clipPxBottom;
            for (let py = iy0; py < iy1; py++) {
              const rowOffset = py * canvasW;
              for (let px = ix0; px < ix1; px++) {
                const idx = rowOffset + px;
                const dstPacked = u32[idx];
                u32[idx] = dstPacked === 0 ? srcPacked : blendPackedRgbaOver(dstPacked, srcPacked);
              }
            }
          }
        } else if (mainLut) {
          const mainColor = mainLut[q];
          if (mainColor !== lastFillStyle) {
            targetCtx.fillStyle = mainColor;
            lastFillStyle = mainColor;
          }
          targetCtx.fillRect(x, yTop, drawWidth, cellHeight);
        }
        if (outBounds) {
          const cx0 = Math.max(clipLeft, x);
          const cy0 = Math.max(clipTop, yTop);
          const cx1 = Math.min(clipLeft + clipWidth, x + drawWidth);
          const cy1 = Math.min(clipTop + clipHeight, yTop + cellHeight);
          if (cx1 > cx0 && cy1 > cy0) {
            if (cx0 < outBounds.minX) outBounds.minX = cx0;
            if (cy0 < outBounds.minY) outBounds.minY = cy0;
            if (cx1 > outBounds.maxX) outBounds.maxX = cx1;
            if (cy1 > outBounds.maxY) outBounds.maxY = cy1;
          }
        }
        paintedCount++;
      },
      barFirst,
      barLast,
      clipTop,
      clipHeight,
    );
    if (u32 && imgData) {
      if (paintedCount > 0) {
        targetCtx.putImageData(imgData, 0, 0);
      }
    } else {
      targetCtx.restore();
    }
    return paintedCount;
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
    const market = this.getMarket();
    if (this.lastMarket !== "" && market !== this.lastMarket) {
      this.currentTier = null;
      this.canonicalTailBars.clear();
      this.reset("");
    }
    this.lastMarket = market;
    this.syncLiveTailSubscription();
    if (!this.active() || series.length === 0) {
      if (this.settings.mode === "custom" && this.dataKey !== "") {
        this.reset("");
      } else {
        this.releaseRasterCache();
      }
      return null;
    }
    this.lastSeriesLiveBarTime = series.timeOfIndex(series.length - 1);
    const tier = heatmapTierFor(series.config.intervalMs);
    this.currentTier = tier;
    const settings = this.settings;
    const threshold = activeOrderbookHeatmapThreshold(settings);
    // Threshold and unit only filter or convert a compatible mode/sources/tier/step
    // dataset. Raising threshold or switching visual settings reuses the compatible cache.
    const key = this.dataKeyFor(settings, tier);
    if (key !== this.dataKey) this.reset(key);
    this.syncCanonicalTailProjection(settings, tier);
    const first = Math.max(0, Math.floor(range[0]));
    const last = Math.min(series.length - 1, Math.ceil(range[1]));
    if (last < first) {
      this.releaseRasterCache();
      return null;
    }
    this.lastVisibleFromMs = series.timeOfIndex(first);
    this.lastVisibleToMs = series.timeOfIndex(last + 1) - 1;
    // Chunk scheduling runs every frame so a quiet chart still honors the
    // live-refresh TTL and error retries.
    this.ensureChunks(this.lastVisibleFromMs, this.lastVisibleToMs, tier);
    return { settings, tier, threshold, first, last };
  }

  /**
   * Streams the visible density cells through `visit` with primitive args (zero
   * per-cell object allocations). Returns the visible ceiling. With `cellLimit`
   * the scan stops as soon as the limit is reached.
   */
  private forEachVisibleCell(
    view: View,
    series: FootprintSeries,
    frame: { settings: OrderbookHeatmapSettings; tier: HeatmapTier; threshold: number; first: number; last: number },
    cellLimit: number | null,
    visit: (x: number, yTop: number, cellHeight: number, value: number, live: boolean) => void,
    barFirst = frame.first,
    barLast = frame.last,
    clipTop = view.area.top,
    clipHeight = view.area.height,
  ): number {
    const step = frame.settings.bucketStep;
    const clipBottom = clipTop + clipHeight;
    let minVisPrice = Number.NEGATIVE_INFINITY;
    let maxVisPrice = Number.POSITIVE_INFINITY;
    if (typeof view.priceOfY === "function") {
      const pTop = view.priceOfY(clipTop);
      const pBottom = view.priceOfY(clipBottom);
      if (Number.isFinite(pTop) && Number.isFinite(pBottom)) {
        minVisPrice = Math.min(pTop, pBottom);
        maxVisPrice = Math.max(pTop, pBottom);
      }
    }
    const threshold = frame.threshold;
    const unit = frame.settings.unit;
    const liveIndex = this.isReplayActive() ? -1 : series.length - 1;
    const sortedTimes = this.subBarTimesFor(series, frame.tier);
    const isLinearFast =
      !(typeof view.isLogScale === "function" && view.isLogScale()) &&
      !Object.hasOwn(view, "yOfPrice") &&
      Number.isFinite(view.priceTop) &&
      view.pricePerPx > 0;
    const areaTop = view.area.top;
    const priceTop = view.priceTop;
    const pricePerPx = view.pricePerPx;
    let ceiling = 0;
    let emitted = 0;
    for (let index = barFirst; index <= barLast; index++) {
      const live = index === liveIndex;
      const bar = (live ? liveHeatmapSubBar : lastHeatmapSubBar)(
        this.bars, series.timeOfIndex(index), series.timeOfIndex(index + 1), frame.tier, sortedTimes);
      if (!bar || bar.cells.length === 0) continue;
      let cells: readonly OrderbookHeatmapCell[] = bar.cells;
      let sparseValues: readonly number[] | null = null;
      if (threshold > 0) {
        const sparse = getHeatmapThresholdSparseBar(bar, unit, threshold, step);
        if (sparse.maxValue < threshold || sparse.cells.length === 0) continue;
        cells = sparse.cells;
        sparseValues = sparse.values;
      }
      const x = view.xOfIndex(index);
      const { start: cStart, end: cEnd } = visibleHeatmapCellBounds(cells, minVisPrice, maxVisPrice, step);
      for (let c = cStart; c < cEnd; c++) {
        const cell = cells[c];
        const priceStart = cell[0];
        if (priceStart + step < minVisPrice || priceStart > maxVisPrice) continue;
        const yTop = isLinearFast
          ? areaTop + (priceTop - (priceStart + step)) / pricePerPx
          : view.yOfPrice(priceStart + step);
        const yBottom = isLinearFast
          ? areaTop + (priceTop - priceStart) / pricePerPx
          : view.yOfPrice(priceStart);
        if (yBottom < clipTop || yTop > clipBottom) continue;
        const value = sparseValues ? sparseValues[c] : heatmapValueInUnit(heatmapCellUsd(cell), priceStart, step, unit);
        if (threshold > 0 && value < threshold) continue;
        if (value > ceiling) ceiling = value;
        if (cellLimit !== null && emitted >= cellLimit) return ceiling;
        visit(x, yTop, Math.max(1, yBottom - yTop), value, live);
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
   */
  prepareGpuCells(
    view: View,
    series: FootprintSeries,
    range: [number, number],
    reserve?: (logicalBytes: number) => { release(): void } | null,
  ): HeatmapGpuCellFrame | null {
    if (!reserve) {
      const visible = this.collectVisibleCells(view, series, range, GPU_MAX_PREPARED_CELLS);
      if (!visible || visible.length >= GPU_MAX_PREPARED_CELLS) return null;
      return this.buildGpuFrame(visible, view);
    }
    const preamble = this.beginFrame(series, range);
    if (!preamble) return null;
    const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
    try {
      return this.prepareReservedGpuCells(preamble, view, series, reserve);
    } finally {
      if (startedAt !== null) recordPerformanceDuration("chart.gpu.heatmap.prepare.ms", performance.now() - startedAt);
    }
  }

  /** The production (reserved) prepare after the shared frame preamble; see `prepareGpuCells`. */
  private prepareReservedGpuCells(
    preamble: HeatmapFramePreamble,
    view: View,
    series: FootprintSeries,
    reserve: (logicalBytes: number) => { release(): void } | null,
  ): HeatmapGpuCellFrame | null {
    const { top, height } = view.area;
    const step = preamble.settings.bucketStep;
    const fixedCeiling = this.resolveFixedCeiling(preamble.settings);
    const replayActive = this.isReplayActive();
    const scalePlan = this.evaluateAutoScale(view, series, preamble.settings, preamble.threshold, fixedCeiling, replayActive);
    const sortedTimes = this.subBarTimesFor(series, preamble.tier);
    let minVisPrice = Number.NEGATIVE_INFINITY;
    let maxVisPrice = Number.POSITIVE_INFINITY;
    if (typeof view.priceOfY === "function") {
      const pTop = view.priceOfY(top);
      const pBottom = view.priceOfY(top + height);
      if (Number.isFinite(pTop) && Number.isFinite(pBottom)) {
        minVisPrice = Math.min(pTop, pBottom);
        maxVisPrice = Math.max(pTop, pBottom);
      }
    }
    let resolved: { floor: number; ceiling: number; opacity: number };
    if (scalePlan.needsScan) {
      const scanned = this.resolveAutoScaleValues(
        view,
        series,
        preamble,
        scalePlan,
        fixedCeiling,
        replayActive,
      );
      resolved = scanned.resolved;
    } else {
      resolved = {
        floor: scalePlan.floor,
        ceiling: scalePlan.ceiling,
        opacity: resolveOrderbookHeatmapOpacity(preamble.settings.opacity),
      };
    }

    let mainCount = 0;
    const liveIndex = replayActive ? -1 : series.length - 1;
    const isLinearFast =
      !(typeof view.isLogScale === "function" && view.isLogScale()) &&
      !Object.hasOwn(view, "yOfPrice") &&
      Number.isFinite(view.priceTop) &&
      view.pricePerPx > 0;
    const priceTop = view.priceTop;
    const pricePerPx = view.pricePerPx;
    for (let index = preamble.first; index <= preamble.last; index++) {
      const live = index === liveIndex;
      const bar = (live ? liveHeatmapSubBar : lastHeatmapSubBar)(
        this.bars, series.timeOfIndex(index), series.timeOfIndex(index + 1), preamble.tier, sortedTimes);
      if (!bar || bar.cells.length === 0) continue;
      let cells: readonly OrderbookHeatmapCell[] = bar.cells;
      if (preamble.threshold > 0) {
        const sparse = getHeatmapThresholdSparseBar(bar, preamble.settings.unit, preamble.threshold, step);
        if (sparse.maxValue < preamble.threshold || sparse.cells.length === 0) continue;
        cells = sparse.cells;
      }
      const { start: cStart, end: cEnd } = visibleHeatmapCellBounds(cells, minVisPrice, maxVisPrice, step);
      for (let c = cStart; c < cEnd; c++) {
        const cell = cells[c];
        const priceStart = cell[0];
        if (priceStart + step < minVisPrice || priceStart > maxVisPrice) continue;
        const yTop = isLinearFast
          ? top + (priceTop - (priceStart + step)) / pricePerPx
          : view.yOfPrice(priceStart + step);
        const yBottom = isLinearFast
          ? top + (priceTop - priceStart) / pricePerPx
          : view.yOfPrice(priceStart);
        if (yBottom < top || yTop > top + height) continue;
        mainCount++;
      }
    }
    this.visibleFloor = resolved.floor;
    this.visibleCeiling = resolved.ceiling;
    this.visibleThreshold = preamble.threshold;
    this.visibleOpacity = resolved.opacity;
    const palette = resolveOrderbookHeatmapPalette(preamble.settings.palette);
    if (mainCount === 0) {
      return {
        main: [],
        extension: [],
        ceiling: resolved.ceiling,
        threshold: preamble.threshold,
        floor: resolved.floor,
        opacity: resolved.opacity,
        palette,
        dataKey: this.dataKey,
        contentRevision: ++this.gpuFrameContentRevision,
      };
    }
    if (mainCount >= GPU_MAX_PREPARED_CELLS) return null;
    const logicalBytes = mainCount * (PREPARED_ENTRY_PAYLOAD_BYTES + PREPARED_MAIN_RECT_PAYLOAD_BYTES
      + PREPARED_INSTANCE_PAYLOAD_BYTES);
    if (!Number.isSafeInteger(logicalBytes) || logicalBytes <= 0) return null;
    const lease = reserve(logicalBytes);
    if (!lease) return null;
    try {
      const visible: Array<{ x: number; yTop: number; cellHeight: number; value: number; live: boolean }> = [];
      this.forEachVisibleCell(view, series, preamble, GPU_MAX_PREPARED_CELLS, (x, yTop, cellHeight, value, live) => {
        visible.push({ x, yTop, cellHeight, value, live });
      });
      if (visible.length !== mainCount || visible.length >= GPU_MAX_PREPARED_CELLS) {
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

  /**
   * Builds a lightweight descriptor for the WebGPU resident vertex-projected heatmap pipeline.
   * Skips `prepareReservedGpuCells` and cell-rect array allocations entirely, freezing Auto P96
   * range computation during active viewport motion (within `HEATMAP_CPU_RASTER_QUIET_MS`) and
   * scanning raw `bar.cells` once settled or when visible/data inputs change.
   */
  prepareResidentGpuScene(
    view: View,
    series: FootprintSeries,
    range: [number, number],
  ): GpuNativeHeatmapResidentFrame | null {
    const preamble = this.beginFrame(series, range);
    if (!preamble) return null;
    const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
    try {
      const unit = preamble.settings.unit;
      const step = preamble.settings.bucketStep;
      const threshold = preamble.threshold;
      const replayActive = this.isReplayActive();
      const seriesStartTime = series.length > 0 ? series.timeOfIndex(0) : Number.NaN;
      const seriesStructRev = (series as { structureRevision?: number }).structureRevision ?? 0;
      const prevLastBarTime = series.length >= 2 ? series.timeOfIndex(series.length - 2) : Number.NaN;

      const findSampleBarPrice = (): number | null => {
        const candidates = [
          series.length > 0 ? this.bars.get(series.timeOfIndex(preamble.first)) : undefined,
          series.length > 0 ? this.bars.get(seriesStartTime) : undefined,
          this.bars.values().next().value,
        ];
        for (const bar of candidates) {
          const samplePrice = bar?.cells?.[0]?.[0];
          if (typeof samplePrice === "number" && Number.isFinite(samplePrice)) {
            return Math.floor(samplePrice);
          }
        }
        return null;
      };

      const structureReset =
        !Number.isFinite(this.residentPriceOrigin)
        || (!this.residentPriceOriginInitializedFromBars && this.bars.size > 0)
        || this.lastResidentSeries !== series
        || this.lastResidentUnit !== unit
        || !Number.isFinite(this.residentCoverageThreshold)
        || threshold < this.residentCoverageThreshold
        || this.lastResidentReplayActive !== replayActive
        || this.lastResidentSeriesStartTime !== seriesStartTime
        || (series.length === this.lastResidentSeriesLength && seriesStructRev !== this.lastResidentSeriesStructureRevision)
        || (series.length === this.lastResidentSeriesLength + 1 && series.length >= 2 && prevLastBarTime !== this.lastResidentPrevLastBarTime)
        || series.length < this.lastResidentSeriesLength
        || series.length > this.lastResidentSeriesLength + 1;

      if (structureReset) {
        this.gpuSyncGeneration++;
        this.residentDirtyFromTime = Number.POSITIVE_INFINITY;
        this.residentCoverageThreshold = threshold;
        const sampleOrigin = findSampleBarPrice();
        if (sampleOrigin !== null) {
          this.residentPriceOrigin = sampleOrigin;
          this.residentPriceOriginInitializedFromBars = true;
        } else {
          this.residentPriceOrigin = Number.isFinite(view.priceTop) ? Math.floor(view.priceTop) : 0;
          this.residentPriceOriginInitializedFromBars = false;
        }
        this.autoScaleCache = null;
        this.autoScaleHistCache = null;
      } else if (series.length === this.lastResidentSeriesLength + 1) {
        this.liveTailSyncRevision++;
      }

      this.lastResidentSeries = series;
      this.lastResidentSeriesStructureRevision = seriesStructRev;
      this.lastResidentPrevLastBarTime = series.length > 0 ? series.timeOfIndex(series.length - 1) : Number.NaN;
      this.lastResidentUnit = unit;
      this.lastResidentReplayActive = replayActive;
      this.lastResidentSeriesStartTime = seriesStartTime;
      this.lastResidentSeriesLength = series.length;

      const fixedCeiling = this.resolveFixedCeiling(preamble.settings);
      const opacity = resolveOrderbookHeatmapOpacity(preamble.settings.opacity);
      const palette = resolveOrderbookHeatmapPalette(preamble.settings.palette);
      const scalePlan = this.evaluateAutoScale(view, series, preamble.settings, threshold, fixedCeiling, replayActive);
      let resolved: { floor: number; ceiling: number; opacity: number };
      if (scalePlan.needsScan) {
        const scanned = this.resolveAutoScaleValues(
          view,
          series,
          preamble,
          scalePlan,
          fixedCeiling,
          replayActive,
        );
        resolved = scanned.resolved;
      } else {
        resolved = {
          floor: scalePlan.floor,
          ceiling: scalePlan.ceiling,
          opacity,
        };
      }

      this.visibleFloor = resolved.floor;
      this.visibleCeiling = resolved.ceiling;
      this.visibleThreshold = threshold;
      this.visibleOpacity = resolved.opacity;

      let dirtyFromBarIndex: number | undefined;
      if (Number.isFinite(this.residentDirtyFromTime) && series.length > 0) {
        const searchStart = Math.max(0, series.length - 12);
        if (searchStart > 0 && this.residentDirtyFromTime < series.timeOfIndex(searchStart)) {
          this.gpuSyncGeneration++;
        } else {
          for (let i = searchStart; i < series.length; i++) {
            if (series.timeOfIndex(i + 1) > this.residentDirtyFromTime) {
              dirtyFromBarIndex = i;
              break;
            }
          }
        }
        this.residentDirtyFromTime = Number.POSITIVE_INFINITY;
      }

      const liveIndex = replayActive ? -1 : series.length - 1;
      const tier = preamble.tier;
      const bars = this.bars;
      const sortedTimes = this.subBarTimesFor(series, tier);
      const uploadThreshold = this.residentCoverageThreshold;
      return {
        syncGeneration: this.gpuSyncGeneration,
        tailSyncRevision: this.liveTailSyncRevision,
        barCount: series.length,
        priceOrigin: this.residentPriceOrigin,
        bucketStep: step,
        liveBarIndex: liveIndex,
        dataKey: this.dataKey,
        view: {
          offsetX: view.offsetX,
          colWidth: view.colWidth,
          priceTop: view.priceTop,
          pricePerPx: view.pricePerPx,
        },
        floor: resolved.floor,
        ceiling: resolved.ceiling,
        threshold,
        opacity: resolved.opacity,
        palette,
        ...(dirtyFromBarIndex !== undefined ? { dirtyFromBarIndex } : {}),
        visibleRange: [preamble.first, preamble.last],
        readBarCells: (barIndex: number): readonly GpuNativeHeatmapResidentCell[] => {
          if (barIndex < 0 || barIndex >= series.length) return [];
          const isLive = barIndex === liveIndex;
          const bar = (isLive ? liveHeatmapSubBar : lastHeatmapSubBar)(
            bars, series.timeOfIndex(barIndex), series.timeOfIndex(barIndex + 1), tier, sortedTimes);
          if (!bar || bar.cells.length === 0) return [];
          const out: GpuNativeHeatmapResidentCell[] = [];
          for (const cell of bar.cells) {
            const priceStart = cell[0];
            const value = heatmapValueInUnit(heatmapCellUsd(cell), priceStart, step, unit);
            if (value <= 0 || (uploadThreshold > 0 && value < uploadThreshold)) continue;
            out.push({ priceStart, value, liveEligible: isLive });
          }
          return out;
        },
      };
    } finally {
      if (startedAt !== null) {
        recordPerformanceDuration("chart.gpu.heatmap.residentPrepare.ms", performance.now() - startedAt);
      }
    }
  }

  /** Builds the GPU instance frame from an already collected visible list. */
  private buildGpuFrame(
    visible: Array<{ x: number; yTop: number; cellHeight: number; value: number; live: boolean }>,
    view: View,
  ): HeatmapGpuCellFrame {
    const mainWidth = Math.max(1, view.colWidth);
    const main: HeatmapGpuCellFrame["main"] = [];
    for (const cell of visible) {
      main.push({ x: cell.x, yTop: cell.yTop, width: mainWidth, height: cell.cellHeight, value: cell.value });
    }
    return {
      main,
      extension: [],
      ceiling: this.visibleCeiling,
      threshold: this.visibleThreshold,
      floor: this.visibleFloor,
      opacity: this.visibleOpacity,
      palette: resolveOrderbookHeatmapPalette(this.settings.palette),
      dataKey: this.dataKey,
      contentRevision: ++this.gpuFrameContentRevision,
    };
  }

  /** Returns the currently active palette identifier. */
  getActivePalette(): OrderbookHeatmapPalette {
    return resolveOrderbookHeatmapPalette(this.settings.palette);
  }

  /** Returns the currently active heatmap opacity. */
  getActiveOpacity(): number {
    return resolveOrderbookHeatmapOpacity(this.settings.opacity);
  }

  /** Identifies what the cached bars were fetched for; used for GPU/annotation frame agreement. */
  currentDataKey(): string {
    return this.dataKey;
  }

  /**
   * Returns a deterministic cache key for GPU prepare inputs (while running
   * `beginFrame` chunk TTL and error retry scheduling), or `null` when nothing can be drawn.
   */
  getPrepareCacheKey(view: View, series: FootprintSeries, range: [number, number]): string | null {
    const frame = this.beginFrame(series, range);
    if (!frame) return null;
    return this.frameCacheKey(view, series, frame, false, false);
  }

  private scheduleScaleSettleTimer(): void {
    if (this.scaleSettleTimer) clearTimeout(this.scaleSettleTimer);
    this.scaleSettleTimer = setTimeout(() => {
      this.scaleSettleTimer = null;
      if (!this.disposed && this.active()) {
        this.invalidate();
      }
    }, HEATMAP_CPU_RASTER_QUIET_MS);
  }

  private evaluateAutoScale(
    view: View,
    series: FootprintSeries,
    settings: OrderbookHeatmapSettings,
    threshold: number,
    fixedCeiling: number | undefined,
    replayActive: boolean,
  ):
    | { needsScan: false; floor: number; ceiling: number }
    | { needsScan: true; scaleInputSig: string; viewportKey: string; contrast: NonNullable<OrderbookHeatmapSettings["contrast"]> } {
    const viewportKey =
      `${view.offsetX}|${view.colWidth}|${view.priceTop}|${view.pricePerPx}|${view.area.left}|${view.area.top}|${view.area.width}|${view.area.height}`;
    const needsRange = this.needsRangeValues(threshold, fixedCeiling);
    const contrast = needsRange ? (settings.contrast ?? "medium") : "medium";
    const seriesStructRev = (series as { structureRevision?: number }).structureRevision ?? 0;
    const scaleInputSig =
      `${this.dataKey}|${settings.unit}|${threshold}|${settings.scaleMode ?? "auto"}|${fixedCeiling ?? ""}|${contrast}|${replayActive}|${seriesIdentityId(series)}|${seriesStructRev}`;
    const now = this.now();
    if (this.scaleViewportKey !== "" && this.scaleViewportKey !== viewportKey) {
      this.scaleViewportChangedAt = now;
      if (needsRange) {
        this.scheduleScaleSettleTimer();
      }
    }
    this.scaleViewportKey = viewportKey;

    if (!needsRange) {
      return {
        needsScan: false,
        floor: threshold,
        ceiling: Math.max(fixedCeiling!, threshold * HEATMAP_MIN_CEILING_RATIO),
      };
    }

    const isMoving =
      this.scaleViewportChangedAt > Number.NEGATIVE_INFINITY
      && (now - this.scaleViewportChangedAt) < HEATMAP_CPU_RASTER_QUIET_MS;
    const canReuseFrozen =
      this.autoScaleCache !== null
      && this.autoScaleInputSig === scaleInputSig
      && (this.autoScaleCache.hadCells || this.bars.size === 0)
      && (isMoving || (this.autoScaleViewportKey === viewportKey && this.autoScaleBarsRevision === this.barsRevision));
    if (canReuseFrozen) {
      return {
        needsScan: false,
        floor: this.autoScaleCache!.floor,
        ceiling: this.autoScaleCache!.ceiling,
      };
    }
    return {
      needsScan: true,
      scaleInputSig,
      viewportKey,
      contrast,
    };
  }

  private commitAutoScale(
    scaleInputSig: string,
    viewportKey: string,
    floor: number,
    ceiling: number,
    cellCount: number,
    scanMs: number | null,
  ): void {
    this.autoScaleCache = { floor, ceiling, hadCells: cellCount > 0 };
    this.autoScaleInputSig = scaleInputSig;
    this.autoScaleViewportKey = viewportKey;
    this.autoScaleBarsRevision = this.barsRevision;
    incrementPerformanceCounter("chart.heatmap.scale.scan.count");
    incrementPerformanceCounter("chart.heatmap.scale.scan.cells", cellCount);
    if (scanMs !== null) {
      recordPerformanceDuration("chart.heatmap.scale.scan.ms", scanMs);
    }
  }

  private subBarTimesFor(series: FootprintSeries, tier: HeatmapTier): readonly number[] | undefined {
    if (series.config.intervalMs <= tier.periodMs) return undefined;
    if (this.sortedBarTimesKeysRevision !== this.barKeysRevision) {
      const times = Array.from(this.bars.keys());
      times.sort((a, b) => a - b);
      this.sortedBarTimes = times;
      this.sortedBarTimesKeysRevision = this.barKeysRevision;
    }
    return this.sortedBarTimes;
  }

  private pushLiveScratchValue(value: number): void {
    if (this.liveScratchValueCount === this.liveScratchValues.length) {
      const next = new Float64Array(this.liveScratchValues.length * 2);
      next.set(this.liveScratchValues);
      this.liveScratchValues = next;
    }
    this.liveScratchValues[this.liveScratchValueCount++] = value;
  }

  private resolveAutoScaleValues(
    view: View,
    series: FootprintSeries,
    frame: HeatmapFramePreamble,
    scalePlan: { scaleInputSig: string; viewportKey: string; contrast: NonNullable<OrderbookHeatmapSettings["contrast"]> },
    fixedCeiling: number | undefined,
    replayActive: boolean,
  ): { resolved: { floor: number; ceiling: number; opacity: number }; knownCellCount: number } {
    const scanStart = isPerformanceTelemetryEnabled() ? performance.now() : null;
    const liveIndex = replayActive ? -1 : series.length - 1;
    const step = frame.settings.bucketStep;
    const unit = frame.settings.unit;
    const threshold = frame.threshold;
    const sortedTimes = this.subBarTimesFor(series, frame.tier);

    let minVisPrice = Number.NEGATIVE_INFINITY;
    let maxVisPrice = Number.POSITIVE_INFINITY;
    if (typeof view.priceOfY === "function") {
      const pTop = view.priceOfY(view.area.top);
      const pBottom = view.priceOfY(view.area.top + view.area.height);
      if (Number.isFinite(pTop) && Number.isFinite(pBottom)) {
        minVisPrice = Math.min(pTop, pBottom);
        maxVisPrice = Math.max(pTop, pBottom);
      }
    }

    const histCache = this.autoScaleHistCache;
    const canIncrementalLive =
      !replayActive
      && histCache !== null
      && histCache.scaleInputSig === scalePlan.scaleInputSig
      && histCache.viewportKey === scalePlan.viewportKey
      && histCache.historicalBarsRevision === this.historicalBarsRevision
      && histCache.first === frame.first
      && histCache.last === frame.last
      && histCache.liveIndex === liveIndex;

    if (canIncrementalLive) {
      this.liveScratchValueCount = 0;
      let liveCells = 0;
      if (liveIndex >= frame.first && liveIndex <= frame.last) {
        const bar = liveHeatmapSubBar(
          this.bars,
          series.timeOfIndex(liveIndex),
          series.timeOfIndex(liveIndex + 1),
          frame.tier,
          sortedTimes,
        );
        if (bar && bar.cells.length > 0) {
          const { start: cStart, end: cEnd } = visibleHeatmapCellBounds(bar.cells, minVisPrice, maxVisPrice, step);
          for (let c = cStart; c < cEnd; c++) {
            const cell = bar.cells[c];
            const priceStart = cell[0];
            if (priceStart + step < minVisPrice || priceStart > maxVisPrice) continue;
            const yTop = view.yOfPrice(priceStart + step);
            const yBottom = view.yOfPrice(priceStart);
            if (yBottom < view.area.top || yTop > view.area.top + view.area.height) continue;
            const value = heatmapValueInUnit(heatmapCellUsd(cell), priceStart, step, unit);
            if (threshold > 0 && value < threshold) continue;
            liveCells++;
            if (value > 0) this.pushLiveScratchValue(value);
          }
        }
      }
      const liveSlice = this.liveScratchValues.subarray(0, this.liveScratchValueCount);
      liveSlice.sort();
      const rangeRes = resolveHeatmapColorRangeFromTwoSorted({
        histSorted: histCache.histSorted,
        histCount: histCache.histCount,
        liveSorted: liveSlice,
        liveCount: this.liveScratchValueCount,
        threshold,
        scaleMode: frame.settings.scaleMode,
        fixedCeiling,
        contrast: scalePlan.contrast,
      });
      this.liveScratchValueCount = 0;
      const resolved = {
        floor: rangeRes.floor,
        ceiling: rangeRes.ceiling,
        opacity: resolveOrderbookHeatmapOpacity(frame.settings.opacity),
      };
      this.commitAutoScale(
        scalePlan.scaleInputSig,
        scalePlan.viewportKey,
        resolved.floor,
        resolved.ceiling,
        liveCells,
        scanStart !== null ? performance.now() - scanStart : null,
      );
      return { resolved, knownCellCount: histCache.histCells + liveCells };
    }

    this.scratchValueCount = 0;
    this.liveScratchValueCount = 0;
    let histCells = 0;
    let liveCells = 0;
    for (let index = frame.first; index <= frame.last; index++) {
      const live = index === liveIndex;
      const bar = (live ? liveHeatmapSubBar : lastHeatmapSubBar)(
        this.bars,
        series.timeOfIndex(index),
        series.timeOfIndex(index + 1),
        frame.tier,
        sortedTimes,
      );
      if (!bar || bar.cells.length === 0) continue;
      const { start: cStart, end: cEnd } = visibleHeatmapCellBounds(bar.cells, minVisPrice, maxVisPrice, step);
      for (let c = cStart; c < cEnd; c++) {
        const cell = bar.cells[c];
        const priceStart = cell[0];
        if (priceStart + step < minVisPrice || priceStart > maxVisPrice) continue;
        const yTop = view.yOfPrice(priceStart + step);
        const yBottom = view.yOfPrice(priceStart);
        if (yBottom < view.area.top || yTop > view.area.top + view.area.height) continue;
        const value = heatmapValueInUnit(heatmapCellUsd(cell), priceStart, step, unit);
        if (threshold > 0 && value < threshold) continue;
        if (live) {
          liveCells++;
          if (value > 0) this.pushLiveScratchValue(value);
        } else {
          histCells++;
          if (value > 0) this.pushScratchValue(value);
        }
      }
    }

    const histCount = this.scratchValueCount;
    const liveCount = this.liveScratchValueCount;
    const histSlice = this.scratchValues.subarray(0, histCount);
    const liveSlice = this.liveScratchValues.subarray(0, liveCount);
    histSlice.sort();
    liveSlice.sort();

    if (!replayActive && histCount <= 250_000) {
      this.autoScaleHistCache = {
        scaleInputSig: scalePlan.scaleInputSig,
        viewportKey: scalePlan.viewportKey,
        historicalBarsRevision: this.historicalBarsRevision,
        first: frame.first,
        last: frame.last,
        liveIndex,
        histSorted: histSlice.slice(),
        histCount,
        histCells,
      };
    } else {
      this.autoScaleHistCache = null;
    }

    const rangeRes = resolveHeatmapColorRangeFromTwoSorted({
      histSorted: histSlice,
      histCount,
      liveSorted: liveSlice,
      liveCount,
      threshold,
      scaleMode: frame.settings.scaleMode,
      fixedCeiling,
      contrast: scalePlan.contrast,
    });
    this.scratchValueCount = 0;
    this.liveScratchValueCount = 0;
    const resolved = {
      floor: rangeRes.floor,
      ceiling: rangeRes.ceiling,
      opacity: resolveOrderbookHeatmapOpacity(frame.settings.opacity),
    };
    const totalCells = histCells + liveCells;
    this.commitAutoScale(
      scalePlan.scaleInputSig,
      scalePlan.viewportKey,
      resolved.floor,
      resolved.ceiling,
      totalCells,
      scanStart !== null ? performance.now() - scanStart : null,
    );
    return { resolved, knownCellCount: totalCells };
  }

  /** Threshold of the last collected frame; 0 before the first draw/prepare. */
  private visibleThreshold = 0;
  /** Bumped whenever acknowledged book data merges; part of the collection memo key. */
  private barsRevision = 0;
  /** Bumped only when bar timestamp keys are added, deleted, evicted, or reset. */
  private barKeysRevision = 0;
  /** Bumped only when non-live historical bars or resets/evictions change. */
  private historicalBarsRevision = 0;
  /** Bumped when GPU-resident dataset must rebuild (reset, eviction, history shift, unit/threshold change). */
  private gpuSyncGeneration = 0;
  /** Bumped when only live tail bars or rollover bar update. */
  private liveTailSyncRevision = 0;
  private lastResidentUnit: OrderbookHeatmapUnit | null = null;
  private residentCoverageThreshold = Number.NaN;
  private lastResidentReplayActive: boolean | null = null;
  private lastResidentSeries: FootprintSeries | null = null;
  private lastResidentSeriesStructureRevision = -1;
  private lastResidentPrevLastBarTime = Number.NaN;
  private lastResidentSeriesStartTime = Number.NaN;
  private lastResidentSeriesLength = 0;
  private residentPriceOrigin = Number.NaN;
  private residentPriceOriginInitializedFromBars = false;
  private residentDirtyFromTime = Number.POSITIVE_INFINITY;
  private sortedBarTimes: number[] = [];
  private sortedBarTimesKeysRevision = -1;
  private gpuFrameContentRevision = 0;
  private scaleViewportKey = "";
  private scaleViewportChangedAt = Number.NEGATIVE_INFINITY;
  private scaleSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private autoScaleCache: { floor: number; ceiling: number; hadCells: boolean } | null = null;
  private autoScaleHistCache: {
    scaleInputSig: string;
    viewportKey: string;
    historicalBarsRevision: number;
    first: number;
    last: number;
    liveIndex: number;
    histSorted: Float64Array;
    histCount: number;
    histCells: number;
  } | null = null;
  private autoScaleInputSig = "";
  private autoScaleViewportKey = "";
  private autoScaleBarsRevision = -1;
  private lastSeriesLiveBarTime = Number.NEGATIVE_INFINITY;
  /** Same-frame collection memo: one visible list per frame shared by the GPU prepare and the legacy draw. */
  private lastCollectedKey = "";
  private lastCollected: Array<{ x: number; yTop: number; cellHeight: number; value: number; live: boolean }> | null = null;
  private lastCollectedRange: { floor: number; ceiling: number; threshold: number; opacity: number } | null = null;
  private lastRasterKey = "";
  private rasterCacheCanvas: HTMLCanvasElement | null = null;
  private rasterReservedBytes = 0;
  private rasterCacheHasCells = false;
  private rasterCacheFloor = 0;
  private rasterCacheCeiling = 0;
  private rasterCacheThreshold = 0;
  private rasterCacheOpacity = 0.85;
  private rasterCacheDataSig = "";
  private rasterCacheView: {
    offsetX: number;
    colWidth: number;
    priceTop: number;
    pricePerPx: number;
    areaLeft: number;
    areaTop: number;
    areaWidth: number;
    areaHeight: number;
    transformA: number;
    transformD: number;
    transformE: number;
    transformF: number;
  } | null = null;
  private rasterCacheHistRightCss = 0;
  private rasterCacheOriginX = 0;
  private rasterCacheOriginY = 0;
  private rasterCacheBlitBounds: { x: number; y: number; w: number; h: number } | null = null;
  private rasterImageData: ImageData | null = null;
  private rasterImageDataU32: Uint32Array | null = null;

  private frameCacheKey(
    view: View,
    series: FootprintSeries,
    frame: HeatmapFramePreamble,
    includePalette = true,
    includeOpacity = true,
  ): string {
    const opacityPart = includeOpacity ? resolveOrderbookHeatmapOpacity(frame.settings.opacity) : "";
    const scaleMode = frame.settings.scaleMode ?? "auto";
    const fixedCeiling = scaleMode === "fixed" ? (frame.settings.fixedCeiling?.[frame.settings.unit] ?? 0) : 0;
    const contrast = frame.settings.contrast ?? "medium";
    const palettePart = includePalette ? resolveOrderbookHeatmapPalette(frame.settings.palette) : "";
    const seriesStructRev = (series as { structureRevision?: number }).structureRevision ?? 0;
    return `${this.dataKey}|${frame.settings.unit}|${frame.threshold}|${opacityPart}|${scaleMode}|${fixedCeiling}|${contrast}|${palettePart}|${this.barsRevision}|${seriesIdentityId(series)}|${seriesStructRev}|${series.length}|${frame.first}|${frame.last}|${this.isReplayActive()}|${view.colWidth}|${view.offsetX}|${view.area.left}|${view.area.top}|${view.area.width}|${view.area.height}|${view.priceTop}|${view.pricePerPx}|${view.priceScaleMode}`;
  }

  /** Collects the visible density cells and refreshes chunk requests/ceiling. */
  private collectVisibleCells(
    view: View,
    series: FootprintSeries,
    range: [number, number],
    cellLimit: number | null = null,
  ): Array<{ x: number; yTop: number; cellHeight: number; value: number; live: boolean }> | null {
    const frame = this.beginFrame(series, range);
    if (!frame) return null;
    const collectKey = this.frameCacheKey(view, series, frame);
    if (cellLimit === null && this.lastCollectedKey === collectKey && this.lastCollected && this.lastCollectedRange) {
      this.visibleFloor = this.lastCollectedRange.floor;
      this.visibleCeiling = this.lastCollectedRange.ceiling;
      this.visibleThreshold = this.lastCollectedRange.threshold;
      this.visibleOpacity = this.lastCollectedRange.opacity;
      return this.lastCollected;
    }
    const visible: Array<{ x: number; yTop: number; cellHeight: number; value: number; live: boolean }> = [];
    const fixedCeiling = this.resolveFixedCeiling(frame.settings);
    const collectRangeValues = this.needsRangeValues(frame.threshold, fixedCeiling);
    this.scratchValueCount = 0;
    this.forEachVisibleCell(view, series, frame, cellLimit, (x, yTop, cellHeight, value, live) => {
      visible.push({ x, yTop, cellHeight, value, live });
      if (collectRangeValues && value > 0) this.pushScratchValue(value);
    });
    const resolved = this.resolveRangeForValues(
      this.scratchValues.subarray(0, this.scratchValueCount),
      frame.settings,
      frame.threshold,
      fixedCeiling,
    );
    this.scratchValueCount = 0;
    this.visibleFloor = resolved.floor;
    this.visibleCeiling = resolved.ceiling;
    this.visibleThreshold = frame.threshold;
    this.visibleOpacity = resolved.opacity;
    if (cellLimit === null) {
      this.lastCollectedKey = collectKey;
      this.lastCollected = visible;
      this.lastCollectedRange = {
        floor: resolved.floor,
        ceiling: resolved.ceiling,
        threshold: frame.threshold,
        opacity: resolved.opacity,
      };
    }
    return visible;
  }

  private evictStaleChunks(tier: HeatmapTier): void {
    if (this.chunks.size <= OrderbookHeatmapOverlay.MAX_CACHED_CHUNKS) {
      this.evictStaleLiveBars(tier);
      return;
    }
    const now = this.now();
    const candidates: Array<{ chunkStart: number; chunkEnd: number; fetchedAt: number }> = [];

    for (const [chunkStart, state] of this.chunks) {
      if (state.status === "loading") continue;
      const chunkEnd = heatmapChunkEnd(chunkStart, tier);
      const isLive = now <= chunkEnd + tier.periodMs;
      if (isLive) continue;
      const isVisible = chunkEnd >= this.lastVisibleFromMs && chunkStart <= this.lastVisibleToMs;
      if (isVisible) continue;
      candidates.push({ chunkStart, chunkEnd, fetchedAt: state.fetchedAt });
    }

    candidates.sort((a, b) => a.fetchedAt - b.fetchedAt);

    let evictedAny = false;
    while (this.chunks.size > OrderbookHeatmapOverlay.MAX_CACHED_CHUNKS && candidates.length > 0) {
      const { chunkStart, chunkEnd } = candidates.shift()!;
      this.chunks.delete(chunkStart);
      this.chunkCoverage.delete(chunkStart);
      for (const barTime of [...this.bars.keys()]) {
        if (barTime >= chunkStart && barTime < chunkEnd) {
          this.bars.delete(barTime);
          this.liveBarTimes.delete(barTime);
          evictedAny = true;
        }
      }
    }

    if (evictedAny) {
      this.barKeysRevision++;
      this.bumpBarsRevision();
    }
    this.evictStaleLiveBars(tier);
  }

  private evictStaleLiveBars(tier: HeatmapTier): boolean {
    if (this.liveBarTimes.size === 0) return false;
    const hasVisibleRange = this.lastVisibleToMs > this.lastVisibleFromMs;
    const nonVisibleLiveTimes: number[] = [];
    let totalLiveCells = 0;

    for (const barTime of [...this.liveBarTimes]) {
      const bar = this.bars.get(barTime);
      if (!bar) {
        this.liveBarTimes.delete(barTime);
        continue;
      }
      totalLiveCells += bar.cells.length;
      const isVisible = hasVisibleRange && barTime >= this.lastVisibleFromMs && barTime <= this.lastVisibleToMs;
      if (!isVisible) {
        nonVisibleLiveTimes.push(barTime);
      }
    }

    if (nonVisibleLiveTimes.length <= MAX_LIVE_TAIL_BARS && totalLiveCells <= MAX_LIVE_TAIL_CELLS) {
      return false;
    }

    nonVisibleLiveTimes.sort((a, b) => a - b);
    let remainingNonVisible = nonVisibleLiveTimes.length;
    let remainingCells = totalLiveCells;
    const now = this.now();
    const touchedChunks = new Set<number>();
    let evictedAny = false;

    for (const barTime of nonVisibleLiveTimes) {
      if (remainingNonVisible <= 1) break;
      if (remainingNonVisible <= MAX_LIVE_TAIL_BARS && remainingCells <= MAX_LIVE_TAIL_CELLS) break;
      const bar = this.bars.get(barTime);
      if (bar) {
        remainingCells -= bar.cells.length;
      }
      this.bars.delete(barTime);
      this.liveBarTimes.delete(barTime);
      remainingNonVisible--;
      touchedChunks.add(heatmapChunkStart(barTime, tier));
      evictedAny = true;
    }

    for (const chunkStart of touchedChunks) {
      const state = this.chunks.get(chunkStart);
      if (!state || state.status === "loading") continue;
      const chunkEnd = heatmapChunkEnd(chunkStart, tier);
      const isLiveChunk = now <= chunkEnd + tier.periodMs;
      const isVisibleChunk = hasVisibleRange && chunkEnd >= this.lastVisibleFromMs && chunkStart <= this.lastVisibleToMs;
      if (!isLiveChunk && !isVisibleChunk) {
        this.chunks.delete(chunkStart);
        this.chunkCoverage.delete(chunkStart);
      }
    }

    if (evictedAny) {
      this.barKeysRevision++;
      this.bumpBarsRevision();
    }
    return evictedAny;
  }

  private ensureChunks(from: number, to: number, tier: HeatmapTier): void {
    const now = this.now();
    const key = this.dataKey;
    const threshold = activeOrderbookHeatmapThreshold(this.settings);
    const unit = this.settings.unit;
    for (const chunkStart of heatmapChunksFor(from, Math.min(to, now), tier)) {
      const chunkEnd = heatmapChunkEnd(chunkStart, tier);
      const state = this.chunks.get(chunkStart);
      const live = now <= chunkEnd + tier.periodMs;
      const emptyKey = `${key}|${unit}|${threshold}|${chunkStart}`;
      if (!live && this.emptyChunkKeys.has(emptyKey)) continue;
      if (state?.status === "loading") continue;
      if (state?.status === "error" && now - state.fetchedAt < RETRY_MS) continue;

      const isSameUnit = state?.unit === unit;
      const needsFullRefetch = state?.status === "ready" && (!isSameUnit || state.fullThreshold > threshold);
      const needsLowerTailThreshold = state?.status === "ready" && isSameUnit && state.threshold > threshold;
      const needsLowerThresholdData = needsFullRefetch || needsLowerTailThreshold;

      // Live chunk: when live-tail subscription is healthy, suppress blind 20s REST refresh; otherwise refresh every 20s
      if (state?.status === "ready") {
        if (needsLowerThresholdData) {
          // Keep old compatible cells visible while the chunk refreshes.
        } else {
          if (!live) continue;
          if (this.isLiveTailHealthy(now)) continue;
          if (now - state.fetchedAt < LIVE_REFRESH_MS) continue;
        }
      }
      if (this.inFlight.size >= MAX_PARALLEL_CHUNKS) return;
      // A live chunk that is already loaded only re-reads its last few bars unless its full-chunk coverage needs lowering or unit changed.
      const refreshFrom = state?.status === "ready" && !needsFullRefetch
        ? Math.max(chunkStart, Math.floor(now / tier.periodMs) * tier.periodMs - 2 * tier.periodMs)
        : chunkStart;
      const fullThreshold = refreshFrom === chunkStart ? threshold : (state?.fullThreshold ?? threshold);
      const fullUnit = refreshFrom === chunkStart ? unit : (state?.fullUnit ?? unit);
      this.chunks.set(chunkStart, {
        status: "loading",
        fetchedAt: state?.fetchedAt ?? 0,
        threshold,
        unit,
        fullThreshold,
        fullUnit,
      });
      this.emitStatus();
      const controller = new AbortController();
      this.inFlight.add(controller);
      this.fetchHeatmap({
        ...this.baseRequest(tier),
        ...this.thresholdParams(),
        from: refreshFrom,
        to: chunkEnd,
      }, controller.signal).then((response) => {
        if (key !== this.dataKey || controller.signal.aborted) return;
        const changed = this.mergeIntoBars(response.bars);
        this.recordChunkCoverage(chunkStart, response);
        const liveSettings = this.settings;
        let dataChanged = changed.length > 0;
        if (liveSettings.mode === "custom" && tier.name === "1m" && this.canonicalTailBars.size > 0 && this.isLiveTailHealthy(this.now())) {
          const prevRev = this.barsRevision;
          this.reprojectCanonicalTailBars(liveSettings, tier, changed, refreshFrom > chunkStart);
          dataChanged = dataChanged || this.barsRevision !== prevRev;
        } else {
          this.bumpBarsRevision(changed, refreshFrom > chunkStart);
        }
        this.lastErrorCode = undefined;
        this.lastErrorMessage = undefined;
        if (!live && refreshFrom === chunkStart && response.bars.length === 0) {
          this.chunks.delete(chunkStart);
          if (this.emptyChunkKeys.size >= OrderbookHeatmapOverlay.MAX_EMPTY_CHUNK_KEYS) {
            const oldest = this.emptyChunkKeys.values().next().value;
            if (oldest !== undefined) this.emptyChunkKeys.delete(oldest);
          }
          this.emptyChunkKeys.add(emptyKey);
        } else {
          this.emptyChunkKeys.delete(emptyKey);
          this.chunks.set(chunkStart, {
            status: "ready",
            fetchedAt: this.now(),
            threshold,
            unit,
            fullThreshold,
            fullUnit,
          });
          this.evictStaleChunks(tier);
        }
        this.emitStatus();
        if (dataChanged || state?.status !== "ready") this.invalidate();
      }, (error: unknown) => {
        if (key !== this.dataKey || controller.signal.aborted) return;
        const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;
        const message = error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : undefined;
        this.lastErrorCode = code;
        this.lastErrorMessage = message;
        this.chunks.set(chunkStart, {
          status: state?.status === "ready" ? "ready" : "error",
          fetchedAt: this.now(),
          threshold: state?.threshold ?? threshold,
          unit: state?.unit ?? unit,
          fullThreshold: state?.fullThreshold ?? fullThreshold,
          fullUnit: state?.fullUnit ?? fullUnit,
        });
        this.emitStatus();
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
    const expectedKey = this.dataKeyFor(settings, tier);
    if (expectedKey !== this.dataKey) this.reset(expectedKey);
    this.syncCanonicalTailProjection(settings, tier);
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
    const replayActive = this.isReplayActive();
    const liveSlot = !replayActive && columns[columns.length - 1] === series.length - 1
      ? Math.floor(this.now() / LIVE_REFRESH_MS)
      : 0;
    const sourcesKey = settings.mode === "custom"
      ? normalizeOrderbookHeatmapSources(settings.customSources ?? []).join(",")
      : "";
    const hoverKey = `${this.dataKey}|${sourcesKey}|${windowFrom}|${windowTo}|${bucket}|${replayActive}|${liveSlot}`;
    const hover = this.hoverWindows.get(hoverKey);
    if (this.pointerDragging || this.isViewportMoving()) {
      if (this.hoverTimer) {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
        this.pendingHoverKey = "";
      }
    } else if (!hover) {
      this.scheduleHover(hoverKey, series, columns, rows, tier);
    }

    const threshold = activeOrderbookHeatmapThreshold(settings);
    const values = rows.map((price) => columns.map((index) => {
      if (hover?.status !== "ready") return null;
      const live = !replayActive && index === series.length - 1;
      const bar = (live ? liveHeatmapSubBar : lastHeatmapSubBar)(
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
      floor: this.visibleFloor > 0 ? this.visibleFloor : threshold,
      ceiling: this.visibleCeiling,
      opacity: resolveOrderbookHeatmapOpacity(settings.opacity),
      palette: resolveOrderbookHeatmapPalette(settings.palette),
      unit: settings.unit,
      failed: hover?.status === "error",
    });
  }

  private abortAllHoverRequests(): void {
    for (const req of this.hoverRangeRequests.values()) {
      req.controller.abort();
    }
    this.hoverRangeRequests.clear();
    for (const [hoverKey, hover] of this.hoverWindows) {
      if (hover.status === "loading") {
        this.hoverWindows.delete(hoverKey);
      }
    }
    this.hoverConsumerRanges.clear();
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
      if (key !== this.dataKey || !this.active()) {
        if (this.pendingHoverKey === hoverKey) this.pendingHoverKey = "";
        return;
      }
      const market = this.getMarket();
      const rangeKeys = ranges.map(([from, to]) => `${market}|${key}|${priceFrom}|${priceTo}|${tier.name}|${from}|${to}`);
      const neededKeys = new Set(rangeKeys);

      // Drop superseded hover consumers and abort only unshared old range requests first so the new hover is prioritized.
      for (const [otherHoverKey, otherRanges] of [...this.hoverConsumerRanges]) {
        if (otherHoverKey === hoverKey) continue;
        for (const rKey of otherRanges) {
          const req = this.hoverRangeRequests.get(rKey);
          if (!req) continue;
          req.consumers.delete(otherHoverKey);
          if (req.consumers.size === 0 && !neededKeys.has(rKey)) {
            req.controller.abort();
            this.hoverRangeRequests.delete(rKey);
          }
        }
        this.hoverConsumerRanges.delete(otherHoverKey);
        const otherHover = this.hoverWindows.get(otherHoverKey);
        if (otherHover?.status === "loading") {
          this.hoverWindows.delete(otherHoverKey);
        }
      }

      const hover: HoverWindow = { status: "loading", bars: new Map() };
      this.rememberHover(hoverKey, hover);
      this.hoverConsumerRanges.set(hoverKey, new Set(rangeKeys));

      const rangePromises = ranges.map(([from, to], idx) => {
        const rKey = rangeKeys[idx];
        const existing = this.hoverRangeRequests.get(rKey);
        if (existing && !existing.controller.signal.aborted) {
          existing.consumers.add(hoverKey);
          return existing.promise;
        }
        const controller = new AbortController();
        const req: HoverRangeRequest = {
          key: rKey,
          controller,
          promise: null as unknown as Promise<OrderbookHeatmapResponse>,
          consumers: new Set([hoverKey]),
        };
        const promise = this.fetchHeatmap({ ...base, from, to, priceFrom, priceTo }, controller.signal)
          .finally(() => {
            if (this.hoverRangeRequests.get(rKey) === req) {
              this.hoverRangeRequests.delete(rKey);
            }
          });
        req.promise = promise;
        this.hoverRangeRequests.set(rKey, req);
        return promise;
      });

      Promise.all(rangePromises)
        .then((responses) => {
          if (key !== this.dataKey || market !== this.getMarket() || this.disposed) return;
          if (this.hoverWindows.get(hoverKey) !== hover) return;
          for (const response of responses) mergeHeatmapBars(hover.bars, response.bars);
          hover.status = "ready";
        }, () => {
          if (key !== this.dataKey || market !== this.getMarket() || this.disposed) return;
          if (this.hoverWindows.get(hoverKey) !== hover) return;
          hover.status = "error";
        })
        .finally(() => {
          this.hoverConsumerRanges.delete(hoverKey);
          if (this.pendingHoverKey === hoverKey) this.pendingHoverKey = "";
          if (key === this.dataKey && market === this.getMarket() && !this.disposed && this.hoverWindows.get(hoverKey) === hover) {
            this.invalidate();
          }
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

  /** Read-only test seam: returns cached bars count. */
  cachedBarsCount(): number {
    return this.bars.size;
  }

  /** Read-only test seam: returns cached chunks count. */
  cachedChunksCount(): number {
    return this.chunks.size;
  }

  /** Read-only test seam: returns chunk status for a chunk start time. */
  chunkStatus(chunkStart: number): "loading" | "ready" | "error" | undefined {
    return this.chunks.get(chunkStart)?.status;
  }

  /** Read-only seam / diagnostics: returns RGBA bytes held by this overlay's CPU raster cache. */
  reservedRasterBytes(): number {
    return this.rasterReservedBytes;
  }

  /** Read-only test seam: returns whether live tail is considered healthy. */
  isLiveTailHealthyForTest(): boolean {
    return this.isLiveTailHealthy(this.now());
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
  floor: number;
  ceiling: number;
  opacity: number;
  palette: OrderbookHeatmapPalette;
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
      if (value !== null && value > 0 && (table.threshold === 0 || value >= table.threshold)) {
        const floor = table.floor > 0 ? table.floor : table.threshold;
        ctx.fillStyle = heatmapCellColor(
          heatmapIntensity(value, floor, Math.max(table.ceiling, value)),
          1,
          table.opacity,
          table.palette,
        );
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

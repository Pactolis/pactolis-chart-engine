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
  LiveHeatmapTailEvent,
  LiveHeatmapTailRequest,
  OrderbookHeatmapBar,
  OrderbookHeatmapRequest,
  OrderbookHeatmapResponse,
} from "./heatmapContracts.js";
import {
  HEATMAP_HOVER_SPAN,
  HEATMAP_WINDOW_MAX_BARS,
  formatHeatmapValue,
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
  projectCanonicalHeatmapTailBar,
  resolveHeatmapColorRange,
  type HeatmapTier,
} from "./heatmapModel.js";
import type { HeatmapGpuCellFrame } from "../chart/heatmap/gpu/heatmapGpuRenderer.js";

export type { LiveHeatmapTailEvent, LiveHeatmapTailRequest } from "./heatmapContracts.js";

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
const PREPARED_EXT_RECT_PAYLOAD_BYTES = 160;
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

export interface OrderbookHeatmapOverlayOptions {
  fetch: OrderbookHeatmapFetch;
  invalidate: () => void;
  /** The chart's current market; the overlay only draws on the BTCUSDT perp chart. */
  getMarket: () => string;
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
  private readonly fetchHeatmap: OrderbookHeatmapFetch;
  private readonly invalidate: () => void;
  private readonly now: () => number;
  private readonly getMarket: () => string;
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
  private chunks = new Map<number, ChunkState>();
  private chunkCoverage = new Map<number, OrderbookHeatmapCoverage>();
  private inFlight = new Set<AbortController>();
  private hoverWindows = new Map<string, HoverWindow>();
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingHoverKey = "";
  /** Resolved floor and ceiling of the last drawn/prepared frame. */
  private visibleFloor = 0;
  private visibleCeiling = 0;
  private visibleOpacity = 0.85;
  private scratchPositiveValues: number[] = [];
  private explicitVisible = true;
  private rasterCacheDisabledForTest = false;
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
    }
  };
  private readonly liveTimer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;

  constructor(options: OrderbookHeatmapOverlayOptions) {
    this.fetchHeatmap = options.fetch;
    this.invalidate = options.invalidate;
    this.getMarket = options.getMarket;
    this.isReplayActive = options.isReplayActive ?? (() => false);
    this.now = options.now ?? Date.now;
    this.subscribeLiveTail = options.subscribeLiveTail;
    this.liveDebounceMs = Math.max(50, options.liveDebounceMs ?? DEFAULT_LIVE_DEBOUNCE_MS);
    this.lastMarket = this.getMarket();
    this.unsubscribe = orderbookHeatmapSettingsSource().onChange(() => {
      if (this.currentTier) {
        const nextSettings = this.trySettings();
        if (nextSettings && nextSettings.mode === "custom" && !this.activeFor(nextSettings)) {
          if (this.dataKey !== "") this.reset("");
        } else if (nextSettings && nextSettings.mode !== "off" && this.activeFor(nextSettings)) {
          const nextKey = this.dataKeyFor(nextSettings, this.currentTier);
          if (nextKey !== this.dataKey) this.reset(nextKey);
        }
      }
      this.syncLiveTailSubscription();
      this.invalidate();
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

  /** Shared settings with the mode saved for the chart's current pair. */
  private get settings(): OrderbookHeatmapSettings {
    return orderbookHeatmapSettingsSource().settingsFor(this.getMarket());
  }

  private trySettings(): OrderbookHeatmapSettings | null {
    try {
      return orderbookHeatmapSettingsSource().settingsFor(this.getMarket());
    } catch {
      return null;
    }
  }

  private liveTailKeyFor(market: string, settings: OrderbookHeatmapSettings | null): string {
    if (!settings) return `${market}|unconfigured`;
    const sourceKey = settings.mode === "custom"
      ? normalizeOrderbookHeatmapSources(settings.customSources ?? []).join(",")
      : "";
    return `${market}|${settings.mode}|${sourceKey}|${settings.unit}|${settings.bucketStep}|${activeOrderbookHeatmapThreshold(settings)}`;
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
    if (!settings || settings.mode === "off" || customDisabled || !isOrderbookHeatmapMarket(market)) {
      this.releaseRasterCache();
    }
    if (!this.subscribeLiveTail) return;
    if (customDisabled) {
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
    const request: LiveHeatmapTailRequest = {
      market,
      ...(parsed.base ? { base: parsed.base } : {}),
    };
    if (settings) {
      request.bucketStep = settings.bucketStep;
      if (settings.mode === "custom") {
        request.source = "custom";
        request.sources = customSources;
      }
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
    this.reset("");
    this.syncLiveTailSubscription();
  }

  /** Whether the live-tail subscription is actively receiving events. */
  private isLiveTailHealthy(now: number): boolean {
    return Boolean(this.subscribeLiveTail && this.lastLiveEventAt > 0 && now - this.lastLiveEventAt < LIVE_TAIL_IDLE_FALLBACK_MS);
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
        const settings = this.settings;
        const threshold = activeOrderbookHeatmapThreshold(settings);
        const source = settings.mode === "custom" ? "custom" : settings.mode === "single" ? "single" : "aggregated";
        barsToMerge = event.canonicalBars.map((bar) => projectCanonicalHeatmapTailBar(bar, {
          source,
          customSources: settings.customSources,
          bucketStep: settings.bucketStep,
          ...(settings.unit === "btc" ? { minBtc: threshold } : { minUsd: threshold }),
        }));
      }
      if (barsToMerge && barsToMerge.length > 0) {
        mergeHeatmapBars(this.bars, barsToMerge);
        this.barsRevision++;
        // Mark current live chunk as refreshed if loaded
        const liveChunkStart = heatmapChunkStart(now, this.currentTier);
        const existing = this.chunks.get(liveChunkStart);
        if (existing && existing.status === "ready") {
          existing.fetchedAt = now;
        }
        this.invalidate();
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
      mergeHeatmapBars(this.bars, response.bars);
      this.recordChunkCoverage(chunkStart, response);
      this.barsRevision++;
      this.chunks.set(chunkStart, {
        status: "ready",
        fetchedAt: this.now(),
        threshold,
        unit,
        fullThreshold,
        fullUnit,
      });
      this.evictStaleChunks(tier);
      this.invalidate();
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
    this.unsubscribe();
    this.unsubscribeLiveTail?.();
    this.unsubscribeLiveTail = null;
    this.liveTailRequestKey = "";
    this.releaseVisibilityTracking();
    this.reset("");
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
    this.pendingHoverKey = "";
    this.lastLiveEventAt = 0;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.dataKey = key;
    this.bars = new Map();
    this.chunks = new Map();
    this.chunkCoverage = new Map();
    this.hoverWindows = new Map();
    // Dropping the data identity also releases the owned same-frame visible list.
    this.lastCollectedKey = "";
    this.lastCollected = null;
    this.lastCollectedRange = null;
    this.releaseRasterCache();
    this.barsRevision++;
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

  private thresholdParams(): Pick<OrderbookHeatmapRequest, "minUsd" | "minBtc"> {
    const threshold = activeOrderbookHeatmapThreshold(this.settings);
    return this.settings.unit === "btc" ? { minBtc: threshold } : { minUsd: threshold };
  }

  /** Updates explicit panel visibility; hiding immediately releases the CPU raster cache. */
  setVisible(visible: boolean): void {
    this.explicitVisible = visible;
    if (!visible) {
      this.releaseRasterCache();
    }
  }

  /** Test-only seam: bypasses CPU raster caching so direct painting can be measured on identical viewports. */
  setRasterCacheDisabledForTest(disabled: boolean): void {
    this.rasterCacheDisabledForTest = disabled;
    if (disabled) {
      this.releaseRasterCache();
    }
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
    const frame = this.beginFrame(series, range);
    if (!frame) return;
    this.syncVisibilityTracking(ctx.canvas);
    const hidden = this.isVisibilityHidden(ctx.canvas);
    if (hidden) {
      this.releaseRasterCache();
    }
    const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
    try {
      const canvasWidth = ctx.canvas?.width ?? 0;
      const canvasHeight = ctx.canvas?.height ?? 0;
      const rasterKey = `${this.frameCacheKey(view, series, frame)}|${canvasWidth}|${canvasHeight}`;
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

      // Streaming CPU path: two passes (range resolution, then paint) with an O(1)-held
      // payload. It never builds or reuses the whole-visible collection list.
      this.scratchPositiveValues.length = 0;
      let cells = 0;
      this.forEachVisibleCell(view, series, frame, null, ({ value }) => {
        cells++;
        if (value > 0) this.scratchPositiveValues.push(value);
      });
      const resolved = this.resolveRangeForValues(this.scratchPositiveValues, frame.settings, frame.threshold);
      this.scratchPositiveValues.length = 0;
      this.visibleFloor = resolved.floor;
      this.visibleCeiling = resolved.ceiling;
      this.visibleThreshold = frame.threshold;
      this.visibleOpacity = resolved.opacity;
      if (cells === 0) {
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

      if (canUseRasterCache) {
        const offCtx = this.ensureRasterCacheCanvas(ctx.canvas.ownerDocument, canvasWidth, canvasHeight);
        if (offCtx) {
          offCtx.save();
          offCtx.setTransform?.(1, 0, 0, 1, 0, 0);
          offCtx.clearRect(0, 0, canvasWidth, canvasHeight);
          const transform = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
          if (transform && Number.isFinite(transform.a) && Number.isFinite(transform.d)) {
            offCtx.setTransform?.(
              transform.a,
              transform.b,
              transform.c,
              transform.d,
              transform.e,
              transform.f,
            );
          } else {
            const dpr = view.pixelRatio !== null && view.pixelRatio !== undefined && view.pixelRatio > 0
              ? view.pixelRatio
              : 1;
            offCtx.setTransform?.(dpr, 0, 0, dpr, 0, 0);
          }
          this.paintCellsToContext(offCtx, view, series, frame);
          offCtx.restore();
          this.lastRasterKey = rasterKey;
          this.rasterCacheHasCells = true;
          this.rasterCacheFloor = resolved.floor;
          this.rasterCacheCeiling = resolved.ceiling;
          this.rasterCacheThreshold = frame.threshold;
          this.rasterCacheOpacity = resolved.opacity;
          this.blitRasterCache(ctx);
          incrementPerformanceCounter("chart.cpu.heatmap.raster.miss");
          return;
        }
      }

      incrementPerformanceCounter("chart.cpu.heatmap.raster.direct");
      this.paintCellsToContext(ctx, view, series, frame);
    } finally {
      if (startedAt !== null) recordPerformanceDuration("chart.cpu.heatmap.draw.ms", performance.now() - startedAt);
    }
  }

  private ensureRasterCacheCanvas(
    doc: Document,
    width: number,
    height: number,
  ): CanvasRenderingContext2D | null {
    const requiredBytes = heatmapRasterByteSize(width, height);
    if (requiredBytes === null) {
      this.releaseRasterCache();
      return null;
    }
    if (requiredBytes > HEATMAP_CPU_RASTER_CHART_BUDGET_BYTES) {
      this.releaseRasterCache();
      incrementPerformanceCounter("chart.cpu.heatmap.raster.budgetFallback");
      return null;
    }

    const otherModuleBytes = Math.max(0, moduleCpuRasterReservedBytes - this.rasterReservedBytes);
    if (otherModuleBytes + requiredBytes > HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES) {
      this.releaseRasterCache();
      incrementPerformanceCounter("chart.cpu.heatmap.raster.budgetFallback");
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
    if (!this.rasterCacheCanvas) return;
    ctx.save();
    ctx.setTransform?.(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.rasterCacheCanvas, 0, 0);
    ctx.restore();
  }

  private resolveRangeForValues(
    values: readonly number[],
    settings: OrderbookHeatmapSettings,
    threshold: number,
  ): { floor: number; ceiling: number; opacity: number } {
    const fixedCeiling = settings.scaleMode === "fixed"
      ? settings.fixedCeiling?.[settings.unit]
      : undefined;
    const { floor, ceiling } = resolveHeatmapColorRange({
      values,
      threshold,
      scaleMode: settings.scaleMode,
      fixedCeiling,
      contrast: settings.contrast,
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
  ): void {
    const { left, top, width, height } = view.area;
    const right = left + width;
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.rect(left, top, width, height);
    targetCtx.clip();
    this.forEachVisibleCell(view, series, frame, null, ({ x, yTop, cellHeight, value, live }) => {
      const intensity = heatmapIntensity(value, this.visibleFloor, this.visibleCeiling);
      targetCtx.fillStyle = heatmapCellColor(intensity, 1, this.visibleOpacity);
      targetCtx.fillRect(x, yTop, Math.max(1, view.colWidth), cellHeight);
      // The live bar's walls continue across the empty space right of the last candle.
      if (live && x + view.colWidth < right) {
        targetCtx.fillStyle = heatmapCellColor(intensity, 0.45, this.visibleOpacity);
        targetCtx.fillRect(x + view.colWidth, yTop, right - x - view.colWidth, cellHeight);
      }
    });
    targetCtx.restore();
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
    const tier = heatmapTierFor(series.config.intervalMs);
    this.currentTier = tier;
    const settings = this.settings;
    const threshold = activeOrderbookHeatmapThreshold(settings);
    // Threshold and unit only filter or convert a compatible mode/sources/tier/step
    // dataset. Raising threshold or switching visual settings reuses the compatible cache.
    const key = this.dataKeyFor(settings, tier);
    if (key !== this.dataKey) this.reset(key);
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
   * Streams the visible density cells through `visit` without retaining a
   * whole-visible list; only the transient per-cell object exists. Returns
   * the visible ceiling. With `cellLimit` the scan stops as soon as the
   * limit is reached (bounded known payload before any list allocation).
   */
  private forEachVisibleCell(
    view: View,
    series: FootprintSeries,
    frame: { settings: OrderbookHeatmapSettings; tier: HeatmapTier; threshold: number; first: number; last: number },
    cellLimit: number | null,
    visit: (cell: { x: number; yTop: number; cellHeight: number; value: number; live: boolean }) => void,
  ): number {
    const step = frame.settings.bucketStep;
    const { top, height } = view.area;
    let ceiling = 0;
    let emitted = 0;
    for (let index = frame.first; index <= frame.last; index++) {
      const live = !this.isReplayActive() && index === series.length - 1;
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
    let mainCount = 0;
    let extCount = 0;
    this.scratchPositiveValues.length = 0;
    for (let index = preamble.first; index <= preamble.last; index++) {
      const live = !this.isReplayActive() && index === series.length - 1;
      const bar = (live ? liveHeatmapSubBar : lastHeatmapSubBar)(
        this.bars, series.timeOfIndex(index), series.timeOfIndex(index + 1), preamble.tier);
      if (!bar || bar.cells.length === 0) continue;
      const x = view.xOfIndex(index);
      for (const cell of bar.cells) {
        const yTop = view.yOfPrice(cell[0] + step);
        const yBottom = view.yOfPrice(cell[0]);
        if (yBottom < top || yTop > top + height) continue;
        const value = heatmapValueInUnit(heatmapCellUsd(cell), cell[0], step, preamble.settings.unit);
        if (value > 0) this.scratchPositiveValues.push(value);
        mainCount++;
        if (live && x + view.colWidth < right) extCount++;
      }
    }
    const resolved = this.resolveRangeForValues(this.scratchPositiveValues, preamble.settings, preamble.threshold);
    this.scratchPositiveValues.length = 0;
    this.visibleFloor = resolved.floor;
    this.visibleCeiling = resolved.ceiling;
    this.visibleThreshold = preamble.threshold;
    this.visibleOpacity = resolved.opacity;
    if (mainCount === 0) {
      return {
        main: [],
        extension: [],
        ceiling: resolved.ceiling,
        threshold: preamble.threshold,
        floor: resolved.floor,
        opacity: resolved.opacity,
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
      floor: this.visibleFloor,
      opacity: this.visibleOpacity,
      dataKey: this.dataKey,
    };
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
    return this.frameCacheKey(view, series, frame);
  }

  /** Threshold of the last collected frame; 0 before the first draw/prepare. */
  private visibleThreshold = 0;
  /** Bumped whenever acknowledged book data merges; part of the collection memo key. */
  private barsRevision = 0;
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

  private frameCacheKey(view: View, series: FootprintSeries, frame: HeatmapFramePreamble): string {
    const opacity = resolveOrderbookHeatmapOpacity(frame.settings.opacity);
    const scaleMode = frame.settings.scaleMode ?? "auto";
    const fixedCeiling = scaleMode === "fixed" ? (frame.settings.fixedCeiling?.[frame.settings.unit] ?? 0) : 0;
    const contrast = frame.settings.contrast ?? "medium";
    return `${this.dataKey}|${frame.settings.unit}|${frame.threshold}|${opacity}|${scaleMode}|${fixedCeiling}|${contrast}|${this.barsRevision}|${series.length}|${frame.first}|${frame.last}|${this.isReplayActive()}|${view.colWidth}|${view.offsetX}|${view.area.left}|${view.area.top}|${view.area.width}|${view.area.height}|${view.priceTop}|${view.pricePerPx}|${view.priceScaleMode}`;
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
    this.scratchPositiveValues.length = 0;
    this.forEachVisibleCell(view, series, frame, cellLimit, (cell) => {
      visible.push(cell);
      if (cell.value > 0) this.scratchPositiveValues.push(cell.value);
    });
    const resolved = this.resolveRangeForValues(this.scratchPositiveValues, frame.settings, frame.threshold);
    this.scratchPositiveValues.length = 0;
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
    if (this.chunks.size <= OrderbookHeatmapOverlay.MAX_CACHED_CHUNKS) return;
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
          evictedAny = true;
        }
      }
    }

    if (evictedAny) {
      this.barsRevision++;
    }
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
        this.recordChunkCoverage(chunkStart, response);
        this.barsRevision++;
        this.chunks.set(chunkStart, {
          status: "ready",
          fetchedAt: this.now(),
          threshold,
          unit,
          fullThreshold,
          fullUnit,
        });
        this.evictStaleChunks(tier);
        this.invalidate();
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
    if (!hover) this.scheduleHover(hoverKey, series, columns, rows, tier);

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
      if (key !== this.dataKey || !this.active()) {
        if (this.pendingHoverKey === hoverKey) this.pendingHoverKey = "";
        return;
      }
      const controller = new AbortController();
      this.inFlight.add(controller);
      const hover: HoverWindow = { status: "loading", bars: new Map() };
      this.rememberHover(hoverKey, hover);
      Promise.all(ranges.map(([from, to]) => this.fetchHeatmap({ ...base, from, to, priceFrom, priceTo }, controller.signal)))
        .then((responses) => {
          if (key !== this.dataKey || controller.signal.aborted) return;
          for (const response of responses) mergeHeatmapBars(hover.bars, response.bars);
          hover.status = "ready";
        }, () => {
          if (key !== this.dataKey || controller.signal.aborted) return;
          hover.status = "error";
        })
        .finally(() => {
          this.inFlight.delete(controller);
          if (this.pendingHoverKey === hoverKey) this.pendingHoverKey = "";
          if (key === this.dataKey && !controller.signal.aborted) this.invalidate();
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

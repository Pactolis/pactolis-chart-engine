import { BoundedCache } from "../../../core/cache/boundedCache.js";
import { DAY_MS, DEFAULT_ZSCORE_MIN_SPAN_MS, rollingZScore } from "../../../core/analysis/rollingZScore.js";
import { tOr } from "../../../core/chartLocaleFallbacks.js";
import { bucketEnd } from "../../../core/time.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import type {
  WhaleCrowdPoint,
  WhaleCrowdResponse,
  WhaleCrowdSeriesState,
  WhaleCrowdVenue,
  WhaleCrowdVenueSeries,
} from "../metricContracts.js";
import { indicatorDataSource } from "../indicatorDataSource.js";
import type {
  IndicatorDefinition,
  IndicatorDrawContext,
  IndicatorPreparedData,
  IndicatorReadout,
  IndicatorSettings,
} from "../types.js";
import {
  INDICATOR_PANE_HEADER_H,
  compactUsd,
  drawHoveredVerticalGuide,
  drawIndicatorAxisTicks,
  drawIndicatorBadge,
  drawIndicatorCrosshairValueLabel,
  drawIndicatorLastValueLabel,
  drawIndicatorMessage,
  drawIndicatorReadout,
  indicatorReadoutToText,
  panePlotBounds,
  settingEnabled,
} from "../render/indicatorPaneUi.js";
import { createIndicatorScale, indicatorDisplayRange, indicatorDisplayScaleMode } from "../scale/indicatorScale.js";
import { indicatorWarningMessageColor, seriesPalette, uiColor } from "../../../core/ui/seriesPalette.js";
import { findLastPointWithData, findPointByIndex } from "./pointLookup.js";

export const WHALE_CROWD_VENUES: readonly WhaleCrowdVenue[] = ["binance", "okx", "hyperliquid"];
const WHALE_CROWD_VENUE_SET = new Set<string>(WHALE_CROWD_VENUES);

export type WhaleCrowdMode = "zScore" | "spread" | "ratios";

export interface WhaleCrowdSettings extends IndicatorSettings {
  mode: WhaleCrowdMode;
  ratioVenue: WhaleCrowdVenue;
  zWindowDays: number;
  zThreshold: number;
  venueBinance: boolean;
  venueOkx: boolean;
  venueHyperliquid: boolean;
  venues?: Partial<Record<WhaleCrowdVenue, boolean>>;
  lineWidth: number;
  binanceColor: string;
  okxColor: string;
  hyperliquidColor: string;
  whaleColor: string;
  crowdColor: string;
  thresholdColor: string;
  baselineColor: string;
  showScaleLabel?: boolean;
  showLastValueLabel?: boolean;
  showReadout?: boolean;
  showAxisTicks?: boolean;
  showPlotLabel: boolean;
}

export interface WhaleCrowdGap {
  from: number;
  to: number;
}

export interface NativeWhaleCrowdPoint {
  t: number;
  whaleRatio: number;
  crowdRatio: number;
  spread: number;
  zScore: number;
  windowMean: number;
  insufficientData: boolean;
}

export interface ChartWhaleCrowdVenuePoint {
  index: number;
  candleStart: number;
  candleEnd: number;
  time: number;
  whaleRatio: number;
  crowdRatio: number;
  spread: number;
  zScore: number;
  windowMean: number;
  value: number;
  hasData: boolean;
  insufficientData: boolean;
}

export interface PreparedVenueBadge {
  venue: WhaleCrowdVenue;
  kind: "warming" | "unsupported" | "unavailable" | "disabled";
  text: string;
  color: string;
}

export interface PreparedVenueData {
  venue: WhaleCrowdVenue;
  status: "ready" | "warming" | "unsupported" | "unavailable" | "disabled";
  definition?: string;
  thresholdUsd?: number;
  historyStartedAt?: number | null;
  gaps: WhaleCrowdGap[];
  points: ChartWhaleCrowdVenuePoint[];
  warmingDays: number;
  isWarming: boolean;
  hasFiniteValue: boolean;
  badge?: PreparedVenueBadge;
}

type WhaleCrowdMeta = Record<string, unknown> & {
  interval: string;
  mode: WhaleCrowdMode;
  ratioVenue: WhaleCrowdVenue;
  activeVenues: WhaleCrowdVenue[];
  source: string;
  zWindowDays: number;
  zThreshold: number;
  venues: Partial<Record<WhaleCrowdVenue, PreparedVenueData>>;
  badges: PreparedVenueBadge[];
};

type WhaleCrowdPreparedData = IndicatorPreparedData<ChartWhaleCrowdVenuePoint, WhaleCrowdMeta> & {
  points: ChartWhaleCrowdVenuePoint[];
  range: { min: number; max: number; baseline: number };
  meta: WhaleCrowdMeta;
};

type NativeVenueZSeriesResult = ReturnType<typeof computeVenueNativeZSeries>;

const preparedCache = new BoundedCache<WhaleCrowdPreparedData>({ maxEntries: 64, ttlMs: 60 * 60_000 });
const nativeZSeriesCache = new BoundedCache<NativeVenueZSeriesResult>({ maxEntries: 64, ttlMs: 60 * 60_000 });
let nativeZSeriesComputeCount = 0;
let nativeZSeriesCacheHitCount = 0;

export function getWhaleCrowdNativeCacheStats(): { computes: number; hits: number } {
  return { computes: nativeZSeriesComputeCount, hits: nativeZSeriesCacheHitCount };
}

export function resetWhaleCrowdCachesForTests(): void {
  preparedCache.clear();
  nativeZSeriesCache.clear();
  nativeZSeriesComputeCount = 0;
  nativeZSeriesCacheHitCount = 0;
}

function getOrComputeVenueNativeZSeries(
  rawSeries: WhaleCrowdVenueSeries,
  zWindowDays: number,
  asOfTime: number | undefined,
): NativeVenueZSeriesResult {
  const firstT = rawSeries.points.length ? rawSeries.points[0].t : "empty";
  const lastT = rawSeries.points.length ? rawSeries.points[rawSeries.points.length - 1].t : "empty";
  const gapsKey = rawSeries.gaps?.map((g) => `${g.from}-${g.to}`).join(",") ?? "";
  const nativeKey = [
    rawSeries.venue,
    rawSeries.status ?? "ready",
    rawSeries.points.length,
    firstT,
    lastT,
    gapsKey,
    rawSeries.historyStartedAt ?? "",
    zWindowDays,
    asOfTime ?? "live",
  ].join("|");
  const cached = nativeZSeriesCache.get(nativeKey);
  if (cached) {
    nativeZSeriesCacheHitCount += 1;
    return cached;
  }
  nativeZSeriesComputeCount += 1;
  const computed = computeVenueNativeZSeries(rawSeries, zWindowDays, asOfTime);
  nativeZSeriesCache.set(nativeKey, computed);
  return computed;
}

function rememberPreparedData(key: string, value: WhaleCrowdPreparedData): WhaleCrowdPreparedData {
  preparedCache.set(key, value);
  return value;
}

function translateOrFallback(
  key: string,
  params: Record<string, string | number> | undefined,
  fallback: string,
): string {
  try {
    const out = tOr(key, params);
    if (out && out !== key) return out;
  } catch {
    // Plain Node unit tests may import indicator builtins without configuring chartLocale().
  }
  if (!params) return fallback;
  return fallback.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

function showLastValueLabel(settings: WhaleCrowdSettings): boolean {
  return settingEnabled(settings, "showLastValueLabel", "showScaleLabel", true);
}

function showReadout(settings: WhaleCrowdSettings): boolean {
  return settingEnabled(settings, "showReadout", "showScaleLabel", true);
}

function clampZWindowDays(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 30;
  return Math.max(7, Math.min(90, Math.round(num)));
}

function clampZThreshold(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 2;
  return Math.max(0.5, Math.min(5, num));
}

function venueDisplayName(venue: WhaleCrowdVenue): string {
  if (venue === "binance") return "Binance";
  if (venue === "okx") return "OKX";
  return "Hyperliquid";
}

function venueShortName(venue: WhaleCrowdVenue): string {
  if (venue === "binance") return "BN";
  if (venue === "okx") return "OKX";
  return "HL";
}

function venueColor(settings: WhaleCrowdSettings, venue: WhaleCrowdVenue): string {
  if (venue === "binance") return settings.binanceColor || seriesPalette[1];
  if (venue === "okx") return settings.okxColor || seriesPalette[0];
  return settings.hyperliquidColor || seriesPalette[2];
}

export function activeWhaleCrowdVenues(settings: Partial<WhaleCrowdSettings> | undefined | null): WhaleCrowdVenue[] {
  if (!settings || typeof settings !== "object") return [...WHALE_CROWD_VENUES];
  const map = settings.venues;
  const enabled: WhaleCrowdVenue[] = [];
  const check = (venue: WhaleCrowdVenue, flatKey: "venueBinance" | "venueOkx" | "venueHyperliquid"): boolean => {
    if (map && typeof map === "object" && typeof map[venue] === "boolean") {
      return Boolean(map[venue]);
    }
    if (typeof settings[flatKey] === "boolean") {
      return Boolean(settings[flatKey]);
    }
    return true;
  };
  if (check("binance", "venueBinance")) enabled.push("binance");
  if (check("okx", "venueOkx")) enabled.push("okx");
  if (check("hyperliquid", "venueHyperliquid")) enabled.push("hyperliquid");
  return enabled.length ? enabled : [...WHALE_CROWD_VENUES];
}

function resolveRatioVenue(settings: WhaleCrowdSettings, activeVenues: readonly WhaleCrowdVenue[]): WhaleCrowdVenue {
  const requested = settings.ratioVenue;
  if (WHALE_CROWD_VENUE_SET.has(requested) && activeVenues.includes(requested)) {
    return requested;
  }
  return activeVenues[0] ?? "binance";
}

export function computeWhaleCrowdSpread(
  point: Pick<WhaleCrowdPoint, "whaleRatio" | "crowdRatio" | "spread">,
): number {
  if (typeof point.spread === "number" && Number.isFinite(point.spread)) {
    return point.spread;
  }
  if (
    typeof point.whaleRatio === "number"
    && Number.isFinite(point.whaleRatio)
    && point.whaleRatio > 0
    && typeof point.crowdRatio === "number"
    && Number.isFinite(point.crowdRatio)
    && point.crowdRatio > 0
  ) {
    return Math.log(point.whaleRatio) - Math.log(point.crowdRatio);
  }
  return Number.NaN;
}

function normalizeGaps(gaps: readonly WhaleCrowdGap[] | undefined): WhaleCrowdGap[] {
  if (!Array.isArray(gaps) || !gaps.length) return [];
  return gaps
    .filter((g) => g && Number.isFinite(g.from) && Number.isFinite(g.to) && g.to >= g.from)
    .sort((a, b) => a.from - b.from);
}

function isTimeInGap(t: number, gaps: readonly WhaleCrowdGap[]): boolean {
  for (const gap of gaps) {
    if (t >= gap.from && t <= gap.to) return true;
    if (gap.from > t) break;
  }
  return false;
}

function hasGapBetween(fromTime: number, toTime: number, gaps: readonly WhaleCrowdGap[]): boolean {
  if (!gaps.length) return false;
  const lo = Math.min(fromTime, toTime);
  const hi = Math.max(fromTime, toTime);
  for (const gap of gaps) {
    if (gap.from <= hi && gap.to >= lo) return true;
    if (gap.from > hi) break;
  }
  return false;
}

function inferNativeCadenceMs(points: readonly WhaleCrowdPoint[], venue: WhaleCrowdVenue): number {
  if (points.length >= 2) {
    let minDiff = Infinity;
    for (let i = 1; i < Math.min(points.length, 32); i++) {
      const diff = points[i].t - points[i - 1].t;
      if (diff > 0 && diff < minDiff) minDiff = diff;
    }
    if (Number.isFinite(minDiff)) return minDiff;
  }
  const res = points[0]?.resolution?.toLowerCase();
  if (res === "1h" || res === "1hour") return 3_600_000;
  if (res === "15m" || res === "15min") return 900_000;
  if (res === "5m" || res === "5min") return 300_000;
  return venue === "hyperliquid" ? 900_000 : 300_000;
}

export function computeVenueNativeZSeries(
  series: WhaleCrowdVenueSeries,
  zWindowDays: number,
  asOfTime?: number,
): {
  points: NativeWhaleCrowdPoint[];
  gaps: WhaleCrowdGap[];
  cadenceMs: number;
  warmingDays: number;
  isWarming: boolean;
} {
  const gaps = normalizeGaps(series.gaps);
  const filtered = series.points
    .filter((pt) => Number.isFinite(pt.t) && (asOfTime === undefined || pt.t < asOfTime))
    .slice()
    .sort((a, b) => a.t - b.t);

  const cadenceMs = inferNativeCadenceMs(filtered, series.venue);
  const zInputs = filtered.map((pt) => {
    const inGap = isTimeInGap(pt.t, gaps);
    const spread = inGap ? Number.NaN : computeWhaleCrowdSpread(pt);
    return { t: pt.t, value: spread };
  });

  const zResults = rollingZScore(zInputs, {
    windowMs: zWindowDays * DAY_MS,
    minSpanMs: DEFAULT_ZSCORE_MIN_SPAN_MS,
  });

  let firstValidT: number | null = null;
  let lastValidT: number | null = null;
  let maxSpanMs = 0;
  let hasFiniteZ = false;

  const nativePoints: NativeWhaleCrowdPoint[] = filtered.map((pt, idx) => {
    const inGap = isTimeInGap(pt.t, gaps);
    const whaleRatio = !inGap && typeof pt.whaleRatio === "number" && Number.isFinite(pt.whaleRatio)
      ? pt.whaleRatio
      : Number.NaN;
    const crowdRatio = !inGap && typeof pt.crowdRatio === "number" && Number.isFinite(pt.crowdRatio)
      ? pt.crowdRatio
      : Number.NaN;
    const spread = zInputs[idx].value;
    const z = zResults[idx];
    const zScore = z?.zScore ?? Number.NaN;
    const windowMean = z?.mean ?? Number.NaN;
    const insufficientData = z ? z.insufficientData : true;

    if (Number.isFinite(spread)) {
      if (firstValidT === null) firstValidT = pt.t;
      lastValidT = pt.t;
    }
    if (z && z.spanMs > maxSpanMs) maxSpanMs = z.spanMs;
    if (Number.isFinite(zScore)) hasFiniteZ = true;

    return {
      t: pt.t,
      whaleRatio,
      crowdRatio,
      spread,
      zScore,
      windowMean,
      insufficientData,
    };
  });

  const historyStart = typeof series.historyStartedAt === "number" && Number.isFinite(series.historyStartedAt)
    ? series.historyStartedAt
    : firstValidT;
  const elapsedMs = historyStart !== null && lastValidT !== null
    ? Math.max(0, lastValidT - historyStart, maxSpanMs)
    : maxSpanMs;
  const warmingDays = Math.max(0, Math.min(zWindowDays, Math.floor(elapsedMs / DAY_MS)));
  const isWarming = series.status === "warming"
    || (series.status !== "unsupported" && series.status !== "unavailable" && series.status !== "disabled"
      && (!hasFiniteZ || elapsedMs < DEFAULT_ZSCORE_MIN_SPAN_MS));

  return {
    points: nativePoints,
    gaps,
    cadenceMs,
    warmingDays,
    isWarming,
  };
}

function findNativePointForCandle(
  native: readonly NativeWhaleCrowdPoint[],
  cursorRef: { i: number },
  candleStart: number,
  candleEnd: number,
  cadenceMs: number,
  gaps: readonly WhaleCrowdGap[],
): NativeWhaleCrowdPoint | null {
  if (!native.length) return null;
  if (hasGapBetween(candleStart, candleEnd, gaps)) return null;

  while (cursorRef.i < native.length && native[cursorRef.i].t <= candleStart) {
    cursorRef.i++;
  }

  // Prefer native bar-end points within (candleStart, candleEnd].
  if (cursorRef.i < native.length && native[cursorRef.i].t <= candleEnd) {
    let last = native[cursorRef.i];
    while (cursorRef.i + 1 < native.length && native[cursorRef.i + 1].t <= candleEnd) {
      cursorRef.i++;
      last = native[cursorRef.i];
    }
    return last;
  }

  // Handle native point aligned exactly to candleStart if no point fell in (candleStart, candleEnd].
  if (cursorRef.i > 0 && native[cursorRef.i - 1].t === candleStart) {
    return native[cursorRef.i - 1];
  }

  // When chart interval is finer than native cadence, hold within 1 native bar unless a gap intervened.
  const prev = cursorRef.i > 0 ? native[cursorRef.i - 1] : null;
  if (prev && candleEnd - prev.t <= cadenceMs && !hasGapBetween(prev.t, candleEnd, gaps)) {
    return prev;
  }

  const next = cursorRef.i < native.length ? native[cursorRef.i] : null;
  if (next && candleEnd <= next.t && candleStart >= next.t - cadenceMs && !hasGapBetween(candleStart, next.t, gaps)) {
    return next;
  }

  return null;
}

export function mapVenueSeriesToChartCandles(
  ctx: Pick<IndicatorDrawContext<WhaleCrowdSettings>, "range" | "series">,
  native: readonly NativeWhaleCrowdPoint[],
  mode: WhaleCrowdMode,
  cadenceMs: number,
  gaps: readonly WhaleCrowdGap[],
  suppressZScore: boolean,
): ChartWhaleCrowdVenuePoint[] {
  const [from, to] = ctx.range;
  if (from >= to || ctx.series.length === 0 || !native.length) return [];

  const points: ChartWhaleCrowdVenuePoint[] = [];
  const startIndex = Math.max(0, Math.floor(from) - 1);
  const endIndex = Math.min(ctx.series.length, Math.ceil(to) + 1);
  const cursorRef = { i: 0 };

  for (let index = startIndex; index < endIndex; index++) {
    const bar = ctx.series.at(index);
    if (!bar) continue;
    const candleStart = bar.startTime;
    const candleEnd = bucketEnd(candleStart, ctx.series.config.intervalMs);
    const matched = findNativePointForCandle(native, cursorRef, candleStart, candleEnd, cadenceMs, gaps);
    if (!matched) continue;

    const zScore = suppressZScore ? Number.NaN : matched.zScore;
    const value = mode === "zScore"
      ? zScore
      : mode === "spread"
        ? matched.spread
        : matched.whaleRatio;

    points.push({
      index,
      candleStart,
      candleEnd,
      time: matched.t,
      whaleRatio: matched.whaleRatio,
      crowdRatio: matched.crowdRatio,
      spread: matched.spread,
      zScore,
      windowMean: matched.windowMean,
      value,
      hasData: Number.isFinite(value) || Number.isFinite(matched.whaleRatio) || Number.isFinite(matched.crowdRatio),
      insufficientData: suppressZScore || matched.insufficientData,
    });
  }

  return points;
}

function buildVenueBadge(
  venue: WhaleCrowdVenue,
  status: PreparedVenueData["status"],
  warmingDays: number,
  zWindowDays: number,
  mode: WhaleCrowdMode,
  isWarming: boolean,
  settings: WhaleCrowdSettings,
): PreparedVenueBadge | undefined {
  const name = venueDisplayName(venue);
  if (status === "unsupported") {
    return {
      venue,
      kind: "unsupported",
      text: translateOrFallback("indicator.whaleVsCrowd.venueUnsupported", { venue: name }, `${name}: desteklenmiyor`),
      color: indicatorWarningMessageColor,
    };
  }
  if (status === "unavailable") {
    const text = venue === "hyperliquid"
      ? translateOrFallback("indicator.whaleVsCrowd.hlCrowdUnavailable", undefined, "Hyperliquid kalabalık verisi yok")
      : translateOrFallback("indicator.whaleVsCrowd.venueUnavailable", { venue: name }, `${name}: veri yok`);
    return {
      venue,
      kind: "unavailable",
      text,
      color: indicatorWarningMessageColor,
    };
  }
  if (status === "disabled") {
    return {
      venue,
      kind: "disabled",
      text: translateOrFallback("indicator.whaleVsCrowd.venueDisabled", { venue: name }, `${name}: devre dışı`),
      color: indicatorWarningMessageColor,
    };
  }
  if (mode === "zScore" && isWarming) {
    return {
      venue,
      kind: "warming",
      text: translateOrFallback(
        "indicator.whaleVsCrowd.warmingBadge",
        { venue: name, days: warmingDays, target: zWindowDays },
        `${name}: ısınıyor (${warmingDays}/${zWindowDays} gün)`,
      ),
      color: venueColor(settings, venue),
    };
  }
  return undefined;
}

function isReadyState(
  state: WhaleCrowdSeriesState | null | undefined,
): state is { status: "ready"; data: WhaleCrowdResponse } {
  return state?.status === "ready";
}

function emptyMeta(settings: WhaleCrowdSettings, interval: string): WhaleCrowdMeta {
  const activeVenues = activeWhaleCrowdVenues(settings);
  return {
    interval,
    mode: settings.mode,
    ratioVenue: resolveRatioVenue(settings, activeVenues),
    activeVenues,
    source: "",
    zWindowDays: clampZWindowDays(settings.zWindowDays),
    zThreshold: clampZThreshold(settings.zThreshold),
    venues: {},
    badges: [],
  };
}

function computeRangeForMode(
  mode: WhaleCrowdMode,
  zThreshold: number,
  ratioVenue: WhaleCrowdVenue,
  activeVenues: readonly WhaleCrowdVenue[],
  venuesMap: Partial<Record<WhaleCrowdVenue, PreparedVenueData>>,
): { min: number; max: number; baseline: number } {
  let min = Infinity;
  let max = -Infinity;

  if (mode === "ratios") {
    const vData = venuesMap[ratioVenue];
    if (vData) {
      for (const pt of vData.points) {
        if (Number.isFinite(pt.whaleRatio)) {
          min = Math.min(min, pt.whaleRatio);
          max = Math.max(max, pt.whaleRatio);
        }
        if (Number.isFinite(pt.crowdRatio)) {
          min = Math.min(min, pt.crowdRatio);
          max = Math.max(max, pt.crowdRatio);
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0.5, max: 1.5, baseline: 1 };
    min = Math.min(min, 1);
    max = Math.max(max, 1);
    if (!(max > min)) {
      min -= 0.1;
      max += 0.1;
    }
    return { min, max, baseline: 1 };
  }

  for (const venue of activeVenues) {
    const vData = venuesMap[venue];
    if (!vData) continue;
    if (mode === "zScore" && (vData.isWarming || vData.status !== "ready")) continue;
    for (const pt of vData.points) {
      if (!Number.isFinite(pt.value)) continue;
      min = Math.min(min, pt.value);
      max = Math.max(max, pt.value);
    }
  }

  if (mode === "zScore") {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: -zThreshold, max: zThreshold, baseline: 0 };
    }
    min = Math.min(min, -zThreshold);
    max = Math.max(max, zThreshold);
    return { min, max, baseline: 0 };
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -0.5, max: 0.5, baseline: 0 };
  min = Math.min(min, 0);
  max = Math.max(max, 0);
  if (!(max > min)) {
    min -= 0.1;
    max += 0.1;
  }
  return { min, max, baseline: 0 };
}

function prepareWhaleCrowdData(ctx: IndicatorDrawContext<WhaleCrowdSettings>): WhaleCrowdPreparedData {
  const interval = ctx.chart?.timeframe ?? "";
  if (!ctx.instance.visible) {
    return {
      status: "hidden",
      points: [],
      range: { min: -2, max: 2, baseline: 0 },
      meta: emptyMeta(ctx.settings, interval),
      message: "gizli",
    };
  }

  const chart = ctx.chart;
  if (!chart) {
    return {
      status: "error",
      points: [],
      range: { min: -2, max: 2, baseline: 0 },
      meta: emptyMeta(ctx.settings, ""),
      message: "chart context yok",
      error: "chart context yok",
    };
  }

  const ds = indicatorDataSource();
  if (typeof ds.requestWhaleCrowdSeries !== "function") {
    return {
      status: "unsupported",
      points: [],
      range: { min: -2, max: 2, baseline: 0 },
      meta: emptyMeta(ctx.settings, chart.timeframe),
      message: translateOrFallback(
        "indicator.whaleVsCrowd.sourceUnsupported",
        undefined,
        "Balina/Kalabalık veri kaynağı desteklenmiyor",
      ),
    };
  }

  const activeVenues = activeWhaleCrowdVenues(ctx.settings);
  const ratioVenue = resolveRatioVenue(ctx.settings, activeVenues);
  const zWindowDays = clampZWindowDays(ctx.settings.zWindowDays);
  const zThreshold = clampZThreshold(ctx.settings.zThreshold);

  const [fromIdx, toIdx] = ctx.range;
  const firstIdx = Math.max(0, Math.floor(fromIdx));
  const lastIdx = Math.min(ctx.series.length - 1, Math.max(firstIdx, Math.ceil(toIdx) - 1));
  const firstBar = ctx.series.at(firstIdx);
  const lastBar = ctx.series.at(lastIdx);
  const visibleFromMs = firstBar ? firstBar.startTime : Date.now() - DAY_MS;
  const rawVisibleToMs = lastBar ? bucketEnd(lastBar.startTime, ctx.series.config.intervalMs) : Date.now();
  const visibleToMs = chart.asOfTime !== undefined ? Math.min(rawVisibleToMs, chart.asOfTime) : rawVisibleToMs;
  const requestFromMs = visibleFromMs - zWindowDays * DAY_MS;

  const state = ds.requestWhaleCrowdSeries({
    market: chart.market,
    from: requestFromMs,
    to: visibleToMs,
    venues: activeVenues,
    onUpdate: ctx.requestRefresh,
  });

  if (state.status === "loading" || state.status === "idle") {
    return {
      status: "loading",
      points: [],
      range: { min: -2, max: 2, baseline: 0 },
      meta: emptyMeta(ctx.settings, chart.timeframe),
      message: "yükleniyor...",
    };
  }

  if (state.status === "unsupported" || state.status === "error") {
    return {
      status: state.status,
      points: [],
      range: { min: -2, max: 2, baseline: 0 },
      meta: emptyMeta(ctx.settings, chart.timeframe),
      message: state.message,
      error: state.message,
    };
  }

  if (!isReadyState(state)) {
    return {
      status: "no-data",
      points: [],
      range: { min: -2, max: 2, baseline: 0 },
      meta: emptyMeta(ctx.settings, chart.timeframe),
      message: translateOrFallback("indicator.whaleVsCrowd.noData", undefined, "Balina/Kalabalık verisi yok"),
    };
  }

  const response = state.data;
  if (response.status === "unsupported" || response.status === "unavailable" || response.status === "disabled") {
    return {
      status: response.status === "unsupported" ? "unsupported" : "no-data",
      points: [],
      range: { min: -2, max: 2, baseline: 0 },
      meta: { ...emptyMeta(ctx.settings, chart.timeframe), source: response.source ?? "" },
      message: translateOrFallback("indicator.whaleVsCrowd.noData", undefined, "Balina/Kalabalık verisi yok"),
    };
  }

  const cacheKey = [
    ctx.instance.id,
    ctx.series.revision,
    ctx.series.length,
    ctx.series.config.intervalMs,
    Math.floor(fromIdx),
    Math.ceil(toIdx),
    ctx.settings.mode,
    ratioVenue,
    zWindowDays,
    zThreshold,
    activeVenues.join(","),
    chart.asOfTime ?? "live",
    response.status,
    response.source ?? "",
    response.venues.map((v) => `${v.venue}:${v.status ?? "ready"}:${v.points.length}:${v.gaps?.length ?? 0}:${v.historyStartedAt ?? ""}`).join(";"),
  ].join("|");
  const cached = preparedCache.get(cacheKey);
  if (cached) return cached;

  const venuesMap: Partial<Record<WhaleCrowdVenue, PreparedVenueData>> = {};
  const badges: PreparedVenueBadge[] = [];

  for (const venue of activeVenues) {
    const rawSeries = response.venues.find((v) => v.venue === venue);
    if (!rawSeries) {
      const badge = buildVenueBadge(venue, "unavailable", 0, zWindowDays, ctx.settings.mode, false, ctx.settings);
      if (badge) badges.push(badge);
      venuesMap[venue] = {
        venue,
        status: "unavailable",
        gaps: [],
        points: [],
        warmingDays: 0,
        isWarming: false,
        hasFiniteValue: false,
        badge,
      };
      continue;
    }

    const declaredStatus = rawSeries.status ?? "ready";
    if (declaredStatus === "unsupported" || declaredStatus === "unavailable" || declaredStatus === "disabled") {
      const badge = buildVenueBadge(venue, declaredStatus, 0, zWindowDays, ctx.settings.mode, false, ctx.settings);
      if (badge) badges.push(badge);
      venuesMap[venue] = {
        venue,
        status: declaredStatus,
        definition: rawSeries.definition,
        thresholdUsd: rawSeries.thresholdUsd,
        historyStartedAt: rawSeries.historyStartedAt,
        gaps: normalizeGaps(rawSeries.gaps),
        points: [],
        warmingDays: 0,
        isWarming: false,
        hasFiniteValue: false,
        badge,
      };
      continue;
    }

    const native = getOrComputeVenueNativeZSeries(rawSeries, zWindowDays, chart.asOfTime);
    const effectiveStatus: PreparedVenueData["status"] = native.isWarming ? "warming" : declaredStatus;
    const suppressZScore = ctx.settings.mode === "zScore" && native.isWarming;
    const chartPoints = mapVenueSeriesToChartCandles(
      ctx,
      native.points,
      ctx.settings.mode,
      native.cadenceMs,
      native.gaps,
      suppressZScore,
    );
    const hasFiniteValue = chartPoints.some((p) => Number.isFinite(p.value));
    const badge = buildVenueBadge(
      venue,
      effectiveStatus,
      native.warmingDays,
      zWindowDays,
      ctx.settings.mode,
      native.isWarming,
      ctx.settings,
    );
    if (badge) badges.push(badge);

    venuesMap[venue] = {
      venue,
      status: effectiveStatus,
      definition: rawSeries.definition,
      thresholdUsd: rawSeries.thresholdUsd,
      historyStartedAt: rawSeries.historyStartedAt,
      gaps: native.gaps,
      points: chartPoints,
      warmingDays: native.warmingDays,
      isWarming: native.isWarming,
      hasFiniteValue,
      badge,
    };
  }

  const primaryPoints = (ctx.settings.mode === "ratios" ? venuesMap[ratioVenue]?.points : undefined)
    ?? activeVenues.map((v) => venuesMap[v]?.points ?? []).find((pts) => pts.length > 0)
    ?? [];

  const meta: WhaleCrowdMeta = {
    interval: chart.timeframe,
    mode: ctx.settings.mode,
    ratioVenue,
    activeVenues,
    source: response.source ?? "",
    zWindowDays,
    zThreshold,
    venues: venuesMap,
    badges,
  };

  const hasAnyRenderableOrBadge = primaryPoints.length > 0 || badges.length > 0;
  if (!hasAnyRenderableOrBadge) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: -zThreshold, max: zThreshold, baseline: 0 },
      meta,
      message: translateOrFallback("indicator.whaleVsCrowd.noData", undefined, "Balina/Kalabalık verisi yok"),
    });
  }

  const range = computeRangeForMode(ctx.settings.mode, zThreshold, ratioVenue, activeVenues, venuesMap);
  return rememberPreparedData(cacheKey, {
    status: "ok",
    points: primaryPoints,
    range,
    meta,
  });
}

function asWhaleCrowdData(
  prepared: IndicatorPreparedData | undefined,
  settings?: WhaleCrowdSettings,
): WhaleCrowdPreparedData {
  if (prepared?.points && prepared.range && prepared.meta) return prepared as WhaleCrowdPreparedData;
  return {
    status: "no-data",
    points: [],
    range: { min: -2, max: 2, baseline: 0 },
    meta: emptyMeta(settings ?? whaleVsCrowdIndicatorDefinition.defaultSettings(), ""),
    message: prepared?.message ?? prepared?.error ?? "bu görünümde veri yok",
  };
}

function pointX(ctx: IndicatorDrawContext<WhaleCrowdSettings>, point: Pick<ChartWhaleCrowdVenuePoint, "index">): number {
  return ctx.view.xOfIndex(point.index) + ctx.view.colWidth / 2;
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)}x` : "n/a";
}

function formatSpread(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function formatZScore(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}σ`;
}

function formatModeAxisValue(mode: WhaleCrowdMode, value: number): string {
  if (mode === "zScore") return formatZScore(value);
  if (mode === "spread") return formatSpread(value);
  return formatRatio(value);
}

function focusVenuePoint(
  venueData: PreparedVenueData | undefined,
  index: number | null,
): ChartWhaleCrowdVenuePoint | null {
  if (!venueData?.points.length) return null;
  if (index !== null) return findPointByIndex(venueData.points, index);
  return findLastPointWithData(venueData.points);
}

function formatWhaleCrowdReadout(
  ctx: IndicatorDrawContext<WhaleCrowdSettings>,
  data: WhaleCrowdPreparedData,
  index: number | null,
): IndicatorReadout | null {
  const items: IndicatorReadout["items"] = [];
  let focusTime: number | null = null;

  for (const venue of data.meta.activeVenues) {
    const vData = data.meta.venues[venue];
    if (!vData) continue;
    const pt = focusVenuePoint(vData, index);
    if (pt && focusTime === null) focusTime = pt.candleStart;

    const short = venueShortName(venue);
    if (vData.status === "unsupported" || vData.status === "unavailable") {
      items.push({ label: short, value: vData.badge?.text ?? vData.status });
      continue;
    }

    if (pt) {
      const zPart = vData.isWarming
        ? `${vData.warmingDays}/${data.meta.zWindowDays}g`
        : formatZScore(pt.zScore);
      const parts = [
        `W:${formatRatio(pt.whaleRatio)}`,
        `C:${formatRatio(pt.crowdRatio)}`,
        `S:${formatSpread(pt.spread)}`,
        `Z:${zPart}`,
      ];
      if (vData.definition) {
        parts.push(vData.definition);
      }
      if (typeof vData.thresholdUsd === "number" && Number.isFinite(vData.thresholdUsd) && vData.thresholdUsd > 0) {
        parts.push(`≥${compactUsd(vData.thresholdUsd)}`);
      }
      items.push({ label: short, value: parts.join(" ") });
    } else if (vData.definition) {
      items.push({ label: short, value: vData.definition });
    }
  }

  if (!items.length || focusTime === null) return null;
  return {
    title: index === null ? "Last" : "*",
    time: tzDateTimeHud(focusTime, ctx.chart?.intervalMs ?? ctx.series.config.intervalMs),
    items,
  };
}

function whaleVsCrowdReadout(
  ctx: IndicatorDrawContext<WhaleCrowdSettings>,
  prepared: IndicatorPreparedData,
  index: number | null,
): IndicatorReadout | null {
  const data = asWhaleCrowdData(prepared, ctx.settings);
  if (data.status !== "ok") return null;
  return formatWhaleCrowdReadout(ctx, data, index);
}

function drawStatus(ctx: IndicatorDrawContext<WhaleCrowdSettings>, data: WhaleCrowdPreparedData): boolean {
  if (data.status === "hidden") {
    drawIndicatorMessage(ctx, data.message ?? "gizli");
    return true;
  }
  if (data.status === "loading") {
    drawIndicatorMessage(ctx, data.message ?? "yükleniyor...");
    return true;
  }
  if (data.status === "error" || data.status === "unsupported") {
    drawIndicatorMessage(ctx, data.message ?? data.error ?? "Balina/Kalabalık verisi yüklenemedi", uiColor.sell);
    return true;
  }
  if (data.status === "no-data") {
    drawIndicatorMessage(ctx, data.message ?? "bu görünümde veri yok", indicatorWarningMessageColor);
    return true;
  }
  return false;
}

function drawDashedHorizontalLine(
  canvas: CanvasRenderingContext2D,
  left: number,
  width: number,
  y: number,
  color: string,
): void {
  canvas.save();
  canvas.strokeStyle = color;
  canvas.lineWidth = 1;
  canvas.setLineDash([4, 4]);
  canvas.beginPath();
  canvas.moveTo(left, y);
  canvas.lineTo(left + width, y);
  canvas.stroke();
  canvas.restore();
}

function drawPolylineWithGaps(
  ctx: IndicatorDrawContext<WhaleCrowdSettings>,
  points: readonly ChartWhaleCrowdVenuePoint[],
  getValue: (pt: ChartWhaleCrowdVenuePoint) => number,
  gaps: readonly WhaleCrowdGap[],
  scale: ReturnType<typeof createIndicatorScale>,
  color: string,
  lineWidth: number,
): void {
  const canvas = ctx.ctx;
  canvas.save();
  canvas.strokeStyle = color;
  canvas.lineJoin = "round";
  canvas.lineCap = "round";
  canvas.lineWidth = Math.max(1, lineWidth);
  canvas.beginPath();

  let penDown = false;
  let prevPoint: ChartWhaleCrowdVenuePoint | null = null;

  for (const point of points) {
    const val = getValue(point);
    if (!Number.isFinite(val)) {
      penDown = false;
      prevPoint = null;
      continue;
    }
    if (prevPoint && hasGapBetween(prevPoint.time, point.time, gaps)) {
      penDown = false;
    }
    const x = pointX(ctx, point);
    const y = scale.y(val);
    if (!penDown) {
      canvas.moveTo(x, y);
      penDown = true;
    } else {
      canvas.lineTo(x, y);
    }
    prevPoint = point;
  }

  canvas.stroke();
  canvas.restore();
}

function drawVenueBadges(
  ctx: IndicatorDrawContext<WhaleCrowdSettings>,
  badges: readonly PreparedVenueBadge[],
): void {
  if (!badges.length) return;
  let y = ctx.rect.top + INDICATOR_PANE_HEADER_H + 14;
  const maxWidth = Math.max(180, ctx.view.area.width - 16);
  for (const badge of badges) {
    drawIndicatorBadge(ctx.ctx, badge.text, ctx.view.area.left + 8, y, {
      color: badge.color,
      align: "left",
      maxWidth,
    });
    y += 22;
  }
}

function drawWhaleVsCrowd(ctx: IndicatorDrawContext<WhaleCrowdSettings>, prepared?: IndicatorPreparedData): void {
  const { ctx: canvas, view, rect, settings } = ctx;
  const data = asWhaleCrowdData(prepared ?? prepareWhaleCrowdData(ctx), settings);
  if (drawStatus(ctx, data)) return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const mode = data.meta.mode;
  const scale = createIndicatorScale({
    mode: mode === "ratios" ? "linear" : "signed-zero",
    min: displayRange.min,
    max: displayRange.max,
    baseline: data.range.baseline,
    formatter: (v) => formatModeAxisValue(mode, v),
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.12,
  }, { top, bottom });

  const baseline = data.range.baseline;
  if (scale.contains(baseline)) {
    const baseY = scale.y(baseline);
    canvas.save();
    canvas.strokeStyle = settings.baselineColor || uiColor.separatorStrong;
    canvas.beginPath();
    canvas.moveTo(view.area.left, baseY);
    canvas.lineTo(view.area.left + view.area.width, baseY);
    canvas.stroke();
    canvas.restore();
  }

  if (mode === "zScore") {
    const threshold = data.meta.zThreshold;
    const thresholdColor = settings.thresholdColor || uiColor.warn;
    if (scale.contains(threshold)) {
      drawDashedHorizontalLine(canvas, view.area.left, view.area.width, scale.y(threshold), thresholdColor);
    }
    if (scale.contains(-threshold)) {
      drawDashedHorizontalLine(canvas, view.area.left, view.area.width, scale.y(-threshold), thresholdColor);
    }
  }

  const lineWidth = settings.lineWidth || 1.75;
  let lastDrawValue: { value: number; color: string } | null = null;

  if (mode === "ratios") {
    const vData = data.meta.venues[data.meta.ratioVenue];
    if (vData && vData.points.length && vData.status !== "unsupported" && vData.status !== "unavailable") {
      const whaleColor = settings.whaleColor || uiColor.buy;
      const crowdColor = settings.crowdColor || uiColor.sell;
      drawPolylineWithGaps(ctx, vData.points, (pt) => pt.whaleRatio, vData.gaps, scale, whaleColor, lineWidth);
      drawPolylineWithGaps(ctx, vData.points, (pt) => pt.crowdRatio, vData.gaps, scale, crowdColor, lineWidth);
      const last = findLastPointWithData(vData.points);
      if (last && Number.isFinite(last.whaleRatio)) {
        lastDrawValue = { value: last.whaleRatio, color: whaleColor };
      }
    }
  } else {
    for (const venue of data.meta.activeVenues) {
      const vData = data.meta.venues[venue];
      if (!vData || !vData.points.length) continue;
      if (vData.status === "unsupported" || vData.status === "unavailable" || vData.status === "disabled") continue;
      if (mode === "zScore" && vData.isWarming) continue;

      const color = venueColor(settings, venue);
      drawPolylineWithGaps(ctx, vData.points, (pt) => pt.value, vData.gaps, scale, color, lineWidth);
      const last = findLastPointWithData(vData.points);
      if (last && Number.isFinite(last.value)) {
        lastDrawValue = { value: last.value, color };
      }
    }
  }

  drawVenueBadges(ctx, data.meta.badges);

  if (settings.showAxisTicks) drawIndicatorAxisTicks(ctx, scale, top, bottom);

  if (showLastValueLabel(settings) && lastDrawValue && Number.isFinite(lastDrawValue.value)) {
    const y = Math.max(top + 9, Math.min(bottom - 9, scale.y(lastDrawValue.value)));
    drawIndicatorLastValueLabel(ctx, {
      text: scale.format(lastDrawValue.value),
      color: lastDrawValue.color,
      y,
    });
  }
}

function drawWhaleVsCrowdInteraction(
  ctx: IndicatorDrawContext<WhaleCrowdSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const { ctx: canvas, rect, settings } = ctx;
  const data = asWhaleCrowdData(prepared ?? prepareWhaleCrowdData(ctx), settings);
  if (data.status !== "ok") return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const hoverIndex = ctx.crosshair?.visible ? Math.floor(ctx.view.indexOfX(ctx.crosshair.x)) : null;

  if (showReadout(settings)) {
    const readout = formatWhaleCrowdReadout(ctx, data, hoverIndex);
    if (readout) {
      drawIndicatorReadout(ctx, indicatorReadoutToText(readout));
    }
  }

  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const mode = data.meta.mode;
  const scale = createIndicatorScale({
    mode: mode === "ratios" ? "linear" : "signed-zero",
    min: displayRange.min,
    max: displayRange.max,
    baseline: data.range.baseline,
    formatter: (v) => formatModeAxisValue(mode, v),
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.12,
  }, { top, bottom });

  if (hoverIndex !== null) {
    const focusPt = data.points.length ? findPointByIndex(data.points, hoverIndex) : null;
    if (focusPt) drawHoveredVerticalGuide(canvas, pointX(ctx, focusPt), top, bottom);
  }
  drawIndicatorCrosshairValueLabel(ctx, scale, top, bottom);
}

function whaleVsCrowdHeaderLabel(ctx: {
  settings: WhaleCrowdSettings;
  chart?: { timeframe: string };
  prepared?: IndicatorPreparedData;
}): string {
  if (ctx.settings.showPlotLabel === false) return "";
  const timeframe = ctx.chart?.timeframe ? ` ${ctx.chart.timeframe}` : "";
  const meta = ctx.prepared?.meta as WhaleCrowdMeta | undefined;
  const active = meta?.activeVenues ?? activeWhaleCrowdVenues(ctx.settings);
  const modeText = ctx.settings.mode === "zScore"
    ? "Z-Score"
    : ctx.settings.mode === "spread"
      ? "Spread"
      : `Ratios (${venueShortName(meta?.ratioVenue ?? resolveRatioVenue(ctx.settings, active))})`;
  const parts = [`Whale vs Crowd${timeframe}`, modeText];
  if (ctx.settings.mode === "zScore") {
    parts.push(`${clampZWindowDays(ctx.settings.zWindowDays)}d`);
  }
  parts.push(`${active.length}/3`);
  if (meta?.source) parts.push(meta.source);
  return parts.join(" | ");
}

export const whaleVsCrowdIndicatorDefinition: IndicatorDefinition<WhaleCrowdSettings> = {
  type: "whale-vs-crowd",
  name: "Whale vs Crowd",
  category: "derivatives",
  defaultPane: "separate",
  canOverlay: false,
  defaultPlacement: "separate-pane",
  supportedPlacements: ["separate-pane"],
  paneHeight: 132,
  defaultSettings: () => ({
    mode: "zScore",
    ratioVenue: "binance",
    zWindowDays: 30,
    zThreshold: 2,
    venueBinance: true,
    venueOkx: true,
    venueHyperliquid: true,
    lineWidth: 1.75,
    binanceColor: seriesPalette[1],
    okxColor: seriesPalette[0],
    hyperliquidColor: seriesPalette[2],
    whaleColor: uiColor.buy,
    crowdColor: uiColor.sell,
    thresholdColor: uiColor.warn,
    baselineColor: uiColor.separatorStrong,
    showScaleLabel: true,
    showLastValueLabel: true,
    showReadout: true,
    showAxisTicks: true,
    showPlotLabel: true,
  }),
  settingsSchema: {
    sections: [
      {
        title: "Data",
        titleKey: "indicator.common.section.data",
        fields: [
          {
            kind: "select",
            key: "mode",
            label: "Mode",
            labelKey: "indicator.common.mode",
            requiresRecalc: true,
            options: [
              { label: "Z-Score", value: "zScore" },
              { label: "Spread (ln W/C)", value: "spread" },
              { label: "Whale & Crowd Ratios", value: "ratios" },
            ],
          },
          {
            kind: "select",
            key: "ratioVenue",
            label: "Ratio Venue",
            requiresRecalc: true,
            visibleWhen: { key: "mode", values: ["ratios"] },
            options: [
              { label: "Binance", value: "binance" },
              { label: "OKX", value: "okx" },
              { label: "Hyperliquid", value: "hyperliquid" },
            ],
          },
          {
            kind: "number",
            key: "zWindowDays",
            label: "Z-Score Window (Days)",
            min: 7,
            max: 90,
            step: 1,
            requiresRecalc: true,
            visibleWhen: { key: "mode", values: ["zScore"] },
          },
          {
            kind: "number",
            key: "zThreshold",
            label: "Z-Score Threshold (±σ)",
            min: 0.5,
            max: 5,
            step: 0.25,
            requiresRecalc: false,
            visibleWhen: { key: "mode", values: ["zScore"] },
          },
          { kind: "boolean", key: "venueBinance", label: "Binance", requiresRecalc: true },
          { kind: "boolean", key: "venueOkx", label: "OKX", requiresRecalc: true },
          { kind: "boolean", key: "venueHyperliquid", label: "Hyperliquid", requiresRecalc: true },
        ],
      },
      {
        title: "Display",
        titleKey: "indicator.common.section.display",
        fields: [
          { kind: "number", key: "lineWidth", label: "Line Thickness", labelKey: "indicator.common.lineWidth", min: 1, max: 8, step: 0.25 },
          { kind: "boolean", key: "showLastValueLabel", label: "Show Last Value Label", labelKey: "indicator.common.showLastValueLabel" },
          { kind: "boolean", key: "showReadout", label: "Show Readout", labelKey: "indicator.common.showReadout" },
          { kind: "boolean", key: "showAxisTicks", label: "Show Axis Ticks", labelKey: "indicator.common.showAxisTicks" },
          { kind: "boolean", key: "showPlotLabel", label: "Show Header Label", labelKey: "indicator.common.showPlotLabel" },
        ],
      },
      {
        title: "Colors",
        titleKey: "indicator.common.section.colors",
        fields: [
          { kind: "color", key: "binanceColor", label: "Binance Color" },
          { kind: "color", key: "okxColor", label: "OKX Color" },
          { kind: "color", key: "hyperliquidColor", label: "Hyperliquid Color" },
          { kind: "color", key: "whaleColor", label: "Whale Ratio Color", visibleWhen: { key: "mode", values: ["ratios"] } },
          { kind: "color", key: "crowdColor", label: "Crowd Ratio Color", visibleWhen: { key: "mode", values: ["ratios"] } },
          { kind: "color", key: "thresholdColor", label: "Threshold Color", visibleWhen: { key: "mode", values: ["zScore"] } },
          { kind: "color", key: "baselineColor", label: "Baseline Color", labelKey: "indicator.common.baselineColor" },
        ],
      },
    ],
  },
  getHeaderLabel: whaleVsCrowdHeaderLabel,
  prepareData: prepareWhaleCrowdData,
  getReadout: whaleVsCrowdReadout,
  drawSubPane: drawWhaleVsCrowd,
  drawInteraction: drawWhaleVsCrowdInteraction,
};

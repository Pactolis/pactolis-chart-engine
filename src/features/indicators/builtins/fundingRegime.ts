import { BoundedCache } from "../../../core/cache/boundedCache.js";
import { DAY_MS, DEFAULT_ZSCORE_MIN_SPAN_MS, rollingZScore } from "../../../core/analysis/rollingZScore.js";
import { bucketEnd } from "../../../core/time.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import type {
  FundingVenue,
  VenueFundingResponse,
  VenueFundingSeries,
  VenueFundingSeriesState,
  VenueFundingSettledPoint,
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
  drawHoveredVerticalGuide,
  drawIndicatorAxisTicks,
  drawIndicatorCrosshairValueLabel,
  drawIndicatorLastValueLabel,
  drawIndicatorMessage,
  drawIndicatorReadout,
  indicatorReadoutToText,
  panePlotBounds,
  settingEnabled,
} from "../render/indicatorPaneUi.js";
import { createIndicatorScale, indicatorDisplayRange, indicatorDisplayScaleMode } from "../scale/indicatorScale.js";
import { uiColor, indicatorWarningMessageColor, fundingPredictedColorDefault } from "../../../core/ui/seriesPalette.js";
import { findLastPointWithData, findPointByIndex } from "./pointLookup.js";

export const FUNDING_VENUES: readonly FundingVenue[] = ["binancef", "bybitf", "okxf", "hyperliquid"];
const FUNDING_VENUE_SET = new Set<string>(FUNDING_VENUES);
const HOUR_MS = 3_600_000;

export type FundingRegimeMode = "zScore" | "fundingRate" | "predictedFundingRate" | "spread";
export type FundingZSource = "aggregate" | "venues";

export interface FundingRegimeSettings extends IndicatorSettings {
  mode: FundingRegimeMode;
  zWindowDays: number;
  zThreshold: number;
  zSource: FundingZSource;
  lineWidth: number;
  zScoreColor: string;
  thresholdColor: string;
  fundingColor: string;
  predictedColor: string;
  spreadColor: string;
  baselineColor: string;
  showScaleLabel?: boolean;
  showLastValueLabel?: boolean;
  showReadout?: boolean;
  showAxisTicks?: boolean;
  showPlotLabel: boolean;
  exchanges: Record<string, boolean>;
}

const DEFAULT_VENUES: Record<FundingVenue, boolean> = {
  binancef: true,
  bybitf: true,
  okxf: true,
  hyperliquid: true,
};

export function migrateFundingExchanges(
  exchanges: Record<string, boolean> | undefined | null,
): Record<FundingVenue, boolean> {
  if (!exchanges || typeof exchanges !== "object") {
    return { ...DEFAULT_VENUES };
  }
  const migrated: Record<FundingVenue, boolean> = {
    binancef: Boolean(exchanges.binancef),
    bybitf: Boolean(exchanges.bybitf),
    okxf: Boolean(exchanges.okxf),
    hyperliquid: Boolean(exchanges.hyperliquid),
  };
  const anyEnabled = FUNDING_VENUES.some((venue) => migrated[venue]);
  if (!anyEnabled) {
    return { ...DEFAULT_VENUES };
  }
  return migrated;
}

export function activeFundingVenues(exchanges: Record<string, boolean> | undefined | null): FundingVenue[] {
  const migrated = migrateFundingExchanges(exchanges);
  return FUNDING_VENUES.filter((venue) => migrated[venue]);
}

type ChartFundingPoint = {
  index: number;
  candleStart: number;
  candleEnd: number;
  time: number;
  fundingRate: number;
  predictedFundingRate: number;
  spread: number;
  zScore: number;
  windowMean: number;
  value: number;
  hasData: boolean;
  insufficientData: boolean;
};

type FundingRegimeMeta = Record<string, unknown> & {
  interval: string;
  mode: FundingRegimeMode;
  truncated: boolean;
  activeVenues: FundingVenue[];
  excludedVenues: FundingVenue[];
  source: string;
  insufficientData: boolean;
  zWindowDays: number;
  zThreshold: number;
  zSource: FundingZSource;
};

type FundingRegimeData = IndicatorPreparedData<ChartFundingPoint, FundingRegimeMeta> & {
  points: ChartFundingPoint[];
  range: { min: number; max: number; baseline: number };
  meta: FundingRegimeMeta;
};

interface HourlyAlignedFunding {
  t: number;
  fundingRate: number;
  predictedFundingRate: number;
  spread: number;
}

interface HourlyZFunding extends HourlyAlignedFunding {
  zScore: number;
  windowMean: number;
  insufficientData: boolean;
}

const preparedCache = new BoundedCache<FundingRegimeData>({ maxEntries: 64, ttlMs: 60 * 60_000 });
const nativeFundingZCache = new BoundedCache<HourlyZFunding[]>({ maxEntries: 64, ttlMs: 60 * 60_000 });
let nativeFundingComputeCount = 0;
let nativeFundingCacheHitCount = 0;

export function getFundingRegimeNativeCacheStats(): { computes: number; hits: number } {
  return { computes: nativeFundingComputeCount, hits: nativeFundingCacheHitCount };
}

export function resetFundingRegimeCachesForTests(): void {
  preparedCache.clear();
  nativeFundingZCache.clear();
  nativeFundingComputeCount = 0;
  nativeFundingCacheHitCount = 0;
}

function rememberPreparedData(key: string, value: FundingRegimeData): FundingRegimeData {
  preparedCache.set(key, value);
  return value;
}

function showLastValueLabel(settings: FundingRegimeSettings): boolean {
  return settingEnabled(settings, "showLastValueLabel", "showScaleLabel", true);
}

function showReadout(settings: FundingRegimeSettings): boolean {
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

function modeLabel(mode: FundingRegimeMode): string {
  if (mode === "zScore") return "Z-Score";
  if (mode === "predictedFundingRate") return "Anlik tahmin";
  if (mode === "spread") return "Anlik - Son odenen";
  return "Odenmis";
}

function valueForMode(point: Omit<ChartFundingPoint, "value">, mode: FundingRegimeMode): number {
  if (mode === "zScore") return point.zScore;
  if (mode === "predictedFundingRate") return point.predictedFundingRate;
  if (mode === "spread") return point.spread;
  return point.fundingRate;
}

function formatFundingRate(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 10) return `${value.toFixed(2)}%`;
  if (abs >= 1) return `${value.toFixed(3)}%`;
  return `${value.toFixed(4)}%`;
}

function formatZScore(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}σ`;
}

function formatModeValue(mode: FundingRegimeMode, value: number): string {
  return mode === "zScore" ? formatZScore(value) : formatFundingRate(value);
}

function colorForMode(settings: FundingRegimeSettings, mode: FundingRegimeMode): string {
  if (mode === "zScore") return settings.zScoreColor || uiColor.info;
  if (mode === "predictedFundingRate") return settings.predictedColor || fundingPredictedColorDefault;
  if (mode === "spread") return settings.spreadColor || uiColor.special;
  return settings.fundingColor || uiColor.buy;
}

function isReadyState(
  state: VenueFundingSeriesState | null | undefined,
): state is { status: "ready"; data: VenueFundingResponse } {
  return state?.status === "ready";
}

function asOfAllowed(t: number, asOfTime: number | undefined): boolean {
  return asOfTime === undefined || t < asOfTime;
}

function settledRateAtHourEnd(
  settled: readonly VenueFundingSettledPoint[],
  defaultIntervalHours: number,
  hourEnd: number,
  asOfTime: number | undefined,
): { rate8h: number; settledEnd: number } | null {
  for (let i = settled.length - 1; i >= 0; i--) {
    const pt = settled[i];
    if (!asOfAllowed(pt.t, asOfTime)) continue;
    const hours = Number.isFinite(pt.intervalHours) && pt.intervalHours > 0 ? pt.intervalHours : defaultIntervalHours;
    const periodStart = pt.t - hours * HOUR_MS;
    if (hourEnd > periodStart && hourEnd <= pt.t) {
      return { rate8h: pt.rate8h, settledEnd: pt.t };
    }
    if (pt.t < hourEnd - hours * HOUR_MS) break;
  }
  return null;
}

export function alignVenueSeriesToHourEnd(
  series: VenueFundingSeries,
  hourEnd: number,
  asOfTime?: number,
): { rate8h: number; settledRate8h: number; currentRate8h: number; isCurrent: boolean } | null {
  const defaultHours = Number.isFinite(series.intervalHours) && (series.intervalHours ?? 0) > 0
    ? Number(series.intervalHours)
    : 8;
  const settledSorted = series.settled;
  let lastSettled: VenueFundingSettledPoint | null = null;
  for (let i = settledSorted.length - 1; i >= 0; i--) {
    if (asOfAllowed(settledSorted[i].t, asOfTime)) {
      lastSettled = settledSorted[i];
      break;
    }
  }

  const current = series.current && asOfAllowed(series.current.t, asOfTime) ? series.current : null;
  const currentRate8h = current ? current.rate8h : Number.NaN;
  const hit = settledRateAtHourEnd(settledSorted, defaultHours, hourEnd, asOfTime);

  if (hit) {
    return {
      rate8h: hit.rate8h,
      settledRate8h: hit.rate8h,
      currentRate8h,
      isCurrent: false,
    };
  }

  const afterLastSettled = !lastSettled || hourEnd > lastSettled.t;
  if (afterLastSettled && current) {
    return {
      rate8h: current.rate8h,
      settledRate8h: lastSettled ? lastSettled.rate8h : Number.NaN,
      currentRate8h: current.rate8h,
      isCurrent: true,
    };
  }

  return null;
}

export function buildHourlyFundingTimeline(
  response: VenueFundingResponse,
  selectedVenues: readonly FundingVenue[],
  zSource: FundingZSource,
  fromMs: number,
  toMs: number,
  asOfTime?: number,
): HourlyAlignedFunding[] {
  if (!(toMs > fromMs)) return [];
  const startHourEnd = Math.floor(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  const endHourEnd = Math.ceil(toMs / HOUR_MS) * HOUR_MS;
  const out: HourlyAlignedFunding[] = [];

  const venueSet = new Set<FundingVenue>(selectedVenues);
  const activeSeries = response.series.filter((s) => venueSet.has(s.venue));

  const aggPoints = response.aggregate?.points?.length
    ? response.aggregate.points.filter((p) => asOfAllowed(p.t, asOfTime))
    : [];
  const aggSpanMs = aggPoints.length >= 2 ? aggPoints[aggPoints.length - 1].t - aggPoints[0].t : 0;

  let minSettledT = Infinity;
  let maxSettledT = -Infinity;
  for (const venueSeries of activeSeries) {
    for (const pt of venueSeries.settled) {
      if (!asOfAllowed(pt.t, asOfTime)) continue;
      if (pt.t < minSettledT) minSettledT = pt.t;
      if (pt.t > maxSettledT) maxSettledT = pt.t;
    }
  }
  const seriesSpanMs = Number.isFinite(minSettledT) && Number.isFinite(maxSettledT)
    ? maxSettledT - minSettledT
    : 0;

  const useAggregate = zSource === "aggregate"
    && aggPoints.length > 0
    && (aggSpanMs >= DEFAULT_ZSCORE_MIN_SPAN_MS || seriesSpanMs <= aggSpanMs);
  if (useAggregate && response.aggregate) {
    const aggCurrent = response.aggregate.current && asOfAllowed(response.aggregate.current.t, asOfTime)
      ? response.aggregate.current
      : null;
    const lastAgg = aggPoints[aggPoints.length - 1];
    let cursor = 0;

    for (let hourEnd = startHourEnd; hourEnd <= endHourEnd; hourEnd += HOUR_MS) {
      const hourStart = hourEnd - HOUR_MS;
      while (cursor < aggPoints.length && aggPoints[cursor].t <= hourStart) {
        cursor++;
      }
      let matched = cursor < aggPoints.length && aggPoints[cursor].t <= hourEnd ? aggPoints[cursor] : null;
      if (!matched && cursor > 0 && aggPoints[cursor - 1].t === hourStart) {
        matched = aggPoints[cursor - 1];
      }
      let fundingRate = matched && Number.isFinite(matched.rate8h) ? matched.rate8h : Number.NaN;
      if (!Number.isFinite(fundingRate) && aggCurrent && (!lastAgg || hourEnd > lastAgg.t)) {
        fundingRate = aggCurrent.rate8h;
      }
      const predictedFundingRate = aggCurrent ? aggCurrent.rate8h : Number.NaN;
      const spread = Number.isFinite(fundingRate) && Number.isFinite(predictedFundingRate)
        ? predictedFundingRate - fundingRate
        : Number.NaN;
      if (Number.isFinite(fundingRate) || Number.isFinite(predictedFundingRate)) {
        out.push({ t: hourEnd, fundingRate, predictedFundingRate, spread });
      }
    }
    return out;
  }

  if (!activeSeries.length) return [];

  for (let hourEnd = startHourEnd; hourEnd <= endHourEnd; hourEnd += HOUR_MS) {
    let rateSum = 0;
    let rateCount = 0;
    let predSum = 0;
    let predCount = 0;

    for (const venueSeries of activeSeries) {
      const aligned = alignVenueSeriesToHourEnd(venueSeries, hourEnd, asOfTime);
      if (!aligned) continue;
      if (Number.isFinite(aligned.rate8h)) {
        rateSum += aligned.rate8h;
        rateCount += 1;
      }
      if (Number.isFinite(aligned.currentRate8h)) {
        predSum += aligned.currentRate8h;
        predCount += 1;
      }
    }

    if (rateCount === 0 && predCount === 0) continue;
    const fundingRate = rateCount > 0 ? rateSum / rateCount : Number.NaN;
    const predictedFundingRate = predCount > 0 ? predSum / predCount : Number.NaN;
    const spread = Number.isFinite(fundingRate) && Number.isFinite(predictedFundingRate)
      ? predictedFundingRate - fundingRate
      : Number.NaN;
    out.push({ t: hourEnd, fundingRate, predictedFundingRate, spread });
  }

  return out;
}

function attachRollingZScores(
  hourly: readonly HourlyAlignedFunding[],
  zWindowDays: number,
): HourlyZFunding[] {
  if (!hourly.length) return [];
  const zResults = rollingZScore(
    hourly.map((pt) => ({ t: pt.t, value: pt.fundingRate })),
    {
      windowMs: zWindowDays * DAY_MS,
      minSpanMs: DEFAULT_ZSCORE_MIN_SPAN_MS,
    },
  );
  return hourly.map((pt, idx) => {
    const z = zResults[idx];
    return {
      ...pt,
      zScore: z?.zScore ?? Number.NaN,
      windowMean: z?.mean ?? Number.NaN,
      insufficientData: z ? z.insufficientData : true,
    };
  });
}

function findHourlyPointForCandle(
  hourly: readonly HourlyZFunding[],
  cursorRef: { i: number },
  candleStart: number,
  candleEnd: number,
): HourlyZFunding | null {
  if (!hourly.length) return null;
  while (cursorRef.i < hourly.length && hourly[cursorRef.i].t <= candleStart) {
    cursorRef.i++;
  }
  if (cursorRef.i < hourly.length && hourly[cursorRef.i].t <= candleEnd) {
    let last = hourly[cursorRef.i];
    while (cursorRef.i + 1 < hourly.length && hourly[cursorRef.i + 1].t <= candleEnd) {
      cursorRef.i++;
      last = hourly[cursorRef.i];
    }
    return last;
  }
  if (cursorRef.i < hourly.length && candleEnd <= hourly[cursorRef.i].t && candleStart >= hourly[cursorRef.i].t - HOUR_MS) {
    return hourly[cursorRef.i];
  }
  return cursorRef.i > 0 ? hourly[cursorRef.i - 1] : null;
}

function mapToVisibleChartCandles(
  ctx: IndicatorDrawContext<FundingRegimeSettings>,
  hourlyZ: readonly HourlyZFunding[],
): ChartFundingPoint[] {
  const [from, to] = ctx.range;
  if (from >= to || ctx.series.length === 0 || !hourlyZ.length) return [];

  const points: ChartFundingPoint[] = [];
  const startIndex = Math.max(0, Math.floor(from) - 1);
  const endIndex = Math.min(ctx.series.length, Math.ceil(to) + 1);
  const cursorRef = { i: 0 };

  for (let index = startIndex; index < endIndex; index++) {
    const bar = ctx.series.at(index);
    if (!bar) continue;
    const candleStart = bar.startTime;
    const candleEnd = bucketEnd(candleStart, ctx.series.config.intervalMs);
    const matched = findHourlyPointForCandle(hourlyZ, cursorRef, candleStart, candleEnd);
    if (!matched) continue;

    const base = {
      index,
      candleStart,
      candleEnd,
      time: matched.t,
      fundingRate: matched.fundingRate,
      predictedFundingRate: matched.predictedFundingRate,
      spread: matched.spread,
      zScore: matched.zScore,
      windowMean: matched.windowMean,
      hasData: true,
      insufficientData: matched.insufficientData,
    };
    const value = valueForMode(base, ctx.settings.mode);
    if (ctx.settings.mode !== "zScore" && !Number.isFinite(value)) continue;
    points.push({ ...base, value });
  }

  return points;
}

/** The funding line fits its visible values; the zero line is drawn only when zero is in view. */
export function rangeForPoints(points: readonly Pick<ChartFundingPoint, "value">[]): { min: number; max: number; baseline: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    min = Math.min(min, point.value);
    max = Math.max(max, point.value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -0.0001, max: 0.0001, baseline: 0 };
  if (!(max > min)) {
    const pad = Math.max(0.0001, Math.abs(max) * 0.1);
    min -= pad;
    max += pad;
  }
  return { min, max, baseline: 0 };
}

function emptyMeta(settings: FundingRegimeSettings, interval: string): FundingRegimeMeta {
  return {
    interval,
    mode: settings.mode,
    truncated: false,
    activeVenues: activeFundingVenues(settings.exchanges),
    excludedVenues: [],
    source: "",
    insufficientData: false,
    zWindowDays: clampZWindowDays(settings.zWindowDays),
    zThreshold: clampZThreshold(settings.zThreshold),
    zSource: settings.zSource === "venues" ? "venues" : "aggregate",
  };
}

function prepareFundingRegimeData(ctx: IndicatorDrawContext<FundingRegimeSettings>): FundingRegimeData {
  const interval = ctx.chart?.timeframe ?? "";
  if (!ctx.instance.visible) {
    return {
      status: "hidden",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: emptyMeta(ctx.settings, interval),
      message: "gizli",
    };
  }

  const chart = ctx.chart;
  if (!chart) {
    return {
      status: "error",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: emptyMeta(ctx.settings, ""),
      message: "chart context yok",
      error: "chart context yok",
    };
  }

  const ds = indicatorDataSource();
  if (typeof ds.requestVenueFundingSeries !== "function") {
    return {
      status: "unsupported",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: emptyMeta(ctx.settings, chart.timeframe),
      message: "Venue funding veri kaynagi desteklenmiyor",
    };
  }

  const selectedVenues = activeFundingVenues(ctx.settings.exchanges);
  const zWindowDays = clampZWindowDays(ctx.settings.zWindowDays);
  const zThreshold = clampZThreshold(ctx.settings.zThreshold);
  const zSource: FundingZSource = ctx.settings.zSource === "venues" ? "venues" : "aggregate";

  const [fromIdx, toIdx] = ctx.range;
  const firstIdx = Math.max(0, Math.floor(fromIdx));
  const lastIdx = Math.min(ctx.series.length - 1, Math.max(firstIdx, Math.ceil(toIdx) - 1));
  const firstBar = ctx.series.at(firstIdx);
  const lastBar = ctx.series.at(lastIdx);
  const visibleFromMs = firstBar ? firstBar.startTime : Date.now() - DAY_MS;
  const rawVisibleToMs = lastBar ? bucketEnd(lastBar.startTime, ctx.series.config.intervalMs) : Date.now();
  const visibleToMs = chart.asOfTime !== undefined ? Math.min(rawVisibleToMs, chart.asOfTime) : rawVisibleToMs;
  const requestFromMs = visibleFromMs - zWindowDays * DAY_MS;

  const state = ds.requestVenueFundingSeries({
    market: chart.market,
    from: requestFromMs,
    to: visibleToMs,
    venues: selectedVenues,
    onUpdate: ctx.requestRefresh,
  });

  if (state.status === "loading" || state.status === "idle") {
    return {
      status: "loading",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: emptyMeta(ctx.settings, chart.timeframe),
      message: "yukleniyor...",
    };
  }

  if (state.status === "unsupported" || state.status === "error") {
    return {
      status: state.status,
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: emptyMeta(ctx.settings, chart.timeframe),
      message: state.message,
      error: state.message,
    };
  }

  if (!isReadyState(state)) {
    return {
      status: "no-data",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: emptyMeta(ctx.settings, chart.timeframe),
      message: "Funding verisi yok",
    };
  }

  const response = state.data;
  const excludedVenues = (response.aggregate?.excludedVenues ?? response.excludedVenues ?? [])
    .filter((v): v is FundingVenue => FUNDING_VENUE_SET.has(v));
  const sourceLabel = response.aggregate?.source ?? response.source ?? "";
  const active = response.venues.length ? response.venues : selectedVenues;

  const meta: FundingRegimeMeta = {
    interval: chart.timeframe,
    mode: ctx.settings.mode,
    truncated: response.truncated === true,
    activeVenues: active,
    excludedVenues,
    source: sourceLabel,
    insufficientData: false,
    zWindowDays,
    zThreshold,
    zSource,
  };

  const cacheKey = [
    ctx.instance.id,
    ctx.series.revision,
    ctx.series.length,
    ctx.series.config.intervalMs,
    Math.floor(fromIdx),
    Math.ceil(toIdx),
    ctx.settings.mode,
    zWindowDays,
    zThreshold,
    zSource,
    selectedVenues.join(","),
    chart.asOfTime ?? "live",
    response.from,
    response.to,
    response.series.map((s) => `${s.venue}:${s.settled.length}:${s.current?.t ?? "nc"}`).join(";"),
    response.aggregate?.points.length ?? 0,
    response.aggregate?.current?.t ?? "na",
  ].join("|");
  const cached = preparedCache.get(cacheKey);
  if (cached) return cached;

  // Bucket the timeline window so pan/live-tick bar shifts reuse the chart-independent hourly z-series.
  const bucketedFromMs = Math.floor(requestFromMs / DAY_MS) * DAY_MS;
  const bucketedToMs = Math.ceil(visibleToMs / DAY_MS) * DAY_MS;
  const nativeFromMs = Number.isFinite(response.from) ? Math.min(response.from, bucketedFromMs) : bucketedFromMs;
  const rawNativeToMs = Number.isFinite(response.to) ? Math.max(response.to, bucketedToMs) : bucketedToMs;
  const nativeToMs = chart.asOfTime !== undefined ? Math.min(rawNativeToMs, chart.asOfTime) : rawNativeToMs;

  const nativeKey = [
    zWindowDays,
    zSource,
    selectedVenues.join(","),
    chart.asOfTime ?? "live",
    nativeFromMs,
    nativeToMs,
    response.from,
    response.to,
    response.series.map((s) => `${s.venue}:${s.settled.length}:${s.current?.t ?? "nc"}`).join(";"),
    response.aggregate?.points.length ?? 0,
    response.aggregate?.current?.t ?? "na",
  ].join("|");
  let hourlyZ = nativeFundingZCache.get(nativeKey);
  if (hourlyZ) {
    nativeFundingCacheHitCount += 1;
  } else {
    nativeFundingComputeCount += 1;
    const hourly = buildHourlyFundingTimeline(
      response,
      selectedVenues,
      zSource,
      nativeFromMs,
      nativeToMs,
      chart.asOfTime,
    );
    hourlyZ = attachRollingZScores(hourly, zWindowDays);
    nativeFundingZCache.set(nativeKey, hourlyZ);
  }
  const points = mapToVisibleChartCandles(ctx, hourlyZ);

  if (!points.length) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta,
      message: "bu gorunumde funding verisi yok",
    });
  }

  const hasFiniteZScore = points.some((p) => Number.isFinite(p.value));
  const insufficientData = ctx.settings.mode === "zScore" && !hasFiniteZScore;
  meta.insufficientData = insufficientData;

  let range = rangeForPoints(points);
  if (ctx.settings.mode === "zScore" && hasFiniteZScore) {
    range = {
      min: Math.min(range.min, -zThreshold),
      max: Math.max(range.max, zThreshold),
      baseline: 0,
    };
  }

  return rememberPreparedData(cacheKey, {
    status: "ok",
    points,
    range,
    meta,
  });
}

function asFundingRegimeData(prepared: IndicatorPreparedData | undefined, settings?: FundingRegimeSettings): FundingRegimeData {
  if (prepared?.points && prepared.range && prepared.meta) return prepared as FundingRegimeData;
  return {
    status: "no-data",
    points: [],
    range: { min: -0.0001, max: 0.0001, baseline: 0 },
    meta: emptyMeta(settings ?? fundingRegimeIndicatorDefinition.defaultSettings(), ""),
    message: prepared?.message ?? prepared?.error ?? "bu gorunumde veri yok",
  };
}

function pointX(ctx: IndicatorDrawContext<FundingRegimeSettings>, point: ChartFundingPoint): number {
  return ctx.view.xOfIndex(point.index) + ctx.view.colWidth / 2;
}

function focusPoint(data: FundingRegimeData, index: number | null): ChartFundingPoint | null {
  if (!data.points.length) return null;
  if (index !== null) return findPointByIndex(data.points, index);
  return findLastPointWithData(data.points);
}

function formatFundingRegimeReadout(
  ctx: IndicatorDrawContext<FundingRegimeSettings>,
  data: FundingRegimeData,
  point: ChartFundingPoint,
  isLast: boolean,
): IndicatorReadout {
  const items: IndicatorReadout["items"] = [
    { label: modeLabel(data.meta.mode), value: formatModeValue(data.meta.mode, point.value) },
  ];
  if (data.meta.mode === "zScore" && data.meta.insufficientData) {
    items.push({ label: "durum", value: "yetersiz veri" });
  } else {
    items.push({ label: "Z", value: formatZScore(point.zScore) });
  }
  const activeVenueCount = data.meta.activeVenues?.length ?? activeFundingVenues(ctx.settings.exchanges).length;
  items.push(
    { label: "rate8h", value: formatFundingRate(point.fundingRate) },
    { label: "ort", value: formatFundingRate(point.windowMean) },
    { label: "borsa", value: `${activeVenueCount}/4` },
  );
  if (data.meta.excludedVenues?.length) {
    items.push({ label: "haric", value: data.meta.excludedVenues.join(",") });
  }
  if (data.meta.source) {
    items.push({ label: "src", value: data.meta.source });
  }
  return {
    title: isLast ? "Last" : "*",
    time: tzDateTimeHud(point.candleStart, ctx.chart?.intervalMs ?? ctx.series.config.intervalMs),
    items,
  };
}

function fundingRegimeReadout(
  ctx: IndicatorDrawContext<FundingRegimeSettings>,
  prepared: IndicatorPreparedData,
  index: number | null,
): IndicatorReadout | null {
  const data = asFundingRegimeData(prepared, ctx.settings);
  const point = focusPoint(data, index);
  if (!point) return null;
  return formatFundingRegimeReadout(ctx, data, point, index === null);
}

function drawStatus(ctx: IndicatorDrawContext<FundingRegimeSettings>, data: FundingRegimeData): boolean {
  if (data.status === "hidden") {
    drawIndicatorMessage(ctx, data.message ?? "gizli");
    return true;
  }
  if (data.status === "loading") {
    drawIndicatorMessage(ctx, data.message ?? "yukleniyor...");
    return true;
  }
  if (data.status === "error" || data.status === "unsupported") {
    drawIndicatorMessage(ctx, data.message ?? data.error ?? "Funding verisi yuklenemedi", uiColor.sell);
    return true;
  }
  if (data.status === "no-data") {
    drawIndicatorMessage(ctx, data.message ?? "bu gorunumde veri yok", indicatorWarningMessageColor);
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

function drawFundingRegime(ctx: IndicatorDrawContext<FundingRegimeSettings>, prepared?: IndicatorPreparedData): void {
  const { ctx: canvas, view, rect, settings } = ctx;
  const data = asFundingRegimeData(prepared ?? prepareFundingRegimeData(ctx), settings);
  if (drawStatus(ctx, data)) return;

  if (data.meta.mode === "zScore" && data.meta.insufficientData) {
    drawIndicatorMessage(ctx, "yetersiz veri", indicatorWarningMessageColor);
    return;
  }

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const color = colorForMode(settings, data.meta.mode);
  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const isZ = data.meta.mode === "zScore";
  const scale = createIndicatorScale({
    mode: isZ ? "signed-zero" : "percent",
    min: displayRange.min,
    max: displayRange.max,
    baseline: 0,
    formatter: isZ ? formatZScore : formatFundingRate,
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.12,
  }, { top, bottom });

  if (scale.contains(0)) {
    const zeroY = scale.y(0);
    canvas.save();
    canvas.strokeStyle = settings.baselineColor || uiColor.separatorStrong;
    canvas.beginPath();
    canvas.moveTo(view.area.left, zeroY);
    canvas.lineTo(view.area.left + view.area.width, zeroY);
    canvas.stroke();
    canvas.restore();
  }

  if (isZ) {
    const threshold = clampZThreshold(settings.zThreshold);
    const thresholdColor = settings.thresholdColor || uiColor.warn;
    if (scale.contains(threshold)) {
      drawDashedHorizontalLine(canvas, view.area.left, view.area.width, scale.y(threshold), thresholdColor);
    }
    if (scale.contains(-threshold)) {
      drawDashedHorizontalLine(canvas, view.area.left, view.area.width, scale.y(-threshold), thresholdColor);
    }
  }

  canvas.save();
  canvas.strokeStyle = color;
  canvas.lineJoin = "round";
  canvas.lineCap = "round";
  canvas.lineWidth = Math.max(1, settings.lineWidth || 1.5);
  canvas.beginPath();
  let penDown = false;
  for (const point of data.points) {
    if (!Number.isFinite(point.value)) {
      penDown = false;
      continue;
    }
    const x = pointX(ctx, point);
    const y = scale.y(point.value);
    if (!penDown) {
      canvas.moveTo(x, y);
      penDown = true;
    } else {
      canvas.lineTo(x, y);
    }
  }
  canvas.stroke();
  canvas.restore();

  if (settings.showAxisTicks) drawIndicatorAxisTicks(ctx, scale, top, bottom);

  const lastPoint = focusPoint(data, null);
  if (showLastValueLabel(settings) && lastPoint && Number.isFinite(lastPoint.value)) {
    const y = Math.max(top + 9, Math.min(bottom - 9, scale.y(lastPoint.value)));
    drawIndicatorLastValueLabel(ctx, { text: scale.format(lastPoint.value), color, y });
  }
}

function drawFundingRegimeInteraction(
  ctx: IndicatorDrawContext<FundingRegimeSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const { ctx: canvas, rect, settings } = ctx;
  const data = asFundingRegimeData(prepared ?? prepareFundingRegimeData(ctx), settings);
  if (data.status !== "ok") return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const hoveredPoint = ctx.crosshair?.visible
    ? findPointByIndex(data.points, Math.floor(ctx.view.indexOfX(ctx.crosshair.x)))
    : null;
  const hoverIndex = hoveredPoint ? hoveredPoint.index : null;
  const focus = hoveredPoint ?? findLastPointWithData(data.points);

  if (showReadout(settings) && focus) {
    const readout = formatFundingRegimeReadout(ctx, data, focus, hoverIndex === null);
    drawIndicatorReadout(ctx, indicatorReadoutToText(readout));
  }

  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const isZ = data.meta.mode === "zScore";
  const scale = createIndicatorScale({
    mode: isZ ? "signed-zero" : "percent",
    min: displayRange.min,
    max: displayRange.max,
    baseline: 0,
    formatter: isZ ? formatZScore : formatFundingRate,
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.12,
  }, { top, bottom });

  if (hoverIndex !== null && focus) drawHoveredVerticalGuide(canvas, pointX(ctx, focus), top, bottom);
  drawIndicatorCrosshairValueLabel(ctx, scale, top, bottom);
}

function fundingRegimeHeaderLabel(ctx: {
  settings: FundingRegimeSettings;
  chart?: { timeframe: string };
  prepared?: IndicatorPreparedData;
}): string {
  const timeframe = ctx.chart?.timeframe ? ` ${ctx.chart.timeframe}` : "";
  const meta = ctx.prepared?.meta as FundingRegimeMeta | undefined;
  const venues = meta?.activeVenues ?? activeFundingVenues(ctx.settings.exchanges);
  const parts = [`Funding${timeframe}`, modeLabel(ctx.settings.mode)];
  if (ctx.settings.mode === "zScore") {
    parts.push(`${clampZWindowDays(ctx.settings.zWindowDays)}d`);
  }
  parts.push(`${venues.length}/4 borsa`);
  if (meta?.excludedVenues?.length) parts.push(`haric:${meta.excludedVenues.join(",")}`);
  if (meta?.source) parts.push(meta.source);
  if (meta?.insufficientData) parts.push("yetersiz veri");
  if (meta?.truncated) parts.push("truncated");
  return parts.join(" | ");
}

export const fundingRegimeIndicatorDefinition: IndicatorDefinition<FundingRegimeSettings> = {
  type: "funding-regime",
  name: "Funding Regime",
  category: "derivatives",
  defaultPane: "separate",
  canOverlay: false,
  defaultPlacement: "separate-pane",
  supportedPlacements: ["separate-pane"],
  paneHeight: 112,
  defaultSettings: () => ({
    mode: "zScore",
    zWindowDays: 30,
    zThreshold: 2,
    zSource: "aggregate",
    lineWidth: 2,
    zScoreColor: uiColor.info,
    thresholdColor: uiColor.warn,
    fundingColor: uiColor.buy,
    predictedColor: fundingPredictedColorDefault,
    spreadColor: uiColor.special,
    baselineColor: uiColor.separatorStrong,
    showScaleLabel: true,
    showLastValueLabel: true,
    showReadout: true,
    showAxisTicks: true,
    showPlotLabel: true,
    exchanges: { ...DEFAULT_VENUES },
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
              { label: "Z-Score", value: "zScore", labelKey: "indicator.fundingRegime.mode.zScore" },
              { label: "Ödenmiş", value: "fundingRate", labelKey: "indicator.fundingRegime.mode.funding" },
              { label: "Anlık tahmin", value: "predictedFundingRate", labelKey: "indicator.fundingRegime.mode.predicted" },
              { label: "Anlık − Son ödenen", value: "spread", labelKey: "indicator.fundingRegime.mode.spread" },
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
          {
            kind: "select",
            key: "zSource",
            label: "Z-Score Source",
            requiresRecalc: true,
            visibleWhen: { key: "mode", values: ["zScore"] },
            options: [
              { label: "Aggregate (OI-weighted)", value: "aggregate" },
              { label: "Selected Venues (Equal)", value: "venues" },
            ],
          },
          { kind: "exchange-matrix", key: "exchangeMatrix", label: "Aggregate Exchanges", labelKey: "indicator.common.aggregateExchanges", requiresRecalc: true },
        ],
      },
      {
        title: "Display",
        titleKey: "indicator.common.section.display",
        fields: [
          { kind: "number", key: "lineWidth", label: "Line Thickness", labelKey: "indicator.common.lineWidth", min: 1, max: 8, step: 0.5 },
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
          { kind: "color", key: "zScoreColor", label: "Z-Score Color", visibleWhen: { key: "mode", values: ["zScore"] } },
          { kind: "color", key: "thresholdColor", label: "Threshold Color", visibleWhen: { key: "mode", values: ["zScore"] } },
          { kind: "color", key: "fundingColor", label: "Funding Color", labelKey: "indicator.fundingRegime.fundingColor" },
          { kind: "color", key: "predictedColor", label: "Predicted Color", labelKey: "indicator.fundingRegime.predictedColor" },
          { kind: "color", key: "spreadColor", label: "Spread Color", labelKey: "indicator.fundingRegime.spreadColor" },
          { kind: "color", key: "baselineColor", label: "Baseline Color", labelKey: "indicator.common.baselineColor" },
        ],
      },
    ],
  },
  getHeaderLabel: fundingRegimeHeaderLabel,
  prepareData: prepareFundingRegimeData,
  getReadout: fundingRegimeReadout,
  drawSubPane: drawFundingRegime,
  drawInteraction: drawFundingRegimeInteraction,
};

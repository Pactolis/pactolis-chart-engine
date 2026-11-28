import { BoundedCache } from "../../../core/cache/boundedCache.js";
import { tOr } from "../../../core/chartLocaleFallbacks.js";
import { bucketEnd } from "../../../core/time.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import type {
  OpenInterestGap,
  OpenInterestPoint,
  OpenInterestSeriesResponse,
  OpenInterestUnit,
  OpenInterestVenue,
  OpenInterestVenueSeries,
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
  compactNumber,
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
import { uiColor, indicatorWarningMessageColor, openInterestLineColorDefault } from "../../../core/ui/seriesPalette.js";
import { findLastPointWithData, findPointByIndex } from "./pointLookup.js";

export type CrossExchangeOpenInterestMode = "openInterestUsd" | "openInterestDeltaUsd";

export const OPEN_INTEREST_VENUES: readonly OpenInterestVenue[] = [
  "binance",
  "bybit",
  "okx",
  "hyperliquid",
];

const LEGACY_EXCHANGE_KEY_MAP: Readonly<Record<string, OpenInterestVenue>> = {
  binance: "binance",
  binancef: "binance",
  bybit: "bybit",
  bybitf: "bybit",
  okx: "okx",
  okxf: "okx",
  hyperliquid: "hyperliquid",
};

export interface CrossExchangeOpenInterestSettings extends IndicatorSettings {
  mode: CrossExchangeOpenInterestMode;
  unit: OpenInterestUnit;
  lineWidth: number;
  lineColor: string;
  positiveColor: string;
  negativeColor: string;
  baselineColor: string;
  showScaleLabel?: boolean;
  showLastValueLabel?: boolean;
  showReadout?: boolean;
  showAxisTicks?: boolean;
  showPlotLabel: boolean;
  exchanges: Record<OpenInterestVenue, boolean>;
}

const DEFAULT_EXCHANGES: Record<OpenInterestVenue, boolean> = {
  binance: true,
  bybit: true,
  okx: true,
  hyperliquid: true,
};

export type ChartOpenInterestPoint = {
  index: number;
  candleStart: number;
  candleEnd: number;
  time: number;
  openInterestUsd: number;
  openInterestDeltaUsd: number;
  openInterestBase: number;
  openInterestDeltaBase: number;
  value: number;
  hasData: boolean;
};

export type OpenInterestVenueMeta = {
  venue: OpenInterestVenue;
  historyStartedAt?: number | null;
  recordingStartedAt?: number | null;
  source?: "backend" | "browser" | "instant-only";
  instantOnly: boolean;
};

type CrossExchangeOpenInterestMeta = Record<string, unknown> & {
  interval: string;
  mode: CrossExchangeOpenInterestMode;
  unit: OpenInterestUnit;
  truncated: boolean;
  recordingStartedAt: number | null;
  historyStartedAt: number | null;
  venues: OpenInterestVenueMeta[];
  activeVenueCount: number;
  selectedVenueCount: number;
  hasInstantOnlyVenue: boolean;
};

type CrossExchangeOpenInterestData = IndicatorPreparedData<ChartOpenInterestPoint, CrossExchangeOpenInterestMeta> & {
  points: ChartOpenInterestPoint[];
  range: { min: number; max: number; baseline?: number };
  meta: CrossExchangeOpenInterestMeta;
};

const preparedCache = new BoundedCache<CrossExchangeOpenInterestData>({ maxEntries: 64, ttlMs: 60 * 60_000 });

function rememberPreparedData(key: string, value: CrossExchangeOpenInterestData): CrossExchangeOpenInterestData {
  preparedCache.set(key, value);
  return value;
}

function trText(key: string, fallback: string, params?: Record<string, string | number>): string {
  try {
    return tOr(key, params);
  } catch {
    if (!params) return fallback;
    return fallback.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
  }
}

function safeFormatBoundaryTime(ms: number, intervalMs: number): string {
  try {
    return tzDateTimeHud(ms, intervalMs);
  } catch {
    const iso = new Date(ms).toISOString();
    return intervalMs >= 24 * 60 * 60_000 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
}

function resolveReliableStartBoundary(
  response: OpenInterestSeriesResponse,
  selected: readonly OpenInterestVenue[],
): { time: number; kind: "history" | "recording" } | null {
  const responseHist = finiteOrNull(response.historyStartedAt);
  const responseRec = finiteOrNull(response.recordingStartedAt);
  if (responseHist !== null || responseRec !== null) {
    if (responseHist !== null && responseRec !== null) {
      return responseHist <= responseRec
        ? { time: responseHist, kind: "history" }
        : { time: responseRec, kind: "recording" };
    }
    return responseHist !== null
      ? { time: responseHist, kind: "history" }
      : { time: responseRec!, kind: "recording" };
  }

  const selectedSet = new Set(selected);
  let best: { time: number; kind: "history" | "recording" } | null = null;
  for (const venueSeries of response.venues) {
    if (selectedSet.size > 0 && !selectedSet.has(venueSeries.venue)) continue;
    const hist = finiteOrNull(venueSeries.historyStartedAt);
    const rec = finiteOrNull(venueSeries.recordingStartedAt);
    const candidate = hist !== null && rec !== null
      ? (hist <= rec ? { time: hist, kind: "history" as const } : { time: rec, kind: "recording" as const })
      : hist !== null
        ? { time: hist, kind: "history" as const }
        : rec !== null
          ? { time: rec, kind: "recording" as const }
          : null;
    if (candidate && (!best || candidate.time < best.time)) {
      best = candidate;
    }
  }
  return best;
}

function emptyRangeMessage(
  response: OpenInterestSeriesResponse,
  selected: readonly OpenInterestVenue[],
  intervalMs: number,
): string {
  const boundary = resolveReliableStartBoundary(response, selected);
  if (boundary) {
    const timeText = safeFormatBoundaryTime(boundary.time, intervalMs);
    const labelKey = boundary.kind === "history"
      ? "indicator.crossExchangeOpenInterest.historyStarted"
      : "indicator.crossExchangeOpenInterest.recordingStarted";
    const fallbackLabel = boundary.kind === "history"
      ? `Geçmiş başlangıcı: ${timeText}`
      : `Kayıt başlangıcı: ${timeText}`;
    const started = trText(labelKey, fallbackLabel, { time: timeText });
    return trText(
      "indicator.crossExchangeOpenInterest.noDataInRangeSince",
      `Bu aralıkta OI verisi yok · ${started}`,
      { started },
    );
  }
  return trText("indicator.crossExchangeOpenInterest.noDataInRange", "Bu aralıkta OI verisi yok");
}

export function normalizeCrossExchangeOpenInterestSettings(
  raw: unknown,
): CrossExchangeOpenInterestSettings {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

  const mode: CrossExchangeOpenInterestMode =
    source.mode === "openInterestUsd" ? "openInterestUsd" : "openInterestDeltaUsd";
  const unit: OpenInterestUnit = source.unit === "base" ? "base" : "usd";

  const exchanges: Record<OpenInterestVenue, boolean> = {
    binance: false,
    bybit: false,
    okx: false,
    hyperliquid: false,
  };

  let hasExplicitExchangeSetting = false;
  const rawExchanges = source.exchanges;
  if (rawExchanges && typeof rawExchanges === "object" && !Array.isArray(rawExchanges)) {
    const legacy = rawExchanges as Record<string, unknown>;
    for (const [key, val] of Object.entries(legacy)) {
      const mapped = LEGACY_EXCHANGE_KEY_MAP[key];
      if (!mapped || typeof val !== "boolean") continue;
      hasExplicitExchangeSetting = true;
      if (key === mapped || !(mapped in legacy)) {
        exchanges[mapped] = val;
      }
    }
  }

  if (!hasExplicitExchangeSetting) {
    for (const venue of OPEN_INTEREST_VENUES) {
      exchanges[venue] = true;
    }
  }

  const lineWidth = typeof source.lineWidth === "number" && Number.isFinite(source.lineWidth)
    ? source.lineWidth
    : 2;

  return {
    mode,
    unit,
    lineWidth,
    lineColor: typeof source.lineColor === "string" && source.lineColor ? source.lineColor : openInterestLineColorDefault,
    positiveColor: typeof source.positiveColor === "string" && source.positiveColor ? source.positiveColor : uiColor.buy,
    negativeColor: typeof source.negativeColor === "string" && source.negativeColor ? source.negativeColor : uiColor.sell,
    baselineColor: typeof source.baselineColor === "string" && source.baselineColor ? source.baselineColor : uiColor.separatorStrong,
    showScaleLabel: typeof source.showScaleLabel === "boolean" ? source.showScaleLabel : true,
    showLastValueLabel: typeof source.showLastValueLabel === "boolean" ? source.showLastValueLabel : true,
    showReadout: typeof source.showReadout === "boolean" ? source.showReadout : true,
    showAxisTicks: typeof source.showAxisTicks === "boolean" ? source.showAxisTicks : true,
    showPlotLabel: typeof source.showPlotLabel === "boolean" ? source.showPlotLabel : true,
    exchanges,
  };
}

function selectedVenues(settings: CrossExchangeOpenInterestSettings): OpenInterestVenue[] {
  return OPEN_INTEREST_VENUES.filter((venue) => settings.exchanges[venue] === true);
}

function showLastValueLabel(settings: CrossExchangeOpenInterestSettings): boolean {
  return settingEnabled(settings, "showLastValueLabel", "showScaleLabel", true);
}

function showReadout(settings: CrossExchangeOpenInterestSettings): boolean {
  return settingEnabled(settings, "showReadout", "showScaleLabel", true);
}

function modeLabel(mode: CrossExchangeOpenInterestMode): string {
  return mode === "openInterestDeltaUsd" ? "OI Delta" : "Total OI";
}

function formatOiValue(value: number, unit: OpenInterestUnit): string {
  return unit === "base" ? compactNumber(value) : compactUsd(value);
}

function scaleFormatter(unit: OpenInterestUnit): (value: number) => string {
  return unit === "base" ? compactNumber : compactUsd;
}

function valueForMode(
  point: Omit<ChartOpenInterestPoint, "value">,
  mode: CrossExchangeOpenInterestMode,
  unit: OpenInterestUnit,
): number {
  if (unit === "base") {
    return mode === "openInterestDeltaUsd" ? point.openInterestDeltaBase : point.openInterestBase;
  }
  return mode === "openInterestDeltaUsd" ? point.openInterestDeltaUsd : point.openInterestUsd;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isInGap(time: number, gaps: readonly OpenInterestGap[] | undefined): boolean {
  if (!gaps || !gaps.length) return false;
  for (const gap of gaps) {
    if (time >= gap.from && time < gap.to) return true;
  }
  return false;
}

function effectiveStartBoundary(
  historyStartedAt: number | null | undefined,
  recordingStartedAt: number | null | undefined,
): number | null {
  const hist = finiteOrNull(historyStartedAt);
  const rec = finiteOrNull(recordingStartedAt);
  if (hist !== null && rec !== null) return Math.min(hist, rec);
  return hist ?? rec;
}

type VenueCursorState = {
  venue: OpenInterestVenue;
  sorted: OpenInterestPoint[];
  cursor: number;
  lastSeen: OpenInterestPoint | null;
  startBoundary: number | null;
  gaps: readonly OpenInterestGap[] | undefined;
};

function createVenueCursor(series: OpenInterestVenueSeries): VenueCursorState {
  const sorted = [...series.points].sort((a, b) => a.time - b.time);
  return {
    venue: series.venue,
    sorted,
    cursor: 0,
    lastSeen: null,
    startBoundary: effectiveStartBoundary(series.historyStartedAt, series.recordingStartedAt),
    gaps: series.gaps,
  };
}

function sampleVenueForCandle(
  state: VenueCursorState,
  candleStart: number,
  candleEnd: number,
  asOfTime: number | undefined,
): { value: number; time: number; hasNewSample: boolean } | null {
  const upperBound = asOfTime !== undefined ? Math.min(candleEnd, asOfTime) : candleEnd;

  while (state.cursor < state.sorted.length && state.sorted[state.cursor].time < candleStart) {
    const pt = state.sorted[state.cursor];
    if (!isInGap(pt.time, state.gaps)) {
      state.lastSeen = pt;
    }
    state.cursor++;
  }

  let latestInCandle: OpenInterestPoint | null = null;
  while (state.cursor < state.sorted.length && state.sorted[state.cursor].time < upperBound) {
    const pt = state.sorted[state.cursor];
    if (!isInGap(pt.time, state.gaps)) {
      latestInCandle = pt;
    }
    state.cursor++;
  }

  if (state.startBoundary !== null && candleStart < state.startBoundary) {
    return null;
  }

  if (isInGap(candleStart, state.gaps)) {
    state.lastSeen = null;
    return null;
  }

  if (latestInCandle) {
    state.lastSeen = latestInCandle;
  }

  const chosen = latestInCandle ?? state.lastSeen;
  if (!chosen || !Number.isFinite(chosen.value)) return null;
  if (state.startBoundary !== null && chosen.time < state.startBoundary && !latestInCandle) {
    return null;
  }

  return {
    value: chosen.value,
    time: chosen.time,
    hasNewSample: latestInCandle !== null,
  };
}

export function aggregateOpenInterestToChartCandles(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  response: OpenInterestSeriesResponse,
  settings: CrossExchangeOpenInterestSettings,
): ChartOpenInterestPoint[] {
  const [from, to] = ctx.range;
  if (from >= to || ctx.series.length === 0) return [];

  const enabledSet = new Set(selectedVenues(settings));
  const venueCursors = response.venues
    .filter((venueSeries) => enabledSet.has(venueSeries.venue))
    .map(createVenueCursor);

  if (!venueCursors.length) return [];

  const seriesStart = effectiveStartBoundary(response.historyStartedAt, response.recordingStartedAt);
  const asOfTime = ctx.chart?.asOfTime;
  const intervalMs = ctx.series.config.intervalMs;
  const startIndex = Math.max(0, Math.floor(from) - 1);
  const endIndex = Math.min(ctx.series.length, Math.ceil(to) + 1);
  const seedIndex = Math.max(0, startIndex - 1);

  let prevByVenue = new Map<OpenInterestVenue, number>();
  const points: ChartOpenInterestPoint[] = [];

  for (let index = seedIndex; index < endIndex; index++) {
    const bar = ctx.series.at(index);
    if (!bar) continue;
    const candleStart = bar.startTime;
    const candleEnd = bucketEnd(candleStart, intervalMs);

    if (asOfTime !== undefined && candleStart >= asOfTime) {
      break;
    }

    const beforeSeriesStart = seriesStart !== null && candleStart < seriesStart;
    const inResponseGap = isInGap(candleStart, response.gaps);

    const currentByVenue = new Map<OpenInterestVenue, number>();
    let latestTime = candleStart;
    let anyNewSample = false;

    for (const cursor of venueCursors) {
      const sample = sampleVenueForCandle(cursor, candleStart, candleEnd, asOfTime);
      if (beforeSeriesStart || inResponseGap || !sample) continue;
      currentByVenue.set(cursor.venue, sample.value);
      if (sample.time > latestTime) latestTime = sample.time;
      if (sample.hasNewSample) anyNewSample = true;
    }

    if (beforeSeriesStart || inResponseGap || currentByVenue.size === 0) {
      prevByVenue = new Map();
      continue;
    }

    let totalCoin = 0;
    for (const val of currentByVenue.values()) {
      totalCoin += val;
    }

    let coinDelta = 0;
    let overlapCount = 0;
    for (const [venue, currentVal] of currentByVenue.entries()) {
      const prevVal = prevByVenue.get(venue);
      if (prevVal !== undefined && Number.isFinite(prevVal)) {
        coinDelta += currentVal - prevVal;
        overlapCount++;
      }
    }
    if (overlapCount === 0) {
      coinDelta = 0;
    }

    prevByVenue = currentByVenue;

    if (index < startIndex) continue;

    const closePrice = Number.isFinite(bar.close) ? bar.close : 0;
    const openInterestUsd = totalCoin * closePrice;
    const openInterestDeltaUsd = coinDelta * closePrice;

    const base = {
      index,
      candleStart,
      candleEnd,
      time: latestTime,
      openInterestUsd,
      openInterestDeltaUsd,
      openInterestBase: totalCoin,
      openInterestDeltaBase: coinDelta,
      hasData: anyNewSample || currentByVenue.size > 0,
    };

    points.push({
      ...base,
      value: valueForMode(base, settings.mode, settings.unit),
    });
  }

  return points;
}

function rangeForPoints(
  points: ChartOpenInterestPoint[],
  mode: CrossExchangeOpenInterestMode,
): { min: number; max: number; baseline?: number } {
  const baseline = mode === "openInterestDeltaUsd" ? 0 : undefined;
  let min = baseline ?? Infinity;
  let max = baseline ?? -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    min = Math.min(min, point.value);
    max = Math.max(max, point.value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, baseline };
  if (!(max > min)) {
    const pad = Math.max(1, Math.abs(max) * 0.01);
    min -= pad;
    max += pad;
  }
  return { min, max, baseline };
}

function isVenueInstantOnly(venueSeries: OpenInterestVenueSeries): boolean {
  if (venueSeries.source === "instant-only") return true;
  return (
    venueSeries.venue === "hyperliquid"
    && venueSeries.source !== "backend"
    && finiteOrNull(venueSeries.historyStartedAt) === null
    && venueSeries.points.length <= 1
  );
}

function buildVenueMeta(
  venues: readonly OpenInterestVenueSeries[],
  selected: readonly OpenInterestVenue[],
): OpenInterestVenueMeta[] {
  const selectedSet = new Set(selected);
  return venues
    .filter((v) => selectedSet.has(v.venue))
    .map((v) => ({
      venue: v.venue,
      historyStartedAt: finiteOrNull(v.historyStartedAt),
      recordingStartedAt: finiteOrNull(v.recordingStartedAt),
      source: v.source,
      instantOnly: isVenueInstantOnly(v),
    }));
}

function prepareCrossExchangeOpenInterestData(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
): CrossExchangeOpenInterestData {
  const settings = normalizeCrossExchangeOpenInterestSettings(ctx.settings);
  const venues = selectedVenues(settings);

  const emptyMeta = (interval: string): CrossExchangeOpenInterestMeta => ({
    interval,
    mode: settings.mode,
    unit: settings.unit,
    truncated: false,
    recordingStartedAt: null,
    historyStartedAt: null,
    venues: [],
    activeVenueCount: 0,
    selectedVenueCount: venues.length,
    hasInstantOnlyVenue: false,
  });

  if (!ctx.instance.visible) {
    return {
      status: "hidden",
      points: [],
      range: { min: 0, max: 1 },
      meta: emptyMeta(ctx.chart?.timeframe ?? ""),
      message: "gizli",
    };
  }

  const chart = ctx.chart;
  if (!chart) {
    return {
      status: "error",
      points: [],
      range: { min: 0, max: 1 },
      meta: emptyMeta(""),
      message: "chart context yok",
      error: "chart context yok",
    };
  }

  if (venues.length === 0) {
    const msg = trText(
      "indicator.crossExchangeOpenInterest.noExchangeSelected",
      "OI için en az bir borsa seçilmelidir",
    );
    return {
      status: "no-data",
      points: [],
      range: { min: 0, max: 1 },
      meta: emptyMeta(chart.timeframe),
      message: msg,
    };
  }

  const requestFn = indicatorDataSource().requestOpenInterestSeries;
  if (!requestFn) {
    const msg = trText("indicator.crossExchangeOpenInterest.unrecorded", "OI kaydı yok (bu market kaydedilmiyor)");
    return {
      status: "no-data",
      points: [],
      range: { min: 0, max: 1 },
      meta: emptyMeta(chart.timeframe),
      message: msg,
    };
  }

  const state = requestFn({
    market: chart.market,
    timeframe: chart.timeframe,
    intervalMs: chart.intervalMs,
    venues,
    onUpdate: ctx.requestRefresh,
  });

  if (state.status === "loading" || state.status === "idle") {
    return {
      status: "loading",
      points: [],
      range: { min: 0, max: 1 },
      meta: emptyMeta(chart.timeframe),
      message: "yukleniyor...",
    };
  }

  if (state.status === "unsupported") {
    const msg = state.message || trText("indicator.crossExchangeOpenInterest.unrecorded", "OI kaydı yok (bu market kaydedilmiyor)");
    return {
      status: "no-data",
      points: [],
      range: { min: 0, max: 1 },
      meta: emptyMeta(chart.timeframe),
      message: msg,
    };
  }

  if (state.status === "error") {
    return {
      status: "error",
      points: [],
      range: { min: 0, max: 1 },
      meta: emptyMeta(chart.timeframe),
      message: state.message,
      error: state.message,
    };
  }

  const response = state.data;
  const venueMeta = buildVenueMeta(response.venues, venues);
  const hasInstantOnlyVenue = venueMeta.some((v) => v.instantOnly);
  const meta: CrossExchangeOpenInterestMeta = {
    interval: response.resolution || chart.timeframe,
    mode: settings.mode,
    unit: settings.unit,
    truncated: response.truncated === true,
    recordingStartedAt: finiteOrNull(response.recordingStartedAt),
    historyStartedAt: finiteOrNull(response.historyStartedAt),
    venues: venueMeta,
    activeVenueCount: venueMeta.length,
    selectedVenueCount: venues.length,
    hasInstantOnlyVenue,
  };

  const intervalMs = ctx.chart?.intervalMs ?? ctx.series.config.intervalMs;

  if (response.status === "unsupported") {
    const msg = response.message || trText("indicator.crossExchangeOpenInterest.unrecorded", "OI kaydı yok (bu market kaydedilmiyor)");
    return {
      status: "no-data",
      points: [],
      range: { min: 0, max: 1 },
      meta,
      message: msg,
    };
  }

  if (response.status === "no-data" || response.venues.length === 0) {
    const msg = response.message || emptyRangeMessage(response, venues, intervalMs);
    return {
      status: "no-data",
      points: [],
      range: { min: 0, max: 1 },
      meta,
      message: msg,
    };
  }

  const pointCounts = response.venues.map((v) => `${v.venue}:${v.points.length}`).join(",");
  const cacheKey = [
    ctx.instance.id,
    ctx.series.revision,
    ctx.series.length,
    ctx.series.config.intervalMs,
    ctx.chart?.asOfTime ?? "",
    Math.floor(ctx.range[0]),
    Math.ceil(ctx.range[1]),
    response.resolution,
    pointCounts,
    response.recordingStartedAt ?? "",
    response.historyStartedAt ?? "",
    response.gaps?.length ?? 0,
    response.truncated === true ? "trunc" : "full",
    settings.mode,
    settings.unit,
    venues.join(","),
  ].join("|");

  const cached = preparedCache.get(cacheKey);
  if (cached) return cached;

  const points = aggregateOpenInterestToChartCandles(ctx, response, settings);
  if (!points.length) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: 0, max: 1 },
      meta,
      message: emptyRangeMessage(response, venues, intervalMs),
    });
  }

  return rememberPreparedData(cacheKey, {
    status: "ok",
    points,
    range: rangeForPoints(points, settings.mode),
    meta,
  });
}

function asCrossExchangeOpenInterestData(prepared: IndicatorPreparedData | undefined): CrossExchangeOpenInterestData {
  if (prepared?.points && prepared.range && prepared.meta) return prepared as CrossExchangeOpenInterestData;
  return {
    status: "no-data",
    points: [],
    range: { min: 0, max: 1 },
    meta: {
      interval: "",
      mode: "openInterestDeltaUsd",
      unit: "usd",
      truncated: false,
      recordingStartedAt: null,
      historyStartedAt: null,
      venues: [],
      activeVenueCount: 0,
      selectedVenueCount: 4,
      hasInstantOnlyVenue: false,
    },
    message: prepared?.message ?? prepared?.error ?? "bu gorunumde veri yok",
  };
}

function pointX(ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>, point: ChartOpenInterestPoint): number {
  return ctx.view.xOfIndex(point.index) + ctx.view.colWidth / 2;
}

function focusPoint(data: CrossExchangeOpenInterestData, index: number | null): ChartOpenInterestPoint | null {
  if (!data.points.length) return null;
  if (index !== null) return findPointByIndex(data.points, index);
  return findLastPointWithData(data.points);
}

function formatCrossExchangeOpenInterestReadout(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  data: CrossExchangeOpenInterestData,
  point: ChartOpenInterestPoint,
  isLast: boolean,
): IndicatorReadout {
  const unit: OpenInterestUnit = data.meta.unit === "base" ? "base" : "usd";
  const intervalMs = ctx.chart?.intervalMs ?? ctx.series.config.intervalMs;
  const totalValue = unit === "base" && Number.isFinite(point.openInterestBase)
    ? point.openInterestBase
    : point.openInterestUsd;
  const deltaValue = unit === "base" && Number.isFinite(point.openInterestDeltaBase)
    ? point.openInterestDeltaBase
    : point.openInterestDeltaUsd;

  const items: IndicatorReadout["items"] = [
    { label: modeLabel(data.meta.mode), value: formatOiValue(point.value, unit) },
    { label: "OI", value: formatOiValue(totalValue, unit) },
    { label: "dOI", value: formatOiValue(deltaValue, unit) },
  ];

  const venueCount = data.meta.activeVenueCount ?? 0;
  if (venueCount > 0) {
    items.push({ label: "venues", value: String(venueCount) });
  }

  const venueList = Array.isArray(data.meta.venues) ? data.meta.venues : [];
  const hlVenue = venueList.find((v) => v.venue === "hyperliquid");
  if (hlVenue?.instantOnly) {
    items.push({ label: "HL", value: trText("indicator.crossExchangeOpenInterest.instantOnly", "instant-only") });
  }

  return {
    title: isLast ? "Last" : "*",
    time: tzDateTimeHud(point.candleStart, intervalMs),
    items,
  };
}

function crossExchangeOpenInterestReadout(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  prepared: IndicatorPreparedData,
  index: number | null,
): IndicatorReadout | null {
  const data = asCrossExchangeOpenInterestData(prepared);
  const point = focusPoint(data, index);
  if (!point) return null;
  return formatCrossExchangeOpenInterestReadout(ctx, data, point, index === null);
}

function drawStatus(ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>, data: CrossExchangeOpenInterestData): boolean {
  if (data.status === "hidden") {
    drawIndicatorMessage(ctx, data.message ?? "gizli");
    return true;
  }
  if (data.status === "loading") {
    drawIndicatorMessage(ctx, data.message ?? "yukleniyor...");
    return true;
  }
  if (data.status === "error") {
    drawIndicatorMessage(ctx, data.message ?? data.error ?? "OI verisi yuklenemedi", uiColor.sell);
    return true;
  }
  if (data.status === "no-data") {
    drawIndicatorMessage(
      ctx,
      data.message ?? trText("indicator.crossExchangeOpenInterest.noDataInRange", "Bu aralıkta OI verisi yok"),
      indicatorWarningMessageColor,
    );
    return true;
  }
  return false;
}

function findBoundaryIndex(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  boundaryTime: number,
): number | null {
  if (!ctx.series || ctx.series.length === 0) return null;
  const [from, to] = ctx.range;
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(ctx.series.length - 1, Math.ceil(to));
  for (let i = start; i <= end; i++) {
    const bar = ctx.series.at(i);
    if (bar && bar.startTime >= boundaryTime) {
      return i;
    }
  }
  return null;
}

function drawStartBoundary(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  data: CrossExchangeOpenInterestData,
  top: number,
  bottom: number,
): void {
  const boundaryTime = data.meta.historyStartedAt ?? data.meta.recordingStartedAt;
  if (boundaryTime === null || boundaryTime === undefined || !Number.isFinite(boundaryTime)) return;
  const boundaryIndex = findBoundaryIndex(ctx, boundaryTime);
  if (boundaryIndex === null) return;

  const x = ctx.view.xOfIndex(boundaryIndex);
  const { ctx: canvas, view } = ctx;
  if (x < view.area.left || x > view.area.left + view.area.width) return;

  canvas.save();
  canvas.strokeStyle = uiColor.separatorStrong;
  canvas.lineWidth = 1;
  canvas.setLineDash([4, 4]);
  canvas.beginPath();
  canvas.moveTo(x, top);
  canvas.lineTo(x, bottom);
  canvas.stroke();
  canvas.restore();

  const intervalMs = ctx.chart?.intervalMs ?? ctx.series.config.intervalMs;
  const timeText = tzDateTimeHud(boundaryTime, intervalMs);
  const labelKey = data.meta.historyStartedAt !== null && data.meta.historyStartedAt !== undefined
    ? "indicator.crossExchangeOpenInterest.historyStarted"
    : "indicator.crossExchangeOpenInterest.recordingStarted";
  const label = trText(labelKey, `Start: ${timeText}`, { time: timeText });
  drawIndicatorBadge(canvas, label, x + 4, top + 12, {
    color: uiColor.info,
    align: "left",
    maxWidth: 220,
  });
}

function drawCrossExchangeOpenInterest(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const { ctx: canvas, view, rect } = ctx;
  const settings = normalizeCrossExchangeOpenInterestSettings(ctx.settings);
  const data = asCrossExchangeOpenInterestData(prepared ?? prepareCrossExchangeOpenInterestData(ctx));
  if (drawStatus(ctx, data)) return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const mode = data.meta.mode;
  const unit: OpenInterestUnit = data.meta.unit === "base" ? "base" : "usd";
  const formatter = scaleFormatter(unit);
  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: mode === "openInterestDeltaUsd" ? "signed-zero" : (unit === "base" ? "linear" : "usd"),
    min: displayRange.min,
    max: displayRange.max,
    baseline: data.range.baseline,
    formatter,
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.08,
  }, { top, bottom });

  if (mode === "openInterestDeltaUsd" && scale.contains(0)) {
    const zeroY = scale.y(0);
    canvas.save();
    canvas.strokeStyle = settings.baselineColor || uiColor.separatorStrong;
    canvas.beginPath();
    canvas.moveTo(view.area.left, zeroY);
    canvas.lineTo(view.area.left + view.area.width, zeroY);
    canvas.stroke();
    canvas.restore();
  }

  drawStartBoundary(ctx, data, top, bottom);

  canvas.save();
  canvas.lineJoin = "round";
  canvas.lineCap = "round";
  canvas.lineWidth = Math.max(1, settings.lineWidth || 1.5);
  if (mode === "openInterestDeltaUsd") {
    const zeroY = scale.contains(0) ? scale.y(0) : bottom;
    const barWidth = Math.max(1, Math.min(view.colWidth * 0.58, 18));
    for (const point of data.points) {
      if (!point.hasData || !Number.isFinite(point.value)) continue;
      const y = scale.y(point.value);
      canvas.fillStyle = point.value >= 0
        ? settings.positiveColor || uiColor.buy
        : settings.negativeColor || uiColor.sell;
      canvas.globalAlpha = 0.82;
      canvas.fillRect(pointX(ctx, point) - barWidth / 2, Math.min(y, zeroY), barWidth, Math.max(1, Math.abs(zeroY - y)));
    }
    canvas.globalAlpha = 1;
  } else {
    canvas.strokeStyle = settings.lineColor || openInterestLineColorDefault;
    canvas.beginPath();
    let drawing = false;
    let prevIndex = -2;
    for (const point of data.points) {
      if (!point.hasData || !Number.isFinite(point.value)) {
        drawing = false;
        continue;
      }
      const x = pointX(ctx, point);
      const y = scale.y(point.value);
      if (!drawing || point.index !== prevIndex + 1) {
        canvas.moveTo(x, y);
        drawing = true;
      } else {
        canvas.lineTo(x, y);
      }
      prevIndex = point.index;
    }
    canvas.stroke();
  }
  canvas.restore();

  if (settings.showAxisTicks) drawIndicatorAxisTicks(ctx, scale, top, bottom);

  const lastPoint = focusPoint(data, null);
  if (showLastValueLabel(settings) && lastPoint) {
    const labelColor = mode === "openInterestDeltaUsd"
      ? lastPoint.value >= 0 ? settings.positiveColor : settings.negativeColor
      : settings.lineColor;
    const y = Math.max(top + 9, Math.min(bottom - 9, scale.y(lastPoint.value)));
    drawIndicatorLastValueLabel(ctx, { text: scale.format(lastPoint.value), color: labelColor || openInterestLineColorDefault, y });
  }
}

function drawCrossExchangeOpenInterestInteraction(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const { ctx: canvas, rect } = ctx;
  const settings = normalizeCrossExchangeOpenInterestSettings(ctx.settings);
  const data = asCrossExchangeOpenInterestData(prepared ?? prepareCrossExchangeOpenInterestData(ctx));
  if (data.status !== "ok") return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const hoveredPoint = ctx.crosshair?.visible
    ? findPointByIndex(data.points, Math.floor(ctx.view.indexOfX(ctx.crosshair.x)))
    : null;
  const hoverIndex = hoveredPoint ? hoveredPoint.index : null;
  const focus = hoveredPoint ?? findLastPointWithData(data.points);

  if (showReadout(settings) && focus) {
    const readout = formatCrossExchangeOpenInterestReadout(ctx, data, focus, hoverIndex === null);
    drawIndicatorReadout(ctx, indicatorReadoutToText(readout));
  }

  const mode = data.meta.mode;
  const unit: OpenInterestUnit = data.meta.unit === "base" ? "base" : "usd";
  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: mode === "openInterestDeltaUsd" ? "signed-zero" : (unit === "base" ? "linear" : "usd"),
    min: displayRange.min,
    max: displayRange.max,
    baseline: data.range.baseline,
    formatter: scaleFormatter(unit),
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.08,
  }, { top, bottom });

  if (hoverIndex !== null && focus) drawHoveredVerticalGuide(canvas, pointX(ctx, focus), top, bottom);
  drawIndicatorCrosshairValueLabel(ctx, scale, top, bottom);
}

function crossExchangeOpenInterestHeaderLabel(ctx: {
  settings: CrossExchangeOpenInterestSettings;
  chart?: { timeframe: string };
  prepared?: IndicatorPreparedData;
}): string {
  const settings = normalizeCrossExchangeOpenInterestSettings(ctx.settings);
  const timeframe = ctx.chart?.timeframe ? ` ${ctx.chart.timeframe}` : "";
  const meta = ctx.prepared?.meta as CrossExchangeOpenInterestMeta | undefined;
  const interval = meta?.interval || ctx.chart?.timeframe || "";
  const unitLabel = settings.unit === "base" ? "BASE" : "USD";
  const parts = [`Cross OI${timeframe}`, modeLabel(settings.mode), unitLabel];
  if (interval) parts.push(`src ${interval}`);
  parts.push(`${selectedVenues(settings).length}ex`);
  if (meta?.hasInstantOnlyVenue) {
    parts.push(`HL ${trText("indicator.crossExchangeOpenInterest.instantOnly", "instant-only")}`);
  }
  if (meta?.truncated) parts.push("truncated");
  return parts.join(" | ");
}

export const crossExchangeOpenInterestIndicatorDefinition: IndicatorDefinition<CrossExchangeOpenInterestSettings> = {
  type: "cross-exchange-open-interest",
  name: "Cross-Exchange OI",
  category: "derivatives",
  defaultPane: "separate",
  canOverlay: false,
  defaultPlacement: "separate-pane",
  supportedPlacements: ["separate-pane"],
  paneHeight: 120,
  defaultSettings: () => ({
    mode: "openInterestDeltaUsd",
    unit: "usd",
    lineWidth: 2,
    lineColor: openInterestLineColorDefault,
    positiveColor: uiColor.buy,
    negativeColor: uiColor.sell,
    baselineColor: uiColor.separatorStrong,
    showScaleLabel: true,
    showLastValueLabel: true,
    showReadout: true,
    showAxisTicks: true,
    showPlotLabel: true,
    exchanges: structuredClone(DEFAULT_EXCHANGES),
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
              { label: "OI Delta", value: "openInterestDeltaUsd", labelKey: "indicator.crossExchangeOpenInterest.mode.delta" },
              { label: "Total OI", value: "openInterestUsd", labelKey: "indicator.crossExchangeOpenInterest.mode.total" },
            ],
          },
          {
            kind: "select",
            key: "unit",
            label: "Unit",
            labelKey: "indicator.common.unit",
            requiresRecalc: true,
            options: [
              { label: "USD", value: "usd", labelKey: "indicator.crossExchangeOpenInterest.unit.usd" },
              { label: "Base (Coin)", value: "base", labelKey: "indicator.crossExchangeOpenInterest.unit.base" },
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
          { kind: "color", key: "lineColor", label: "OI Line Color", labelKey: "indicator.crossExchangeOpenInterest.lineColor" },
          { kind: "color", key: "positiveColor", label: "Positive Delta Color", labelKey: "indicator.common.positiveDeltaColor" },
          { kind: "color", key: "negativeColor", label: "Negative Delta Color", labelKey: "indicator.common.negativeDeltaColor" },
          { kind: "color", key: "baselineColor", label: "Baseline Color", labelKey: "indicator.common.baselineColor" },
        ],
      },
    ],
  },
  getHeaderLabel: crossExchangeOpenInterestHeaderLabel,
  prepareData: prepareCrossExchangeOpenInterestData,
  getReadout: crossExchangeOpenInterestReadout,
  drawSubPane: drawCrossExchangeOpenInterest,
  drawInteraction: drawCrossExchangeOpenInterestInteraction,
};

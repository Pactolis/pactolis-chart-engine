import { BoundedCache } from "../../../core/cache/boundedCache.js";
import { bucketEnd } from "../../../core/time.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import type { CoinalyzeDerivativePoint } from "../metricContracts.js";
import { indicatorDataSource } from "../indicatorDataSource.js";
import type {
  IndicatorDefinition,
  IndicatorDrawContext,
  IndicatorPreparedData,
  IndicatorReadout,
  IndicatorSettings,
} from "../types.js";
import {
  compactUsd,
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
import { uiColor, indicatorWarningMessageColor, openInterestLineColorDefault } from "../../../core/ui/seriesPalette.js";

export type CrossExchangeOpenInterestMode = "openInterestUsd" | "openInterestDeltaUsd";

export interface CrossExchangeOpenInterestSettings extends IndicatorSettings {
  mode: CrossExchangeOpenInterestMode;
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
  marketTypes: {
    spot: boolean;
    futuresUsdPerp: boolean;
    futuresCoinPerp: boolean;
  };
  exchanges: Record<string, boolean>;
}

const DEFAULT_EXCHANGES: Record<string, boolean> = {
  binancef: true,
  "binancef-inverse": true,
  bitmexf: true,
  "bitmex-inverse": true,
  bybitf: true,
  "bybitf-inverse": true,
  coinbasef: true,
  hyperliquid: true,
  okxf: true,
};

type ChartOpenInterestPoint = {
  index: number;
  candleStart: number;
  candleEnd: number;
  time: number;
  openInterestUsd: number;
  openInterestDeltaUsd: number;
  value: number;
  hasData: boolean;
};

type CrossExchangeOpenInterestMeta = Record<string, unknown> & {
  interval: string;
  mode: CrossExchangeOpenInterestMode;
  truncated: boolean;
  symbolCount: number;
};

type CrossExchangeOpenInterestData = IndicatorPreparedData<ChartOpenInterestPoint, CrossExchangeOpenInterestMeta> & {
  points: ChartOpenInterestPoint[];
  range: { min: number; max: number; baseline?: number };
  meta: CrossExchangeOpenInterestMeta;
};

// Memoizes derived draw data per (instance x series revision x range x settings)
// key; keys naturally rotate as the chart advances, so this is a size-bounded
// LRU rather than a TTL concern (a generous TTL is just a safety net for a key
// that stops rotating, e.g. a hidden/inactive instance).
const preparedCache = new BoundedCache<CrossExchangeOpenInterestData>({ maxEntries: 64, ttlMs: 60 * 60_000 });

function rememberPreparedData(key: string, value: CrossExchangeOpenInterestData): CrossExchangeOpenInterestData {
  preparedCache.set(key, value);
  return value;
}

function showLastValueLabel(settings: CrossExchangeOpenInterestSettings): boolean {
  return settingEnabled(settings, "showLastValueLabel", "showScaleLabel", true);
}

function showReadout(settings: CrossExchangeOpenInterestSettings): boolean {
  return settingEnabled(settings, "showReadout", "showScaleLabel", true);
}

function enabledExchangeCount(settings: CrossExchangeOpenInterestSettings): number {
  return Object.values(settings.exchanges ?? {}).filter(Boolean).length;
}

function marketTypesLabel(settings: CrossExchangeOpenInterestSettings): string {
  const parts: string[] = [];
  if (settings.marketTypes?.spot) parts.push("SPOT");
  if (settings.marketTypes?.futuresUsdPerp) parts.push("USD");
  if (settings.marketTypes?.futuresCoinPerp) parts.push("COIN");
  return parts.length ? parts.join("+") : "no market";
}

function modeLabel(mode: CrossExchangeOpenInterestMode): string {
  return mode === "openInterestDeltaUsd" ? "OI Delta" : "Total OI";
}

function valueForMode(point: Omit<ChartOpenInterestPoint, "value">, mode: CrossExchangeOpenInterestMode): number {
  return mode === "openInterestDeltaUsd" ? point.openInterestDeltaUsd : point.openInterestUsd;
}

function aggregateToChartCandles(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  source: CoinalyzeDerivativePoint[],
): ChartOpenInterestPoint[] {
  const [from, to] = ctx.range;
  if (from >= to || ctx.series.length === 0 || source.length === 0) return [];

  const sorted = [...source].sort((a, b) => a.time - b.time);
  let cursor = 0;
  let lastSeen: CoinalyzeDerivativePoint | null = null;
  let previousOpenInterestUsd: number | null = null;
  const points: ChartOpenInterestPoint[] = [];
  const startIndex = Math.max(0, Math.floor(from) - 1);
  const endIndex = Math.min(ctx.series.length, Math.ceil(to) + 1);

  for (let index = startIndex; index < endIndex; index++) {
    const bar = ctx.series.at(index);
    if (!bar) continue;
    const candleStart = bar.startTime;
    const candleEnd = bucketEnd(candleStart, ctx.series.config.intervalMs);

    while (cursor < sorted.length && sorted[cursor].time < candleStart) {
      lastSeen = sorted[cursor];
      cursor++;
    }

    const bucket: CoinalyzeDerivativePoint[] = [];
    let scan = cursor;
    while (scan < sorted.length && sorted[scan].time < candleEnd) {
      bucket.push(sorted[scan]);
      scan++;
    }
    if (bucket.length) lastSeen = bucket[bucket.length - 1];
    const latest = bucket[bucket.length - 1] ?? lastSeen;
    if (!latest) continue;

    const openInterestDeltaUsd = previousOpenInterestUsd === null
      ? 0
      : latest.value - previousOpenInterestUsd;
    previousOpenInterestUsd = latest.value;

    const base = {
      index,
      candleStart,
      candleEnd,
      time: latest.time,
      openInterestUsd: latest.value,
      openInterestDeltaUsd,
      hasData: bucket.length > 0,
    };
    points.push({
      ...base,
      value: valueForMode(base, ctx.settings.mode),
    });
  }

  return points;
}

function rangeForPoints(points: ChartOpenInterestPoint[], mode: CrossExchangeOpenInterestMode): { min: number; max: number; baseline?: number } {
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

function prepareCrossExchangeOpenInterestData(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
): CrossExchangeOpenInterestData {
  if (!ctx.instance.visible) {
    return {
      status: "hidden",
      points: [],
      range: { min: 0, max: 1 },
      meta: { interval: ctx.chart?.timeframe ?? "", mode: ctx.settings.mode, truncated: false, symbolCount: 0 },
      message: "gizli",
    };
  }

  const chart = ctx.chart;
  if (!chart) {
    return {
      status: "error",
      points: [],
      range: { min: 0, max: 1 },
      meta: { interval: "", mode: ctx.settings.mode, truncated: false, symbolCount: 0 },
      message: "chart context yok",
      error: "chart context yok",
    };
  }

  const state = indicatorDataSource().requestCoinalyzeDerivativeSeries({
    metric: "openInterest",
    market: chart.market,
    timeframe: chart.timeframe,
    intervalMs: chart.intervalMs,
    exchanges: ctx.settings.exchanges,
    marketTypes: ctx.settings.marketTypes,
    onUpdate: ctx.requestRefresh,
  });

  if (state.status === "loading" || state.status === "idle") {
    return {
      status: "loading",
      points: [],
      range: { min: 0, max: 1 },
      meta: { interval: chart.timeframe, mode: ctx.settings.mode, truncated: false, symbolCount: 0 },
      message: "yukleniyor...",
    };
  }
  if (state.status === "unsupported" || state.status === "error") {
    return {
      status: "error",
      points: [],
      range: { min: 0, max: 1 },
      meta: { interval: chart.timeframe, mode: ctx.settings.mode, truncated: false, symbolCount: 0 },
      message: state.message,
      error: state.message,
    };
  }

  const cacheKey = [
    ctx.instance.id,
    ctx.series.revision,
    ctx.series.length,
    ctx.series.config.intervalMs,
    Math.floor(ctx.range[0]),
    Math.ceil(ctx.range[1]),
    state.data.interval,
    state.data.from,
    state.data.to,
    state.data.symbols.length,
    state.data.points.length,
    state.data.truncated === true ? "trunc" : "full",
    ctx.settings.mode,
  ].join("|");
  const cached = preparedCache.get(cacheKey);
  if (cached) return cached;

  const meta = {
    interval: state.data.interval,
    mode: ctx.settings.mode,
    truncated: state.data.truncated === true,
    symbolCount: state.data.symbols.length,
  };
  if (!state.data.symbols.length) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: 0, max: 1 },
      meta,
      message: "secili borsalarda Coinalyze OI sembolu bulunamadi",
    });
  }

  const points = aggregateToChartCandles(ctx, state.data.points);
  if (!points.length) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: 0, max: 1 },
      meta,
      message: "bu gorunumde OI verisi yok",
    });
  }

  return rememberPreparedData(cacheKey, {
    status: "ok",
    points,
    range: rangeForPoints(points, ctx.settings.mode),
    meta,
  });
}

function asCrossExchangeOpenInterestData(prepared: IndicatorPreparedData | undefined): CrossExchangeOpenInterestData {
  if (prepared?.points && prepared.range && prepared.meta) return prepared as CrossExchangeOpenInterestData;
  return {
    status: "no-data",
    points: [],
    range: { min: 0, max: 1 },
    meta: { interval: "", mode: "openInterestUsd", truncated: false, symbolCount: 0 },
    message: prepared?.message ?? prepared?.error ?? "bu gorunumde veri yok",
  };
}

function pointX(ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>, point: ChartOpenInterestPoint): number {
  return ctx.view.xOfIndex(point.index) + ctx.view.colWidth / 2;
}

function focusIndex(ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>, data: CrossExchangeOpenInterestData): number | null {
  const crosshair = ctx.crosshair;
  if (!crosshair?.visible) return null;
  const hoverIndex = Math.floor(ctx.view.indexOfX(crosshair.x));
  return data.points.some((point) => point.index === hoverIndex) ? hoverIndex : null;
}

function focusPoint(data: CrossExchangeOpenInterestData, index: number | null): ChartOpenInterestPoint | null {
  if (!data.points.length) return null;
  if (index !== null) return data.points.find((point) => point.index === index) ?? null;
  const lastWithData = [...data.points].reverse().find((point) => point.hasData);
  return lastWithData ?? data.points[data.points.length - 1] ?? null;
}

function crossExchangeOpenInterestReadout(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  prepared: IndicatorPreparedData,
  index: number | null,
): IndicatorReadout | null {
  const data = asCrossExchangeOpenInterestData(prepared);
  const point = focusPoint(data, index);
  if (!point) return null;
  return {
    title: index === null ? "Last" : "*",
    time: tzDateTimeHud(point.candleStart, ctx.chart?.intervalMs ?? ctx.series.config.intervalMs),
    items: [
      { label: modeLabel(data.meta.mode), value: compactUsd(point.value) },
      { label: "OI", value: compactUsd(point.openInterestUsd) },
      { label: "dOI", value: compactUsd(point.openInterestDeltaUsd) },
      { label: "sym", value: String(data.meta.symbolCount) },
    ],
  };
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
    drawIndicatorMessage(ctx, data.message ?? data.error ?? "Coinalyze OI verisi yuklenemedi", uiColor.sell);
    return true;
  }
  if (data.status === "no-data") {
    drawIndicatorMessage(ctx, data.message ?? "bu gorunumde veri yok", indicatorWarningMessageColor);
    return true;
  }
  return false;
}

function drawCrossExchangeOpenInterest(
  ctx: IndicatorDrawContext<CrossExchangeOpenInterestSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const { ctx: canvas, view, rect, settings } = ctx;
  const data = asCrossExchangeOpenInterestData(prepared ?? prepareCrossExchangeOpenInterestData(ctx));
  if (drawStatus(ctx, data)) return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const mode = data.meta.mode;
  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: mode === "openInterestDeltaUsd" ? "signed-zero" : "usd",
    min: displayRange.min,
    max: displayRange.max,
    baseline: data.range.baseline,
    formatter: compactUsd,
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

  canvas.save();
  canvas.lineJoin = "round";
  canvas.lineCap = "round";
  canvas.lineWidth = Math.max(1, settings.lineWidth || 1.5);
  if (mode === "openInterestDeltaUsd") {
    const zeroY = scale.contains(0) ? scale.y(0) : bottom;
    const barWidth = Math.max(1, Math.min(view.colWidth * 0.58, 18));
    for (const point of data.points) {
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
    data.points.forEach((point, index) => {
      const x = pointX(ctx, point);
      const y = scale.y(point.value);
      if (index === 0) canvas.moveTo(x, y);
      else canvas.lineTo(x, y);
    });
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
  const { ctx: canvas, rect, settings } = ctx;
  const data = asCrossExchangeOpenInterestData(prepared ?? prepareCrossExchangeOpenInterestData(ctx));
  if (data.status !== "ok") return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const hoverIndex = focusIndex(ctx, data);
  const focus = focusPoint(data, hoverIndex);

  if (showReadout(settings)) {
    const readout = crossExchangeOpenInterestReadout(ctx, data, hoverIndex);
    if (readout) drawIndicatorReadout(ctx, indicatorReadoutToText(readout));
  }

  const mode = data.meta.mode;
  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: mode === "openInterestDeltaUsd" ? "signed-zero" : "usd",
    min: displayRange.min,
    max: displayRange.max,
    baseline: data.range.baseline,
    formatter: compactUsd,
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
  const timeframe = ctx.chart?.timeframe ? ` ${ctx.chart.timeframe}` : "";
  const meta = ctx.prepared?.meta as CrossExchangeOpenInterestMeta | undefined;
  const interval = meta?.interval || ctx.chart?.timeframe || "";
  const parts = [`Cross OI${timeframe}`, modeLabel(ctx.settings.mode)];
  if (interval) parts.push(`src ${interval}`);
  parts.push(`${enabledExchangeCount(ctx.settings)}ex`);
  parts.push(marketTypesLabel(ctx.settings));
  if (meta?.symbolCount) parts.push(`${meta.symbolCount} sym`);
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
    marketTypes: {
      spot: false,
      futuresUsdPerp: true,
      futuresCoinPerp: true,
    },
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

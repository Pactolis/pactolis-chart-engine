import { BoundedCache } from "../../../core/cache/boundedCache.js";
import { bucketEnd } from "../../../core/time.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import type {
  FuturesPositioningMode,
  FuturesPositioningPoint,
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
import { uiColor, indicatorWarningMessageColor, positioningRatioColorDefault } from "../../../core/ui/seriesPalette.js";

export interface FuturesPositioningIndicatorSettings extends IndicatorSettings {
  mode: FuturesPositioningMode;
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
}

type ChartPositioningPoint = {
  index: number;
  candleStart: number;
  candleEnd: number;
  time: number;
  openInterest: number;
  openInterestUsd: number;
  openInterestDeltaUsd: number;
  topTraderAccountLongShortRatio: number;
  topTraderPositionLongShortRatio: number;
  globalLongShortRatio: number;
  takerLongShortVolumeRatio: number;
  value: number;
  hasData: boolean;
};

type FuturesPositioningPreparedMeta = Record<string, unknown> & {
  symbol: string;
  interval: string;
  mode: FuturesPositioningMode;
  truncated: boolean;
  missingDays: number;
};

type FuturesPositioningPreparedData = IndicatorPreparedData<ChartPositioningPoint, FuturesPositioningPreparedMeta> & {
  points: ChartPositioningPoint[];
  range: { min: number; max: number; baseline?: number };
  meta: FuturesPositioningPreparedMeta;
};

// Memoizes derived draw data per (instance x series revision x range x settings)
// key; keys naturally rotate as the chart advances, so this is a size-bounded
// LRU rather than a TTL concern (a generous TTL is just a safety net for a key
// that stops rotating, e.g. a hidden/inactive instance).
const preparedCache = new BoundedCache<FuturesPositioningPreparedData>({ maxEntries: 64, ttlMs: 60 * 60_000 });

function rememberPreparedData(key: string, value: FuturesPositioningPreparedData): FuturesPositioningPreparedData {
  preparedCache.set(key, value);
  return value;
}

function showLastValueLabel(settings: FuturesPositioningIndicatorSettings): boolean {
  return settingEnabled(settings, "showLastValueLabel", "showScaleLabel", true);
}

function showReadout(settings: FuturesPositioningIndicatorSettings): boolean {
  return settingEnabled(settings, "showReadout", "showScaleLabel", true);
}

function modeLabel(mode: FuturesPositioningMode): string {
  switch (mode) {
    case "openInterestDeltaUsd": return "OI Delta";
    case "globalLongShortRatio": return "Global L/S";
    case "topTraderLongShortRatio": return "Top L/S";
    case "takerLongShortVolumeRatio": return "Taker Pressure";
    case "openInterestUsd":
    default:
      return "OI Notional";
  }
}

function valueForMode(point: Omit<ChartPositioningPoint, "value">, mode: FuturesPositioningMode): number {
  switch (mode) {
    case "openInterestDeltaUsd": return point.openInterestDeltaUsd;
    case "globalLongShortRatio": return point.globalLongShortRatio;
    case "topTraderLongShortRatio": return point.topTraderPositionLongShortRatio;
    case "takerLongShortVolumeRatio": return point.takerLongShortVolumeRatio;
    case "openInterestUsd":
    default:
      return point.openInterestUsd;
  }
}

function formatForMode(mode: FuturesPositioningMode, value: number): string {
  if (mode === "openInterestUsd" || mode === "openInterestDeltaUsd") return compactUsd(value);
  return `${value.toFixed(2)}x`;
}

function baselineForMode(mode: FuturesPositioningMode): number | undefined {
  if (mode === "openInterestDeltaUsd") return 0;
  if (mode === "globalLongShortRatio" || mode === "topTraderLongShortRatio" || mode === "takerLongShortVolumeRatio") return 1;
  return undefined;
}

function lineColorForMode(settings: FuturesPositioningIndicatorSettings, mode: FuturesPositioningMode): string {
  if (mode === "openInterestDeltaUsd") return settings.positiveColor || uiColor.buy;
  if (mode === "takerLongShortVolumeRatio") return uiColor.buy;
  if (mode === "globalLongShortRatio" || mode === "topTraderLongShortRatio") return uiColor.special;
  return settings.lineColor || positioningRatioColorDefault;
}

function visibleTimeWindow(ctx: IndicatorDrawContext<FuturesPositioningIndicatorSettings>): { from: number; to: number } | null {
  const [fromIndex, toIndex] = ctx.range;
  const startIndex = Math.max(0, Math.floor(fromIndex) - 1);
  const endIndex = Math.min(ctx.series.length - 1, Math.ceil(toIndex) + 1);
  const first = ctx.series.at(startIndex);
  const last = ctx.series.at(endIndex);
  if (!first || !last) return null;
  return {
    from: Math.max(0, first.startTime - 24 * 60 * 60 * 1000),
    to: bucketEnd(last.startTime, ctx.series.config.intervalMs) + 24 * 60 * 60 * 1000,
  };
}

function average(points: FuturesPositioningPoint[], key: keyof FuturesPositioningPoint, fallback: number): number {
  let sum = 0;
  let count = 0;
  for (const point of points) {
    const value = point[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    sum += value;
    count++;
  }
  return count > 0 ? sum / count : fallback;
}

function aggregateToChartCandles(
  ctx: IndicatorDrawContext<FuturesPositioningIndicatorSettings>,
  source: FuturesPositioningPoint[],
): ChartPositioningPoint[] {
  const [from, to] = ctx.range;
  if (from >= to || ctx.series.length === 0 || source.length === 0) return [];

  const sorted = [...source].sort((a, b) => a.time - b.time);
  let cursor = 0;
  let lastSeen: FuturesPositioningPoint | null = null;
  let previousOpenInterestUsd: number | null = null;
  const points: ChartPositioningPoint[] = [];
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

    const bucket: FuturesPositioningPoint[] = [];
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
      : latest.openInterestUsd - previousOpenInterestUsd;
    previousOpenInterestUsd = latest.openInterestUsd;

    const base = {
      index,
      candleStart,
      candleEnd,
      time: latest.time,
      openInterest: latest.openInterest,
      openInterestUsd: latest.openInterestUsd,
      openInterestDeltaUsd,
      topTraderAccountLongShortRatio: average(bucket, "topTraderAccountLongShortRatio", latest.topTraderAccountLongShortRatio),
      topTraderPositionLongShortRatio: average(bucket, "topTraderPositionLongShortRatio", latest.topTraderPositionLongShortRatio),
      globalLongShortRatio: average(bucket, "globalLongShortRatio", latest.globalLongShortRatio),
      takerLongShortVolumeRatio: average(bucket, "takerLongShortVolumeRatio", latest.takerLongShortVolumeRatio),
      hasData: bucket.length > 0,
    };
    points.push({
      ...base,
      value: valueForMode(base, ctx.settings.mode),
    });
  }

  return points;
}

/**
 * The pane fits its visible values. OI delta bars grow from zero, so zero stays
 * in view for them; the ratio baseline of 1 is a reference line only.
 */
export function rangeForPoints(points: readonly Pick<ChartPositioningPoint, "value">[], mode: FuturesPositioningMode): { min: number; max: number; baseline?: number } {
  const baseline = baselineForMode(mode);
  const barsFromZero = mode === "openInterestDeltaUsd";
  let min = barsFromZero ? 0 : Infinity;
  let max = barsFromZero ? 0 : -Infinity;
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

function prepareFuturesPositioningData(ctx: IndicatorDrawContext<FuturesPositioningIndicatorSettings>): FuturesPositioningPreparedData {
  if (!ctx.instance.visible) {
    return {
      status: "hidden",
      points: [],
      range: { min: 0, max: 1 },
      meta: { symbol: "", interval: "5m", mode: ctx.settings.mode, truncated: false, missingDays: 0 },
      message: "gizli",
    };
  }

  const chart = ctx.chart;
  const window = visibleTimeWindow(ctx);
  if (!chart || !window) {
    return {
      status: "error",
      points: [],
      range: { min: 0, max: 1 },
      meta: { symbol: "", interval: "5m", mode: ctx.settings.mode, truncated: false, missingDays: 0 },
      message: "chart context yok",
      error: "chart context yok",
    };
  }

  const state = indicatorDataSource().requestFuturesPositioningSeries({
    market: chart.market,
    from: window.from,
    to: window.to,
    onUpdate: ctx.requestRefresh,
  });

  if (state.status === "loading" || state.status === "idle") {
    return {
      status: "loading",
      points: [],
      range: { min: 0, max: 1 },
      meta: { symbol: "", interval: "5m", mode: ctx.settings.mode, truncated: false, missingDays: 0 },
      message: "yukleniyor...",
    };
  }
  if (state.status === "unsupported") {
    return {
      status: "error",
      points: [],
      range: { min: 0, max: 1 },
      meta: { symbol: "", interval: "5m", mode: ctx.settings.mode, truncated: false, missingDays: 0 },
      message: state.message,
      error: state.message,
    };
  }
  if (state.status === "error") {
    return {
      status: "error",
      points: [],
      range: { min: 0, max: 1 },
      meta: { symbol: "", interval: "5m", mode: ctx.settings.mode, truncated: false, missingDays: 0 },
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
    state.data.symbol,
    state.data.from,
    state.data.to,
    state.data.points.length,
    ctx.settings.mode,
  ].join("|");
  const cached = preparedCache.get(cacheKey);
  if (cached) return cached;

  const points = aggregateToChartCandles(ctx, state.data.points);
  const meta = {
    symbol: state.data.symbol,
    interval: state.data.interval,
    mode: ctx.settings.mode,
    truncated: state.data.truncated === true,
    missingDays: state.data.missingDays.length,
  };
  if (!points.length) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: 0, max: 1 },
      meta,
      message: "bu gorunumde positioning verisi yok",
    });
  }

  return rememberPreparedData(cacheKey, {
    status: "ok",
    points,
    range: rangeForPoints(points, ctx.settings.mode),
    meta,
  });
}

function asFuturesPositioningData(prepared: IndicatorPreparedData | undefined): FuturesPositioningPreparedData {
  if (prepared?.points && prepared.range && prepared.meta) return prepared as FuturesPositioningPreparedData;
  return {
    status: "no-data",
    points: [],
    range: { min: 0, max: 1 },
    meta: { symbol: "", interval: "5m", mode: "openInterestUsd", truncated: false, missingDays: 0 },
    message: prepared?.message ?? prepared?.error ?? "bu gorunumde veri yok",
  };
}

function pointX(ctx: IndicatorDrawContext<FuturesPositioningIndicatorSettings>, point: ChartPositioningPoint): number {
  return ctx.view.xOfIndex(point.index) + ctx.view.colWidth / 2;
}

function focusIndex(ctx: IndicatorDrawContext<FuturesPositioningIndicatorSettings>, data: FuturesPositioningPreparedData): number | null {
  const crosshair = ctx.crosshair;
  if (!crosshair?.visible) return null;
  const hoverIndex = Math.floor(ctx.view.indexOfX(crosshair.x));
  return data.points.some((point) => point.index === hoverIndex) ? hoverIndex : null;
}

function focusPoint(data: FuturesPositioningPreparedData, index: number | null): ChartPositioningPoint | null {
  if (!data.points.length) return null;
  if (index !== null) return data.points.find((point) => point.index === index) ?? null;
  const lastWithData = [...data.points].reverse().find((point) => point.hasData);
  return lastWithData ?? data.points[data.points.length - 1] ?? null;
}

function futuresPositioningReadout(
  ctx: IndicatorDrawContext<FuturesPositioningIndicatorSettings>,
  prepared: IndicatorPreparedData,
  index: number | null,
): IndicatorReadout | null {
  const data = asFuturesPositioningData(prepared);
  const point = focusPoint(data, index);
  if (!point) return null;
  return {
    title: index === null ? "Last" : "*",
    time: tzDateTimeHud(point.candleStart, ctx.chart?.intervalMs ?? ctx.series.config.intervalMs),
    items: [
      { label: modeLabel(data.meta.mode), value: formatForMode(data.meta.mode, point.value) },
      { label: "OI", value: compactUsd(point.openInterestUsd) },
      { label: "dOI", value: compactUsd(point.openInterestDeltaUsd) },
      { label: "G L/S", value: `${point.globalLongShortRatio.toFixed(2)}x` },
      { label: "Top", value: `${point.topTraderPositionLongShortRatio.toFixed(2)}x` },
      { label: "Taker", value: `${point.takerLongShortVolumeRatio.toFixed(2)}x` },
    ],
  };
}

function drawStatus(ctx: IndicatorDrawContext<FuturesPositioningIndicatorSettings>, data: FuturesPositioningPreparedData): boolean {
  if (data.status === "hidden") {
    drawIndicatorMessage(ctx, data.message ?? "gizli");
    return true;
  }
  if (data.status === "loading") {
    drawIndicatorMessage(ctx, data.message ?? "yukleniyor...");
    return true;
  }
  if (data.status === "error") {
    drawIndicatorMessage(ctx, data.message ?? data.error ?? "positioning verisi yuklenemedi", uiColor.sell);
    return true;
  }
  if (data.status === "no-data") {
    drawIndicatorMessage(ctx, data.message ?? "bu gorunumde veri yok", indicatorWarningMessageColor);
    return true;
  }
  return false;
}

function drawFuturesPositioning(ctx: IndicatorDrawContext<FuturesPositioningIndicatorSettings>, prepared?: IndicatorPreparedData): void {
  const { ctx: canvas, view, rect, settings } = ctx;
  const data = asFuturesPositioningData(prepared ?? prepareFuturesPositioningData(ctx));
  if (drawStatus(ctx, data)) return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const mode = data.meta.mode;
  const color = lineColorForMode(settings, mode);
  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: mode === "openInterestDeltaUsd" ? "signed-zero" : "linear",
    min: displayRange.min,
    max: displayRange.max,
    baseline: data.range.baseline,
    formatter: (value) => formatForMode(mode, value),
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.08,
  }, { top, bottom });

  const baseline = baselineForMode(mode);
  if (baseline !== undefined && scale.contains(baseline)) {
    const y = scale.y(baseline);
    canvas.save();
    canvas.strokeStyle = settings.baselineColor || uiColor.separatorStrong;
    canvas.beginPath();
    canvas.moveTo(view.area.left, y);
    canvas.lineTo(view.area.left + view.area.width, y);
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
    canvas.strokeStyle = color;
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
    const y = Math.max(top + 9, Math.min(bottom - 9, scale.y(lastPoint.value)));
    const labelColor = mode === "openInterestDeltaUsd"
      ? lastPoint.value >= 0 ? settings.positiveColor : settings.negativeColor
      : color;
    drawIndicatorLastValueLabel(ctx, { text: scale.format(lastPoint.value), color: labelColor || color, y });
  }
}

function drawFuturesPositioningInteraction(
  ctx: IndicatorDrawContext<FuturesPositioningIndicatorSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const { ctx: canvas, rect, settings } = ctx;
  const data = asFuturesPositioningData(prepared ?? prepareFuturesPositioningData(ctx));
  if (data.status !== "ok") return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const hoverIndex = focusIndex(ctx, data);
  const focus = focusPoint(data, hoverIndex);

  if (showReadout(settings)) {
    const readout = futuresPositioningReadout(ctx, data, hoverIndex);
    if (readout) drawIndicatorReadout(ctx, indicatorReadoutToText(readout));
  }

  const mode = data.meta.mode;
  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: mode === "openInterestDeltaUsd" ? "signed-zero" : "linear",
    min: displayRange.min,
    max: displayRange.max,
    baseline: data.range.baseline,
    formatter: (value) => formatForMode(mode, value),
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.08,
  }, { top, bottom });

  if (hoverIndex !== null && focus) drawHoveredVerticalGuide(canvas, pointX(ctx, focus), top, bottom);
  drawIndicatorCrosshairValueLabel(ctx, scale, top, bottom);
}

function futuresPositioningHeaderLabel(ctx: {
  settings: FuturesPositioningIndicatorSettings;
  chart?: { timeframe: string };
  prepared?: IndicatorPreparedData;
}): string {
  const timeframe = ctx.chart?.timeframe ? ` ${ctx.chart.timeframe}` : "";
  const meta = ctx.prepared?.meta as FuturesPositioningPreparedMeta | undefined;
  const parts = [`Positioning${timeframe}`, modeLabel(ctx.settings.mode), "src 5m"];
  if (meta?.symbol) parts.push(meta.symbol);
  if (meta?.truncated) parts.push("truncated");
  if (meta?.missingDays) parts.push(`${meta.missingDays} missing`);
  return parts.join(" | ");
}

export const futuresPositioningIndicatorDefinition: IndicatorDefinition<FuturesPositioningIndicatorSettings> = {
  type: "futures-positioning",
  name: "Futures Positioning",
  category: "derivatives",
  defaultPane: "separate",
  canOverlay: false,
  defaultPlacement: "separate-pane",
  supportedPlacements: ["separate-pane"],
  paneHeight: 124,
  defaultSettings: () => ({
    mode: "openInterestUsd",
    lineWidth: 2,
    lineColor: positioningRatioColorDefault,
    positiveColor: uiColor.buy,
    negativeColor: uiColor.sell,
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
              { label: "OI Notional", value: "openInterestUsd", labelKey: "indicator.futuresPositioning.mode.oiNotional" },
              { label: "OI Delta", value: "openInterestDeltaUsd", labelKey: "indicator.futuresPositioning.mode.oiDelta" },
              { label: "Global Long/Short", value: "globalLongShortRatio", labelKey: "indicator.futuresPositioning.mode.globalLongShort" },
              { label: "Top Trader Long/Short", value: "topTraderLongShortRatio", labelKey: "indicator.futuresPositioning.mode.topTraderLongShort" },
              { label: "Taker Pressure", value: "takerLongShortVolumeRatio", labelKey: "indicator.futuresPositioning.mode.takerPressure" },
            ],
          },
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
          { kind: "color", key: "lineColor", label: "OI Line Color", labelKey: "indicator.futuresPositioning.lineColor" },
          { kind: "color", key: "positiveColor", label: "Positive Delta Color", labelKey: "indicator.common.positiveDeltaColor" },
          { kind: "color", key: "negativeColor", label: "Negative Delta Color", labelKey: "indicator.common.negativeDeltaColor" },
          { kind: "color", key: "baselineColor", label: "Baseline Color", labelKey: "indicator.common.baselineColor" },
        ],
      },
    ],
  },
  getHeaderLabel: futuresPositioningHeaderLabel,
  prepareData: prepareFuturesPositioningData,
  getReadout: futuresPositioningReadout,
  drawSubPane: drawFuturesPositioning,
  drawInteraction: drawFuturesPositioningInteraction,
};

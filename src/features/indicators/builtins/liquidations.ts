import { BoundedCache } from "../../../core/cache/boundedCache.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import { bucketEnd } from "../../../core/time.js";
import type { LiquidationPoint } from "../metricContracts.js";
import { indicatorDataSource } from "../indicatorDataSource.js";
import { t } from "../../../core/chartLocale.js";
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

export interface LiquidationsIndicatorSettings extends IndicatorSettings {
  showLong: boolean;
  showShort: boolean;
  showDelta: boolean;
  longColor: string;
  shortColor: string;
  deltaColor: string;
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

type ChartLiquidationPoint = LiquidationPoint & {
  index: number;
  candleStart: number;
  candleEnd: number;
  hasData: boolean;
};

type LiquidationsPreparedMeta = Record<string, unknown> & {
  interval: string;
  truncated: boolean;
  symbolCount: number;
  maxAbs: number;
};

type LiquidationsPreparedData = IndicatorPreparedData<ChartLiquidationPoint, LiquidationsPreparedMeta> & {
  points: ChartLiquidationPoint[];
  range: { min: number; max: number; baseline: number };
  meta: LiquidationsPreparedMeta;
};

// Memoizes derived draw data per (instance x series revision x range x settings)
// key; keys naturally rotate as the chart advances, so this is a size-bounded
// LRU rather than a TTL concern (a generous TTL is just a safety net for a key
// that stops rotating, e.g. a hidden/inactive instance).
const preparedCache = new BoundedCache<LiquidationsPreparedData>({ maxEntries: 64, ttlMs: 60 * 60_000 });

function rememberPreparedData(key: string, value: LiquidationsPreparedData): LiquidationsPreparedData {
  preparedCache.set(key, value);
  return value;
}

function showLastValueLabel(settings: LiquidationsIndicatorSettings): boolean {
  return settingEnabled(settings, "showLastValueLabel", "showScaleLabel", true);
}

function showReadout(settings: LiquidationsIndicatorSettings): boolean {
  return settingEnabled(settings, "showReadout", "showScaleLabel", true);
}

function enabledExchangeCount(settings: LiquidationsIndicatorSettings): number {
  return Object.values(settings.exchanges ?? {}).filter(Boolean).length;
}

function marketTypesLabel(settings: LiquidationsIndicatorSettings): string {
  const parts: string[] = [];
  if (settings.marketTypes?.spot) parts.push("SPOT");
  if (settings.marketTypes?.futuresUsdPerp) parts.push("USD");
  if (settings.marketTypes?.futuresCoinPerp) parts.push("COIN");
  return parts.length ? parts.join("+") : "no market";
}

function liquidationsHeaderLabel(ctx: {
  settings: LiquidationsIndicatorSettings;
  chart?: { timeframe: string };
  prepared?: IndicatorPreparedData;
}): string {
  const timeframe = ctx.chart?.timeframe ? ` ${ctx.chart.timeframe}` : "";
  const interval = typeof ctx.prepared?.meta?.interval === "string" && ctx.prepared.meta.interval
    ? ctx.prepared.meta.interval
    : ctx.chart?.timeframe;
  const parts = [`Liquidations${timeframe}`];
  if (interval) parts.push(`src ${interval}`);
  parts.push(`${enabledExchangeCount(ctx.settings)}ex`);
  parts.push(marketTypesLabel(ctx.settings));
  const symbolCount = typeof ctx.prepared?.meta?.symbolCount === "number" ? ctx.prepared.meta.symbolCount : 0;
  if (symbolCount > 0) parts.push(`${symbolCount} sym`);
  return parts.join(" · ");
}


function aggregateToChartCandles(
  ctx: IndicatorDrawContext<LiquidationsIndicatorSettings>,
  points: LiquidationPoint[],
): ChartLiquidationPoint[] {
  const [from, to] = ctx.range;
  if (from >= to || ctx.series.length === 0) return [];

  const sorted = [...points].sort((a, b) => a.time - b.time);
  let cursor = 0;
  const out: ChartLiquidationPoint[] = [];
  const startIndex = Math.max(0, Math.floor(from) - 1);
  const endIndex = Math.min(ctx.series.length, Math.ceil(to) + 1);

  for (let index = startIndex; index < endIndex; index++) {
    const bar = ctx.series.at(index);
    if (!bar) continue;
    const candleStart = bar.startTime;
    const candleEnd = bucketEnd(candleStart, ctx.series.config.intervalMs);

    while (cursor < sorted.length && sorted[cursor].time < candleStart) cursor++;

    let longLiquidationsUsd = 0;
    let shortLiquidationsUsd = 0;
    const components: LiquidationPoint["components"] = [];
    let scan = cursor;
    while (scan < sorted.length && sorted[scan].time < candleEnd) {
      const point = sorted[scan];
      longLiquidationsUsd += point.longLiquidationsUsd;
      shortLiquidationsUsd += point.shortLiquidationsUsd;
      if (point.components?.length) components.push(...point.components);
      scan++;
    }

    out.push({
      time: candleStart,
      candleStart,
      candleEnd,
      longLiquidationsUsd,
      shortLiquidationsUsd,
      totalLiquidationsUsd: longLiquidationsUsd + shortLiquidationsUsd,
      liquidationDeltaUsd: shortLiquidationsUsd - longLiquidationsUsd,
      components,
      index,
      hasData: longLiquidationsUsd > 0 || shortLiquidationsUsd > 0,
    });
  }

  return out;
}

function maxAbsForPoints(points: ChartLiquidationPoint[], settings: LiquidationsIndicatorSettings): number {
  let maxAbs = 0;
  for (const point of points) {
    if (settings.showLong) maxAbs = Math.max(maxAbs, point.longLiquidationsUsd);
    if (settings.showShort) maxAbs = Math.max(maxAbs, point.shortLiquidationsUsd);
    if (settings.showDelta) maxAbs = Math.max(maxAbs, Math.abs(point.liquidationDeltaUsd));
  }
  return maxAbs;
}

/**
 * The pane fits the visible candles: short liquidation bars rise from zero and
 * long ones fall from it, so zero stays in view but the larger side is not mirrored.
 */
export function rangeForPoints(
  points: readonly Pick<ChartLiquidationPoint, "longLiquidationsUsd" | "shortLiquidationsUsd" | "liquidationDeltaUsd">[],
  settings: Pick<LiquidationsIndicatorSettings, "showLong" | "showShort" | "showDelta">,
): { min: number; max: number; baseline: number } {
  let min = 0;
  let max = 0;
  for (const point of points) {
    if (settings.showShort) max = Math.max(max, point.shortLiquidationsUsd);
    if (settings.showLong) min = Math.min(min, -point.longLiquidationsUsd);
    if (settings.showDelta) {
      min = Math.min(min, point.liquidationDeltaUsd);
      max = Math.max(max, point.liquidationDeltaUsd);
    }
  }
  return { min, max, baseline: 0 };
}

function prepareLiquidationsData(ctx: IndicatorDrawContext<LiquidationsIndicatorSettings>): IndicatorPreparedData {
  if (!ctx.instance.visible) {
    return {
      status: "hidden",
      points: [],
      range: { min: -1, max: 1, baseline: 0 },
      meta: { interval: ctx.chart?.timeframe ?? "", truncated: false, symbolCount: 0, maxAbs: 0 },
      message: "gizli",
    } satisfies LiquidationsPreparedData;
  }

  const chart = ctx.chart;
  if (!chart) {
    return {
      status: "error",
      points: [],
      range: { min: -1, max: 1, baseline: 0 },
      meta: { interval: "", truncated: false, symbolCount: 0, maxAbs: 0 },
      message: "chart context yok",
      error: "chart context yok",
    } satisfies LiquidationsPreparedData;
  }

  const state = indicatorDataSource().requestLiquidationSeries({
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
      range: { min: -1, max: 1, baseline: 0 },
      meta: { interval: chart.timeframe, truncated: false, symbolCount: 0, maxAbs: 0 },
      message: "yükleniyor...",
    } satisfies LiquidationsPreparedData;
  }
  if (state.status === "unsupported") {
    return {
      status: "error",
      points: [],
      range: { min: -1, max: 1, baseline: 0 },
      meta: { interval: chart.timeframe, truncated: false, symbolCount: 0, maxAbs: 0 },
      message: state.message,
      error: state.message,
    } satisfies LiquidationsPreparedData;
  }
  if (state.status === "error") {
    return {
      status: "error",
      points: [],
      range: { min: -1, max: 1, baseline: 0 },
      meta: { interval: chart.timeframe, truncated: false, symbolCount: 0, maxAbs: 0 },
      message: state.message,
      error: state.message,
    } satisfies LiquidationsPreparedData;
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
    ctx.settings.showLong ? "L1" : "L0",
    ctx.settings.showShort ? "S1" : "S0",
    ctx.settings.showDelta ? "D1" : "D0",
  ].join("|");
  const cached = preparedCache.get(cacheKey);
  if (cached) return cached;

  if (!state.data.symbols.length) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: -1, max: 1, baseline: 0 },
      meta: { interval: state.data.interval, truncated: state.data.truncated === true, symbolCount: 0, maxAbs: 0 },
      message: t("indicator.liquidations.noSymbols"),
    });
  }

  const points = aggregateToChartCandles(ctx, state.data.points);
  if (!points.length) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: -1, max: 1, baseline: 0 },
      meta: { interval: state.data.interval, truncated: state.data.truncated === true, symbolCount: state.data.symbols.length, maxAbs: 0 },
      message: "bu görünümde veri yok",
    });
  }

  const maxAbs = maxAbsForPoints(points, ctx.settings);
  return rememberPreparedData(cacheKey, {
    status: "ok",
    points,
    range: maxAbs > 0 ? rangeForPoints(points, ctx.settings) : { min: -1, max: 1, baseline: 0 },
    meta: {
      interval: state.data.interval,
      truncated: state.data.truncated === true,
      symbolCount: state.data.symbols.length,
      maxAbs,
    },
    message: maxAbs > 0 ? undefined : "bu görünümde likidasyon yok",
  });
}

function asLiquidationsData(prepared: IndicatorPreparedData | undefined): LiquidationsPreparedData {
  if (prepared?.points && prepared.range && prepared.meta) return prepared as LiquidationsPreparedData;
  return {
    status: "no-data",
    points: [],
    range: { min: -1, max: 1, baseline: 0 },
    meta: { interval: "", truncated: false, symbolCount: 0, maxAbs: 0 },
    message: prepared?.message ?? prepared?.error ?? "bu görünümde veri yok",
  };
}

function pointX(ctx: IndicatorDrawContext<LiquidationsIndicatorSettings>, point: ChartLiquidationPoint): number {
  return ctx.view.xOfIndex(point.index) + ctx.view.colWidth / 2;
}

function focusIndex(ctx: IndicatorDrawContext<LiquidationsIndicatorSettings>, data: LiquidationsPreparedData): number | null {
  const crosshair = ctx.crosshair;
  if (!crosshair?.visible) return null;
  const hoverIndex = Math.floor(ctx.view.indexOfX(crosshair.x));
  return data.points.some((point) => point.index === hoverIndex) ? hoverIndex : null;
}

function focusPoint(data: LiquidationsPreparedData, index: number | null): ChartLiquidationPoint | null {
  if (!data.points.length) return null;
  if (index !== null) return data.points.find((point) => point.index === index) ?? null;
  const lastWithData = [...data.points].reverse().find((point) => point.hasData);
  return lastWithData ?? data.points[data.points.length - 1] ?? null;
}

function liquidationsReadout(
  ctx: IndicatorDrawContext<LiquidationsIndicatorSettings>,
  prepared: IndicatorPreparedData,
  index: number | null,
): IndicatorReadout | null {
  const data = asLiquidationsData(prepared);
  const point = focusPoint(data, index);
  if (!point) return null;
  const total = point.longLiquidationsUsd + point.shortLiquidationsUsd;
  return {
    title: index === null ? "Last" : "◆",
    time: tzDateTimeHud(point.candleStart, ctx.chart?.intervalMs ?? ctx.series.config.intervalMs),
    items: [
      { label: "L", value: compactUsd(point.longLiquidationsUsd) },
      { label: "S", value: compactUsd(point.shortLiquidationsUsd) },
      { label: "T", value: compactUsd(total) },
    ],
  };
}

function drawStatus(ctx: IndicatorDrawContext<LiquidationsIndicatorSettings>, data: LiquidationsPreparedData): boolean {
  if (data.status === "hidden") {
    drawIndicatorMessage(ctx, data.message ?? "gizli");
    return true;
  }
  if (data.status === "loading") {
    drawIndicatorMessage(ctx, data.message ?? "yükleniyor...");
    return true;
  }
  if (data.status === "error") {
    drawIndicatorMessage(ctx, data.message ?? data.error ?? t("indicator.liquidations.loadFailed"), uiColor.sell);
    return true;
  }
  if (data.status === "no-data") {
    drawIndicatorMessage(ctx, data.message ?? "bu görünümde veri yok", indicatorWarningMessageColor);
    return true;
  }
  return false;
}

function drawLiquidations(ctx: IndicatorDrawContext<LiquidationsIndicatorSettings>, prepared?: IndicatorPreparedData): void {
  const { ctx: canvas, view, rect, settings } = ctx;
  const data = asLiquidationsData(prepared ?? prepareLiquidationsData(ctx));
  if (drawStatus(ctx, data)) return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);

  if (data.meta.maxAbs <= 0) {
    drawIndicatorMessage(ctx, data.message ?? "bu görünümde likidasyon yok");
    return;
  }

  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: "signed-zero",
    min: displayRange.min,
    max: displayRange.max,
    baseline: 0,
    formatter: compactUsd,
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.08,
  }, { top, bottom });
  const zeroY = scale.y(0);

  canvas.save();
  canvas.strokeStyle = uiColor.separator;
  canvas.beginPath();
  canvas.moveTo(view.area.left, zeroY);
  canvas.lineTo(view.area.left + view.area.width, zeroY);
  canvas.stroke();

  const barWidth = Math.max(1, Math.min(view.colWidth * 0.34, 14));
  for (const point of data.points) {
    const x = pointX(ctx, point);
    if (settings.showShort && point.shortLiquidationsUsd > 0) {
      const y = scale.y(point.shortLiquidationsUsd);
      canvas.fillStyle = settings.shortColor || uiColor.buy;
      canvas.globalAlpha = 0.82;
      canvas.fillRect(x - barWidth, y, barWidth, Math.max(1, zeroY - y));
    }
    if (settings.showLong && point.longLiquidationsUsd > 0) {
      const y = scale.y(-point.longLiquidationsUsd);
      canvas.fillStyle = settings.longColor || uiColor.sell;
      canvas.globalAlpha = 0.82;
      canvas.fillRect(x + 1, zeroY, barWidth, Math.max(1, y - zeroY));
    }
  }
  canvas.globalAlpha = 1;

  if (settings.showDelta) {
    canvas.strokeStyle = settings.deltaColor || positioningRatioColorDefault;
    canvas.lineWidth = 1.5;
    canvas.beginPath();
    data.points.forEach((point, i) => {
      const y = scale.y(point.liquidationDeltaUsd);
      const x = pointX(ctx, point);
      if (i === 0) canvas.moveTo(x, y);
      else canvas.lineTo(x, y);
    });
    canvas.stroke();
    canvas.lineWidth = 1;
  }
  canvas.restore();

  if (settings.showAxisTicks) drawIndicatorAxisTicks(ctx, scale, top, bottom);

  const lastPoint = focusPoint(data, null);
  if (showLastValueLabel(settings) && lastPoint) {
    const total = lastPoint.longLiquidationsUsd + lastPoint.shortLiquidationsUsd;
    const value = settings.showDelta ? lastPoint.liquidationDeltaUsd : total;
    const color = settings.showDelta
      ? settings.deltaColor || positioningRatioColorDefault
      : total > 0 && lastPoint.shortLiquidationsUsd >= lastPoint.longLiquidationsUsd
        ? settings.shortColor || uiColor.buy
        : settings.longColor || uiColor.sell;
    const yValue = settings.showDelta
      ? lastPoint.liquidationDeltaUsd
      : lastPoint.shortLiquidationsUsd >= lastPoint.longLiquidationsUsd
        ? lastPoint.shortLiquidationsUsd
        : -lastPoint.longLiquidationsUsd;
    const y = Math.max(top + 9, Math.min(bottom - 9, scale.y(yValue)));
    drawIndicatorLastValueLabel(ctx, { text: scale.format(value), color, y });
  }
}

function drawLiquidationsInteraction(
  ctx: IndicatorDrawContext<LiquidationsIndicatorSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const { ctx: canvas, rect, settings } = ctx;
  const data = asLiquidationsData(prepared ?? prepareLiquidationsData(ctx));
  if (data.status !== "ok") return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const hoverIndex = focusIndex(ctx, data);
  const focus = focusPoint(data, hoverIndex);

  if (showReadout(settings)) {
    const readout = liquidationsReadout(ctx, data, hoverIndex);
    if (readout) drawIndicatorReadout(ctx, indicatorReadoutToText(readout));
  }

  if (data.meta.maxAbs <= 0) return;

  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: "signed-zero",
    min: displayRange.min,
    max: displayRange.max,
    baseline: 0,
    formatter: compactUsd,
    displayMode: indicatorDisplayScaleMode(settings),
    paddingFraction: 0.08,
  }, { top, bottom });

  if (hoverIndex !== null && focus) drawHoveredVerticalGuide(canvas, pointX(ctx, focus), top, bottom);
  drawIndicatorCrosshairValueLabel(ctx, scale, top, bottom);
}

export const liquidationsIndicatorDefinition: IndicatorDefinition<LiquidationsIndicatorSettings> = {
  type: "liquidations",
  name: "Liquidations",
  category: "derivatives",
  defaultPane: "separate",
  canOverlay: false,
  defaultPlacement: "separate-pane",
  supportedPlacements: ["separate-pane"],
  paneHeight: 116,
  defaultSettings: () => ({
    showLong: true,
    showShort: true,
    showDelta: false,
    longColor: uiColor.sell,
    shortColor: uiColor.buy,
    deltaColor: positioningRatioColorDefault,
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
          { kind: "exchange-matrix", key: "exchangeMatrix", label: "Aggregate Exchanges", labelKey: "indicator.common.aggregateExchanges", requiresRecalc: true },
        ],
      },
      {
        title: "Display",
        titleKey: "indicator.common.section.display",
        fields: [
          { kind: "boolean", key: "showLong", label: "Show Long Liquidations", labelKey: "indicator.liquidations.showLong" },
          { kind: "boolean", key: "showShort", label: "Show Short Liquidations", labelKey: "indicator.liquidations.showShort" },
          { kind: "boolean", key: "showDelta", label: "Show Net Delta", labelKey: "indicator.liquidations.showDelta" },
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
          { kind: "color", key: "longColor", label: "Long Liquidation Color", labelKey: "indicator.liquidations.longColor" },
          { kind: "color", key: "shortColor", label: "Short Liquidation Color", labelKey: "indicator.liquidations.shortColor" },
          { kind: "color", key: "deltaColor", label: "Net Delta Color", labelKey: "indicator.liquidations.deltaColor" },
        ],
      },
    ],
  },
  getHeaderLabel: liquidationsHeaderLabel,
  prepareData: prepareLiquidationsData,
  getReadout: liquidationsReadout,
  drawSubPane: drawLiquidations,
  drawInteraction: drawLiquidationsInteraction,
};

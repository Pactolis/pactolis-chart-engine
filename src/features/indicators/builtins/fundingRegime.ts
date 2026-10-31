import { BoundedCache } from "../../../core/cache/boundedCache.js";
import { bucketEnd } from "../../../core/time.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import type {
  CoinalyzeDerivativePoint,
  CoinalyzeDerivativeSeries,
  CoinalyzeDerivativeSeriesState,
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

export type FundingRegimeMode = "fundingRate" | "predictedFundingRate" | "spread";

export interface FundingRegimeSettings extends IndicatorSettings {
  mode: FundingRegimeMode;
  lineWidth: number;
  fundingColor: string;
  predictedColor: string;
  spreadColor: string;
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

type ChartFundingPoint = {
  index: number;
  candleStart: number;
  candleEnd: number;
  time: number;
  fundingRate: number;
  predictedFundingRate: number;
  spread: number;
  value: number;
  hasData: boolean;
};

type FundingRegimeMeta = Record<string, unknown> & {
  interval: string;
  mode: FundingRegimeMode;
  truncated: boolean;
  symbolCount: number;
};

type FundingRegimeData = IndicatorPreparedData<ChartFundingPoint, FundingRegimeMeta> & {
  points: ChartFundingPoint[];
  range: { min: number; max: number; baseline: number };
  meta: FundingRegimeMeta;
};

type SourceScan = {
  sorted: CoinalyzeDerivativePoint[];
  cursor: number;
  lastSeen: CoinalyzeDerivativePoint | null;
};

// Memoizes derived draw data per (instance x series revision x range x settings)
// key; keys naturally rotate as the chart advances, so this is a size-bounded
// LRU rather than a TTL concern (a generous TTL is just a safety net for a key
// that stops rotating, e.g. a hidden/inactive instance).
const preparedCache = new BoundedCache<FundingRegimeData>({ maxEntries: 64, ttlMs: 60 * 60_000 });

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

function enabledExchangeCount(settings: FundingRegimeSettings): number {
  return Object.values(settings.exchanges ?? {}).filter(Boolean).length;
}

function marketTypesLabel(settings: FundingRegimeSettings): string {
  const parts: string[] = [];
  if (settings.marketTypes?.spot) parts.push("SPOT");
  if (settings.marketTypes?.futuresUsdPerp) parts.push("USD");
  if (settings.marketTypes?.futuresCoinPerp) parts.push("COIN");
  return parts.length ? parts.join("+") : "no market";
}

function modeLabel(mode: FundingRegimeMode): string {
  if (mode === "predictedFundingRate") return "Predicted";
  if (mode === "spread") return "Spread";
  return "Funding";
}

function valueForMode(point: Omit<ChartFundingPoint, "value">, mode: FundingRegimeMode): number {
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

function colorForMode(settings: FundingRegimeSettings, mode: FundingRegimeMode): string {
  if (mode === "predictedFundingRate") return settings.predictedColor || fundingPredictedColorDefault;
  if (mode === "spread") return settings.spreadColor || uiColor.special;
  return settings.fundingColor || uiColor.buy;
}

function isReadyState(
  state: CoinalyzeDerivativeSeriesState | null,
): state is { status: "ready"; data: CoinalyzeDerivativeSeries } {
  return state?.status === "ready";
}

function createSourceScan(source: CoinalyzeDerivativePoint[] | null): SourceScan | null {
  if (!source) return null;
  return {
    // Metric responses are normalized to chronological order once at the cache boundary.
    sorted: source,
    cursor: 0,
    lastSeen: null,
  };
}

function latestForCandle(scan: SourceScan | null, candleStart: number, candleEnd: number): {
  point: CoinalyzeDerivativePoint | null;
  hasData: boolean;
} {
  if (!scan) return { point: null, hasData: false };
  while (scan.cursor < scan.sorted.length && scan.sorted[scan.cursor].time < candleStart) {
    scan.lastSeen = scan.sorted[scan.cursor];
    scan.cursor++;
  }

  let latest: CoinalyzeDerivativePoint | null = null;
  let hasData = false;
  while (scan.cursor < scan.sorted.length && scan.sorted[scan.cursor].time < candleEnd) {
    latest = scan.sorted[scan.cursor];
    scan.cursor++;
    hasData = true;
  }
  if (latest) scan.lastSeen = latest;
  return { point: latest ?? scan.lastSeen, hasData };
}

function aggregateToChartCandles(
  ctx: IndicatorDrawContext<FundingRegimeSettings>,
  funding: CoinalyzeDerivativePoint[] | null,
  predicted: CoinalyzeDerivativePoint[] | null,
): ChartFundingPoint[] {
  const [from, to] = ctx.range;
  if (from >= to || ctx.series.length === 0) return [];

  const fundingScan = createSourceScan(funding);
  const predictedScan = createSourceScan(predicted);
  const points: ChartFundingPoint[] = [];
  const startIndex = Math.max(0, Math.floor(from) - 1);
  const endIndex = Math.min(ctx.series.length, Math.ceil(to) + 1);

  for (let index = startIndex; index < endIndex; index++) {
    const bar = ctx.series.at(index);
    if (!bar) continue;
    const candleStart = bar.startTime;
    const candleEnd = bucketEnd(candleStart, ctx.series.config.intervalMs);
    const current = latestForCandle(fundingScan, candleStart, candleEnd);
    const next = latestForCandle(predictedScan, candleStart, candleEnd);
    const fundingRate = current.point?.value ?? Number.NaN;
    const predictedFundingRate = next.point?.value ?? Number.NaN;
    const spread = Number.isFinite(fundingRate) && Number.isFinite(predictedFundingRate)
      ? predictedFundingRate - fundingRate
      : Number.NaN;
    const base = {
      index,
      candleStart,
      candleEnd,
      time: next.point?.time ?? current.point?.time ?? candleStart,
      fundingRate,
      predictedFundingRate,
      spread,
      hasData: current.hasData || next.hasData,
    };
    const value = valueForMode(base, ctx.settings.mode);
    if (!Number.isFinite(value)) continue;
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

function stateError(states: Array<CoinalyzeDerivativeSeriesState | null>): string | null {
  for (const state of states) {
    if (state?.status === "unsupported" || state?.status === "error") return state.message;
  }
  return null;
}

function prepareFundingRegimeData(ctx: IndicatorDrawContext<FundingRegimeSettings>): FundingRegimeData {
  if (!ctx.instance.visible) {
    return {
      status: "hidden",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: { interval: ctx.chart?.timeframe ?? "", mode: ctx.settings.mode, truncated: false, symbolCount: 0 },
      message: "gizli",
    };
  }

  const chart = ctx.chart;
  if (!chart) {
    return {
      status: "error",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: { interval: "", mode: ctx.settings.mode, truncated: false, symbolCount: 0 },
      message: "chart context yok",
      error: "chart context yok",
    };
  }

  const fundingState = ctx.settings.mode === "predictedFundingRate"
    ? null
    : indicatorDataSource().requestCoinalyzeDerivativeSeries({
      metric: "fundingRate",
      market: chart.market,
      timeframe: chart.timeframe,
      intervalMs: chart.intervalMs,
      exchanges: ctx.settings.exchanges,
      marketTypes: ctx.settings.marketTypes,
      onUpdate: ctx.requestRefresh,
    });
  const predictedState = ctx.settings.mode === "fundingRate"
    ? null
    : indicatorDataSource().requestCoinalyzeDerivativeSeries({
      metric: "predictedFundingRate",
      market: chart.market,
      timeframe: chart.timeframe,
      intervalMs: chart.intervalMs,
      exchanges: ctx.settings.exchanges,
      marketTypes: ctx.settings.marketTypes,
      onUpdate: ctx.requestRefresh,
    });
  const states = [fundingState, predictedState];

  if (states.some((state) => state?.status === "loading" || state?.status === "idle")) {
    return {
      status: "loading",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: { interval: chart.timeframe, mode: ctx.settings.mode, truncated: false, symbolCount: 0 },
      message: "yukleniyor...",
    };
  }

  const error = stateError(states);
  if (error) {
    return {
      status: "error",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: { interval: chart.timeframe, mode: ctx.settings.mode, truncated: false, symbolCount: 0 },
      message: error,
      error,
    };
  }

  const fundingData = isReadyState(fundingState) ? fundingState.data : null;
  const predictedData = isReadyState(predictedState) ? predictedState.data : null;
  const reference = fundingData ?? predictedData;
  if (!reference) {
    return {
      status: "no-data",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta: { interval: chart.timeframe, mode: ctx.settings.mode, truncated: false, symbolCount: 0 },
      message: "Coinalyze funding verisi yok",
    };
  }

  const symbolCount = Math.max(fundingData?.symbols.length ?? 0, predictedData?.symbols.length ?? 0);
  const meta = {
    interval: reference.interval,
    mode: ctx.settings.mode,
    truncated: fundingData?.truncated === true || predictedData?.truncated === true,
    symbolCount,
  };
  const cacheKey = [
    ctx.instance.id,
    ctx.series.revision,
    ctx.series.length,
    ctx.series.config.intervalMs,
    Math.floor(ctx.range[0]),
    Math.ceil(ctx.range[1]),
    ctx.settings.mode,
    reference.interval,
    fundingData?.from ?? "nf",
    fundingData?.to ?? "nt",
    fundingData?.symbols.length ?? 0,
    fundingData?.points.length ?? 0,
    predictedData?.from ?? "pf",
    predictedData?.to ?? "pt",
    predictedData?.symbols.length ?? 0,
    predictedData?.points.length ?? 0,
  ].join("|");
  const cached = preparedCache.get(cacheKey);
  if (cached) return cached;

  if (!symbolCount) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta,
      message: "secili borsalarda Coinalyze funding sembolu bulunamadi",
    });
  }

  const points = aggregateToChartCandles(ctx, fundingData?.points ?? null, predictedData?.points ?? null);
  if (!points.length) {
    return rememberPreparedData(cacheKey, {
      status: "no-data",
      points: [],
      range: { min: -0.0001, max: 0.0001, baseline: 0 },
      meta,
      message: "bu gorunumde funding verisi yok",
    });
  }

  return rememberPreparedData(cacheKey, {
    status: "ok",
    points,
    range: rangeForPoints(points),
    meta,
  });
}

function asFundingRegimeData(prepared: IndicatorPreparedData | undefined): FundingRegimeData {
  if (prepared?.points && prepared.range && prepared.meta) return prepared as FundingRegimeData;
  return {
    status: "no-data",
    points: [],
    range: { min: -0.0001, max: 0.0001, baseline: 0 },
    meta: { interval: "", mode: "fundingRate", truncated: false, symbolCount: 0 },
    message: prepared?.message ?? prepared?.error ?? "bu gorunumde veri yok",
  };
}

function pointX(ctx: IndicatorDrawContext<FundingRegimeSettings>, point: ChartFundingPoint): number {
  return ctx.view.xOfIndex(point.index) + ctx.view.colWidth / 2;
}

function focusIndex(ctx: IndicatorDrawContext<FundingRegimeSettings>, data: FundingRegimeData): number | null {
  const crosshair = ctx.crosshair;
  if (!crosshair?.visible) return null;
  const hoverIndex = Math.floor(ctx.view.indexOfX(crosshair.x));
  return data.points.some((point) => point.index === hoverIndex) ? hoverIndex : null;
}

function focusPoint(data: FundingRegimeData, index: number | null): ChartFundingPoint | null {
  if (!data.points.length) return null;
  if (index !== null) return data.points.find((point) => point.index === index) ?? null;
  const lastWithData = [...data.points].reverse().find((point) => point.hasData);
  return lastWithData ?? data.points[data.points.length - 1] ?? null;
}

function fundingRegimeReadout(
  ctx: IndicatorDrawContext<FundingRegimeSettings>,
  prepared: IndicatorPreparedData,
  index: number | null,
): IndicatorReadout | null {
  const data = asFundingRegimeData(prepared);
  const point = focusPoint(data, index);
  if (!point) return null;
  return {
    title: index === null ? "Last" : "*",
    time: tzDateTimeHud(point.candleStart, ctx.chart?.intervalMs ?? ctx.series.config.intervalMs),
    items: [
      { label: modeLabel(data.meta.mode), value: formatFundingRate(point.value) },
      { label: "F", value: formatFundingRate(point.fundingRate) },
      { label: "Pred", value: formatFundingRate(point.predictedFundingRate) },
      { label: "Spr", value: formatFundingRate(point.spread) },
      { label: "sym", value: String(data.meta.symbolCount) },
    ],
  };
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
  if (data.status === "error") {
    drawIndicatorMessage(ctx, data.message ?? data.error ?? "Coinalyze funding verisi yuklenemedi", uiColor.sell);
    return true;
  }
  if (data.status === "no-data") {
    drawIndicatorMessage(ctx, data.message ?? "bu gorunumde veri yok", indicatorWarningMessageColor);
    return true;
  }
  return false;
}

function drawFundingRegime(ctx: IndicatorDrawContext<FundingRegimeSettings>, prepared?: IndicatorPreparedData): void {
  const { ctx: canvas, view, rect, settings } = ctx;
  const data = asFundingRegimeData(prepared ?? prepareFundingRegimeData(ctx));
  if (drawStatus(ctx, data)) return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const color = colorForMode(settings, data.meta.mode);
  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: "percent",
    min: displayRange.min,
    max: displayRange.max,
    baseline: 0,
    formatter: formatFundingRate,
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

  canvas.save();
  canvas.strokeStyle = color;
  canvas.lineJoin = "round";
  canvas.lineCap = "round";
  canvas.lineWidth = Math.max(1, settings.lineWidth || 1.5);
  canvas.beginPath();
  data.points.forEach((point, index) => {
    const x = pointX(ctx, point);
    const y = scale.y(point.value);
    if (index === 0) canvas.moveTo(x, y);
    else canvas.lineTo(x, y);
  });
  canvas.stroke();
  canvas.restore();

  if (settings.showAxisTicks) drawIndicatorAxisTicks(ctx, scale, top, bottom);

  const lastPoint = focusPoint(data, null);
  if (showLastValueLabel(settings) && lastPoint) {
    const y = Math.max(top + 9, Math.min(bottom - 9, scale.y(lastPoint.value)));
    drawIndicatorLastValueLabel(ctx, { text: scale.format(lastPoint.value), color, y });
  }
}

function drawFundingRegimeInteraction(
  ctx: IndicatorDrawContext<FundingRegimeSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const { ctx: canvas, rect, settings } = ctx;
  const data = asFundingRegimeData(prepared ?? prepareFundingRegimeData(ctx));
  if (data.status !== "ok") return;

  const { top, bottom } = panePlotBounds(rect, 32, 5);
  const hoverIndex = focusIndex(ctx, data);
  const focus = focusPoint(data, hoverIndex);

  if (showReadout(settings)) {
    const readout = fundingRegimeReadout(ctx, data, hoverIndex);
    if (readout) drawIndicatorReadout(ctx, indicatorReadoutToText(readout));
  }

  const displayRange = indicatorDisplayRange(settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: "percent",
    min: displayRange.min,
    max: displayRange.max,
    baseline: 0,
    formatter: formatFundingRate,
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
  const interval = meta?.interval || ctx.chart?.timeframe || "";
  const parts = [`Funding${timeframe}`, modeLabel(ctx.settings.mode)];
  if (interval) parts.push(`src ${interval}`);
  parts.push(`${enabledExchangeCount(ctx.settings)}ex`);
  parts.push(marketTypesLabel(ctx.settings));
  if (meta?.symbolCount) parts.push(`${meta.symbolCount} sym`);
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
    mode: "fundingRate",
    lineWidth: 2,
    fundingColor: uiColor.buy,
    predictedColor: fundingPredictedColorDefault,
    spreadColor: uiColor.special,
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
              { label: "Funding", value: "fundingRate", labelKey: "indicator.fundingRegime.mode.funding" },
              { label: "Predicted Funding", value: "predictedFundingRate", labelKey: "indicator.fundingRegime.mode.predicted" },
              { label: "Predicted - Current", value: "spread", labelKey: "indicator.fundingRegime.mode.spread" },
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

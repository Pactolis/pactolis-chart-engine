import type { FootprintBar } from "../../../core/types.js";
import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { aggregatePeriodCandles, type AnalysisPeriod } from "../../../core/analysis/periods.js";
import { exponentialMovingAverage, simpleMovingAverage } from "../../../core/analysis/calc/ta.js";
import { drawPriceOverlayLines, makeOverlayPoints, overlayAppearanceFields, prepareOverlayData } from "./priceOverlayShared.js";
import { periodsFromText, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { seriesPalette } from "../../../core/ui/seriesPalette.js";
import { incrementPerformanceCounter, measurePerformance } from "../../../core/performanceTelemetry.js";
import { indicatorPriceSeriesMutation } from "../seriesMutationSummary.js";

export interface MovingAverageIndicatorSettings extends IndicatorSettings {
  lines: MaLineConfig[];
  lineWidth: number;
  showLastValueLabel: boolean;
  showPlotLabel: boolean;
  showChartLabels: boolean;
}

export interface MaLineConfig { id: string; method: "sma" | "ema"; period: number; timeframe: "chart" | "daily" | "weekly"; color: string; enabled: boolean; }

const COLORS = seriesPalette;

function normalizeLines(settings: MovingAverageIndicatorSettings): MaLineConfig[] {
  if (Array.isArray(settings.lines)) return settings.lines.filter((line) => Number.isInteger(line.period) && line.period > 0 && ["sma", "ema"].includes(line.method) && ["chart", "daily", "weekly"].includes(line.timeframe));
  const legacy = settings as unknown as Record<string, unknown>;
  const hasLegacy = ["periods", "method", "sourceTimeframe", "color1", "color2", "color3"]
    .some((key) => Object.prototype.hasOwnProperty.call(legacy, key));
  if (!hasLegacy) return [];
  const periods = periodsFromText(String(legacy.periods ?? ""), [], 8);
  const method = legacy.method === "ema" ? "ema" : "sma";
  const timeframe = ["daily", "weekly"].includes(String(legacy.sourceTimeframe)) ? String(legacy.sourceTimeframe) : "chart";
  return periods.map((period, i) => ({ id: `legacy-${i}`, method, period, timeframe: timeframe as MaLineConfig["timeframe"], color: String(legacy[`color${i + 1}`] ?? COLORS[i]), enabled: true }));
}

function chartLabelFor(line: MaLineConfig): string { const method = line.method === "sma" ? "MA" : "EMA"; const unit = line.timeframe === "daily" ? " Day" : line.timeframe === "weekly" ? " Week" : ""; return `${line.period}${unit} ${method}`; }

interface MovingAverageIncrementalState {
  instance: object;
  seriesRevision: number;
  structureRevision: number;
  start: number;
  end: number;
  lines: MaLineConfig[];
  values: Array<Array<number | null>>;
  plotSeries: PlotSeries[];
  prepared: ReturnType<typeof prepareOverlayData>;
}

const movingAverageIncrementalStates = new WeakMap<object, Map<string, MovingAverageIncrementalState>>();

function sameCalculationLines(cached: MovingAverageIncrementalState | undefined, lines: readonly MaLineConfig[]): boolean {
  return Boolean(cached)
    && cached!.lines.length === lines.length
    && lines.every((line, index) => cached!.lines[index].id === line.id
      && cached!.lines[index].method === line.method
      && cached!.lines[index].period === line.period
      && cached!.lines[index].timeframe === line.timeframe);
}

function makeMovingAveragePlotSeries(
  lines: readonly MaLineConfig[],
  values: ReadonlyArray<Array<number | null>>,
  bars: readonly FootprintBar[],
  start: number,
  end: number,
): PlotSeries[] {
  return lines.map((line, index) => ({
    key: `ma-${line.id}`,
    label: `${line.method.toUpperCase()} ${line.period}${line.timeframe === "chart" ? "" : line.timeframe === "daily" ? "D" : "W"}`,
    color: line.color,
    chartLabel: chartLabelFor(line),
    points: makeOverlayPoints(values[index], bars, start, end),
  }));
}

function rebuildMovingAverageGeometry(
  ctx: IndicatorDrawContext<MovingAverageIndicatorSettings>,
  cached: MovingAverageIncrementalState,
  bars: readonly FootprintBar[],
  start: number,
  end: number,
): ReturnType<typeof prepareOverlayData> {
  cached.start = start;
  cached.end = end;
  cached.plotSeries = makeMovingAveragePlotSeries(cached.lines, cached.values, bars, start, end);
  cached.prepared = prepareOverlayData(ctx, cached.plotSeries);
  return cached.prepared;
}

function prepareMovingAverage(ctx: IndicatorDrawContext<MovingAverageIndicatorSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const lines = normalizeLines(ctx.settings).filter((line) => line.enabled);
  const incrementalEligible = lines.length > 0 && lines.every((line) => line.timeframe === "chart");
  let perSeries = movingAverageIncrementalStates.get(ctx.series);
  if (!perSeries) {
    perSeries = new Map();
    movingAverageIncrementalStates.set(ctx.series, perSeries);
  }
  const cached = perSeries.get(ctx.instance.id);
  const sameLines = sameCalculationLines(cached, lines);
  const sameConfig = Boolean(cached) && cached!.instance === ctx.instance && sameLines;
  const sameShape = Boolean(cached)
    && cached!.values.length === lines.length
    && cached!.values.every((values) => values.length === bars.length);

  if (sameConfig && sameShape && cached!.seriesRevision === ctx.series.revision) {
    if (cached!.start === start && cached!.end === end) return cached!.prepared;
    incrementPerformanceCounter("indicator.incremental.hit.moving-average");
    return rebuildMovingAverageGeometry(ctx, cached!, bars, start, end);
  }

  const mutation = indicatorPriceSeriesMutation(ctx.series);
  const canReuse = incrementalEligible && sameConfig && sameShape;

  if (canReuse && (mutation.kind === "tail" || mutation.kind === "metadata")) {
    return measurePerformance("indicator.prepare.incremental.moving-average", () => {
      if (mutation.kind === "tail" && mutation.tailIndex >= 0) {
        for (let i = 0; i < lines.length; i++) {
          const next = movingAverageTailValue(bars, cached!.values[i], mutation.tailIndex, lines[i].period, lines[i].method);
          cached!.values[i][mutation.tailIndex] = next;
        }
      }
      cached!.seriesRevision = ctx.series.revision;
      cached!.structureRevision = ctx.series.structureRevision;
      rebuildMovingAverageGeometry(ctx, cached!, bars, start, end);
      incrementPerformanceCounter("indicator.incremental.hit.moving-average");
      return cached!.prepared;
    });
  }

  let fallbackReason: string;
  if (!cached) fallbackReason = "initial";
  else if (cached.instance !== ctx.instance || !sameLines) fallbackReason = "settings";
  else if (!sameShape) fallbackReason = "shape";
  else if (!incrementalEligible) fallbackReason = "ineligible";
  else if (mutation.kind === "structure") fallbackReason = "structure";
  else fallbackReason = `mutation-${mutation.kind}`;
  incrementPerformanceCounter(`indicator.incremental.fallback.moving-average.${fallbackReason}`);

  return measurePerformance("indicator.prepare.full.moving-average", () => {
    const chartCloses = lines.some((line) => line.timeframe === "chart") ? bars.map((bar) => bar.close) : [];
    const values = lines.map((line) => line.timeframe === "chart"
      ? movingAverageValues(chartCloses, line.period, line.method)
      : higherTimeframeValues(bars, line.timeframe, line.period, line.method, ctx.series.config.intervalMs));
    const plotSeries = makeMovingAveragePlotSeries(lines, values, bars, start, end);
    const prepared = prepareOverlayData(ctx, plotSeries);
    perSeries.set(ctx.instance.id, { instance: ctx.instance, seriesRevision: ctx.series.revision, structureRevision: ctx.series.structureRevision, start, end, lines, values, plotSeries, prepared });
    incrementPerformanceCounter("indicator.incremental.full.moving-average");
    return prepared;
  });
}

function movingAverageTailValue(
  bars: readonly FootprintBar[],
  values: readonly (number | null)[],
  index: number,
  period: number,
  method: "sma" | "ema",
): number | null {
  if (index + 1 < period) return null;
  if (method === "sma" || index + 1 === period) {
    let sum = 0;
    for (let i = index - period + 1; i <= index; i++) sum += bars[i].close;
    return sum / period;
  }
  const previous = values[index - 1];
  if (previous === null || previous === undefined) return null;
  const alpha = 2 / (period + 1);
  return bars[index].close * alpha + previous * (1 - alpha);
}

function movingAverageValues(values: readonly number[], period: number, method: string): Array<number | null> {
  return method === "ema" ? exponentialMovingAverage(values, period) : simpleMovingAverage(values, period);
}

function higherTimeframeValues(
  bars: readonly FootprintBar[],
  periodName: AnalysisPeriod,
  length: number,
  method: string,
  sourceIntervalMs: number,
): Array<number | null> {
  const candles = aggregatePeriodCandles(bars.map((bar) => ({
    startTime: bar.startTime,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    delta: bar.delta ?? 0,
    count: bar.count ?? 0,
    cells: new Map(),
    hasRef: true,
    completeness: "complete" as const,
  })), periodName, Date.now(), sourceIntervalMs).filter((item) => item.complete && Number.isFinite(item.close));
  const ma = movingAverageValues(candles.map((item) => item.close), length, method);
  const byEnd = candles.map((candle, index) => ({ end: candle.end, value: ma[index] }));
  const result: Array<number | null> = [];
  let cursor = 0;
  let last: number | null = null;
  for (const bar of bars) {
    while (cursor < byEnd.length && byEnd[cursor].end <= bar.startTime) {
      last = byEnd[cursor].value;
      cursor++;
    }
    result.push(last);
  }
  return result;
}

export const movingAverageIndicatorDefinition: IndicatorDefinition<MovingAverageIndicatorSettings> = {
  type: "moving-average",
  name: "MA / EMA",
  category: "custom",
  defaultPane: "overlay",
  canOverlay: true,
  defaultPlacement: "price-overlay",
  supportedPlacements: ["price-overlay"],
  paneHeight: 0,
  defaultSettings: () => ({
    lines: [{ id: "line-20", method: "sma", period: 20, timeframe: "chart", color: COLORS[0], enabled: true }, { id: "line-50", method: "sma", period: 50, timeframe: "chart", color: COLORS[1], enabled: true }, { id: "line-200", method: "sma", period: 200, timeframe: "chart", color: COLORS[2], enabled: true }],
    lineWidth: 1.5,
    showLastValueLabel: true,
    showPlotLabel: true,
    showChartLabels: false,
  }),
  settingsSchema: {
    sections: [
      {
        title: "Calculation",
        titleKey: "indicator.common.section.calculation",
        fields: [
          { kind: "line-list", key: "lines", label: "Lines", labelKey: "indicator.common.lines", requiresRecalc: true },
        ],
      },
      { title: "Style", titleKey: "indicator.common.section.style", fields: [...overlayAppearanceFields(), { kind: "boolean", key: "showChartLabels", label: "Show Chart Labels", labelKey: "indicator.common.showChartLabels" }] },
    ],
  },
  getHeaderLabel: ({ settings }) => {
    if (settings.showPlotLabel === false) return "";
    const lines = normalizeLines(settings).filter((line) => line.enabled);
    return lines.length > 4 ? `MA ×${lines.length}` : lines.map((line) => `${line.method.toUpperCase()} ${line.period}${line.timeframe === "chart" ? "" : line.timeframe === "daily" ? "D" : "W"}`).join(" · ");
  },
  prepareCache: { mode: "series-range", maxAgeMs: 1_000 },
  prepareData: prepareMovingAverage,
  drawPriceOverlay: drawPriceOverlayLines,
};

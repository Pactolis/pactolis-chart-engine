import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { exponentialMovingAverage } from "../../../core/analysis/calc/ta.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor, macdHistogramColorDefault } from "../../../core/ui/seriesPalette.js";
import { incrementPerformanceCounter, measurePerformance } from "../../../core/performanceTelemetry.js";
import { indicatorPriceSeriesMutation } from "../seriesMutationSummary.js";

export interface MacdSettings extends IndicatorSettings { fast: number; slow: number; signal: number; macdColor: string; signalColor: string; histogramColor: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }

interface MacdIncrementalState {
  instance: object;
  seriesRevision: number;
  structureRevision: number;
  start: number;
  end: number;
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
  macdColor: string;
  signalColor: string;
  histogramColor: string;
  fastValues: Array<number | null>;
  slowValues: Array<number | null>;
  macdValues: Array<number | null>;
  signalValues: Array<number | null>;
  plotSeries: PlotSeries[];
  prepared: ReturnType<typeof prepareMultiSeries>;
}

const macdIncrementalStates = new WeakMap<object, Map<string, MacdIncrementalState>>();

function emaTail(current: number, previous: number | null | undefined, period: number): number | null {
  if (!Number.isFinite(current) || previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  const alpha = 2 / (period + 1);
  return current * alpha + previous * (1 - alpha);
}

function updateVisibleTail(plot: PlotSeries, tailIndex: number, time: number, value: number | null): void {
  const point = plot.points[plot.points.length - 1];
  if (point?.index !== tailIndex) return;
  point.time = time;
  point.value = value;
}

function prepareMacd(ctx: IndicatorDrawContext<MacdSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const fastPeriod = numericSetting(ctx.settings, "fast", 12, 1, 200);
  const slowPeriod = numericSetting(ctx.settings, "slow", 26, 1, 300);
  const signalPeriod = numericSetting(ctx.settings, "signal", 9, 1, 100);
  const macdColor = stringSetting(ctx.settings, "macdColor", uiColor.info);
  const signalColor = stringSetting(ctx.settings, "signalColor", uiColor.warn);
  const histogramColor = stringSetting(ctx.settings, "histogramColor", macdHistogramColorDefault);

  let perSeries = macdIncrementalStates.get(ctx.series);
  if (!perSeries) {
    perSeries = new Map();
    macdIncrementalStates.set(ctx.series, perSeries);
  }
  const cached = perSeries.get(ctx.instance.id);
  const sameConfig = Boolean(cached)
    && cached!.instance === ctx.instance
    && cached!.fastPeriod === fastPeriod
    && cached!.slowPeriod === slowPeriod
    && cached!.signalPeriod === signalPeriod
    && cached!.macdColor === macdColor
    && cached!.signalColor === signalColor
    && cached!.histogramColor === histogramColor;
  if (sameConfig && cached!.seriesRevision === ctx.series.revision && cached!.start === start && cached!.end === end) return cached!.prepared;

  const mutation = indicatorPriceSeriesMutation(ctx.series);
  const sameShape = Boolean(cached)
    && cached!.fastValues.length === bars.length
    && cached!.slowValues.length === bars.length
    && cached!.macdValues.length === bars.length
    && cached!.signalValues.length === bars.length;
  const canReuse = sameConfig
    && cached!.start === start
    && cached!.end === end
    && sameShape;

  if (canReuse && (mutation.kind === "tail" || mutation.kind === "metadata")) {
    if (mutation.kind === "metadata") {
      cached!.seriesRevision = ctx.series.revision;
      cached!.structureRevision = ctx.series.structureRevision;
      incrementPerformanceCounter("indicator.incremental.hit.macd");
      return cached!.prepared;
    }

    const tailIndex = mutation.tailIndex;
    const tail = bars[tailIndex];
    if (tail && tailIndex > 0) {
      const fast = emaTail(tail.close, cached!.fastValues[tailIndex - 1], fastPeriod);
      const slow = emaTail(tail.close, cached!.slowValues[tailIndex - 1], slowPeriod);
      const macdValue = fast !== null && slow !== null ? fast - slow : null;
      const signal = macdValue === null ? null : emaTail(macdValue, cached!.signalValues[tailIndex - 1], signalPeriod);
      if (fast !== null && slow !== null && signal !== null) {
        return measurePerformance("indicator.prepare.incremental.macd", () => {
          const histogram = macdValue! - signal;
          cached!.fastValues[tailIndex] = fast;
          cached!.slowValues[tailIndex] = slow;
          cached!.macdValues[tailIndex] = macdValue;
          cached!.signalValues[tailIndex] = signal;
          updateVisibleTail(cached!.plotSeries[0], tailIndex, tail.startTime, histogram);
          updateVisibleTail(cached!.plotSeries[1], tailIndex, tail.startTime, macdValue);
          updateVisibleTail(cached!.plotSeries[2], tailIndex, tail.startTime, signal);
          if (tailIndex >= start && tailIndex < end) {
            cached!.prepared = prepareMultiSeries(ctx, cached!.plotSeries, { scaleMode: "signed-zero", baseline: 0 });
          }
          cached!.seriesRevision = ctx.series.revision;
          cached!.structureRevision = ctx.series.structureRevision;
          incrementPerformanceCounter("indicator.incremental.hit.macd");
          return cached!.prepared;
        });
      }
      incrementPerformanceCounter("indicator.incremental.fallback.macd.seed");
    } else {
      incrementPerformanceCounter("indicator.incremental.fallback.macd.seed");
    }
  } else {
    let fallbackReason: string;
    if (!cached) fallbackReason = "initial";
    else if (!sameConfig) fallbackReason = "settings";
    else if (cached.start !== start || cached.end !== end) fallbackReason = "range";
    else if (!sameShape) fallbackReason = "shape";
    else if (mutation.kind === "structure") fallbackReason = "structure";
    else fallbackReason = `mutation-${mutation.kind}`;
    incrementPerformanceCounter(`indicator.incremental.fallback.macd.${fallbackReason}`);
  }

  return measurePerformance("indicator.prepare.full.macd", () => {
    const closes = bars.map((bar) => bar.close);
    const fastValues = exponentialMovingAverage(closes, fastPeriod);
    const slowValues = exponentialMovingAverage(closes, slowPeriod);
    const macdValues = fastValues.map((fast, index) => fast !== null && slowValues[index] !== null ? fast - slowValues[index]! : null);
    const signalValues = exponentialMovingAverage(macdValues.map((value) => value ?? NaN), signalPeriod);
    const histogramValues = macdValues.map((value, index) => value !== null && signalValues[index] !== null ? value - signalValues[index]! : null);
    const plotSeries: PlotSeries[] = [
      { key: "hist", label: "Hist", color: histogramColor, style: "histogram", points: makeSeriesPoints(histogramValues, bars, start, end) },
      { key: "macd", label: "MACD", color: macdColor, points: makeSeriesPoints(macdValues, bars, start, end) },
      { key: "signal", label: "Signal", color: signalColor, points: makeSeriesPoints(signalValues, bars, start, end) },
    ];
    const prepared = prepareMultiSeries(ctx, plotSeries, { scaleMode: "signed-zero", baseline: 0 });
    perSeries.set(ctx.instance.id, {
      instance: ctx.instance,
      seriesRevision: ctx.series.revision,
      structureRevision: ctx.series.structureRevision,
      start,
      end,
      fastPeriod,
      slowPeriod,
      signalPeriod,
      macdColor,
      signalColor,
      histogramColor,
      fastValues,
      slowValues,
      macdValues,
      signalValues,
      plotSeries,
      prepared,
    });
    incrementPerformanceCounter("indicator.incremental.full.macd");
    return prepared;
  });
}

export const macdIndicatorDefinition: IndicatorDefinition<MacdSettings> = {
  type: "macd", name: "MACD", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 124,
  defaultSettings: () => defaultPaneSettings({ fast: 12, slow: 26, signal: 9, macdColor: uiColor.info, signalColor: uiColor.warn, histogramColor: macdHistogramColorDefault }) as MacdSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "fast", label: "Fast EMA", labelKey: "indicator.macd.fast", min: 1, max: 200, step: 1, requiresRecalc: true }, { kind: "number", key: "slow", label: "Slow EMA", labelKey: "indicator.macd.slow", min: 1, max: 300, step: 1, requiresRecalc: true }, { kind: "number", key: "signal", label: "Signal EMA", labelKey: "indicator.macd.signal", min: 1, max: 100, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "macdColor", label: "MACD Color", labelKey: "indicator.macd.macdColor" }, { kind: "color", key: "signalColor", label: "Signal Color", labelKey: "indicator.macd.signalColor" }, { kind: "color", key: "histogramColor", label: "Histogram Color", labelKey: "indicator.common.histogramColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("MACD"), prepareCache: "series-range", prepareData: prepareMacd, drawSubPane: drawMultiSeries,
};

import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { rsi, seriesOhlcv } from "../../../core/analysis/calc/ta.js";
import { defaultPaneSettings, drawMultiSeries, drawMultiSeriesInteraction, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";
import { incrementPerformanceCounter, measurePerformance } from "../../../core/performanceTelemetry.js";
import { indicatorPriceSeriesMutation } from "../seriesMutationSummary.js";

export interface RsiSettings extends IndicatorSettings { period: number; overbought: number; oversold: number; color: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }

interface RsiIncrementalState {
  instance: object;
  seriesRevision: number;
  structureRevision: number;
  start: number;
  end: number;
  period: number;
  color: string;
  overbought: number;
  oversold: number;
  avgGains: Array<number | null>;
  avgLosses: Array<number | null>;
  values: Array<number | null>;
  plotSeries: PlotSeries[];
  prepared: ReturnType<typeof prepareMultiSeries>;
}

const rsiIncrementalStates = new WeakMap<object, Map<string, RsiIncrementalState>>();

function wilderTail(current: number, previous: number | null | undefined, period: number): number | null {
  if (!Number.isFinite(current) || previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  return (previous * (period - 1) + current) / period;
}

function rsiValue(avgGain: number | null, avgLoss: number | null): number | null {
  if (avgGain === null || avgLoss === null) return null;
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function fullRsiState(closes: readonly number[], period: number): { avgGains: Array<number | null>; avgLosses: Array<number | null> } {
  const gains: number[] = [NaN];
  const losses: number[] = [NaN];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  const smooth = (values: readonly number[]): Array<number | null> => {
    const out: Array<number | null> = Array.from({ length: values.length }, () => null);
    let seedSum = 0;
    let seedCount = 0;
    let state: number | null = null;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) continue;
      if (state === null) {
        seedSum += value;
        seedCount++;
        if (seedCount === period) { state = seedSum / period; out[i] = state; }
        continue;
      }
      state = (state * (period - 1) + value) / period;
      out[i] = state;
    }
    return out;
  };
  return { avgGains: smooth(gains), avgLosses: smooth(losses) };
}

function rebuildRsiGeometry(
  ctx: IndicatorDrawContext<RsiSettings>,
  cached: RsiIncrementalState,
  bars: ReturnType<IndicatorDrawContext<RsiSettings>["series"]["listReadonly"]>,
  start: number,
  end: number,
): ReturnType<typeof prepareMultiSeries> {
  cached.start = start;
  cached.end = end;
  cached.plotSeries = [{ key: "rsi", label: "RSI", color: cached.color, points: makeSeriesPoints(cached.values, bars, start, end) }];
  cached.prepared = prepareMultiSeries(ctx, cached.plotSeries, { scaleMode: "percent", baseline: 50, horizontalLevels: [{ value: cached.overbought, label: "OB" }, { value: cached.oversold, label: "OS" }] });
  return cached.prepared;
}

function prepareRsi(ctx: IndicatorDrawContext<RsiSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const period = numericSetting(ctx.settings, "period", 14, 1, 200);
  const overbought = numericSetting(ctx.settings, "overbought", 70);
  const oversold = numericSetting(ctx.settings, "oversold", 30);
  const color = stringSetting(ctx.settings, "color", uiColor.special);
  let perSeries = rsiIncrementalStates.get(ctx.series);
  if (!perSeries) { perSeries = new Map(); rsiIncrementalStates.set(ctx.series, perSeries); }
  const cached = perSeries.get(ctx.instance.id);
  const sameConfig = Boolean(cached)
    && cached!.instance === ctx.instance
    && cached!.period === period
    && cached!.color === color
    && cached!.overbought === overbought
    && cached!.oversold === oversold;
  const sameShape = Boolean(cached)
    && cached!.avgGains.length === bars.length
    && cached!.avgLosses.length === bars.length
    && cached!.values.length === bars.length;

  if (sameConfig && sameShape && cached!.seriesRevision === ctx.series.revision) {
    if (cached!.start === start && cached!.end === end) return cached!.prepared;
    incrementPerformanceCounter("indicator.incremental.hit.rsi");
    return rebuildRsiGeometry(ctx, cached!, bars, start, end);
  }

  const mutation = indicatorPriceSeriesMutation(ctx.series);
  const canReuse = sameConfig && sameShape;

  if (canReuse && (mutation.kind === "tail" || mutation.kind === "metadata")) {
    if (mutation.kind === "metadata") {
      cached!.seriesRevision = ctx.series.revision;
      cached!.structureRevision = ctx.series.structureRevision;
      incrementPerformanceCounter("indicator.incremental.hit.rsi");
      return rebuildRsiGeometry(ctx, cached!, bars, start, end);
    }
    const tailIndex = mutation.tailIndex;
    const tail = bars[tailIndex];
    const previousBar = bars[tailIndex - 1];
    if (tail && previousBar && tailIndex > 0) {
      const diff = tail.close - previousBar.close;
      const avgGain = wilderTail(Math.max(0, diff), cached!.avgGains[tailIndex - 1], period);
      const avgLoss = wilderTail(Math.max(0, -diff), cached!.avgLosses[tailIndex - 1], period);
      const value = rsiValue(avgGain, avgLoss);
      if (avgGain !== null && avgLoss !== null && value !== null) {
        return measurePerformance("indicator.prepare.incremental.rsi", () => {
          cached!.avgGains[tailIndex] = avgGain;
          cached!.avgLosses[tailIndex] = avgLoss;
          cached!.values[tailIndex] = value;
          cached!.seriesRevision = ctx.series.revision;
          cached!.structureRevision = ctx.series.structureRevision;
          rebuildRsiGeometry(ctx, cached!, bars, start, end);
          incrementPerformanceCounter("indicator.incremental.hit.rsi");
          return cached!.prepared;
        });
      }
    }
    incrementPerformanceCounter("indicator.incremental.fallback.rsi.seed");
  } else {
    let fallbackReason: string;
    if (!cached) fallbackReason = "initial";
    else if (!sameConfig) fallbackReason = "settings";
    else if (!sameShape) fallbackReason = "shape";
    else if (mutation.kind === "structure") fallbackReason = "structure";
    else fallbackReason = `mutation-${mutation.kind}`;
    incrementPerformanceCounter(`indicator.incremental.fallback.rsi.${fallbackReason}`);
  }

  return measurePerformance("indicator.prepare.full.rsi", () => {
    const points = rsi(seriesOhlcv(ctx.series), period);
    const closes = bars.map((bar) => bar.close);
    const { avgGains, avgLosses } = fullRsiState(closes, period);
    const values = points.map((point) => point.value);
    const plotSeries: PlotSeries[] = [{ key: "rsi", label: "RSI", color, points: makeSeriesPoints(values, bars, start, end) }];
    const prepared = prepareMultiSeries(ctx, plotSeries, { scaleMode: "percent", baseline: 50, horizontalLevels: [{ value: overbought, label: "OB" }, { value: oversold, label: "OS" }] });
    perSeries.set(ctx.instance.id, { instance: ctx.instance, seriesRevision: ctx.series.revision, structureRevision: ctx.series.structureRevision, start, end, period, color, overbought, oversold, avgGains, avgLosses, values, plotSeries, prepared });
    incrementPerformanceCounter("indicator.incremental.full.rsi");
    return prepared;
  });
}

export const rsiIndicatorDefinition: IndicatorDefinition<RsiSettings> = {
  type: "rsi", name: "RSI", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 112,
  defaultSettings: () => defaultPaneSettings({ period: 14, overbought: 70, oversold: 30, color: uiColor.special }) as RsiSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "Period", labelKey: "indicator.rsi.period", min: 1, max: 200, step: 1, requiresRecalc: true }, { kind: "number", key: "overbought", label: "Overbought", labelKey: "indicator.rsi.overbought", min: 1, max: 100, step: 1 }, { kind: "number", key: "oversold", label: "Oversold", labelKey: "indicator.rsi.oversold", min: 0, max: 99, step: 1 }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "color", label: "Line Color", labelKey: "indicator.rsi.lineColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("RSI"), prepareCache: "series-range", prepareData: prepareRsi, drawSubPane: drawMultiSeries, drawInteraction: drawMultiSeriesInteraction,
};

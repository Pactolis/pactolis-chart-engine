import type { FootprintBar } from "../../../core/types.js";
import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { averageTrueRange, seriesOhlcv } from "../../../core/analysis/calc/ta.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { atrColorDefault } from "../../../core/ui/seriesPalette.js";
import { incrementPerformanceCounter, measurePerformance } from "../../../core/performanceTelemetry.js";
import { indicatorPriceSeriesMutation } from "../seriesMutationSummary.js";

export interface AtrSettings extends IndicatorSettings { period: number; color: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }

interface AtrIncrementalState {
  instance: object;
  seriesRevision: number;
  structureRevision: number;
  start: number;
  end: number;
  period: number;
  color: string;
  values: Array<number | null>;
  plotSeries: PlotSeries[];
  prepared: ReturnType<typeof prepareMultiSeries>;
}

const atrIncrementalStates = new WeakMap<object, Map<string, AtrIncrementalState>>();

function trueRangeAt(bars: readonly FootprintBar[], index: number): number | null {
  const bar = bars[index];
  if (!bar) return null;
  const previousClose = index > 0 ? bars[index - 1]?.close : bar.close;
  if (![bar.high, bar.low, previousClose].every(Number.isFinite)) return null;
  return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
}

function atrTailValue(
  bars: readonly FootprintBar[],
  values: readonly (number | null)[],
  index: number,
  period: number,
): { reusable: boolean; value: number | null } {
  const currentRange = trueRangeAt(bars, index);
  if (currentRange === null) return { reusable: false, value: null };
  if (index + 1 < period) return { reusable: true, value: null };
  if (index + 1 === period) {
    let sum = 0;
    for (let i = 0; i <= index; i++) {
      const range = trueRangeAt(bars, i);
      if (range === null) return { reusable: true, value: null };
      sum += range;
    }
    return { reusable: true, value: sum / period };
  }
  if (period === 1) return { reusable: true, value: currentRange };
  const previous = values[index - 1];
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return { reusable: false, value: null };
  return { reusable: true, value: (previous * (period - 1) + currentRange) / period };
}

function prepareAtr(ctx: IndicatorDrawContext<AtrSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const period = numericSetting(ctx.settings, "period", 14, 1, 200);
  const color = stringSetting(ctx.settings, "color", atrColorDefault);
  let perSeries = atrIncrementalStates.get(ctx.series);
  if (!perSeries) {
    perSeries = new Map();
    atrIncrementalStates.set(ctx.series, perSeries);
  }
  const cached = perSeries.get(ctx.instance.id);
  const sameConfig = Boolean(cached)
    && cached!.instance === ctx.instance
    && cached!.period === period
    && cached!.color === color;
  if (sameConfig && cached!.seriesRevision === ctx.series.revision && cached!.start === start && cached!.end === end) return cached!.prepared;

  const mutation = indicatorPriceSeriesMutation(ctx.series);
  const sameShape = Boolean(cached) && cached!.values.length === bars.length;
  const canReuse = sameConfig
    && cached!.start === start
    && cached!.end === end
    && sameShape;

  if (canReuse && (mutation.kind === "tail" || mutation.kind === "metadata")) {
    if (mutation.kind === "metadata") {
      cached!.seriesRevision = ctx.series.revision;
      cached!.structureRevision = ctx.series.structureRevision;
      incrementPerformanceCounter("indicator.incremental.hit.atr");
      return cached!.prepared;
    }
    const tailIndex = mutation.tailIndex;
    const tail = bars[tailIndex];
    const next = atrTailValue(bars, cached!.values, tailIndex, period);
    if (tail && next.reusable) {
      return measurePerformance("indicator.prepare.incremental.atr", () => {
        cached!.values[tailIndex] = next.value;
        const point = cached!.plotSeries[0].points.at(-1);
        if (point?.index === tailIndex) {
          point.time = tail.startTime;
          point.value = next.value;
        }
        if (tailIndex >= start && tailIndex < end) {
          cached!.prepared = prepareMultiSeries(ctx, cached!.plotSeries, { scaleMode: "linear" });
        }
        cached!.seriesRevision = ctx.series.revision;
        cached!.structureRevision = ctx.series.structureRevision;
        incrementPerformanceCounter("indicator.incremental.hit.atr");
        return cached!.prepared;
      });
    }
    incrementPerformanceCounter("indicator.incremental.fallback.atr.seed");
  } else {
    let fallbackReason: string;
    if (!cached) fallbackReason = "initial";
    else if (!sameConfig) fallbackReason = "settings";
    else if (cached.start !== start || cached.end !== end) fallbackReason = "range";
    else if (!sameShape) fallbackReason = "shape";
    else if (mutation.kind === "structure") fallbackReason = "structure";
    else fallbackReason = `mutation-${mutation.kind}`;
    incrementPerformanceCounter(`indicator.incremental.fallback.atr.${fallbackReason}`);
  }

  return measurePerformance("indicator.prepare.full.atr", () => {
    const values = averageTrueRange(seriesOhlcv(ctx.series), period);
    const plotSeries: PlotSeries[] = [{ key: "atr", label: "ATR", color, points: makeSeriesPoints(values, bars, start, end) }];
    const prepared = prepareMultiSeries(ctx, plotSeries, { scaleMode: "linear" });
    perSeries.set(ctx.instance.id, {
      instance: ctx.instance,
      seriesRevision: ctx.series.revision,
      structureRevision: ctx.series.structureRevision,
      start,
      end,
      period,
      color,
      values,
      plotSeries,
      prepared,
    });
    incrementPerformanceCounter("indicator.incremental.full.atr");
    return prepared;
  });
}

export const atrIndicatorDefinition: IndicatorDefinition<AtrSettings> = {
  type: "atr", name: "ATR", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 104,
  defaultSettings: () => defaultPaneSettings({ period: 14, color: atrColorDefault }) as AtrSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "Period", labelKey: "indicator.common.period", min: 1, max: 200, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "color", label: "Line Color", labelKey: "indicator.common.lineColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("ATR"), prepareCache: "series-range", prepareData: prepareAtr, drawSubPane: drawMultiSeries,
};

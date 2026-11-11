import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { seriesOhlcv, moneyFlowIndex } from "../../../core/analysis/calc/ta.js";
import { windowSumAdvance, windowSumFull, type WindowSumState } from "../../../core/analysis/calc/tailState.js";
import { resolveIncremental, type IncrementalBase } from "./incrementalSeries.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { mfiColorDefault } from "../../../core/ui/seriesPalette.js";

export interface MfiSettings extends IndicatorSettings { period: number; color: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
interface MfiState extends IncrementalBase { positive: number[]; negative: number[]; values: Array<number | null>; posBefore: WindowSumState | null; negBefore: WindowSumState | null }
function flows(bars: ReturnType<IndicatorDrawContext<MfiSettings>["series"]["listReadonly"]>, i: number): { pos: number; neg: number } {
  const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
  const prevTp = (bars[i - 1].high + bars[i - 1].low + bars[i - 1].close) / 3;
  const flow = tp * bars[i].volume;
  return { pos: tp > prevTp ? flow : 0, neg: tp < prevTp ? flow : 0 };
}
function prepareMfi(ctx: IndicatorDrawContext<MfiSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const period = numericSetting(ctx.settings, "period", 14, 1, 200);
  const state = resolveIncremental<MfiState>("mfi", ctx, `${period}`, () => {
    const positive: number[] = [0]; const negative: number[] = [0];
    for (let i = 1; i < bars.length; i++) { const f = flows(bars, i); positive.push(f.pos); negative.push(f.neg); }
    return { positive, negative, values: moneyFlowIndex(seriesOhlcv(ctx.series), period).map((point) => point.value), posBefore: windowSumFull(positive, period).before, negBefore: windowSumFull(negative, period).before };
  }, (cached) => {
    const tail = bars.length - 1;
    if (tail < 1 || !cached.posBefore || !cached.negBefore) return false;
    const f = flows(bars, tail);
    cached.positive[tail] = f.pos;
    cached.negative[tail] = f.neg;
    const p = windowSumAdvance(cached.positive, period, cached.posBefore);
    const n = windowSumAdvance(cached.negative, period, cached.negBefore);
    cached.values[tail] = p === null || n === null ? null : p === 0 && n === 0 ? 50 : n === 0 ? 100 : 100 - 100 / (1 + p / n);
    return true;
  });
  const series: PlotSeries[] = [{ key: "mfi", label: "MFI", color: stringSetting(ctx.settings, "color", mfiColorDefault), points: makeSeriesPoints(state.values, bars, start, end) }];
  return prepareMultiSeries(ctx, series, { scaleMode: "percent", baseline: 50, horizontalLevels: [{ value: 80, label: "OB" }, { value: 20, label: "OS" }], axisTicks: [80, 50, 20], fixedRange: { min: 0, max: 100 } });
}
export const mfiIndicatorDefinition: IndicatorDefinition<MfiSettings> = {
  type: "mfi", name: "MFI", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 112,
  defaultSettings: () => defaultPaneSettings({ period: 14, color: mfiColorDefault }) as MfiSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "Period", labelKey: "indicator.common.period", min: 1, max: 200, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "color", label: "Line Color", labelKey: "indicator.common.lineColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("MFI"), prepareCache: "series-range", prepareData: prepareMfi, drawSubPane: drawMultiSeries,
};

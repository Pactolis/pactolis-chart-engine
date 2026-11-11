import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { seriesOhlcv, cci } from "../../../core/analysis/calc/ta.js";
import { windowSumAdvance, windowSumFull, type WindowSumState } from "../../../core/analysis/calc/tailState.js";
import { resolveIncremental, type IncrementalBase } from "./incrementalSeries.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { cciColorDefault } from "../../../core/ui/seriesPalette.js";

export interface CciSettings extends IndicatorSettings { period: number; color: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
interface CciState extends IncrementalBase { typical: number[]; values: Array<number | null>; before: WindowSumState | null }
function prepareCci(ctx: IndicatorDrawContext<CciSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const period = numericSetting(ctx.settings, "period", 20, 1, 300);
  const state = resolveIncremental<CciState>("cci", ctx, `${period}`, () => {
    const typical = bars.map((bar) => (bar.high + bar.low + bar.close) / 3);
    return { typical, values: cci(seriesOhlcv(ctx.series), period).map((point) => point.value), before: windowSumFull(typical, period).before };
  }, (cached) => {
    const tail = bars.length - 1;
    if (!cached.before) return false;
    const bar = bars[tail];
    cached.typical[tail] = (bar.high + bar.low + bar.close) / 3;
    const sum = windowSumAdvance(cached.typical, period, cached.before);
    const n = Math.max(1, Math.floor(period));
    const middle = sum === null ? null : sum / n;
    if (middle === null || tail + 1 < period) { cached.values[tail] = null; return true; }
    const window = cached.typical.slice(tail + 1 - period, tail + 1);
    const meanDeviation = window.reduce((acc, value) => acc + Math.abs(value - middle), 0) / period;
    cached.values[tail] = meanDeviation > 0 ? (cached.typical[tail] - middle) / (0.015 * meanDeviation) : null;
    return true;
  });
  const series: PlotSeries[] = [{ key: "cci", label: "CCI", color: stringSetting(ctx.settings, "color", cciColorDefault), points: makeSeriesPoints(state.values, bars, start, end) }];
  return prepareMultiSeries(ctx, series, { scaleMode: "signed-zero", baseline: 0, horizontalLevels: [{ value: 100, label: "+100" }, { value: -100, label: "-100" }] });
}
export const cciIndicatorDefinition: IndicatorDefinition<CciSettings> = {
  type: "cci", name: "CCI", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 112,
  defaultSettings: () => defaultPaneSettings({ period: 20, color: cciColorDefault }) as CciSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "Period", labelKey: "indicator.common.period", min: 1, max: 300, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "color", label: "Line Color", labelKey: "indicator.common.lineColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("CCI"), prepareCache: "series-range", prepareData: prepareCci, drawSubPane: drawMultiSeries,
};

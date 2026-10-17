import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { seriesOhlcv, kdj } from "../../../core/analysis/calc/ta.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";

// core/analysis/calc/ta.ts's kdj() now smooths RSV with the standard alpha = 1/n (Wilder
// smoothing) instead of EMA's alpha = 2/(n+1) -- with the kSmoothing/dSmoothing default of
// 3 below, plotted K/D/J values differ from the previous release (they react ~1.5x slower,
// matching every other platform's KDJ instead of running ahead of it).
export interface KdjSettings extends IndicatorSettings { period: number; kSmoothing: number; dSmoothing: number; kColor: string; dColor: string; jColor: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
function prepareKdj(ctx: IndicatorDrawContext<KdjSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const values = kdj(seriesOhlcv(ctx.series), numericSetting(ctx.settings, "period", 9, 1, 200), numericSetting(ctx.settings, "kSmoothing", 3, 1, 50), numericSetting(ctx.settings, "dSmoothing", 3, 1, 50));
  const series: PlotSeries[] = [
    { key: "k", label: "K", color: stringSetting(ctx.settings, "kColor", uiColor.info), points: makeSeriesPoints(values.map((point) => point.k), bars, start, end) },
    { key: "d", label: "D", color: stringSetting(ctx.settings, "dColor", uiColor.warn), points: makeSeriesPoints(values.map((point) => point.d), bars, start, end) },
    { key: "j", label: "J", color: stringSetting(ctx.settings, "jColor", uiColor.sell), points: makeSeriesPoints(values.map((point) => point.j), bars, start, end) },
  ];
  return prepareMultiSeries(ctx, series, { scaleMode: "percent", baseline: 50, horizontalLevels: [{ value: 80, label: "OB" }, { value: 20, label: "OS" }] });
}
export const kdjIndicatorDefinition: IndicatorDefinition<KdjSettings> = {
  type: "kdj", name: "KDJ", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 112,
  defaultSettings: () => defaultPaneSettings({ period: 9, kSmoothing: 3, dSmoothing: 3, kColor: uiColor.info, dColor: uiColor.warn, jColor: uiColor.sell }) as KdjSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "Period", labelKey: "indicator.common.period", min: 1, max: 200, step: 1, requiresRecalc: true }, { kind: "number", key: "kSmoothing", label: "K Smoothing", labelKey: "indicator.kdj.kSmoothing", min: 1, max: 50, step: 1, requiresRecalc: true }, { kind: "number", key: "dSmoothing", label: "D Smoothing", labelKey: "indicator.kdj.dSmoothing", min: 1, max: 50, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "kColor", label: "K Color", labelKey: "indicator.kdj.kColor" }, { kind: "color", key: "dColor", label: "D Color", labelKey: "indicator.kdj.dColor" }, { kind: "color", key: "jColor", label: "J Color", labelKey: "indicator.kdj.jColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("KDJ"), prepareCache: "series-range", prepareData: prepareKdj, drawSubPane: drawMultiSeries,
};

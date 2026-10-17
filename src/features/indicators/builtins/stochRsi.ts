import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { seriesOhlcv, stochasticRsi } from "../../../core/analysis/calc/ta.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";

export interface StochRsiSettings extends IndicatorSettings { period: number; kPeriod: number; dPeriod: number; kColor: string; dColor: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
function prepareStochRsi(ctx: IndicatorDrawContext<StochRsiSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const values = stochasticRsi(seriesOhlcv(ctx.series), numericSetting(ctx.settings, "period", 14, 1, 200), numericSetting(ctx.settings, "kPeriod", 3, 1, 50), numericSetting(ctx.settings, "dPeriod", 3, 1, 50));
  const series: PlotSeries[] = [
    { key: "k", label: "%K", color: stringSetting(ctx.settings, "kColor", uiColor.info), points: makeSeriesPoints(values.map((point) => point.k), bars, start, end) },
    { key: "d", label: "%D", color: stringSetting(ctx.settings, "dColor", uiColor.warn), points: makeSeriesPoints(values.map((point) => point.d), bars, start, end) },
  ];
  return prepareMultiSeries(ctx, series, { scaleMode: "percent", baseline: 50, horizontalLevels: [{ value: 80, label: "OB" }, { value: 20, label: "OS" }] });
}
export const stochRsiIndicatorDefinition: IndicatorDefinition<StochRsiSettings> = {
  type: "stoch-rsi", name: "StochRSI", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 112,
  defaultSettings: () => defaultPaneSettings({ period: 14, kPeriod: 3, dPeriod: 3, kColor: uiColor.info, dColor: uiColor.warn }) as StochRsiSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "RSI/Stoch Period", labelKey: "indicator.stochRsi.period", min: 1, max: 200, step: 1, requiresRecalc: true }, { kind: "number", key: "kPeriod", label: "%K Smoothing", labelKey: "indicator.stochRsi.kPeriod", min: 1, max: 50, step: 1, requiresRecalc: true }, { kind: "number", key: "dPeriod", label: "%D Smoothing", labelKey: "indicator.stochRsi.dPeriod", min: 1, max: 50, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "kColor", label: "%K Color", labelKey: "indicator.stochRsi.kColor" }, { kind: "color", key: "dColor", label: "%D Color", labelKey: "indicator.stochRsi.dColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("StochRSI"), prepareCache: "series-range", prepareData: prepareStochRsi, drawSubPane: drawMultiSeries,
};

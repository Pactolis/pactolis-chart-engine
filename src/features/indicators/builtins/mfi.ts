import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { seriesOhlcv, moneyFlowIndex } from "../../../core/analysis/calc/ta.js";
import { defaultPaneSettings, drawMultiSeries, makeNumberPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { mfiColorDefault } from "../../../core/ui/seriesPalette.js";

export interface MfiSettings extends IndicatorSettings { period: number; color: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
function prepareMfi(ctx: IndicatorDrawContext<MfiSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const values = moneyFlowIndex(seriesOhlcv(ctx.series), numericSetting(ctx.settings, "period", 14, 1, 200));
  const series: PlotSeries[] = [{ key: "mfi", label: "MFI", color: stringSetting(ctx.settings, "color", mfiColorDefault), points: makeNumberPoints(values, bars, start, end) }];
  return prepareMultiSeries(ctx, series, { scaleMode: "percent", baseline: 50, horizontalLevels: [{ value: 80, label: "OB" }, { value: 20, label: "OS" }] });
}
export const mfiIndicatorDefinition: IndicatorDefinition<MfiSettings> = {
  type: "mfi", name: "MFI", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 112,
  defaultSettings: () => defaultPaneSettings({ period: 14, color: mfiColorDefault }) as MfiSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "Period", labelKey: "indicator.common.period", min: 1, max: 200, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "color", label: "Line Color", labelKey: "indicator.common.lineColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("MFI"), prepareCache: "series-range", prepareData: prepareMfi, drawSubPane: drawMultiSeries,
};

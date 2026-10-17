import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { seriesOhlcv, cci } from "../../../core/analysis/calc/ta.js";
import { defaultPaneSettings, drawMultiSeries, makeNumberPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { cciColorDefault } from "../../../core/ui/seriesPalette.js";

export interface CciSettings extends IndicatorSettings { period: number; color: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
function prepareCci(ctx: IndicatorDrawContext<CciSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const values = cci(seriesOhlcv(ctx.series), numericSetting(ctx.settings, "period", 20, 1, 300));
  const series: PlotSeries[] = [{ key: "cci", label: "CCI", color: stringSetting(ctx.settings, "color", cciColorDefault), points: makeNumberPoints(values, bars, start, end) }];
  return prepareMultiSeries(ctx, series, { scaleMode: "signed-zero", baseline: 0, horizontalLevels: [{ value: 100, label: "+100" }, { value: -100, label: "-100" }] });
}
export const cciIndicatorDefinition: IndicatorDefinition<CciSettings> = {
  type: "cci", name: "CCI", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 112,
  defaultSettings: () => defaultPaneSettings({ period: 20, color: cciColorDefault }) as CciSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "Period", labelKey: "indicator.common.period", min: 1, max: 300, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "color", label: "Line Color", labelKey: "indicator.common.lineColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("CCI"), prepareCache: "series-range", prepareData: prepareCci, drawSubPane: drawMultiSeries,
};

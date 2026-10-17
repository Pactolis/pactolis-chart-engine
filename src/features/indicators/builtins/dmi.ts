import type { IndicatorDefinition, IndicatorDrawContext, IndicatorPreparedData, IndicatorSettings } from "../types.js";
import { seriesOhlcv, dmi } from "../../../core/analysis/calc/ta.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";

export interface DmiSettings extends IndicatorSettings { period: number; adxPeriod: number; plusColor: string; minusColor: string; adxColor: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
function prepareDmi(ctx: IndicatorDrawContext<DmiSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const values = dmi(seriesOhlcv(ctx.series), numericSetting(ctx.settings, "period", 14, 1, 200), numericSetting(ctx.settings, "adxPeriod", 14, 1, 200));
  const series: PlotSeries[] = [
    { key: "plus", label: "+DI", color: stringSetting(ctx.settings, "plusColor", uiColor.buy), points: makeSeriesPoints(values.map((point) => point.plusDi), bars, start, end) },
    { key: "minus", label: "-DI", color: stringSetting(ctx.settings, "minusColor", uiColor.sell), points: makeSeriesPoints(values.map((point) => point.minusDi), bars, start, end) },
    { key: "adx", label: "ADX", color: stringSetting(ctx.settings, "adxColor", uiColor.warn), points: makeSeriesPoints(values.map((point) => point.adx), bars, start, end) },
  ];
  return prepareMultiSeries(ctx, series, { scaleMode: "percent", baseline: 20, horizontalLevels: [{ value: 20, label: "20" }, { value: 40, label: "40" }] });
}

function drawDmiPane(ctx: IndicatorDrawContext<DmiSettings>, prepared?: IndicatorPreparedData): void {
  drawMultiSeries(ctx, prepared);
  const items = [
    { label: "+DI", color: stringSetting(ctx.settings, "plusColor", uiColor.buy) },
    { label: "−DI", color: stringSetting(ctx.settings, "minusColor", uiColor.sell) },
    { label: "ADX", color: stringSetting(ctx.settings, "adxColor", uiColor.warn) },
  ];
  const canvas = ctx.ctx;
  canvas.save();
  canvas.font = "11px ui-monospace, monospace";
  canvas.textBaseline = "middle";
  let x = ctx.view.area.left + 8;
  const y = ctx.rect.top + 36;
  for (const item of items) {
    canvas.fillStyle = item.color;
    canvas.fillText(item.label, x, y);
    x += canvas.measureText(item.label).width + 14;
  }
  canvas.restore();
}
export const dmiIndicatorDefinition: IndicatorDefinition<DmiSettings> = {
  type: "dmi", name: "DMI + ADX", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 124,
  defaultSettings: () => defaultPaneSettings({ period: 14, adxPeriod: 14, plusColor: uiColor.buy, minusColor: uiColor.sell, adxColor: uiColor.warn }) as DmiSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "DI Period", labelKey: "indicator.dmi.period", min: 1, max: 200, step: 1, requiresRecalc: true }, { kind: "number", key: "adxPeriod", label: "ADX Period", labelKey: "indicator.dmi.adxPeriod", min: 1, max: 200, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "plusColor", label: "+DI Color", labelKey: "indicator.dmi.plusColor" }, { kind: "color", key: "minusColor", label: "-DI Color", labelKey: "indicator.dmi.minusColor" }, { kind: "color", key: "adxColor", label: "ADX Color", labelKey: "indicator.dmi.adxColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("DMI + ADX"), prepareCache: "series-range", prepareData: prepareDmi, drawSubPane: drawDmiPane,
};

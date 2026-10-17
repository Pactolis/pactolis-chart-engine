import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { deltaSeries } from "../../../core/analysis/calc/ta.js";
import { defaultPaneSettings, drawMultiSeries, makeNumberPoints, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { deltaColorDefault, uiColor } from "../../../core/ui/seriesPalette.js";

export interface DeltaSettings extends IndicatorSettings { mode: "delta" | "percent"; color: string; negativeColor: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
function prepareDelta(ctx: IndicatorDrawContext<DeltaSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const percent = ctx.settings.mode === "percent";
  const values = deltaSeries(bars.map((bar) => ({ time: bar.startTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, delta: bar.delta })), percent);
  const positiveColor = stringSetting(ctx.settings, "color", deltaColorDefault);
  const negativeColor = stringSetting(ctx.settings, "negativeColor", uiColor.sell);
  const points = makeNumberPoints(values, bars, start, end).map((point) => ({
    ...point,
    color: point.value === null ? undefined : point.value > 0 ? positiveColor : point.value < 0 ? negativeColor : uiColor.textMuted,
  }));
  const series: PlotSeries[] = [{ key: "delta", label: percent ? "Δ%" : "Δ", color: positiveColor, style: "histogram", points }];
  return prepareMultiSeries(ctx, series, { scaleMode: percent ? "percent" : "signed-zero", baseline: 0 });
}
export const deltaIndicatorDefinition: IndicatorDefinition<DeltaSettings> = {
  type: "delta", name: "Delta / Delta %", category: "flow", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 104,
  defaultSettings: () => defaultPaneSettings({ mode: "delta", color: deltaColorDefault, negativeColor: uiColor.sell }) as DeltaSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "select", key: "mode", label: "Mode", labelKey: "indicator.common.mode", options: [{ label: "Delta", value: "delta", labelKey: "indicator.delta.mode.delta" }, { label: "Delta %", value: "percent", labelKey: "indicator.delta.mode.percent" }], requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "color", label: "Positive Histogram Color", labelKey: "indicator.delta.positiveColor" }, { kind: "color", key: "negativeColor", label: "Negative Histogram Color", labelKey: "indicator.delta.negativeColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("Delta"), prepareCache: "series-range", prepareData: prepareDelta, drawSubPane: drawMultiSeries,
};

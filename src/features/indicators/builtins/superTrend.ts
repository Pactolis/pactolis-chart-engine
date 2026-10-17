import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { seriesOhlcv, superTrend } from "../../../core/analysis/calc/ta.js";
import { drawPriceOverlayLines, makeOverlayPoints, overlayAppearanceFields, prepareOverlayData } from "./priceOverlayShared.js";
import { numericSetting, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";

export interface SuperTrendSettings extends IndicatorSettings {
  period: number;
  multiplier: number;
  upColor: string;
  downColor: string;
  lineWidth: number;
  showLastValueLabel: boolean;
  showPlotLabel: boolean;
}

function prepareSuperTrend(ctx: IndicatorDrawContext<SuperTrendSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const st = superTrend(seriesOhlcv(ctx.series), numericSetting(ctx.settings, "period", 10, 1, 200), numericSetting(ctx.settings, "multiplier", 3, 0.1, 20));
  const up = st.map((point) => point.direction === 1 ? point.trend : null);
  const down = st.map((point) => point.direction === -1 ? point.trend : null);
  const series: PlotSeries[] = [
    { key: "up", label: "ST ↑", color: stringSetting(ctx.settings, "upColor", uiColor.buy), points: makeOverlayPoints(up, bars, start, end) },
    { key: "down", label: "ST ↓", color: stringSetting(ctx.settings, "downColor", uiColor.sell), points: makeOverlayPoints(down, bars, start, end) },
  ];
  return prepareOverlayData(ctx, series);
}

export const superTrendIndicatorDefinition: IndicatorDefinition<SuperTrendSettings> = {
  type: "supertrend",
  name: "SuperTrend",
  category: "custom",
  defaultPane: "overlay",
  canOverlay: true,
  defaultPlacement: "price-overlay",
  supportedPlacements: ["price-overlay"],
  paneHeight: 0,
  defaultSettings: () => ({ period: 10, multiplier: 3, upColor: uiColor.buy, downColor: uiColor.sell, lineWidth: 1.6, showLastValueLabel: true, showPlotLabel: true }),
  settingsSchema: { sections: [
    { title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "ATR Period", labelKey: "indicator.superTrend.period", min: 1, max: 200, step: 1, requiresRecalc: true }, { kind: "number", key: "multiplier", label: "Multiplier", labelKey: "indicator.superTrend.multiplier", min: 0.1, max: 20, step: 0.1, requiresRecalc: true }] },
    { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "upColor", label: "Up Trend", labelKey: "indicator.superTrend.upColor" }, { kind: "color", key: "downColor", label: "Down Trend", labelKey: "indicator.superTrend.downColor" }, ...overlayAppearanceFields()] },
  ] },
  getHeaderLabel: ({ settings }) => settings.showPlotLabel === false ? "" : `SuperTrend ${settings.period ?? 10}/${settings.multiplier ?? 3}`,
  prepareCache: "series-range", prepareData: prepareSuperTrend,
  drawPriceOverlay: drawPriceOverlayLines,
};

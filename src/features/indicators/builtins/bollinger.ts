import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { bollingerBands, seriesOhlcv } from "../../../core/analysis/calc/ta.js";
import { drawPriceOverlayLines, makeOverlayPoints, overlayAppearanceFields, prepareOverlayData } from "./priceOverlayShared.js";
import { numericSetting, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor, bollingerBasisColorDefault } from "../../../core/ui/seriesPalette.js";

export interface BollingerSettings extends IndicatorSettings {
  period: number;
  multiplier: number;
  basisColor: string;
  bandColor: string;
  lineWidth: number;
  showLastValueLabel: boolean;
  showPlotLabel: boolean;
}

function prepareBollinger(ctx: IndicatorDrawContext<BollingerSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const points = bollingerBands(seriesOhlcv(ctx.series), numericSetting(ctx.settings, "period", 20, 1, 500), numericSetting(ctx.settings, "multiplier", 2, 0.1, 10));
  const series: PlotSeries[] = [
    { key: "upper", label: "BB U", color: stringSetting(ctx.settings, "bandColor", uiColor.info), points: makeOverlayPoints(points.map((point) => point.upper), bars, start, end) },
    { key: "middle", label: "BB M", color: stringSetting(ctx.settings, "basisColor", bollingerBasisColorDefault), points: makeOverlayPoints(points.map((point) => point.middle), bars, start, end) },
    { key: "lower", label: "BB L", color: stringSetting(ctx.settings, "bandColor", uiColor.info), points: makeOverlayPoints(points.map((point) => point.lower), bars, start, end) },
  ];
  return prepareOverlayData(ctx, series);
}

export const bollingerIndicatorDefinition: IndicatorDefinition<BollingerSettings> = {
  type: "bollinger-bands",
  name: "Bollinger Bands",
  category: "custom",
  defaultPane: "overlay",
  canOverlay: true,
  defaultPlacement: "price-overlay",
  supportedPlacements: ["price-overlay"],
  paneHeight: 0,
  defaultSettings: () => ({ period: 20, multiplier: 2, basisColor: bollingerBasisColorDefault, bandColor: uiColor.info, lineWidth: 1.3, showLastValueLabel: true, showPlotLabel: true }),
  settingsSchema: { sections: [
    { title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "Period", labelKey: "indicator.common.period", min: 1, max: 500, step: 1, requiresRecalc: true }, { kind: "number", key: "multiplier", label: "StdDev Multiplier", labelKey: "indicator.bollinger.multiplier", min: 0.1, max: 10, step: 0.1, requiresRecalc: true }] },
    { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "basisColor", label: "Basis Color", labelKey: "indicator.bollinger.basisColor" }, { kind: "color", key: "bandColor", label: "Band Color", labelKey: "indicator.bollinger.bandColor" }, ...overlayAppearanceFields()] },
  ] },
  getHeaderLabel: ({ settings }) => settings.showPlotLabel === false ? "" : `BB ${settings.period ?? 20}×${settings.multiplier ?? 2}`,
  prepareCache: "series-range", prepareData: prepareBollinger,
  drawPriceOverlay: drawPriceOverlayLines,
};

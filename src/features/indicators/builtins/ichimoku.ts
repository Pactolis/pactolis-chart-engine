import type { IndicatorDefinition, IndicatorDrawContext, IndicatorPreparedData, IndicatorSettings } from "../types.js";
import { seriesOhlcv, ichimoku } from "../../../core/analysis/calc/ta.js";
import { asOverlayData, drawPriceOverlayLines, makeOverlayPoints, overlayAppearanceFields, prepareOverlayData } from "./priceOverlayShared.js";
import { numericSetting, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { ichimokuCloudSegments } from "./ichimokuCloud.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";

export interface IchimokuSettings extends IndicatorSettings {
  tenkanPeriod: number;
  kijunPeriod: number;
  senkouBPeriod: number;
  displacement: number;
  tenkanColor: string;
  kijunColor: string;
  senkouAColor: string;
  senkouBColor: string;
  chikouColor: string;
  lineWidth: number;
  showLastValueLabel: boolean;
  showPlotLabel: boolean;
}

function prepareIchimoku(ctx: IndicatorDrawContext<IchimokuSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const values = ichimoku(
    seriesOhlcv(ctx.series),
    numericSetting(ctx.settings, "tenkanPeriod", 9, 1, 200),
    numericSetting(ctx.settings, "kijunPeriod", 26, 1, 300),
    numericSetting(ctx.settings, "senkouBPeriod", 52, 1, 500),
    numericSetting(ctx.settings, "displacement", 26, 0, 200),
  );
  const series: PlotSeries[] = [
    { key: "tenkan", label: "Tenkan", color: stringSetting(ctx.settings, "tenkanColor", uiColor.info), points: makeOverlayPoints(values.map((point) => point.tenkan), bars, start, end) },
    { key: "kijun", label: "Kijun", color: stringSetting(ctx.settings, "kijunColor", uiColor.warn), points: makeOverlayPoints(values.map((point) => point.kijun), bars, start, end) },
    { key: "senkouA", label: "Senkou A", color: stringSetting(ctx.settings, "senkouAColor", uiColor.buy), points: makeOverlayPoints(values.map((point) => point.senkouA), bars, start, end) },
    { key: "senkouB", label: "Senkou B", color: stringSetting(ctx.settings, "senkouBColor", uiColor.sell), points: makeOverlayPoints(values.map((point) => point.senkouB), bars, start, end) },
    { key: "chikou", label: "Chikou", color: stringSetting(ctx.settings, "chikouColor", uiColor.special), points: makeOverlayPoints(values.map((point) => point.chikou), bars, start, end) },
  ];
  return prepareOverlayData(ctx, series);
}

function drawIchimoku(ctx: IndicatorDrawContext<IchimokuSettings>, prepared?: IndicatorPreparedData): void {
  const data = asOverlayData(prepared);
  if (data.status !== "ok") return;
  const senkouA = data.meta.series.find((series) => series.key === "senkouA");
  const senkouB = data.meta.series.find((series) => series.key === "senkouB");
  if (senkouA && senkouB) {
    const canvas = ctx.ctx;
    canvas.save();
    canvas.beginPath();
    canvas.rect(ctx.view.area.left, ctx.view.area.top, ctx.view.area.width, ctx.view.area.height);
    canvas.clip();
    canvas.globalAlpha = 0.18;
    for (const segment of ichimokuCloudSegments(senkouA.points, senkouB.points)) {
      const x1 = ctx.view.xOfIndex(segment.fromIndex) + ctx.view.colWidth / 2;
      const x2 = ctx.view.xOfIndex(segment.toIndex) + ctx.view.colWidth / 2;
      canvas.fillStyle = segment.bullish ? senkouA.color : senkouB.color;
      canvas.beginPath();
      canvas.moveTo(x1, ctx.view.yOfPrice(segment.aFrom));
      canvas.lineTo(x2, ctx.view.yOfPrice(segment.aTo));
      canvas.lineTo(x2, ctx.view.yOfPrice(segment.bTo));
      canvas.lineTo(x1, ctx.view.yOfPrice(segment.bFrom));
      canvas.closePath();
      canvas.fill();
    }
    canvas.restore();
  }
  drawPriceOverlayLines(ctx, prepared);
}

export const ichimokuIndicatorDefinition: IndicatorDefinition<IchimokuSettings> = {
  type: "ichimoku",
  name: "Ichimoku Cloud",
  category: "custom",
  defaultPane: "overlay",
  canOverlay: true,
  defaultPlacement: "price-overlay",
  supportedPlacements: ["price-overlay"],
  paneHeight: 0,
  defaultSettings: () => ({
    tenkanPeriod: 9,
    kijunPeriod: 26,
    senkouBPeriod: 52,
    displacement: 26,
    tenkanColor: uiColor.info,
    kijunColor: uiColor.warn,
    senkouAColor: uiColor.buy,
    senkouBColor: uiColor.sell,
    chikouColor: uiColor.special,
    lineWidth: 1.2,
    showLastValueLabel: false,
    showPlotLabel: true,
  }),
  settingsSchema: { sections: [
    { title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [
      { kind: "number", key: "tenkanPeriod", label: "Tenkan", labelKey: "indicator.ichimoku.tenkanPeriod", min: 1, max: 200, step: 1, requiresRecalc: true },
      { kind: "number", key: "kijunPeriod", label: "Kijun", labelKey: "indicator.ichimoku.kijunPeriod", min: 1, max: 300, step: 1, requiresRecalc: true },
      { kind: "number", key: "senkouBPeriod", label: "Senkou B", labelKey: "indicator.ichimoku.senkouBPeriod", min: 1, max: 500, step: 1, requiresRecalc: true },
      { kind: "number", key: "displacement", label: "Displacement", labelKey: "indicator.ichimoku.displacement", min: 0, max: 200, step: 1, requiresRecalc: true },
    ] },
    { title: "Style", titleKey: "indicator.common.section.style", fields: [
      { kind: "color", key: "tenkanColor", label: "Tenkan Color", labelKey: "indicator.ichimoku.tenkanColor" },
      { kind: "color", key: "kijunColor", label: "Kijun Color", labelKey: "indicator.ichimoku.kijunColor" },
      { kind: "color", key: "senkouAColor", label: "Senkou A Color", labelKey: "indicator.ichimoku.senkouAColor" },
      { kind: "color", key: "senkouBColor", label: "Senkou B Color", labelKey: "indicator.ichimoku.senkouBColor" },
      { kind: "color", key: "chikouColor", label: "Chikou Color", labelKey: "indicator.ichimoku.chikouColor" },
      ...overlayAppearanceFields(),
    ] },
  ] },
  getHeaderLabel: ({ settings }) => settings.showPlotLabel === false ? "" : "Ichimoku",
  prepareCache: "series-range", prepareData: prepareIchimoku,
  drawPriceOverlay: drawIchimoku,
};

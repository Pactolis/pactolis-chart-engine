import type { IndicatorDefinition, IndicatorDrawContext, IndicatorPreparedData, IndicatorSettings } from "../types.js";
import { ichimoku, rollingMax, rollingMin, seriesOhlcv } from "../../../core/analysis/calc/ta.js";
import { windowExtreme } from "../../../core/analysis/calc/tailState.js";
import { resolveIncremental, type IncrementalBase } from "./incrementalSeries.js";
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

interface IchimokuState extends IncrementalBase {
  tenkan: Array<number | null>; kijun: Array<number | null>; senkouA: Array<number | null>; senkouB: Array<number | null>; chikou: Array<number | null>;
  baseA: Array<number | null>; baseB: Array<number | null>;
}
const midpoint = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : (a + b) / 2);

/**
 * Cached per-index outputs. A tail change at index t only alters the undisplaced values at
 * t, which land in: tenkan/kijun[t], senkouA/B[t + displacement] (inside the series only when
 * displacement is 0) and chikou[t - displacement]. min/max have no float history, so every
 * one of these equals the full computation exactly.
 */
function prepareIchimoku(ctx: IndicatorDrawContext<IchimokuSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const tenkanPeriod = numericSetting(ctx.settings, "tenkanPeriod", 9, 1, 200);
  const kijunPeriod = numericSetting(ctx.settings, "kijunPeriod", 26, 1, 300);
  const senkouBPeriod = numericSetting(ctx.settings, "senkouBPeriod", 52, 1, 500);
  const displacement = numericSetting(ctx.settings, "displacement", 26, 0, 200);
  const state = resolveIncremental<IchimokuState>("ichimoku", ctx, `${tenkanPeriod}|${kijunPeriod}|${senkouBPeriod}|${displacement}`, () => {
    const rows = seriesOhlcv(ctx.series);
    const values = ichimoku(rows, tenkanPeriod, kijunPeriod, senkouBPeriod, displacement);
    const bHigh = rollingMax(rows.map((bar) => bar.high), senkouBPeriod);
    const bLow = rollingMin(rows.map((bar) => bar.low), senkouBPeriod);
    return {
      tenkan: values.map((p) => p.tenkan), kijun: values.map((p) => p.kijun), senkouA: values.map((p) => p.senkouA), senkouB: values.map((p) => p.senkouB), chikou: values.map((p) => p.chikou),
      baseA: values.map((p) => (p.tenkan !== null && p.kijun !== null ? (p.tenkan + p.kijun) / 2 : null)),
      baseB: values.map((_, i) => midpoint(bHigh[i], bLow[i])),
    };
  }, (cached) => {
    const t = bars.length - 1;
    const hi = (i: number) => bars[i].high; const lo = (i: number) => bars[i].low;
    const tenkan = midpoint(windowExtreme(hi, t, tenkanPeriod, "max"), windowExtreme(lo, t, tenkanPeriod, "min"));
    const kijun = midpoint(windowExtreme(hi, t, kijunPeriod, "max"), windowExtreme(lo, t, kijunPeriod, "min"));
    cached.tenkan[t] = tenkan; cached.kijun[t] = kijun;
    cached.baseA[t] = tenkan !== null && kijun !== null ? (tenkan + kijun) / 2 : null;
    cached.baseB[t] = midpoint(windowExtreme(hi, t, senkouBPeriod, "max"), windowExtreme(lo, t, senkouBPeriod, "min"));
    const refresh = (i: number): void => {
      if (i < 0 || i > t) return;
      cached.senkouA[i] = cached.baseA[i - displacement] ?? null;
      cached.senkouB[i] = cached.baseB[i - displacement] ?? null;
      cached.chikou[i] = bars[i + displacement]?.close ?? null;
    };
    refresh(t);
    if (Number.isInteger(displacement)) refresh(t - displacement);
    return true;
  });
  const series: PlotSeries[] = [
    { key: "tenkan", label: "Tenkan", color: stringSetting(ctx.settings, "tenkanColor", uiColor.info), points: makeOverlayPoints(state.tenkan, bars, start, end) },
    { key: "kijun", label: "Kijun", color: stringSetting(ctx.settings, "kijunColor", uiColor.warn), points: makeOverlayPoints(state.kijun, bars, start, end) },
    { key: "senkouA", label: "Senkou A", color: stringSetting(ctx.settings, "senkouAColor", uiColor.buy), points: makeOverlayPoints(state.senkouA, bars, start, end) },
    { key: "senkouB", label: "Senkou B", color: stringSetting(ctx.settings, "senkouBColor", uiColor.sell), points: makeOverlayPoints(state.senkouB, bars, start, end) },
    { key: "chikou", label: "Chikou", color: stringSetting(ctx.settings, "chikouColor", uiColor.special), points: makeOverlayPoints(state.chikou, bars, start, end) },
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

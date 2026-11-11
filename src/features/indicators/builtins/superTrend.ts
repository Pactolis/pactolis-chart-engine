import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { seriesOhlcv, superTrend } from "../../../core/analysis/calc/ta.js";
import { superTrendBeforeLast, superTrendStep, wilderAdvance, wilderFull, type SuperTrendState, type WilderState } from "../../../core/analysis/calc/tailState.js";
import { resolveIncremental, type IncrementalBase } from "./incrementalSeries.js";
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

interface SuperTrendCache extends IncrementalBase { tr: number[]; atrPrevNull: boolean; up: Array<number | null>; down: Array<number | null>; trB: WilderState | null; st: SuperTrendState }
function prepareSuperTrend(ctx: IndicatorDrawContext<SuperTrendSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const period = numericSetting(ctx.settings, "period", 10, 1, 200);
  const multiplier = numericSetting(ctx.settings, "multiplier", 3, 0.1, 20);
  const state = resolveIncremental<SuperTrendCache>("superTrend", ctx, `${period}|${multiplier}`, () => {
    const rows = seriesOhlcv(ctx.series);
    const st = superTrend(rows, period, multiplier);
    const tr = bars.map((bar, i) => { const pc = i > 0 ? bars[i - 1].close : bar.close; return Math.max(bar.high - bar.low, Math.abs(bar.high - pc), Math.abs(bar.low - pc)); });
    const atr = wilderFull(tr, period);
    return {
      tr, atrPrevNull: bars.length < 2 ? true : atr.out[bars.length - 2] === null,
      up: st.map((point) => point.direction === 1 ? point.trend : null), down: st.map((point) => point.direction === -1 ? point.trend : null),
      trB: atr.before, st: superTrendBeforeLast(bars, atr.out, multiplier),
    };
  }, (cached) => {
    const tail = bars.length - 1;
    if (tail < 1 || !cached.trB) return false;
    const bar = bars[tail]; const pc = bars[tail - 1].close;
    cached.tr[tail] = Math.max(bar.high - bar.low, Math.abs(bar.high - pc), Math.abs(bar.low - pc));
    const range = wilderAdvance(cached.tr, period, cached.trB);
    const point = superTrendStep({ ...cached.st }, tail, bar, pc, range, cached.atrPrevNull, multiplier);
    cached.up[tail] = point.direction === 1 ? point.trend : null;
    cached.down[tail] = point.direction === -1 ? point.trend : null;
    return true;
  });
  const series: PlotSeries[] = [
    { key: "up", label: "ST ↑", color: stringSetting(ctx.settings, "upColor", uiColor.buy), points: makeOverlayPoints(state.up, bars, start, end) },
    { key: "down", label: "ST ↓", color: stringSetting(ctx.settings, "downColor", uiColor.sell), points: makeOverlayPoints(state.down, bars, start, end) },
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

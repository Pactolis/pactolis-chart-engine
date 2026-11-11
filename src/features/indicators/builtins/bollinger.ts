import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { bollingerBands, seriesOhlcv } from "../../../core/analysis/calc/ta.js";
import { windowSumAdvance, windowSumFull, type WindowSumState } from "../../../core/analysis/calc/tailState.js";
import { resolveIncremental, type IncrementalBase } from "./incrementalSeries.js";
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

interface BollingerState extends IncrementalBase {
  period: number;
  multiplier: number;
  closes: number[];
  upper: Array<number | null>;
  middle: Array<number | null>;
  lower: Array<number | null>;
  before: WindowSumState | null;
}

/** Population stddev of the last `n` closes: the same arithmetic as the final step of rollingStdDev. */
function tailStdDev(closes: readonly number[], n: number): number | null {
  const last = closes.length - 1;
  if (last + 1 < n) return null;
  const window: number[] = [];
  for (let k = last + 1 - n; k <= last; k++) window.push(Number.isFinite(closes[k]) ? closes[k] : NaN);
  if (!window.every(Number.isFinite)) return null;
  const mean = window.reduce((sum, item) => sum + item, 0) / n;
  const variance = window.reduce((sum, item) => sum + (item - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

function prepareBollinger(ctx: IndicatorDrawContext<BollingerSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const period = numericSetting(ctx.settings, "period", 20, 1, 500);
  const multiplier = numericSetting(ctx.settings, "multiplier", 2, 0.1, 10);
  const state = resolveIncremental<BollingerState>("bollinger", ctx, `${period}|${multiplier}`, () => {
    const points = bollingerBands(seriesOhlcv(ctx.series), period, multiplier);
    const closes = bars.map((bar) => bar.close);
    return { period, multiplier, closes, upper: points.map((p) => p.upper), middle: points.map((p) => p.middle), lower: points.map((p) => p.lower), before: windowSumFull(closes, period).before };
  }, (cached) => {
    const tail = bars.length - 1;
    if (!cached.before) return false;
    cached.closes[tail] = bars[tail].close;
    const n = Math.max(1, Math.floor(period));
    const sum = windowSumAdvance(cached.closes, period, cached.before);
    const mid = sum === null ? null : sum / n;
    const sd = tailStdDev(cached.closes, n);
    const spread = mid !== null && sd !== null ? sd * multiplier : null;
    cached.middle[tail] = mid;
    cached.upper[tail] = spread === null || mid === null ? null : mid + spread;
    cached.lower[tail] = spread === null || mid === null ? null : mid - spread;
    return true;
  });
  const series: PlotSeries[] = [
    { key: "upper", label: "BB U", color: stringSetting(ctx.settings, "bandColor", uiColor.info), points: makeOverlayPoints(state.upper, bars, start, end) },
    { key: "middle", label: "BB M", color: stringSetting(ctx.settings, "basisColor", bollingerBasisColorDefault), points: makeOverlayPoints(state.middle, bars, start, end) },
    { key: "lower", label: "BB L", color: stringSetting(ctx.settings, "bandColor", uiColor.info), points: makeOverlayPoints(state.lower, bars, start, end) },
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

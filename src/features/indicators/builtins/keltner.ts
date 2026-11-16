import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { averageTrueRange, exponentialMovingAverage, seriesOhlcv, trueRange } from "../../../core/analysis/calc/ta.js";
import { wilderAdvance, wilderFull, type WilderState } from "../../../core/analysis/calc/tailState.js";
import { resolveIncremental, type IncrementalBase } from "./incrementalSeries.js";
import { drawPriceOverlayLines, makeOverlayPoints, overlayAppearanceFields, prepareOverlayData } from "./priceOverlayShared.js";
import { numericSetting, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor, bollingerBasisColorDefault } from "../../../core/ui/seriesPalette.js";

export interface KeltnerSettings extends IndicatorSettings {
  emaPeriod: number;
  atrPeriod: number;
  multiplier: number;
  basisColor: string;
  bandColor: string;
  lineWidth: number;
  showLastValueLabel: boolean;
  showPlotLabel: boolean;
}

interface KeltnerState extends IncrementalBase {
  middle: Array<number | null>;
  upper: Array<number | null>;
  lower: Array<number | null>;
  ranges: number[];
  emaBefore: number | null;
  emaSeedSum: number;
  emaSeedCount: number;
  atrBefore: WilderState | null;
}

function prepareKeltner(ctx: IndicatorDrawContext<KeltnerSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const emaPeriod = Math.floor(numericSetting(ctx.settings, "emaPeriod", 20, 1, 500));
  const atrPeriod = Math.floor(numericSetting(ctx.settings, "atrPeriod", 10, 1, 500));
  const multiplier = numericSetting(ctx.settings, "multiplier", 2, 0.1, 10);
  const warmup = Math.max(emaPeriod, atrPeriod);
  const state = resolveIncremental<KeltnerState>("keltner", ctx, `${emaPeriod}|${atrPeriod}|${multiplier}`, () => {
    const rows = seriesOhlcv(ctx.series);
    const closes = rows.map((bar) => bar.close);
    const ema = exponentialMovingAverage(closes, emaPeriod);
    const atr = averageTrueRange(rows, atrPeriod);
    const ranges = trueRange(rows);
    let emaSeedSum = 0;
    let emaSeedCount = 0;
    // Saved state is before the mutable final bar, including short/invalid seeds.
    for (let i = 0; i < closes.length - 1; i++) {
      if (Number.isFinite(closes[i]) && emaSeedCount < emaPeriod) { emaSeedSum += closes[i]; emaSeedCount++; }
    }
    let emaBefore: number | null = null;
    for (let i = ema.length - 2; i >= 0; i--) {
      if (ema[i] !== null) { emaBefore = ema[i]; break; }
    }
    const middle = ema.map((value, i) => i < warmup || atr[i] === null ? null : value);
    const upper = middle.map((value, i) => value === null ? null : value + multiplier * atr[i]!);
    const lower = middle.map((value, i) => value === null ? null : value - multiplier * atr[i]!);
    return { middle, upper, lower, ranges, emaBefore,
      emaSeedSum, emaSeedCount, atrBefore: wilderFull(ranges, atrPeriod).before };
  }, (cached) => {
    const tail = bars.length - 1;
    if (!cached.atrBefore) return false;
    // trueRange on at most two rows gives exactly the same final true range.
    const rows = seriesOhlcv(ctx.series);
    cached.ranges[tail] = trueRange(tail > 0 ? [rows[tail - 1], rows[tail]] : [rows[tail]]).at(-1)!;
    const atr = wilderAdvance(cached.ranges, atrPeriod, cached.atrBefore);
    const close = bars[tail].close;
    const alpha = 2 / (emaPeriod + 1);
    const ema = !Number.isFinite(close) ? null : cached.emaBefore !== null
      ? close * alpha + cached.emaBefore * (1 - alpha)
      : cached.emaSeedCount + 1 === emaPeriod ? (cached.emaSeedSum + close) / emaPeriod : null;
    const middle = tail < warmup || atr === null ? null : ema;
    cached.middle[tail] = middle;
    cached.upper[tail] = middle === null || atr === null ? null : middle + multiplier * atr;
    cached.lower[tail] = middle === null || atr === null ? null : middle - multiplier * atr;
    return true;
  });
  const series: PlotSeries[] = [
    { key: "upper", label: "KC U", color: stringSetting(ctx.settings, "bandColor", uiColor.info), points: makeOverlayPoints(state.upper, bars, start, end) },
    { key: "middle", label: "KC M", color: stringSetting(ctx.settings, "basisColor", bollingerBasisColorDefault), points: makeOverlayPoints(state.middle, bars, start, end) },
    { key: "lower", label: "KC L", color: stringSetting(ctx.settings, "bandColor", uiColor.info), points: makeOverlayPoints(state.lower, bars, start, end) },
  ];
  return prepareOverlayData(ctx, series);
}

export const keltnerIndicatorDefinition: IndicatorDefinition<KeltnerSettings> = {
  type: "keltner-channels", name: "Keltner Channels", category: "custom", group: "Volatilite/Bant",
  defaultPane: "overlay", canOverlay: true, defaultPlacement: "price-overlay", supportedPlacements: ["price-overlay"], paneHeight: 0,
  defaultSettings: () => ({ emaPeriod: 20, atrPeriod: 10, multiplier: 2, basisColor: bollingerBasisColorDefault,
    bandColor: uiColor.info, lineWidth: 1.3, showLastValueLabel: true, showPlotLabel: true }),
  settingsSchema: { sections: [
    { title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [
      { kind: "number", key: "emaPeriod", label: "EMA Period", min: 1, max: 500, step: 1, requiresRecalc: true },
      { kind: "number", key: "atrPeriod", label: "ATR Period (Wilder)", min: 1, max: 500, step: 1, requiresRecalc: true },
      { kind: "number", key: "multiplier", label: "ATR Multiplier", min: 0.1, max: 10, step: 0.1, requiresRecalc: true },
    ] },
    { title: "Style", titleKey: "indicator.common.section.style", fields: [
      { kind: "color", key: "basisColor", label: "Basis Color", labelKey: "indicator.bollinger.basisColor" },
      { kind: "color", key: "bandColor", label: "Band Color", labelKey: "indicator.bollinger.bandColor" }, ...overlayAppearanceFields(),
    ] },
  ] },
  getHeaderLabel: ({ settings }) => settings.showPlotLabel === false ? "" : `KC ${settings.emaPeriod ?? 20}/${settings.atrPeriod ?? 10}×${settings.multiplier ?? 2}`,
  prepareCache: "series-range", prepareData: prepareKeltner, drawPriceOverlay: drawPriceOverlayLines,
};

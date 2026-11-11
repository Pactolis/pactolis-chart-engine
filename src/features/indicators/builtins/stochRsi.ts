import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { rollingMax, rollingMin, rsi, seriesOhlcv, stochasticRsi } from "../../../core/analysis/calc/ta.js";
import { windowSumAdvance, windowSumFull, wilderAdvance, wilderFull, type WilderState, type WindowSumState } from "../../../core/analysis/calc/tailState.js";
import { resolveIncremental, type IncrementalBase } from "./incrementalSeries.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";

export interface StochRsiSettings extends IndicatorSettings { period: number; kPeriod: number; dPeriod: number; kColor: string; dColor: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
interface StochRsiState extends IncrementalBase {
  gains: number[]; losses: number[]; rsiVals: number[]; stoch: number[]; kIn: number[];
  k: Array<number | null>; d: Array<number | null>;
  gB: WilderState | null; lB: WilderState | null; kB: WindowSumState | null; dB: WindowSumState | null;
}
function rsiFrom(gain: number | null, loss: number | null): number | null {
  if (gain === null || loss === null) return null;
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
function prepareStochRsi(ctx: IndicatorDrawContext<StochRsiSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const period = numericSetting(ctx.settings, "period", 14, 1, 200);
  const kPeriod = numericSetting(ctx.settings, "kPeriod", 3, 1, 50);
  const dPeriod = numericSetting(ctx.settings, "dPeriod", 3, 1, 50);
  const state = resolveIncremental<StochRsiState>("stochRsi", ctx, `${period}|${kPeriod}|${dPeriod}`, () => {
    const rows = seriesOhlcv(ctx.series);
    const values = stochasticRsi(rows, period, kPeriod, dPeriod);
    const gains: number[] = [NaN]; const losses: number[] = [NaN];
    for (let i = 1; i < bars.length; i++) { const diff = bars[i].close - bars[i - 1].close; gains.push(Math.max(0, diff)); losses.push(Math.max(0, -diff)); }
    const rsiVals = rsi(rows, period).map((point) => point.value ?? NaN);
    const lows = rollingMin(rsiVals, period); const highs = rollingMax(rsiVals, period);
    const stoch = rsiVals.map((value, index) => { const low = lows[index]; const high = highs[index]; return low === null || high === null || !Number.isFinite(value) || high === low ? NaN : ((value - low) / (high - low)) * 100; });
    const kIn = values.map((point) => point.k ?? NaN);
    return { gains, losses, rsiVals, stoch, kIn, k: values.map((p) => p.k), d: values.map((p) => p.d), gB: wilderFull(gains, period).before, lB: wilderFull(losses, period).before, kB: windowSumFull(stoch, kPeriod).before, dB: windowSumFull(kIn, dPeriod).before };
  }, (cached) => {
    const tail = bars.length - 1;
    if (tail < 1 || !cached.gB || !cached.lB || !cached.kB || !cached.dB) return false;
    const diff = bars[tail].close - bars[tail - 1].close;
    cached.gains[tail] = Math.max(0, diff); cached.losses[tail] = Math.max(0, -diff);
    cached.rsiVals[tail] = rsiFrom(wilderAdvance(cached.gains, period, cached.gB), wilderAdvance(cached.losses, period, cached.lB)) ?? NaN;
    const n = Math.max(1, Math.floor(period));
    let low: number | null = null; let high: number | null = null;
    if (tail + 1 >= n) {
      let lo = Infinity; let hi = -Infinity; let ok = true;
      for (let k = tail + 1 - n; k <= tail; k++) { const v = cached.rsiVals[k]; if (!Number.isFinite(v)) { ok = false; break; } if (v < lo) lo = v; if (v > hi) hi = v; }
      if (ok) { low = lo; high = hi; }
    }
    const value = cached.rsiVals[tail];
    cached.stoch[tail] = low === null || high === null || !Number.isFinite(value) || high === low ? NaN : ((value - low) / (high - low)) * 100;
    const kSum = windowSumAdvance(cached.stoch, kPeriod, cached.kB);
    const kValue = kSum === null ? null : kSum / Math.max(1, Math.floor(kPeriod));
    cached.k[tail] = kValue; cached.kIn[tail] = kValue ?? NaN;
    const dSum = windowSumAdvance(cached.kIn, dPeriod, cached.dB);
    cached.d[tail] = dSum === null ? null : dSum / Math.max(1, Math.floor(dPeriod));
    return true;
  });
  const series: PlotSeries[] = [
    { key: "k", label: "%K", color: stringSetting(ctx.settings, "kColor", uiColor.info), points: makeSeriesPoints(state.k, bars, start, end) },
    { key: "d", label: "%D", color: stringSetting(ctx.settings, "dColor", uiColor.warn), points: makeSeriesPoints(state.d, bars, start, end) },
  ];
  return prepareMultiSeries(ctx, series, { scaleMode: "percent", baseline: 50, horizontalLevels: [{ value: 80, label: "OB" }, { value: 20, label: "OS" }], axisTicks: [80, 50, 20], fixedRange: { min: 0, max: 100 } });
}
export const stochRsiIndicatorDefinition: IndicatorDefinition<StochRsiSettings> = {
  type: "stoch-rsi", name: "StochRSI", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 112,
  defaultSettings: () => defaultPaneSettings({ period: 14, kPeriod: 3, dPeriod: 3, kColor: uiColor.info, dColor: uiColor.warn }) as StochRsiSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "RSI/Stoch Period", labelKey: "indicator.stochRsi.period", min: 1, max: 200, step: 1, requiresRecalc: true }, { kind: "number", key: "kPeriod", label: "%K Smoothing", labelKey: "indicator.stochRsi.kPeriod", min: 1, max: 50, step: 1, requiresRecalc: true }, { kind: "number", key: "dPeriod", label: "%D Smoothing", labelKey: "indicator.stochRsi.dPeriod", min: 1, max: 50, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "kColor", label: "%K Color", labelKey: "indicator.stochRsi.kColor" }, { kind: "color", key: "dColor", label: "%D Color", labelKey: "indicator.stochRsi.dColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("StochRSI"), prepareCache: "series-range", prepareData: prepareStochRsi, drawSubPane: drawMultiSeries,
};

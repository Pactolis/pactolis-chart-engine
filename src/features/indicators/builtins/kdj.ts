import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { kdj, rollingMax, rollingMin, seriesOhlcv } from "../../../core/analysis/calc/ta.js";
import { wilderAdvance, wilderFull, type WilderState } from "../../../core/analysis/calc/tailState.js";
import { resolveIncremental, type IncrementalBase } from "./incrementalSeries.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";

// core/analysis/calc/ta.ts's kdj() now smooths RSV with the standard alpha = 1/n (Wilder
// smoothing) instead of EMA's alpha = 2/(n+1) -- with the kSmoothing/dSmoothing default of
// 3 below, plotted K/D/J values differ from the previous release (they react ~1.5x slower,
// matching every other platform's KDJ instead of running ahead of it).
export interface KdjSettings extends IndicatorSettings { period: number; kSmoothing: number; dSmoothing: number; kColor: string; dColor: string; jColor: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
interface KdjState extends IncrementalBase { rsv: number[]; kIn: number[]; k: Array<number | null>; d: Array<number | null>; j: Array<number | null>; kBefore: WilderState | null; dBefore: WilderState | null }
/** Min/max of the last `n` values with rollingMin/rollingMax semantics (null if the window holds a non-finite value). */
function windowExtreme(valueAt: (index: number) => number, last: number, n: number, pick: "min" | "max"): number | null {
  if (last + 1 < n) return null;
  let result = pick === "min" ? Infinity : -Infinity;
  for (let k = last + 1 - n; k <= last; k++) {
    const v = valueAt(k);
    if (!Number.isFinite(v)) return null;
    if (pick === "min" ? v < result : v > result) result = v;
  }
  return result;
}
function prepareKdj(ctx: IndicatorDrawContext<KdjSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const period = numericSetting(ctx.settings, "period", 9, 1, 200);
  const kSmoothing = numericSetting(ctx.settings, "kSmoothing", 3, 1, 50);
  const dSmoothing = numericSetting(ctx.settings, "dSmoothing", 3, 1, 50);
  const state = resolveIncremental<KdjState>("kdj", ctx, `${period}|${kSmoothing}|${dSmoothing}`, () => {
    const rows = seriesOhlcv(ctx.series);
    const values = kdj(rows, period, kSmoothing, dSmoothing);
    const lows = rollingMin(rows.map((bar) => bar.low), period);
    const highs = rollingMax(rows.map((bar) => bar.high), period);
    const rsv = rows.map((bar, index) => {
      const low = lows[index]; const high = highs[index];
      return low === null || high === null || high === low ? NaN : ((bar.close - low) / (high - low)) * 100;
    });
    const kFull = wilderFull(rsv, kSmoothing);
    const kIn = kFull.out.map((value) => value ?? NaN);
    return { rsv, kIn, k: values.map((point) => point.k), d: values.map((point) => point.d), j: values.map((point) => point.j), kBefore: kFull.before, dBefore: wilderFull(kIn, dSmoothing).before };
  }, (cached) => {
    const tail = bars.length - 1;
    if (!cached.kBefore || !cached.dBefore) return false;
    const n = Math.max(1, Math.floor(period));
    const low = windowExtreme((i) => bars[i].low, tail, n, "min");
    const high = windowExtreme((i) => bars[i].high, tail, n, "max");
    cached.rsv[tail] = low === null || high === null || high === low ? NaN : ((bars[tail].close - low) / (high - low)) * 100;
    const kValue = wilderAdvance(cached.rsv, kSmoothing, cached.kBefore);
    cached.kIn[tail] = kValue ?? NaN;
    const dValue = wilderAdvance(cached.kIn, dSmoothing, cached.dBefore);
    cached.k[tail] = kValue;
    cached.d[tail] = dValue;
    cached.j[tail] = kValue !== null && dValue !== null ? 3 * kValue - 2 * dValue : null;
    return true;
  });
  const series: PlotSeries[] = [
    { key: "k", label: "K", color: stringSetting(ctx.settings, "kColor", uiColor.info), points: makeSeriesPoints(state.k, bars, start, end) },
    { key: "d", label: "D", color: stringSetting(ctx.settings, "dColor", uiColor.warn), points: makeSeriesPoints(state.d, bars, start, end) },
    { key: "j", label: "J", color: stringSetting(ctx.settings, "jColor", uiColor.sell), points: makeSeriesPoints(state.j, bars, start, end) },
  ];
  return prepareMultiSeries(ctx, series, { scaleMode: "percent", baseline: 50, horizontalLevels: [{ value: 80, label: "OB" }, { value: 20, label: "OS" }] });
}
export const kdjIndicatorDefinition: IndicatorDefinition<KdjSettings> = {
  type: "kdj", name: "KDJ", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 112,
  defaultSettings: () => defaultPaneSettings({ period: 9, kSmoothing: 3, dSmoothing: 3, kColor: uiColor.info, dColor: uiColor.warn, jColor: uiColor.sell }) as KdjSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "Period", labelKey: "indicator.common.period", min: 1, max: 200, step: 1, requiresRecalc: true }, { kind: "number", key: "kSmoothing", label: "K Smoothing", labelKey: "indicator.kdj.kSmoothing", min: 1, max: 50, step: 1, requiresRecalc: true }, { kind: "number", key: "dSmoothing", label: "D Smoothing", labelKey: "indicator.kdj.dSmoothing", min: 1, max: 50, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "kColor", label: "K Color", labelKey: "indicator.kdj.kColor" }, { kind: "color", key: "dColor", label: "D Color", labelKey: "indicator.kdj.dColor" }, { kind: "color", key: "jColor", label: "J Color", labelKey: "indicator.kdj.jColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("KDJ"), prepareCache: "series-range", prepareData: prepareKdj, drawSubPane: drawMultiSeries,
};

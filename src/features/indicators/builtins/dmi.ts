import type { IndicatorDefinition, IndicatorDrawContext, IndicatorPreparedData, IndicatorSettings } from "../types.js";
import { seriesOhlcv, dmi } from "../../../core/analysis/calc/ta.js";
import { wilderAdvance, wilderFull, type WilderState } from "../../../core/analysis/calc/tailState.js";
import { resolveIncremental, type IncrementalBase } from "./incrementalSeries.js";
import { defaultPaneSettings, drawMultiSeries, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";

export interface DmiSettings extends IndicatorSettings { period: number; adxPeriod: number; plusColor: string; minusColor: string; adxColor: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
interface DmiState extends IncrementalBase {
  tr: number[]; plusDm: number[]; minusDm: number[]; dx: number[];
  plusDi: Array<number | null>; minusDi: Array<number | null>; adx: Array<number | null>;
  trB: WilderState | null; plusB: WilderState | null; minusB: WilderState | null; adxB: WilderState | null;
}
type DmiBars = ReturnType<IndicatorDrawContext<DmiSettings>["series"]["listReadonly"]>;
function dmiInputs(bars: DmiBars, i: number): { tr: number; plus: number; minus: number } {
  const bar = bars[i]; const prev = bars[i - 1];
  const upMove = bar.high - prev.high;
  const downMove = prev.low - bar.low;
  return {
    tr: Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)),
    plus: upMove > downMove && upMove > 0 ? upMove : 0,
    minus: downMove > upMove && downMove > 0 ? downMove : 0,
  };
}
function dmiDx(tr: number | null, plusS: number | null, minusS: number | null): number {
  const plus = tr && plusS !== null ? 100 * plusS / tr : null;
  const minus = tr && minusS !== null ? 100 * minusS / tr : null;
  if (plus === null || minus === null || plus + minus === 0) return NaN;
  return 100 * Math.abs(plus - minus) / (plus + minus);
}
function prepareDmi(ctx: IndicatorDrawContext<DmiSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const period = numericSetting(ctx.settings, "period", 14, 1, 200);
  const adxPeriod = numericSetting(ctx.settings, "adxPeriod", 14, 1, 200);
  const state = resolveIncremental<DmiState>("dmi", ctx, `${period}|${adxPeriod}`, () => {
    const b0 = bars[0]; const tr: number[] = [Math.max(b0.high - b0.low, Math.abs(b0.high - b0.close), Math.abs(b0.low - b0.close))]; const plusDm: number[] = [0]; const minusDm: number[] = [0];
    for (let i = 1; i < bars.length; i++) { const x = dmiInputs(bars, i); tr.push(x.tr); plusDm.push(x.plus); minusDm.push(x.minus); }
    const values = dmi(seriesOhlcv(ctx.series), period, adxPeriod);
    const trS = wilderFull(tr, period); const pS = wilderFull(plusDm, period); const mS = wilderFull(minusDm, period);
    const dx = bars.map((_, i) => dmiDx(trS.out[i], pS.out[i], mS.out[i]));
    return { tr, plusDm, minusDm, dx, plusDi: values.map((p) => p.plusDi), minusDi: values.map((p) => p.minusDi), adx: values.map((p) => p.adx), trB: trS.before, plusB: pS.before, minusB: mS.before, adxB: wilderFull(dx, adxPeriod).before };
  }, (cached) => {
    const tail = bars.length - 1;
    if (tail < 1 || !cached.trB || !cached.plusB || !cached.minusB || !cached.adxB) return false;
    const x = dmiInputs(bars, tail);
    cached.tr[tail] = x.tr; cached.plusDm[tail] = x.plus; cached.minusDm[tail] = x.minus;
    const trS = wilderAdvance(cached.tr, period, cached.trB);
    const pS = wilderAdvance(cached.plusDm, period, cached.plusB);
    const mS = wilderAdvance(cached.minusDm, period, cached.minusB);
    cached.dx[tail] = dmiDx(trS, pS, mS);
    cached.plusDi[tail] = trS && pS !== null ? 100 * pS / trS : null;
    cached.minusDi[tail] = trS && mS !== null ? 100 * mS / trS : null;
    cached.adx[tail] = wilderAdvance(cached.dx, adxPeriod, cached.adxB);
    return true;
  });
  const series: PlotSeries[] = [
    { key: "plus", label: "+DI", color: stringSetting(ctx.settings, "plusColor", uiColor.buy), points: makeSeriesPoints(state.plusDi, bars, start, end) },
    { key: "minus", label: "-DI", color: stringSetting(ctx.settings, "minusColor", uiColor.sell), points: makeSeriesPoints(state.minusDi, bars, start, end) },
    { key: "adx", label: "ADX", color: stringSetting(ctx.settings, "adxColor", uiColor.warn), points: makeSeriesPoints(state.adx, bars, start, end) },
  ];
  return prepareMultiSeries(ctx, series, { scaleMode: "percent", baseline: 20, horizontalLevels: [{ value: 20, label: "20" }, { value: 40, label: "40" }] });
}

function drawDmiPane(ctx: IndicatorDrawContext<DmiSettings>, prepared?: IndicatorPreparedData): void {
  drawMultiSeries(ctx, prepared);
  const items = [
    { label: "+DI", color: stringSetting(ctx.settings, "plusColor", uiColor.buy) },
    { label: "−DI", color: stringSetting(ctx.settings, "minusColor", uiColor.sell) },
    { label: "ADX", color: stringSetting(ctx.settings, "adxColor", uiColor.warn) },
  ];
  const canvas = ctx.ctx;
  canvas.save();
  canvas.font = "11px ui-monospace, monospace";
  canvas.textBaseline = "middle";
  let x = ctx.view.area.left + 8;
  const y = ctx.rect.top + 36;
  for (const item of items) {
    canvas.fillStyle = item.color;
    canvas.fillText(item.label, x, y);
    x += canvas.measureText(item.label).width + 14;
  }
  canvas.restore();
}
export const dmiIndicatorDefinition: IndicatorDefinition<DmiSettings> = {
  type: "dmi", name: "DMI + ADX", category: "custom", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 124,
  defaultSettings: () => defaultPaneSettings({ period: 14, adxPeriod: 14, plusColor: uiColor.buy, minusColor: uiColor.sell, adxColor: uiColor.warn }) as DmiSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "number", key: "period", label: "DI Period", labelKey: "indicator.dmi.period", min: 1, max: 200, step: 1, requiresRecalc: true }, { kind: "number", key: "adxPeriod", label: "ADX Period", labelKey: "indicator.dmi.adxPeriod", min: 1, max: 200, step: 1, requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "plusColor", label: "+DI Color", labelKey: "indicator.dmi.plusColor" }, { kind: "color", key: "minusColor", label: "-DI Color", labelKey: "indicator.dmi.minusColor" }, { kind: "color", key: "adxColor", label: "ADX Color", labelKey: "indicator.dmi.adxColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("DMI + ADX"), prepareCache: "series-range", prepareData: prepareDmi, drawSubPane: drawDmiPane,
};

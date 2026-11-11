import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import { simpleMovingAverageAdvance, simpleMovingAverageWithState, volumeSeries, type SmaState } from "../../../core/analysis/calc/ta.js";
import { compactNumber } from "../render/indicatorPaneUi.js";
import { parseMarket } from "../../../core/domain/market.js";
import { incrementPerformanceCounter } from "../../../core/performanceTelemetry.js";
import type { FootprintBar } from "../../../core/types.js";
import type { FootprintSeries } from "../../../core/model/footprint.js";
import { quoteVolumeForBar } from "../../../core/model/footprintCellMetrics.js";
// Canvas defaults mirror theme.ts semantic tokens; kept Node-safe for registry tests.
const VOLUME_COLORS = { buy: `#${"3fe0a0"}`, sell: `#${"e06c75"}`, info: `#${"38bdf8"}`, ma: `#${"eef2fb"}` } as const;
import { defaultPaneSettings, drawMultiSeries, makeNumberPoints, makeSeriesPoints, numericSetting, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";

export interface VolumeSettings extends IndicatorSettings { maPeriod: number; showMa: boolean; deltaColored: boolean; upColor: string; downColor: string; maColor: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }
/**
 * Volume MA values per series + instance. simpleMovingAverage carries a compensated running
 * sum from bar 0, so a windowed recompute would round differently; instead the full array and
 * the rolling state before the tail are kept, and a live tail tick re-runs only the last index
 * from that state (bit-identical to the full recompute). Anything that is not a pure tail
 * change (structure / non-tail revision, period, length) falls back to the full computation.
 */
interface VolumeMaState { period: number; length: number; structureRevision: number; nonTailRevision: number; seriesRevision: number; volumes: number[]; ma: Array<number | null>; beforeLast: SmaState | null }
const volumeMaStates = new WeakMap<FootprintSeries, Map<string, VolumeMaState>>();

function volumeMovingAverage(ctx: IndicatorDrawContext<VolumeSettings>, bars: readonly FootprintBar[], period: number): Array<number | null> {
  const { series } = ctx;
  let perSeries = volumeMaStates.get(series);
  if (!perSeries) { perSeries = new Map(); volumeMaStates.set(series, perSeries); }
  const cached = perSeries.get(ctx.instance.id);
  const tail = bars.length - 1;
  if (cached && cached.period === period && cached.length === bars.length && cached.structureRevision === series.structureRevision && cached.nonTailRevision === series.nonTailRevision && cached.beforeLast !== null) {
    if (cached.seriesRevision === series.revision) return cached.ma;
    cached.volumes[tail] = bars[tail].volume;
    cached.ma[tail] = simpleMovingAverageAdvance(cached.volumes, period, cached.beforeLast);
    cached.seriesRevision = series.revision;
    incrementPerformanceCounter("indicator.incremental.hit.volume");
    return cached.ma;
  }
  const volumes = bars.map((bar) => bar.volume);
  const { out, beforeLast } = simpleMovingAverageWithState(volumes, period);
  perSeries.set(ctx.instance.id, { period, length: bars.length, structureRevision: series.structureRevision, nonTailRevision: series.nonTailRevision, seriesRevision: series.revision, volumes, ma: out, beforeLast });
  incrementPerformanceCounter("indicator.incremental.full.volume");
  return out;
}

function prepareVolume(ctx: IndicatorDrawContext<VolumeSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly();
  const values = volumeSeries(bars.map((bar) => ({ time: bar.startTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })));
  const upColor = stringSetting(ctx.settings, "upColor", VOLUME_COLORS.buy);
  const downColor = stringSetting(ctx.settings, "downColor", VOLUME_COLORS.sell);
  const identity = parseMarket(ctx.chart?.market ?? "");
  const baseLabel = identity.base ?? "Base";
  const quoteLabel = identity.quote ?? "Quote";
  const volumePoints = makeNumberPoints(values, bars, start, end).map((point) => ({ ...point, color: ctx.settings.deltaColored === false ? upColor : volumeBarColor(bars[point.index]?.delta ?? 0, upColor, downColor) }));
  const series: PlotSeries[] = [{ key: "volume", label: baseLabel, color: upColor, style: "histogram", points: volumePoints }];
  const readoutSeries: PlotSeries[] = [
    { key: "baseVolume", label: baseLabel, color: upColor, points: volumePoints },
    { key: "quoteVolume", label: quoteLabel, color: VOLUME_COLORS.info, points: bars.slice(start, end).map((bar, offset) => ({ index: start + offset, time: bar.startTime, value: quoteVolumeForBar(bar) })) },
  ];
  if (ctx.settings.showMa === true) {
    const ma = volumeMovingAverage(ctx, bars, numericSetting(ctx.settings, "maPeriod", 20, 1, 500));
    const maSeries = { key: "ma", label: "MA", color: stringSetting(ctx.settings, "maColor", VOLUME_COLORS.ma), points: makeSeriesPoints(ma, bars, start, end) };
    series.push(maSeries);
    readoutSeries.push(maSeries);
  }
  return prepareMultiSeries(ctx, series, { scaleMode: "volume", formatter: compactNumber, baseline: 0, readoutSeries });
}
export function volumeBarColor(delta: number, upColor: string, downColor: string): string { return delta < 0 ? downColor : upColor; }
export { quoteVolumeForBar };
export const volumeIndicatorDefinition: IndicatorDefinition<VolumeSettings> = {
  type: "volume", name: "Volume", category: "volume", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 104,
  defaultSettings: () => defaultPaneSettings({ maPeriod: 20, showMa: false, deltaColored: true, upColor: VOLUME_COLORS.buy, downColor: VOLUME_COLORS.sell, maColor: VOLUME_COLORS.ma }) as VolumeSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "boolean", key: "showMa", label: "Show Volume MA", labelKey: "indicator.volume.showMa", requiresRecalc: true }, { kind: "number", key: "maPeriod", label: "MA Period", labelKey: "indicator.volume.maPeriod", min: 1, max: 500, step: 1, requiresRecalc: true }, { kind: "boolean", key: "deltaColored", label: "Delta-colored Bars", labelKey: "indicator.volume.deltaColored" }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "upColor", label: "Up/Volume Color", labelKey: "indicator.volume.upColor" }, { kind: "color", key: "downColor", label: "Down Color", labelKey: "indicator.volume.downColor" }, { kind: "color", key: "maColor", label: "MA Color", labelKey: "indicator.volume.maColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: simpleHeader("Volume"), prepareCache: "series-range", prepareData: prepareVolume, drawSubPane: drawMultiSeries,
};

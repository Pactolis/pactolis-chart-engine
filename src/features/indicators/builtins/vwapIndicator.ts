import type { FootprintBar } from "../../../core/types.js";
import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import {
  calculateVwapSeries,
  calendarPeriodStart,
  type CalendarPeriod,
  type VwapDefinition,
  type VwapFamily,
  type VwapPoint,
} from "../../../core/analysis/vwap.js";
import { drawPriceOverlayLines, makeOverlayPoints, overlayAppearanceFields, prepareOverlayData } from "./priceOverlayShared.js";
import { makeNumberPoints, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { vwapIndicatorLineColorDefault, vwapBandColorDefault } from "../../../core/ui/seriesPalette.js";
import { incrementPerformanceCounter, measurePerformance } from "../../../core/performanceTelemetry.js";
import { indicatorPriceSeriesMutation } from "../seriesMutationSummary.js";

export interface VwapLineConfig {
  id: string; enabled: boolean; family: VwapFamily; period: CalendarPeriod; rollingWindowDays: number; color: string; showBands: boolean; bandSigma: number; bandColor: string;
}
export interface VwapIndicatorSettings extends IndicatorSettings { lines: VwapLineConfig[]; lineWidth: number; showLastValueLabel: boolean; showPlotLabel: boolean; showChartLabels: boolean; }

const DEFAULT_COLOR = vwapIndicatorLineColorDefault;
const DEFAULT_BAND_COLOR = vwapBandColorDefault;
const FAMILIES: readonly VwapFamily[] = ["rolling", "current", "previous"];
const PERIODS: readonly CalendarPeriod[] = ["daily", "weekly", "monthly", "quarterly", "half-yearly", "yearly"];

interface CurrentVwapTailState { periodStart: number; prefixPv: number; prefixVolume: number; }
interface VwapIncrementalState {
  instance: object; seriesRevision: number; structureRevision: number; start: number; end: number; lines: VwapLineConfig[]; resultPoints: VwapPoint[][]; plotSeries: Array<PlotSeries & { chartLabel?: string }>; prepared: ReturnType<typeof prepareOverlayData>; tails: CurrentVwapTailState[];
}
const vwapIncrementalStates = new WeakMap<object, Map<string, VwapIncrementalState>>();

export function normalizeVwapLines(settings: VwapIndicatorSettings): VwapLineConfig[] {
  if (Array.isArray(settings.lines)) {
    return settings.lines.flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== "object") return [];
      const line = candidate as Partial<VwapLineConfig>;
      const family = FAMILIES.includes(line.family as VwapFamily) ? line.family as VwapFamily : "current";
      const period = PERIODS.includes(line.period as CalendarPeriod) ? line.period as CalendarPeriod : "daily";
      return [{ id: typeof line.id === "string" && line.id ? line.id : `line-${index}`, enabled: line.enabled !== false, family, period, rollingWindowDays: finiteNumber(line.rollingWindowDays, 1, 1 / 24, 3650), color: typeof line.color === "string" ? line.color : DEFAULT_COLOR, showBands: line.showBands === true, bandSigma: finiteNumber(line.bandSigma, 1, 0.1, 5), bandColor: typeof line.bandColor === "string" ? line.bandColor : DEFAULT_BAND_COLOR }];
    });
  }
  const legacy = settings as unknown as Record<string, unknown>;
  const hasLegacy = ["family", "period", "rollingWindowDays", "color", "showBands", "bandSigma", "bandColor"]
    .some((key) => Object.prototype.hasOwnProperty.call(legacy, key));
  if (!hasLegacy) return [];
  const family = FAMILIES.includes(legacy.family as VwapFamily) ? legacy.family as VwapFamily : "current";
  const period = PERIODS.includes(legacy.period as CalendarPeriod) ? legacy.period as CalendarPeriod : "daily";
  return [{ id: "legacy-0", enabled: true, family, period, rollingWindowDays: finiteNumber(legacy.rollingWindowDays, 1, 1 / 24, 3650), color: typeof legacy.color === "string" ? legacy.color : DEFAULT_COLOR, showBands: legacy.showBands === true, bandSigma: finiteNumber(legacy.bandSigma, 1, 0.1, 5), bandColor: typeof legacy.bandColor === "string" ? legacy.bandColor : DEFAULT_BAND_COLOR }];
}
function finiteNumber(value: unknown, fallback: number, min: number, max: number): number { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
function definitionForLine(line: VwapLineConfig): VwapDefinition { if (line.family === "rolling") return { id: "rolling-24h", family: line.family, label: `R${line.rollingWindowDays}D`, color: line.color, windowMs: line.rollingWindowDays * 86_400_000 }; return { id: `${line.family}-${line.period}` as VwapDefinition["id"], family: line.family, label: labelForLine(line), color: line.color, period: line.period }; }
function labelForLine(line: VwapLineConfig): string { if (line.family === "rolling") return `Rolling ${line.rollingWindowDays}D VWAP`; return `${line.family === "current" ? "Current" : "Previous"} ${line.period[0].toUpperCase()}${line.period.slice(1)} VWAP`; }
function shortLabelForLine(line: VwapLineConfig): string { if (line.family === "rolling") return `R ${line.rollingWindowDays}D`; return `${line.family === "current" ? "C" : "P"} ${line.period[0].toUpperCase()}${line.period.slice(1)}`; }
function weightedBar(bar: FootprintBar): { pv: number; volume: number } { if (!(bar.volume > 0)) return { pv: 0, volume: 0 }; const typical = (bar.high + bar.low + bar.close) / 3; return { pv: typical * bar.volume, volume: bar.volume }; }
function currentTailState(bars: readonly FootprintBar[], line: VwapLineConfig): CurrentVwapTailState {
  const tailIndex = bars.length - 1; const tail = bars[tailIndex]; if (!tail) return { periodStart: NaN, prefixPv: 0, prefixVolume: 0 };
  const periodStart = calendarPeriodStart(tail.startTime, line.period); let prefixPv = 0; let prefixVolume = 0;
  for (let i = tailIndex - 1; i >= 0 && bars[i].startTime >= periodStart; i--) { const weighted = weightedBar(bars[i]); prefixPv += weighted.pv; prefixVolume += weighted.volume; }
  return { periodStart, prefixPv, prefixVolume };
}
function sameIncrementalLines(previous: readonly VwapLineConfig[], next: readonly VwapLineConfig[]): boolean {
  return previous.length === next.length && next.every((line, index) => { const cached = previous[index]; return cached.id === line.id && cached.family === line.family && cached.period === line.period && cached.rollingWindowDays === line.rollingWindowDays && cached.showBands === line.showBands; });
}

function prepareVwap(ctx: IndicatorDrawContext<VwapIndicatorSettings>) {
  const { start, end } = visibleIndexRange(ctx); const bars = ctx.series.listReadonly(); const lines = normalizeVwapLines(ctx.settings).filter((line) => line.enabled);
  const incrementalEligible = lines.length > 0 && lines.every((line) => line.family === "current" && !line.showBands);
  let perSeries = vwapIncrementalStates.get(ctx.series); if (!perSeries) { perSeries = new Map(); vwapIncrementalStates.set(ctx.series, perSeries); }
  const cached = perSeries.get(ctx.instance.id);
  if (cached?.seriesRevision === ctx.series.revision && cached.instance === ctx.instance && cached.start === start && cached.end === end) return cached.prepared;
  const mutation = indicatorPriceSeriesMutation(ctx.series);
  const sameLines = Boolean(cached) && sameIncrementalLines(cached!.lines, lines);
  const sameShape = Boolean(cached) && cached!.resultPoints.length === lines.length && cached!.plotSeries.length === lines.length;
  if (incrementalEligible && cached && cached.instance === ctx.instance && cached.seriesRevision === ctx.series.revision && sameLines && sameShape) {
    // Only the visible range moved (a pan, or an analysis read of another
    // range): the VWAP values still hold, so rebuild just the plotted slice.
    lines.forEach((line, index) => {
      cached.plotSeries[index] = { key: `vwap-${line.id}`, label: shortLabelForLine(line), color: line.color, chartLabel: labelForLine(line), points: makeNumberPoints(cached.resultPoints[index], bars, start, end) };
    });
    cached.start = start; cached.end = end; cached.lines = lines;
    cached.prepared = prepareOverlayData(ctx, cached.plotSeries);
    incrementPerformanceCounter("indicator.incremental.hit.vwap");
    return cached.prepared;
  }
  const canReuse = incrementalEligible && cached && cached.instance === ctx.instance && cached.start === start && cached.end === end && sameLines && sameShape;
  if (canReuse && mutation.kind === "metadata") {
    cached.seriesRevision = ctx.series.revision;
    cached.structureRevision = ctx.series.structureRevision;
    incrementPerformanceCounter("indicator.incremental.hit.vwap");
    return cached.prepared;
  }
  if (canReuse && mutation.kind === "tail" && mutation.tailIndex >= 0) {
    const tail = bars[mutation.tailIndex];
    const periodStartsMatch = tail && cached.tails.every((state, index) => state.periodStart === calendarPeriodStart(tail.startTime, lines[index].period));
    if (periodStartsMatch) {
      return measurePerformance("indicator.prepare.incremental.vwap", () => {
        const weighted = weightedBar(tail);
        for (let i = 0; i < lines.length; i++) {
          const state = cached.tails[i]; const volume = state.prefixVolume + weighted.volume; const value = volume > 0 ? (state.prefixPv + weighted.pv) / volume : null;
          cached.resultPoints[i][mutation.tailIndex] = { time: tail.startTime, value };
          const point = cached.plotSeries[i].points.at(-1); if (point?.index === mutation.tailIndex) { point.time = tail.startTime; point.value = value; }
        }
        cached.prepared = prepareOverlayData(ctx, cached.plotSeries); cached.seriesRevision = ctx.series.revision; cached.structureRevision = ctx.series.structureRevision; incrementPerformanceCounter("indicator.incremental.hit.vwap"); return cached.prepared;
      });
    }
    incrementPerformanceCounter("indicator.incremental.fallback.vwap.period-rollover");
  } else if (!canReuse || mutation.kind !== "tail") {
    let fallbackReason: string;
    if (!incrementalEligible) fallbackReason = "ineligible";
    else if (!cached) fallbackReason = "initial";
    else if (cached.instance !== ctx.instance) fallbackReason = "instance";
    else if (cached.start !== start || cached.end !== end) fallbackReason = "range";
    else if (!sameLines) fallbackReason = "settings";
    else if (!sameShape) fallbackReason = "shape";
    else if (mutation.kind === "structure") fallbackReason = "structure";
    else fallbackReason = `mutation-${mutation.kind}`;
    incrementPerformanceCounter(`indicator.incremental.fallback.vwap.${fallbackReason}`);
  }
  return measurePerformance("indicator.prepare.full.vwap", () => {
    const results = calculateVwapSeries(bars, lines.map(definitionForLine)); const series: Array<PlotSeries & { chartLabel?: string }> = []; const resultPoints = results.map((result) => result.points);
    lines.forEach((line, index) => {
      const linePoints = resultPoints[index] ?? []; const label = shortLabelForLine(line);
      series.push({ key: `vwap-${line.id}`, label, color: line.color, chartLabel: labelForLine(line), points: makeNumberPoints(linePoints, bars, start, end) });
      if (!line.showBands) return; const values = linePoints.map((point) => point.value); const bands = vwapBands(bars, values, line.bandSigma);
      series.push({ key: `vwap-${line.id}-upper`, label: `${label} +${line.bandSigma}σ`, color: line.bandColor, points: makeOverlayPoints(bands.upper, bars, start, end) });
      series.push({ key: `vwap-${line.id}-lower`, label: `${label} -${line.bandSigma}σ`, color: line.bandColor, points: makeOverlayPoints(bands.lower, bars, start, end) });
    });
    const prepared = prepareOverlayData(ctx, series);
    if (incrementalEligible) perSeries.set(ctx.instance.id, { instance: ctx.instance, seriesRevision: ctx.series.revision, structureRevision: ctx.series.structureRevision, start, end, lines, resultPoints, plotSeries: series, prepared, tails: lines.map((line) => currentTailState(bars, line)) }); else perSeries.delete(ctx.instance.id);
    incrementPerformanceCounter("indicator.incremental.full.vwap"); return prepared;
  });
}

function vwapBands(bars: readonly FootprintBar[], vwapValues: readonly (number | null)[], sigma: number): { upper: Array<number | null>; lower: Array<number | null> } {
  const upper: Array<number | null> = []; const lower: Array<number | null> = []; let weightedVariance = 0; let volume = 0;
  for (let i = 0; i < bars.length; i++) { const vwap = vwapValues[i]; if (vwap === null || vwap === undefined || bars[i].volume <= 0) { upper.push(null); lower.push(null); continue; } const typical = (bars[i].high + bars[i].low + bars[i].close) / 3; weightedVariance += (typical - vwap) ** 2 * bars[i].volume; volume += bars[i].volume; const sd = volume > 0 ? Math.sqrt(weightedVariance / volume) : 0; upper.push(vwap + sd * sigma); lower.push(vwap - sd * sigma); }
  return { upper, lower };
}

export const vwapIndicatorDefinition: IndicatorDefinition<VwapIndicatorSettings> = {
  type: "vwap", name: "VWAP", category: "custom", defaultPane: "overlay", canOverlay: true, defaultPlacement: "price-overlay", supportedPlacements: ["price-overlay"], paneHeight: 0,
  defaultSettings: () => ({ lines: [{ id: "line-current-daily", enabled: true, family: "current", period: "daily", rollingWindowDays: 1, color: DEFAULT_COLOR, showBands: false, bandSigma: 1, bandColor: DEFAULT_BAND_COLOR }], lineWidth: 1.5, showLastValueLabel: true, showPlotLabel: true, showChartLabels: false }),
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "line-list", variant: "vwap", key: "lines", label: "Lines", labelKey: "indicator.common.lines", requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [...overlayAppearanceFields(), { kind: "boolean", key: "showChartLabels", label: "Show Chart Labels", labelKey: "indicator.common.showChartLabels" }] }] },
  getHeaderLabel: ({ settings }) => { if (settings.showPlotLabel === false) return ""; const lines = normalizeVwapLines(settings).filter((line) => line.enabled); return lines.length > 4 ? `VWAP ×${lines.length}` : lines.map(shortLabelForLine).join(" · "); },
  prepareCache: "series-range", prepareData: prepareVwap, drawPriceOverlay: drawPriceOverlayLines,
};

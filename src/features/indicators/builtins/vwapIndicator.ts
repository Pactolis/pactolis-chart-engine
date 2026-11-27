import type { FootprintBar } from "../../../core/types.js";
import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import {
  calculateVwapSeries,
  calendarPeriodStart,
  previousPeriodStart,
  type CalendarPeriod,
  type VwapDefinition,
  type VwapFamily,
  type VwapPoint,
} from "../../../core/analysis/vwap.js";
import { addCompensated, createCompensatedSum, type CompensatedSum } from "../../../core/analysis/calc/ta.js";
import { drawPriceOverlayLines, makeOverlayPoints, overlayAppearanceFields, prepareOverlayData } from "./priceOverlayShared.js";
import { makeNumberPoints, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { vwapIndicatorLineColorDefault, vwapBandColorDefault } from "../../../core/ui/seriesPalette.js";
import { incrementPerformanceCounter, measurePerformance } from "../../../core/performanceTelemetry.js";
import { indicatorPriceSeriesMutation } from "../seriesMutationSummary.js";
import { createIndicatorSeriesStateStore } from "./stateRegistry.js";

export interface VwapLineConfig {
  id: string; enabled: boolean; family: VwapFamily; period: CalendarPeriod; rollingWindowDays: number; color: string; showBands: boolean; bandSigma: number; bandColor: string;
}
export interface VwapIndicatorSettings extends IndicatorSettings { lines: VwapLineConfig[]; lineWidth: number; showLastValueLabel: boolean; showPlotLabel: boolean; showChartLabels: boolean; }

const DEFAULT_COLOR = vwapIndicatorLineColorDefault;
const DEFAULT_BAND_COLOR = vwapBandColorDefault;
const FAMILIES: readonly VwapFamily[] = ["rolling", "current", "previous"];
const PERIODS: readonly CalendarPeriod[] = ["daily", "weekly", "monthly", "quarterly", "half-yearly", "yearly"];

interface VwapBandState {
  prefixVariance: number;
  prefixVolume: number;
  upperValues: Array<number | null>;
  lowerValues: Array<number | null>;
}

type VwapLineTailState =
  | { kind: "current"; periodStart: number; prefixPv: number; prefixVolume: number; band: VwapBandState | null }
  | { kind: "rolling"; windowMs: number; prefixLeft: number; prefixPv: CompensatedSum; prefixVolume: CompensatedSum; band: VwapBandState | null }
  | { kind: "previous"; prefixTotals: Map<number, { pv: number; volume: number }>; lastStartTime: number; band: VwapBandState | null };

interface VwapIncrementalState {
  instance: object; seriesRevision: number; structureRevision: number; seriesLength: number; start: number; end: number; lines: VwapLineConfig[]; resultPoints: VwapPoint[][]; plotSeries: Array<PlotSeries & { chartLabel?: string }>; prepared: ReturnType<typeof prepareOverlayData>; tails: VwapLineTailState[];
}
const vwapIncrementalStates = createIndicatorSeriesStateStore<VwapIncrementalState>();

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

function buildLineTailState(
  bars: readonly FootprintBar[],
  line: VwapLineConfig,
  band: VwapBandState | null,
): VwapLineTailState {
  const closedEnd = Math.max(0, bars.length - 1);
  if (line.family === "rolling") {
    const windowMs = line.rollingWindowDays * 86_400_000;
    const prefixPv = createCompensatedSum();
    const prefixVolume = createCompensatedSum();
    let prefixLeft = 0;
    for (let i = 0; i < closedEnd; i++) {
      const w = weightedBar(bars[i]);
      addCompensated(prefixPv, w.pv);
      addCompensated(prefixVolume, w.volume);
      const cutoff = bars[i].startTime - windowMs;
      while (prefixLeft <= i && bars[prefixLeft].startTime < cutoff) {
        const old = weightedBar(bars[prefixLeft++]);
        addCompensated(prefixPv, -old.pv);
        addCompensated(prefixVolume, -old.volume);
      }
    }
    return { kind: "rolling", windowMs, prefixLeft, prefixPv, prefixVolume, band };
  }

  if (line.family === "previous") {
    const prefixTotals = new Map<number, { pv: number; volume: number }>();
    for (let i = 0; i < closedEnd; i++) {
      const start = calendarPeriodStart(bars[i].startTime, line.period);
      const total = prefixTotals.get(start) ?? { pv: 0, volume: 0 };
      const w = weightedBar(bars[i]);
      total.pv += w.pv;
      total.volume += w.volume;
      prefixTotals.set(start, total);
    }
    const lastStartTime = closedEnd > 0 ? bars[closedEnd - 1].startTime : -Infinity;
    return { kind: "previous", prefixTotals, lastStartTime, band };
  }

  const tailIndex = bars.length - 1;
  const tail = bars[tailIndex];
  if (!tail) return { kind: "current", periodStart: NaN, prefixPv: 0, prefixVolume: 0, band };
  const periodStart = calendarPeriodStart(tail.startTime, line.period);
  let prefixPv = 0;
  let prefixVolume = 0;
  for (let i = tailIndex - 1; i >= 0 && calendarPeriodStart(bars[i].startTime, line.period) === periodStart; i--) {
    const weighted = weightedBar(bars[i]);
    prefixPv += weighted.pv;
    prefixVolume += weighted.volume;
  }
  return { kind: "current", periodStart, prefixPv, prefixVolume, band };
}

function sameIncrementalLines(previous: readonly VwapLineConfig[], next: readonly VwapLineConfig[]): boolean {
  return previous.length === next.length && next.every((line, index) => {
    const cached = previous[index];
    return cached.id === line.id
      && cached.family === line.family
      && cached.period === line.period
      && cached.rollingWindowDays === line.rollingWindowDays
      && cached.showBands === line.showBands
      && cached.bandSigma === line.bandSigma
      && cached.color === line.color
      && cached.bandColor === line.bandColor;
  });
}

function rebuildVwapPlotSlice(
  cached: VwapIncrementalState,
  lines: readonly VwapLineConfig[],
  bars: readonly FootprintBar[],
  start: number,
  end: number,
): void {
  let plotIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const label = shortLabelForLine(line);
    cached.plotSeries[plotIdx++] = {
      key: `vwap-${line.id}`,
      label,
      color: line.color,
      chartLabel: labelForLine(line),
      points: makeNumberPoints(cached.resultPoints[i], bars, start, end),
    };
    const band = cached.tails[i].band;
    if (line.showBands && band) {
      cached.plotSeries[plotIdx++] = {
        key: `vwap-${line.id}-upper`,
        label: `${label} +${line.bandSigma}σ`,
        color: line.bandColor,
        points: makeOverlayPoints(band.upperValues, bars, start, end),
      };
      cached.plotSeries[plotIdx++] = {
        key: `vwap-${line.id}-lower`,
        label: `${label} -${line.bandSigma}σ`,
        color: line.bandColor,
        points: makeOverlayPoints(band.lowerValues, bars, start, end),
      };
    }
  }
}

function canApplyTailIncrementally(
  cached: VwapIncrementalState,
  bars: readonly FootprintBar[],
  lines: readonly VwapLineConfig[],
  tailIndex: number,
  tail: FootprintBar,
): boolean {
  const appended = bars.length === cached.seriesLength + 1;
  for (let i = 0; i < lines.length; i++) {
    const state = cached.tails[i];
    const line = lines[i];
    if (state.kind === "current") {
      const nextPeriod = calendarPeriodStart(tail.startTime, line.period);
      if (state.periodStart !== nextPeriod && !appended) return false;
      if (state.periodStart !== nextPeriod && appended && state.prefixVolume === 0 && !Number.isFinite(state.periodStart)) {
        return false;
      }
      // On append across period rollover, current line simply starts a fresh accumulator cleanly!
    } else if (state.kind === "previous") {
      // Chronological tail guarantees prior period points never reference tail's period.
      const compareStart = appended && tailIndex > 0 ? bars[tailIndex - 1].startTime : state.lastStartTime;
      if (tail.startTime < compareStart) return false;
    }
  }
  return true;
}

function computeExpectedPlotCount(lines: readonly VwapLineConfig[]): number {
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    count += lines[i].showBands ? 3 : 1;
  }
  return count;
}

function prepareVwap(ctx: IndicatorDrawContext<VwapIndicatorSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const lines = normalizeVwapLines(ctx.settings).filter((line) => line.enabled);
  const incrementalEligible = lines.length > 0;
  const cached = vwapIncrementalStates.get(ctx.series, ctx.instance.id);
  if (cached?.seriesRevision === ctx.series.revision && cached.instance === ctx.instance && cached.start === start && cached.end === end) {
    return cached.prepared;
  }
  const mutation = indicatorPriceSeriesMutation(ctx.series);
  const sameLines = Boolean(cached) && sameIncrementalLines(cached!.lines, lines);
  const expectedPlotCount = computeExpectedPlotCount(lines);
  const sameShape = Boolean(cached)
    && cached!.resultPoints.length === lines.length
    && cached!.plotSeries.length === expectedPlotCount;

  if (incrementalEligible && cached && cached.instance === ctx.instance && cached.seriesRevision === ctx.series.revision && sameLines && sameShape) {
    rebuildVwapPlotSlice(cached, lines, bars, start, end);
    cached.start = start;
    cached.end = end;
    cached.lines = lines;
    cached.prepared = prepareOverlayData(ctx, cached.plotSeries);
    incrementPerformanceCounter("indicator.incremental.hit.vwap");
    return cached.prepared;
  }

  const canReuse = incrementalEligible
    && cached
    && cached.instance === ctx.instance
    && sameLines
    && sameShape
    && (bars.length === cached.seriesLength || bars.length === cached.seriesLength + 1);

  if (canReuse && mutation.kind === "metadata" && bars.length === cached.seriesLength) {
    if (cached.start !== start || cached.end !== end) {
      rebuildVwapPlotSlice(cached, lines, bars, start, end);
      cached.start = start;
      cached.end = end;
      cached.lines = lines;
      cached.prepared = prepareOverlayData(ctx, cached.plotSeries);
    }
    cached.seriesRevision = ctx.series.revision;
    cached.structureRevision = ctx.series.structureRevision;
    incrementPerformanceCounter("indicator.incremental.hit.vwap");
    return cached.prepared;
  }

  if (canReuse && mutation.kind === "tail" && mutation.tailIndex >= 0 && (bars.length === cached.seriesLength || mutation.tailIndex === cached.seriesLength)) {
    const tail = bars[mutation.tailIndex];
    if (tail && canApplyTailIncrementally(cached, bars, lines, mutation.tailIndex, tail)) {
      return measurePerformance("indicator.prepare.incremental.vwap", () => {
        const appended = bars.length === cached.seriesLength + 1;
        const prevTailIdx = cached.seriesLength - 1;
        const prevTail = appended && prevTailIdx >= 0 ? bars[prevTailIdx] : null;
        const prevTailWeighted = prevTail ? weightedBar(prevTail) : null;
        const weighted = weightedBar(tail);
        const rangeChanged = cached.start !== start || cached.end !== end || appended;
        let plotIdx = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const state = cached.tails[i];
          let value: number | null = null;

          if (state.kind === "current") {
            const tailPeriod = calendarPeriodStart(tail.startTime, line.period);
            if (appended) {
              if (prevTail && prevTailWeighted) {
                if (state.periodStart !== tailPeriod) {
                  state.periodStart = tailPeriod;
                  state.prefixPv = 0;
                  state.prefixVolume = 0;
                } else {
                  state.prefixPv += prevTailWeighted.pv;
                  state.prefixVolume += prevTailWeighted.volume;
                }
              } else {
                state.periodStart = tailPeriod;
              }
            }
            const volume = state.prefixVolume + weighted.volume;
            value = volume > 0 ? (state.prefixPv + weighted.pv) / volume : null;
          } else if (state.kind === "rolling") {
            if (prevTail && prevTailWeighted) {
              addCompensated(state.prefixPv, prevTailWeighted.pv);
              addCompensated(state.prefixVolume, prevTailWeighted.volume);
              const prevCutoff = prevTail.startTime - state.windowMs;
              while (state.prefixLeft <= prevTailIdx && bars[state.prefixLeft].startTime < prevCutoff) {
                const old = weightedBar(bars[state.prefixLeft++]);
                addCompensated(state.prefixPv, -old.pv);
                addCompensated(state.prefixVolume, -old.volume);
              }
            }
            // Apply current tail on a tiny scratch copy of the closed prefix state so
            // intra-bar volume/high/low/close ticks remain bit-identical to rollingSeries.
            const scratchPv: CompensatedSum = { sum: state.prefixPv.sum, correction: state.prefixPv.correction };
            const scratchVolume: CompensatedSum = { sum: state.prefixVolume.sum, correction: state.prefixVolume.correction };
            let scratchLeft = state.prefixLeft;
            addCompensated(scratchPv, weighted.pv);
            addCompensated(scratchVolume, weighted.volume);
            const cutoff = tail.startTime - state.windowMs;
            while (scratchLeft <= mutation.tailIndex && bars[scratchLeft].startTime < cutoff) {
              const old = weightedBar(bars[scratchLeft++]);
              addCompensated(scratchPv, -old.pv);
              addCompensated(scratchVolume, -old.volume);
            }
            const complete = bars[0]?.startTime <= cutoff;
            value = complete && scratchVolume.sum > 0 ? scratchPv.sum / scratchVolume.sum : null;
          } else {
            if (prevTail && prevTailWeighted) {
              const prevPeriod = calendarPeriodStart(prevTail.startTime, line.period);
              const existing = state.prefixTotals.get(prevPeriod);
              if (existing) {
                existing.pv += prevTailWeighted.pv;
                existing.volume += prevTailWeighted.volume;
              } else {
                state.prefixTotals.set(prevPeriod, { pv: prevTailWeighted.pv, volume: prevTailWeighted.volume });
              }
              state.lastStartTime = prevTail.startTime;
            }
            const currentPeriod = calendarPeriodStart(tail.startTime, line.period);
            const previous = state.prefixTotals.get(previousPeriodStart(currentPeriod, line.period));
            value = previous && previous.volume > 0 ? previous.pv / previous.volume : null;
          }

          cached.resultPoints[i][mutation.tailIndex] = { time: tail.startTime, value };

          let upperVal: number | null = null;
          let lowerVal: number | null = null;
          const band = state.band;
          if (line.showBands && band) {
            if (prevTail && prevTailIdx >= 0) {
              const prevVwap = cached.resultPoints[i][prevTailIdx]?.value;
              if (prevVwap !== null && prevVwap !== undefined && prevTail.volume > 0) {
                const prevTypical = (prevTail.high + prevTail.low + prevTail.close) / 3;
                band.prefixVariance += (prevTypical - prevVwap) ** 2 * prevTail.volume;
                band.prefixVolume += prevTail.volume;
              }
            }
            if (value !== null && tail.volume > 0) {
              const tailTypical = (tail.high + tail.low + tail.close) / 3;
              const totalVar = band.prefixVariance + (tailTypical - value) ** 2 * tail.volume;
              const totalVol = band.prefixVolume + tail.volume;
              const sd = totalVol > 0 ? Math.sqrt(totalVar / totalVol) : 0;
              upperVal = value + sd * line.bandSigma;
              lowerVal = value - sd * line.bandSigma;
            }
            band.upperValues[mutation.tailIndex] = upperVal;
            band.lowerValues[mutation.tailIndex] = lowerVal;
          }

          if (!rangeChanged) {
            const point = cached.plotSeries[plotIdx++]?.points.at(-1);
            if (point?.index === mutation.tailIndex) {
              point.time = tail.startTime;
              point.value = value;
            }
            if (line.showBands && band) {
              const upperPt = cached.plotSeries[plotIdx++]?.points.at(-1);
              if (upperPt?.index === mutation.tailIndex) {
                upperPt.time = tail.startTime;
                upperPt.value = upperVal;
              }
              const lowerPt = cached.plotSeries[plotIdx++]?.points.at(-1);
              if (lowerPt?.index === mutation.tailIndex) {
                lowerPt.time = tail.startTime;
                lowerPt.value = lowerVal;
              }
            }
          }
        }

        if (rangeChanged) {
          rebuildVwapPlotSlice(cached, lines, bars, start, end);
        }

        cached.prepared = prepareOverlayData(ctx, cached.plotSeries);
        cached.seriesRevision = ctx.series.revision;
        cached.structureRevision = ctx.series.structureRevision;
        cached.seriesLength = bars.length;
        cached.start = start;
        cached.end = end;
        cached.lines = lines;
        incrementPerformanceCounter("indicator.incremental.hit.vwap");
        return cached.prepared;
      });
    }
    incrementPerformanceCounter("indicator.incremental.fallback.vwap.period-rollover");
  } else if (!canReuse || mutation.kind !== "tail") {
    let fallbackReason: string;
    if (!incrementalEligible) fallbackReason = "ineligible";
    else if (!cached) fallbackReason = "initial";
    else if (cached.instance !== ctx.instance) fallbackReason = "instance";
    else if (bars.length !== cached.seriesLength && bars.length !== cached.seriesLength + 1) fallbackReason = "length";
    else if (!sameLines) fallbackReason = "settings";
    else if (!sameShape) fallbackReason = "shape";
    else if (mutation.kind === "structure") fallbackReason = "structure";
    else fallbackReason = `mutation-${mutation.kind}`;
    incrementPerformanceCounter(`indicator.incremental.fallback.vwap.${fallbackReason}`);
  }

  return measurePerformance("indicator.prepare.full.vwap", () => {
    const results = calculateVwapSeries(bars, lines.map(definitionForLine));
    const series: Array<PlotSeries & { chartLabel?: string }> = [];
    const resultPoints = results.map((result) => result.points);
    const tails: VwapLineTailState[] = [];

    lines.forEach((line, index) => {
      const linePoints = resultPoints[index] ?? [];
      const label = shortLabelForLine(line);
      series.push({ key: `vwap-${line.id}`, label, color: line.color, chartLabel: labelForLine(line), points: makeNumberPoints(linePoints, bars, start, end) });
      let bandState: VwapBandState | null = null;
      if (line.showBands) {
        const bands = vwapBandsWithPrefix(bars, linePoints, line.bandSigma);
        bandState = {
          prefixVariance: bands.prefixVariance,
          prefixVolume: bands.prefixVolume,
          upperValues: bands.upper,
          lowerValues: bands.lower,
        };
        series.push({ key: `vwap-${line.id}-upper`, label: `${label} +${line.bandSigma}σ`, color: line.bandColor, points: makeOverlayPoints(bands.upper, bars, start, end) });
        series.push({ key: `vwap-${line.id}-lower`, label: `${label} -${line.bandSigma}σ`, color: line.bandColor, points: makeOverlayPoints(bands.lower, bars, start, end) });
      }
      tails.push(buildLineTailState(bars, line, bandState));
    });

    const prepared = prepareOverlayData(ctx, series);
    if (incrementalEligible) {
      vwapIncrementalStates.set(ctx.series, ctx.instance.id, {
        instance: ctx.instance,
        seriesRevision: ctx.series.revision,
        structureRevision: ctx.series.structureRevision,
        seriesLength: bars.length,
        start,
        end,
        lines,
        resultPoints,
        plotSeries: series,
        prepared,
        tails,
      });
    } else {
      vwapIncrementalStates.delete(ctx.series, ctx.instance.id);
    }
    incrementPerformanceCounter("indicator.incremental.full.vwap");
    return prepared;
  });
}

function vwapBandsWithPrefix(
  bars: readonly FootprintBar[],
  vwapPoints: readonly VwapPoint[],
  sigma: number,
): { upper: Array<number | null>; lower: Array<number | null>; prefixVariance: number; prefixVolume: number } {
  const upper: Array<number | null> = new Array(bars.length);
  const lower: Array<number | null> = new Array(bars.length);
  let weightedVariance = 0;
  let volume = 0;
  let prefixVariance = 0;
  let prefixVolume = 0;
  const lastIdx = bars.length - 1;
  for (let i = 0; i < bars.length; i++) {
    const vwap = vwapPoints[i]?.value;
    if (vwap === null || vwap === undefined || bars[i].volume <= 0) {
      upper[i] = null;
      lower[i] = null;
    } else {
      const typical = (bars[i].high + bars[i].low + bars[i].close) / 3;
      weightedVariance += (typical - vwap) ** 2 * bars[i].volume;
      volume += bars[i].volume;
      const sd = volume > 0 ? Math.sqrt(weightedVariance / volume) : 0;
      upper[i] = vwap + sd * sigma;
      lower[i] = vwap - sd * sigma;
    }
    if (i === lastIdx - 1) {
      prefixVariance = weightedVariance;
      prefixVolume = volume;
    }
  }
  return { upper, lower, prefixVariance, prefixVolume };
}

export const vwapIndicatorDefinition: IndicatorDefinition<VwapIndicatorSettings> = {
  type: "vwap", name: "VWAP", category: "custom", defaultPane: "overlay", canOverlay: true, defaultPlacement: "price-overlay", supportedPlacements: ["price-overlay"], paneHeight: 0,
  defaultSettings: () => ({ lines: [{ id: "line-current-daily", enabled: true, family: "current", period: "daily", rollingWindowDays: 1, color: DEFAULT_COLOR, showBands: false, bandSigma: 1, bandColor: DEFAULT_BAND_COLOR }], lineWidth: 1.5, showLastValueLabel: true, showPlotLabel: true, showChartLabels: false }),
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "line-list", variant: "vwap", key: "lines", label: "Lines", labelKey: "indicator.common.lines", requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [...overlayAppearanceFields(), { kind: "boolean", key: "showChartLabels", label: "Show Chart Labels", labelKey: "indicator.common.showChartLabels" }] }] },
  getHeaderLabel: ({ settings }) => { if (settings.showPlotLabel === false) return ""; const lines = normalizeVwapLines(settings).filter((line) => line.enabled); return lines.length > 4 ? `VWAP ×${lines.length}` : lines.map(shortLabelForLine).join(" · "); },
  prepareCache: "series-range", prepareData: prepareVwap, drawPriceOverlay: drawPriceOverlayLines,
};

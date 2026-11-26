import { calculateAnchoredVwap } from "../analysis/anchoredVwap.js";
import {
  calculateOiDeltaRangeProfile,
  calculateOrderFlowRangeProfile,
  type OiDeltaRangeMeta,
  type OrderFlowRangeProfileResult,
} from "../analysis/rangeProfile.js";
import type { Drawing, DrawingContext } from "../drawingTypes.js";
import type { View } from "../engine/view.js";
import { chartLocale, t, tOr } from "../chartLocale.js";
import type { FootprintSeries } from "../model/footprint.js";
import {
  levelModeHasDeveloping,
  levelModeHasStatic,
  normalizeFixedRangeOrderFlowProfileSettings,
  profileSupportsValueArea,
  selectedOiVenues,
  type OiDeltaDisplay,
  type ProfileLevelDisplay,
  type ProfileLineStyle,
} from "../orderFlowProfileSettings.js";
import { incrementPerformanceCounter, measurePerformance } from "../performanceTelemetry.js";
import { bucketEnd, bucketStart } from "../time.js";
import { lineDash, profileHistogramParts, stepSegments } from "./orderFlowProfile.js";
import type { FootprintBar } from "../types.js";
import { uiColor } from "../ui/seriesPalette.js";
import {
  buildOiRevisionKey,
  formatOiDeltaBadge,
  parseOiResolutionMs,
} from "../../features/indicators/builtins/oiDeltaProfile.js";
import { indicatorDataSource } from "../../features/indicators/indicatorDataSource.js";
import type {
  OpenInterestRequestInput,
  OpenInterestSeriesResponse,
  OpenInterestSeriesState,
  OpenInterestVenue,
} from "../../features/indicators/metricContracts.js";

export interface AnalysisDrawingsOptions {
  timeframe?: string;
  requestOpenInterestSeries?: (input: OpenInterestRequestInput) => OpenInterestSeriesState;
  createOiUpdateCallback?: (drawingId: string, requestKey: string) => () => void;
}

interface SharedOiRequestEntry {
  state: OpenInterestSeriesState;
  callbacks: Set<() => void>;
}

type AnchoredVwapResult = ReturnType<typeof calculateAnchoredVwap>;

interface CachedRangeProfileResult {
  profile: OrderFlowRangeProfileResult;
  maxMagnitude: number;
  oiMeta?: OiDeltaRangeMeta;
}

interface RangeProfileBarSnapshot {
  bar: FootprintBar;
  startTime: number;
  cellRevision: number;
  volume: number;
  cellsSize: number;
}

type RangeProfileSourceMode = "none" | "estimated" | "exact";

interface CachedRangeProfileCalculation {
  series: FootprintSeries;
  configKey: string;
  sourceMode: RangeProfileSourceMode;
  resetEpoch: number;
  nonTailRevision: number;
  structureRevision: number;
  revision: number;
  firstIndex: number;
  afterLastIndex: number;
  rangeEndTime: number;
  bars: RangeProfileBarSnapshot[];
  result: CachedRangeProfileResult;
}

interface CachedAnchoredVwapEntry {
  series: FootprintSeries;
  revision: number;
  nonTailRevision: number;
  resetEpoch: number;
  anchorTime: number;
  barCount: number;
  lastBarStartTime: number;
  prefixPriceVolume: number;
  prefixVolume: number;
  result: AnchoredVwapResult;
}

const anchoredVwapCache = new WeakMap<Drawing, CachedAnchoredVwapEntry>();
const rangeProfileCache = new WeakMap<Drawing, CachedRangeProfileCalculation>();

function cachedAnchoredVwap(series: FootprintSeries, drawing: Drawing, anchor: number): AnchoredVwapResult {
  const bars = series.listReadonly();
  const cached = anchoredVwapCache.get(drawing);
  const reusable =
    cached &&
    cached.series === series &&
    cached.resetEpoch === series.resetEpoch &&
    cached.nonTailRevision === series.nonTailRevision &&
    cached.anchorTime === anchor &&
    bars.length > 0;

  if (reusable && cached.barCount === bars.length && cached.lastBarStartTime === bars[bars.length - 1].startTime) {
    if (cached.revision === series.revision) return cached.result;

    const lastBar = bars[bars.length - 1];
    if (cached.result.points.length > 0 && cached.result.points[cached.result.points.length - 1].time === lastBar.startTime) {
      const tailPriceVol = lastBar.startTime >= anchor && lastBar.volume > 0
        ? ((lastBar.high + lastBar.low + lastBar.close) / 3) * lastBar.volume
        : 0;
      const tailVol = lastBar.startTime >= anchor && lastBar.volume > 0 ? lastBar.volume : 0;
      const totalPv = cached.prefixPriceVolume + tailPriceVol;
      const totalVol = cached.prefixVolume + tailVol;
      cached.result.points[cached.result.points.length - 1] = {
        time: lastBar.startTime,
        value: totalVol > 0 ? totalPv / totalVol : null,
      };
      cached.result.available = totalVol > 0;
      cached.revision = series.revision;
      return cached.result;
    }
  }

  if (
    cached &&
    cached.series === series &&
    cached.resetEpoch === series.resetEpoch &&
    cached.nonTailRevision + 1 === series.nonTailRevision &&
    cached.anchorTime === anchor &&
    cached.barCount + 1 === bars.length &&
    cached.lastBarStartTime === bars[bars.length - 2].startTime
  ) {
    return measurePerformance("analysis.drawings.avwap.append.ms", () => {
      const completedTail = bars[bars.length - 2];
      const lastBar = bars[bars.length - 1];
      const completedTailIncluded = completedTail.startTime >= anchor && completedTail.volume > 0;
      const completedTailPriceVol = completedTailIncluded
        ? ((completedTail.high + completedTail.low + completedTail.close) / 3) * completedTail.volume
        : 0;
      const completedTailVol = completedTailIncluded ? completedTail.volume : 0;
      const completedTailPoints = cached.result.points;
      const completedTailPoint = completedTailPoints[completedTailPoints.length - 1];
      if (completedTailPoint?.time === completedTail.startTime) {
        const completedTotalPv = cached.prefixPriceVolume + completedTailPriceVol;
        const completedTotalVol = cached.prefixVolume + completedTailVol;
        completedTailPoint.value = completedTotalVol > 0 ? completedTotalPv / completedTotalVol : null;
      } else if (completedTail.startTime >= anchor) {
        completedTailPoints.push({
          time: completedTail.startTime,
          value: completedTailIncluded
            ? (cached.prefixPriceVolume + completedTailPriceVol) / (cached.prefixVolume + completedTailVol)
            : null,
        });
      }
      cached.prefixPriceVolume += completedTailPriceVol;
      cached.prefixVolume += completedTailVol;
      const tailPriceVol = lastBar.startTime >= anchor && lastBar.volume > 0
        ? ((lastBar.high + lastBar.low + lastBar.close) / 3) * lastBar.volume
        : 0;
      const tailVol = lastBar.startTime >= anchor && lastBar.volume > 0 ? lastBar.volume : 0;
      const totalPv = cached.prefixPriceVolume + tailPriceVol;
      const totalVol = cached.prefixVolume + tailVol;
      const value = totalVol > 0 ? totalPv / totalVol : null;
      const points = cached.result.points;
      if (lastBar.startTime >= anchor) points.push({ time: lastBar.startTime, value });
      cached.result.available = cached.result.available || value !== null;
      cached.revision = series.revision;
      cached.nonTailRevision = series.nonTailRevision;
      cached.barCount = bars.length;
      cached.lastBarStartTime = lastBar.startTime;
      return cached.result;
    });
  }

  const result = measurePerformance("analysis.drawings.avwap.calculate.ms", () =>
    calculateAnchoredVwap(bars, anchor)
  );

  let prefixPriceVolume = 0;
  let prefixVolume = 0;
  if (bars.length >= 2) {
    const startIndex = lowerBoundBarTime(bars, anchor);
    for (let i = startIndex; i < bars.length - 1; i++) {
      const bar = bars[i];
      if (bar.volume > 0) {
        prefixPriceVolume += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
        prefixVolume += bar.volume;
      }
    }
  }

  const lastBarStartTime = bars.length > 0 ? bars[bars.length - 1].startTime : 0;
  anchoredVwapCache.set(drawing, {
    series,
    revision: series.revision,
    nonTailRevision: series.nonTailRevision,
    resetEpoch: series.resetEpoch,
    anchorTime: anchor,
    barCount: bars.length,
    lastBarStartTime,
    prefixPriceVolume,
    prefixVolume,
    result,
  });

  return result;
}

function lowerBoundBarTime(bars: readonly FootprintBar[], time: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].startTime < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function snapshotRangeProfileBars(bars: readonly FootprintBar[]): RangeProfileBarSnapshot[] {
  return bars.map((bar) => ({
    bar,
    startTime: bar.startTime,
    cellRevision: bar.cellRevision ?? 0,
    volume: bar.volume,
    cellsSize: bar.cells.size,
  }));
}

function sameRangeProfileBars(
  cached: readonly RangeProfileBarSnapshot[],
  bars: readonly FootprintBar[],
  firstIndex: number,
  afterLastIndex: number,
): boolean {
  const count = Math.max(0, afterLastIndex - firstIndex);
  if (cached.length !== count) return false;
  for (let i = 0; i < count; i++) {
    const bar = bars[firstIndex + i];
    const previous = cached[i];
    if (previous.bar !== bar
      || previous.startTime !== bar.startTime
      || previous.cellRevision !== (bar.cellRevision ?? 0)
      || previous.volume !== bar.volume
      || previous.cellsSize !== bar.cells.size) return false;
  }
  return true;
}

function rangeProfileSourceMode(bars: readonly FootprintBar[]): RangeProfileSourceMode {
  if (bars.length === 0) return "none";
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].cells.size > 0) return "exact";
  }
  return "estimated";
}

function cachedRangeProfile(
  series: FootprintSeries,
  drawing: Drawing,
  from: number,
  to: number,
  oiContext?: {
    market: string;
    timeframe: string;
    response: OpenInterestSeriesResponse;
    venues: OpenInterestVenue[];
    oiDeltaDisplay: OiDeltaDisplay;
  },
): CachedRangeProfileResult {
  const settings = normalizeFixedRangeOrderFlowProfileSettings(drawing as unknown as Record<string, unknown>);
  const developing = profileSupportsValueArea(settings.profileMetric)
    && [settings.pocMode, settings.vahMode, settings.valMode].some(levelModeHasDeveloping);
  const valueAreaPercent = settings.valueAreaPercent ?? 0.7;
  const configKey = oiContext
    ? [
      series.config.priceStep,
      from,
      to,
      "oi-delta",
      oiContext.oiDeltaDisplay,
      oiContext.venues.join(","),
      oiContext.market,
      oiContext.timeframe,
      buildOiRevisionKey(oiContext.response, oiContext.venues, oiContext.oiDeltaDisplay),
    ].join(":")
    : [
      series.config.priceStep,
      from,
      to,
      valueAreaPercent,
      settings.profileMetric,
      settings.profileSide,
      developing ? 1 : 0,
    ].join(":");
  const bars = series.listReadonly();
  const cached = rangeProfileCache.get(drawing);

  if (
    cached
    && cached.series === series
    && cached.configKey === configKey
    && cached.resetEpoch === series.resetEpoch
    && cached.nonTailRevision === series.nonTailRevision
    && cached.structureRevision === series.structureRevision
  ) {
    if (cached.revision === series.revision) {
      incrementPerformanceCounter("analysis.drawings.frvp.cache.hit");
      return cached.result;
    }
    const outOfRangeTailOnly =
      (bars.length === 0 && cached.bars.length === 0)
      || (
        bars.length > 0
        && cached.afterLastIndex <= bars.length - 1
        && bars[bars.length - 1].startTime > cached.rangeEndTime
        && (
          cached.bars.length === 0
          || (
            cached.firstIndex < bars.length - 1
            && cached.afterLastIndex > cached.firstIndex
            && bars[cached.firstIndex] === cached.bars[0].bar
            && bars[cached.afterLastIndex - 1] === cached.bars[cached.bars.length - 1].bar
          )
        )
      );
    if (outOfRangeTailOnly) {
      cached.revision = series.revision;
      incrementPerformanceCounter("analysis.drawings.frvp.cache.hit");
      return cached.result;
    }
  }

  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const intervalMs = series.config.intervalMs;
  const resolutionMs = oiContext ? parseOiResolutionMs(oiContext.response.resolution, intervalMs) : intervalMs;
  const expandSlots = oiContext !== undefined && intervalMs < resolutionMs;
  const sliceStart = expandSlots ? bucketStart(start, resolutionMs) : start;
  const sliceEndExclusive = expandSlots ? bucketEnd(end, resolutionMs) : end + 1;
  const firstIndex = lowerBoundBarTime(bars, sliceStart);
  const afterLastIndex = lowerBoundBarTime(bars, sliceEndExclusive);
  if (
    cached
    && cached.series === series
    && cached.configKey === configKey
    && sameRangeProfileBars(cached.bars, bars, firstIndex, afterLastIndex)
  ) {
    cached.resetEpoch = series.resetEpoch;
    cached.nonTailRevision = series.nonTailRevision;
    cached.structureRevision = series.structureRevision;
    cached.revision = series.revision;
    cached.firstIndex = firstIndex;
    cached.afterLastIndex = afterLastIndex;
    cached.rangeEndTime = sliceEndExclusive - 1;
    incrementPerformanceCounter("analysis.drawings.frvp.cache.hit");
    return cached.result;
  }

  incrementPerformanceCounter("analysis.drawings.frvp.cache.miss");
  const selectedBars = bars.slice(firstIndex, afterLastIndex);
  const sourceMode = rangeProfileSourceMode(selectedBars);
  let result: CachedRangeProfileResult;
  if (oiContext) {
    const oiResult = measurePerformance("analysis.drawings.frvp.calculate.ms", () =>
      calculateOiDeltaRangeProfile(
        selectedBars,
        from,
        to,
        intervalMs,
        oiContext.response,
        oiContext.venues,
        {
          profileMetric: "oi-delta",
          profileSide: "total",
          oiDeltaDisplay: oiContext.oiDeltaDisplay,
          priceStep: series.config.priceStep,
          allowOhlcvEstimate: true,
        },
      ));
    let maxMagnitude = 0;
    for (const level of oiResult.levels) maxMagnitude = Math.max(maxMagnitude, level.magnitude ?? 0);
    result = { profile: oiResult, maxMagnitude, oiMeta: oiResult.oiMeta };
  } else {
    const profile = measurePerformance("analysis.drawings.frvp.calculate.ms", () =>
      calculateOrderFlowRangeProfile(selectedBars, from, to, {
        profileMetric: settings.profileMetric,
        profileSide: settings.profileSide,
        valueAreaPercent,
        developing,
        priceStep: series.config.priceStep,
        allowOhlcvEstimate: true,
      }));
    let maxMagnitude = 0;
    for (const level of profile.levels) maxMagnitude = Math.max(maxMagnitude, level.magnitude ?? 0);
    result = { profile, maxMagnitude };
  }
  rangeProfileCache.set(drawing, {
    series,
    configKey,
    sourceMode,
    resetEpoch: series.resetEpoch,
    nonTailRevision: series.nonTailRevision,
    structureRevision: series.structureRevision,
    revision: series.revision,
    firstIndex,
    afterLastIndex,
    rangeEndTime: sliceEndExclusive - 1,
    bars: snapshotRangeProfileBars(selectedBars),
    result,
  });
  return result;
}

export function drawAnalysisDrawings(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  time: DrawingContext,
  drawings: readonly Drawing[],
  market: string,
  onLineObject?: (price: number, text: string, color: string) => void,
  analysisOptions?: AnalysisDrawingsOptions,
): void {
  const oiRequestCache = new Map<string, SharedOiRequestEntry>();
  for (const drawing of drawings) {
    if (!drawing.visible || drawing.market !== market) continue;
    if (drawing.type === "anchored-vwap") {
      measurePerformance("analysis.drawings.avwap.render.ms", () =>
        drawAnchoredVwap(ctx, view, series, time, drawing, onLineObject));
    } else if (drawing.type === "fixed-range-volume-profile") {
      measurePerformance("analysis.drawings.frvp.render.ms", () =>
        drawRangeProfile(ctx, view, series, time, drawing, market, analysisOptions, oiRequestCache));
    }
  }
}

function drawAnchoredVwap(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  time: DrawingContext,
  drawing: Drawing,
  onLineObject?: (price: number, text: string, color: string) => void
): void {
  const anchor = drawing.points[0]?.time;
  if (anchor === undefined) return;
  const result = cachedAnchoredVwap(series, drawing, anchor);
  const points = result.points;
  const visibleFromIndex = Math.floor(view.indexOfX(view.area.left)) - 1;
  const visibleToIndex = Math.ceil(view.indexOfX(view.area.left + view.area.width)) + 1;
  const visibleFromTime = series.timeOfIndex(visibleFromIndex);
  const visibleToTime = series.timeOfIndex(visibleToIndex);
  const from = Math.max(0, lowerBoundPointTime(points, Math.min(visibleFromTime, visibleToTime)) - 1);
  const to = Math.min(points.length, lowerBoundPointTime(points, Math.max(visibleFromTime, visibleToTime)) + 1);

  ctx.save();
  ctx.strokeStyle = drawing.color;
  ctx.lineWidth = drawing.lineWidth;
  ctx.globalAlpha = drawing.opacity ?? 1;
  applyLineStyle(ctx, drawing.lineStyle);
  ctx.beginPath();
  let started = false;
  for (let i = from; i < to; i++) {
    const point = points[i];
    if (point.value === null) continue;
    const x = view.xOfIndex(time.indexForTime(point.time)) + view.colWidth / 2;
    const y = view.yOfPrice(point.value);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  if (started) ctx.stroke();
  const lastValue = points.length ? points[points.length - 1].value : null;
  if (lastValue !== null && drawing.showPriceLabel !== false) {
    onLineObject?.(lastValue, "AVWAP", drawing.color);
  }
  ctx.restore();
}

function safeLocaleTag(): string {
  try {
    return chartLocale().locale();
  } catch {
    return "en";
  }
}

function resolveOpenInterestRequester(
  analysisOptions: AnalysisDrawingsOptions | undefined,
): ((input: OpenInterestRequestInput) => OpenInterestSeriesState) | undefined {
  if (analysisOptions?.requestOpenInterestSeries) return analysisOptions.requestOpenInterestSeries;
  try {
    return indicatorDataSource().requestOpenInterestSeries;
  } catch {
    return undefined;
  }
}

function requestSharedOpenInterestSeries(
  cache: Map<string, SharedOiRequestEntry>,
  requestFn: (input: OpenInterestRequestInput) => OpenInterestSeriesState,
  input: Omit<OpenInterestRequestInput, "onUpdate">,
  drawingId: string,
  createOiUpdateCallback: ((drawingId: string, requestKey: string) => () => void) | undefined,
): OpenInterestSeriesState {
  const key = `${input.market}|${input.timeframe}|${input.from ?? ""}|${input.to ?? ""}|${input.venues.join(",")}`;
  const cb = createOiUpdateCallback?.(drawingId, key);
  const existing = cache.get(key);
  if (existing) {
    if (cb) existing.callbacks.add(cb);
    return existing.state;
  }
  const callbacks = new Set<() => void>();
  if (cb) callbacks.add(cb);
  const state = requestFn({
    ...input,
    onUpdate: () => {
      for (const fn of callbacks) fn();
    },
  });
  cache.set(key, { state, callbacks });
  return state;
}

function drawStatusBadge(
  ctx: CanvasRenderingContext2D,
  view: View,
  left: number,
  right: number,
  placement: "left" | "right",
  text: string,
  color: string,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.area.left, view.area.top, view.area.width, view.area.height);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = placement === "right" ? "right" : "left";
  const badgeX = placement === "right" ? right - 4 : left + 4;
  ctx.fillText(text, badgeX, view.area.top + 14, Math.max(0, right - left - 8));
  ctx.restore();
}

function drawRangeProfile(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  time: DrawingContext,
  drawing: Drawing,
  market: string,
  analysisOptions: AnalysisDrawingsOptions | undefined,
  oiRequestCache: Map<string, SharedOiRequestEntry>,
): void {
  if (drawing.points.length < 2) return;
  const from = Math.min(drawing.points[0].time, drawing.points[1].time);
  const to = Math.max(drawing.points[0].time, drawing.points[1].time);
  const settings = normalizeFixedRangeOrderFlowProfileSettings(drawing as unknown as Record<string, unknown>);
  const left = view.xOfIndex(time.indexForTime(from));
  const right = view.xOfIndex(time.indexForTime(to)) + view.colWidth;
  const placement = settings.profilePlacement === "right" ? "right" : "left";

  let cachedResult: CachedRangeProfileResult;
  if (settings.profileMetric === "oi-delta") {
    const areaLeft = view.area.left;
    const areaRight = view.area.left + view.area.width;
    if (!Number.isFinite(left) || !Number.isFinite(right) || right < areaLeft || left > areaRight) {
      return;
    }
    const requestFn = resolveOpenInterestRequester(analysisOptions);
    if (!requestFn) {
      drawStatusBadge(ctx, view, left, right, placement, tOr("indicator.volumeProfile.oiNoData"), uiColor.warn);
      return;
    }
    const intervalMs = series.config.intervalMs;
    const timeframe = analysisOptions?.timeframe ?? "";
    const venues = selectedOiVenues(settings.oiVenues) as OpenInterestVenue[];
    const oiDeltaDisplay: OiDeltaDisplay = settings.oiDeltaDisplay === "split" ? "split" : "net";
    const state = requestSharedOpenInterestSeries(
      oiRequestCache,
      requestFn,
      {
        market,
        timeframe,
        intervalMs,
        venues,
        from,
        to: bucketEnd(to, intervalMs),
      },
      drawing.id,
      analysisOptions?.createOiUpdateCallback,
    );
    if (state.status === "loading" || state.status === "idle") {
      drawStatusBadge(ctx, view, left, right, placement, tOr("indicator.volumeProfile.oiLoading"), uiColor.warn);
      return;
    }
    if (state.status === "error" || state.status === "unsupported") {
      drawStatusBadge(ctx, view, left, right, placement, tOr("indicator.volumeProfile.oiNoData"), uiColor.warn);
      return;
    }
    const response = state.data;
    if (response.status === "unsupported" || response.status === "no-data" || response.venues.length === 0) {
      drawStatusBadge(ctx, view, left, right, placement, tOr("indicator.volumeProfile.oiNoData"), uiColor.warn);
      return;
    }
    cachedResult = cachedRangeProfile(series, drawing, from, to, {
      market,
      timeframe,
      response,
      venues,
      oiDeltaDisplay,
    });
    if (!cachedResult.oiMeta || cachedResult.oiMeta.coveredBarCount === 0) {
      drawStatusBadge(ctx, view, left, right, placement, tOr("indicator.volumeProfile.oiNoData"), uiColor.warn);
      return;
    }
  } else {
    cachedResult = cachedRangeProfile(series, drawing, from, to);
  }

  const { profile: result, maxMagnitude, oiMeta } = cachedResult;
  const maxWidth = Math.max(16, (right - left) * (settings.profileWidth ?? 0.3));
  const priceRange = view.priceRange();
  const priceStep = series.config.priceStep;
  const levelFrom = lowerBoundLevelPrice(result.levels, priceRange.minValue() - priceStep);
  const levelTo = lowerBoundLevelPrice(result.levels, priceRange.maxValue() + priceStep);
  const deltaZeroX = placement === "right" ? right - maxWidth / 2 : left + maxWidth / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(view.area.left, view.area.top, view.area.width, view.area.height);
  ctx.clip();
  ctx.globalAlpha = drawing.opacity ?? 0.55;
  if (maxMagnitude > 0) {
    for (let i = levelFrom; i < levelTo; i++) {
      const level = result.levels[i];
      const yTop = view.yOfPrice(level.priceBin + priceStep);
      const yBottom = view.yOfPrice(level.priceBin);
      const rowHeight = Math.max(1, yBottom - yTop - 1);
      const parts = profileHistogramParts(level, result.profileMetric, result.profileSide, settings.oiDeltaDisplay);
      if (result.profileMetric === "delta" || result.profileMetric === "oi-delta") {
        for (const part of parts) {
          const width = maxWidth / 2 * part.value / Math.max(maxMagnitude, Number.EPSILON);
          ctx.fillStyle = part.signed >= 0 ? uiColor.buy : uiColor.sell;
          ctx.fillRect(part.signed >= 0 ? deltaZeroX : deltaZeroX - width, yTop, width, rowHeight);
        }
        continue;
      }
      let cursor = placement === "right" ? right : left;
      const orderedParts = placement === "right" ? [...parts].reverse() : parts;
      for (const part of orderedParts) {
        const width = maxWidth * part.value / Math.max(maxMagnitude, Number.EPSILON);
        ctx.fillStyle = part.side === "sell" ? uiColor.sell : uiColor.buy;
        if (placement === "right") {
          ctx.fillRect(cursor - width, yTop, width, rowHeight);
          cursor -= width;
        } else {
          ctx.fillRect(cursor, yTop, width, rowHeight);
          cursor += width;
        }
      }
    }
  }
  ctx.globalAlpha = 1;
  if (profileSupportsValueArea(result.profileMetric)) {
    drawConfiguredRangeLevel(ctx, view, time, drawing, settings, "poc", result.poc, result.developing.map((point) => ({ time: point.time, price: point.poc, valid: point.valid })), left, right, "POC", "dPOC", uiColor.warn);
    drawConfiguredRangeLevel(ctx, view, time, drawing, settings, "vah", result.vah, result.developing.map((point) => ({ time: point.time, price: point.vah, valid: point.valid })), left, right, "VAH", "dVAH", uiColor.info);
    drawConfiguredRangeLevel(ctx, view, time, drawing, settings, "val", result.val, result.developing.map((point) => ({ time: point.time, price: point.val, valid: point.valid })), left, right, "VAL", "dVAL", uiColor.info);
  }
  const estimatedLabelY = view.area.top + 14;
  let disclosureLines = 0;
  const badgeAlign = placement === "right" ? "right" : "left";
  const badgeX = placement === "right" ? right - 4 : left + 4;
  if (result.profileMetric === "oi-delta" && oiMeta) {
    ctx.fillStyle = result.isEstimated || oiMeta.coveragePercent < 100 ? uiColor.warn : uiColor.info;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = badgeAlign;
    ctx.fillText(
      formatOiDeltaBadge(oiMeta, result.isEstimated, series.config.intervalMs, safeLocaleTag()),
      badgeX,
      estimatedLabelY,
      Math.max(0, right - left - 8),
    );
  } else {
    if (result.isEstimated) {
      ctx.fillStyle = uiColor.warn;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = badgeAlign;
      ctx.fillText(tOr("indicator.volumeProfile.estimated"), badgeX, estimatedLabelY);
      disclosureLines += 1;
    }
    if (result.availability === "unavailable") {
      ctx.fillStyle = uiColor.warn;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = badgeAlign;
      ctx.fillText(
        tOr("indicator.volumeProfile.estimatedMetricUnsupported"),
        badgeX,
        estimatedLabelY + disclosureLines * 12,
        Math.max(0, right - left - 8),
      );
      disclosureLines += 1;
    }
    if (!result.complete || !result.dataComplete) {
      ctx.fillStyle = uiColor.warn;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = badgeAlign;
      const percent = Math.round(result.coverage * 100);
      ctx.fillText(
        drawing.dataState === "loading"
          ? t("indicator.volumeProfile.coverageLoading", { percent })
          : t("indicator.volumeProfile.coverageIncomplete", { percent }),
        badgeX,
        estimatedLabelY + disclosureLines * 12,
        Math.max(0, right - left - 8),
      );
    }
  }
  ctx.restore();
}

function drawConfiguredRangeLevel(
  ctx: CanvasRenderingContext2D,
  view: View,
  time: DrawingContext,
  drawing: Drawing,
  settings: ReturnType<typeof normalizeFixedRangeOrderFlowProfileSettings>,
  prefix: "poc" | "vah" | "val",
  staticPrice: number | null,
  developing: Array<{ time: number; price: number | null; valid: boolean }>,
  left: number,
  right: number,
  staticLabel: string,
  developingLabel: string,
  fallbackColor: string,
): void {
  const mode = settings[`${prefix}Mode`] as ProfileLevelDisplay;
  if (levelModeHasStatic(mode)) {
    drawLevel(
      ctx,
      view,
      left,
      right,
      staticPrice,
      staticLabel,
      stringValue(settings[`${prefix}StaticColor`], fallbackColor),
      numberValue(settings[`${prefix}StaticWidth`], 1),
      lineStyleValue(settings[`${prefix}StaticStyle`], "dashed"),
    );
  }
  if (levelModeHasDeveloping(mode)) {
    drawDevelopingRangeLevel(
      ctx,
      view,
      time,
      developing,
      developingLabel,
      stringValue(settings[`${prefix}DevelopingColor`], fallbackColor),
      numberValue(settings[`${prefix}DevelopingWidth`], 1),
      lineStyleValue(settings[`${prefix}DevelopingStyle`], "solid"),
    );
  }
  void drawing;
}

function drawDevelopingRangeLevel(
  ctx: CanvasRenderingContext2D,
  view: View,
  time: DrawingContext,
  points: Array<{ time: number; price: number | null; valid: boolean }>,
  label: string,
  color: string,
  width: number,
  style: ProfileLineStyle,
): void {
  const runs: Array<Array<{ x: number; y: number; price: number }>> = [];
  let current: Array<{ x: number; y: number; price: number }> = [];
  for (const point of points) {
    if (!point.valid || point.price === null || !Number.isFinite(point.price)) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    current.push({
      x: view.xOfIndex(time.indexForTime(point.time)) + view.colWidth / 2,
      y: view.yOfPrice(point.price),
      price: point.price,
    });
  }
  if (current.length) runs.push(current);
  if (!runs.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(lineDash(style));
  for (const run of runs) {
    for (const [x1, y1, x2, y2] of stepSegments(run)) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  const lastRun = runs[runs.length - 1];
  const last = lastRun[lastRun.length - 1];
  if (last) {
    ctx.fillStyle = color;
    ctx.fillText(label, last.x + 3, last.y - 2);
  }
}

function lowerBoundPointTime(points: AnchoredVwapResult["points"], time: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundLevelPrice(levels: OrderFlowRangeProfileResult["levels"], price: number): number {
  let lo = 0;
  let hi = levels.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (levels[mid].priceBin < price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function drawLevel(
  ctx: CanvasRenderingContext2D,
  view: View,
  left: number,
  right: number,
  price: number | null,
  label: string,
  color: string,
  width: number,
  style: ProfileLineStyle,
): void {
  if (price === null || !Number.isFinite(price)) return;
  const y = view.yOfPrice(price);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(lineDash(style));
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.fillText(label, left + 3, y - 2);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(5, value)) : fallback;
}

function lineStyleValue(value: unknown, fallback: ProfileLineStyle): ProfileLineStyle {
  return value === "solid" || value === "dashed" || value === "dotted" ? value : fallback;
}

function applyLineStyle(ctx: CanvasRenderingContext2D, style: Drawing["lineStyle"]): void {
  if (style === "dashed") ctx.setLineDash([7, 5]);
  else if (style === "dotted") ctx.setLineDash([2, 4]);
  else ctx.setLineDash([]);
}

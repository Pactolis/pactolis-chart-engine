import { calculateAnchoredVwap } from "../analysis/anchoredVwap.js";
import { calculateOrderFlowRangeProfile } from "../analysis/rangeProfile.js";
import type { OrderFlowRangeProfileResult } from "../analysis/rangeProfile.js";
import type { Drawing, DrawingContext } from "../drawingTypes.js";
import type { View } from "../engine/view.js";
import { t } from "../chartLocale.js";
import type { FootprintSeries } from "../model/footprint.js";
import {
  levelModeHasDeveloping,
  levelModeHasStatic,
  normalizeFixedRangeOrderFlowProfileSettings,
  profileSupportsValueArea,
  type ProfileLevelDisplay,
  type ProfileLineStyle,
} from "../orderFlowProfileSettings.js";
import { incrementPerformanceCounter, measurePerformance } from "../performanceTelemetry.js";
import { lineDash, profileHistogramParts, stepSegments } from "./orderFlowProfile.js";
import type { FootprintBar } from "../types.js";
import { uiColor } from "../ui/seriesPalette.js";

type AnchoredVwapResult = ReturnType<typeof calculateAnchoredVwap>;

interface CachedCalculation<T> {
  series: FootprintSeries;
  revision: number;
  key: string;
  result: T;
}

interface CachedRangeProfileResult {
  profile: OrderFlowRangeProfileResult;
  maxMagnitude: number;
}

interface RangeProfileBarSnapshot {
  bar: FootprintBar;
  startTime: number;
  cellRevision: number;
  volume: number;
  cellsSize: number;
}

interface CachedRangeProfileCalculation {
  series: FootprintSeries;
  key: string;
  bars: RangeProfileBarSnapshot[];
  result: CachedRangeProfileResult;
}

interface CachedAnchoredVwapEntry {
  series: FootprintSeries;
  revision: number;
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

  if (
    cached &&
    cached.series === series &&
    cached.anchorTime === anchor &&
    cached.barCount === bars.length &&
    bars.length > 0 &&
    cached.lastBarStartTime === bars[bars.length - 1].startTime
  ) {
    if (cached.revision === series.revision) {
      return cached.result;
    }
    const lastBar = bars[bars.length - 1];
    let tailPriceVol = 0;
    let tailVol = 0;
    if (lastBar.startTime >= anchor && lastBar.volume > 0) {
      tailPriceVol = ((lastBar.high + lastBar.low + lastBar.close) / 3) * lastBar.volume;
      tailVol = lastBar.volume;
    }
    const totalPv = cached.prefixPriceVolume + tailPriceVol;
    const totalVol = cached.prefixVolume + tailVol;
    const points = cached.result.points;
    if (points.length > 0 && points[points.length - 1].time === lastBar.startTime) {
      points[points.length - 1] = {
        time: lastBar.startTime,
        value: totalVol > 0 ? totalPv / totalVol : null,
      };
      cached.result.available = points.some((p) => p.value !== null);
      cached.revision = series.revision;
      return cached.result;
    }
  }

  const result = measurePerformance("analysis.drawings.avwap.calculate.ms", () =>
    calculateAnchoredVwap(bars, anchor)
  );

  let prefixPriceVolume = 0;
  let prefixVolume = 0;
  if (bars.length >= 2) {
    for (let i = 0; i < bars.length - 1; i++) {
      const b = bars[i];
      if (b.startTime >= anchor && b.volume > 0) {
        prefixPriceVolume += ((b.high + b.low + b.close) / 3) * b.volume;
        prefixVolume += b.volume;
      }
    }
  }

  const lastBarStartTime = bars.length > 0 ? bars[bars.length - 1].startTime : 0;
  anchoredVwapCache.set(drawing, {
    series,
    revision: series.revision,
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

function rangeProfileBars(series: FootprintSeries, from: number, to: number): readonly FootprintBar[] {
  const bars = series.listReadonly();
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const first = lowerBoundBarTime(bars, start);
  const afterLast = lowerBoundBarTime(bars, end + 1);
  return bars.slice(first, afterLast);
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

function sameRangeProfileBars(cached: readonly RangeProfileBarSnapshot[], bars: readonly FootprintBar[]): boolean {
  if (cached.length !== bars.length) return false;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const previous = cached[i];
    if (previous.bar !== bar
      || previous.startTime !== bar.startTime
      || previous.cellRevision !== (bar.cellRevision ?? 0)
      || previous.volume !== bar.volume
      || previous.cellsSize !== bar.cells.size) return false;
  }
  return true;
}

function cachedRangeProfile(
  series: FootprintSeries,
  drawing: Drawing,
  from: number,
  to: number,
): CachedRangeProfileResult {
  const settings = normalizeFixedRangeOrderFlowProfileSettings(drawing as unknown as Record<string, unknown>);
  const developing = profileSupportsValueArea(settings.profileMetric)
    && [settings.pocMode, settings.vahMode, settings.valMode].some(levelModeHasDeveloping);
  const valueAreaPercent = settings.valueAreaPercent ?? 0.7;
  const key = [
    from,
    to,
    valueAreaPercent,
    settings.profileMetric,
    settings.profileSide,
    developing ? 1 : 0,
  ].join(":");
  const selectedBars = rangeProfileBars(series, from, to);
  const cached = rangeProfileCache.get(drawing);
  if (cached && cached.series === series && cached.key === key && sameRangeProfileBars(cached.bars, selectedBars)) {
    incrementPerformanceCounter("analysis.drawings.frvp.cache.hit");
    return cached.result;
  }
  incrementPerformanceCounter("analysis.drawings.frvp.cache.miss");
  const profile = measurePerformance("analysis.drawings.frvp.calculate.ms", () =>
    calculateOrderFlowRangeProfile(selectedBars, from, to, {
      profileMetric: settings.profileMetric,
      profileSide: settings.profileSide,
      valueAreaPercent,
      developing,
    }));
  let maxMagnitude = 0;
  for (const level of profile.levels) maxMagnitude = Math.max(maxMagnitude, level.magnitude ?? 0);
  const result = { profile, maxMagnitude };
  rangeProfileCache.set(drawing, { series, key, bars: snapshotRangeProfileBars(selectedBars), result });
  return result;
}

export function drawAnalysisDrawings(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  time: DrawingContext,
  drawings: readonly Drawing[],
  market: string,
  onLineObject?: (price: number, text: string, color: string) => void
): void {
  for (const drawing of drawings) {
    if (!drawing.visible || drawing.market !== market) continue;
    if (drawing.type === "anchored-vwap") {
      measurePerformance("analysis.drawings.avwap.render.ms", () =>
        drawAnchoredVwap(ctx, view, series, time, drawing, onLineObject));
    } else if (drawing.type === "fixed-range-volume-profile") {
      measurePerformance("analysis.drawings.frvp.render.ms", () =>
        drawRangeProfile(ctx, view, series, time, drawing));
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

function drawRangeProfile(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  time: DrawingContext,
  drawing: Drawing
): void {
  if (drawing.points.length < 2) return;
  const from = Math.min(drawing.points[0].time, drawing.points[1].time);
  const to = Math.max(drawing.points[0].time, drawing.points[1].time);
  const settings = normalizeFixedRangeOrderFlowProfileSettings(drawing as unknown as Record<string, unknown>);
  const { profile: result, maxMagnitude } = cachedRangeProfile(series, drawing, from, to);
  const left = view.xOfIndex(time.indexForTime(from));
  const right = view.xOfIndex(time.indexForTime(to)) + view.colWidth;
  const maxWidth = Math.max(16, (right - left) * (settings.profileWidth ?? 0.3));
  const priceRange = view.priceRange();
  const priceStep = series.config.priceStep;
  const levelFrom = lowerBoundLevelPrice(result.levels, priceRange.minValue() - priceStep);
  const levelTo = lowerBoundLevelPrice(result.levels, priceRange.maxValue() + priceStep);
  const deltaZeroX = left + maxWidth / 2;

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
      const parts = profileHistogramParts(level, result.profileMetric, result.profileSide);
      if (result.profileMetric === "delta") {
        const part = parts[0];
        if (!part) continue;
        const width = maxWidth / 2 * part.value / Math.max(maxMagnitude, Number.EPSILON);
        ctx.fillStyle = part.signed >= 0 ? uiColor.buy : uiColor.sell;
        ctx.fillRect(part.signed >= 0 ? deltaZeroX : deltaZeroX - width, yTop, width, rowHeight);
        continue;
      }
      let cursor = left;
      for (const part of parts) {
        const width = maxWidth * part.value / Math.max(maxMagnitude, Number.EPSILON);
        ctx.fillStyle = part.side === "sell" ? uiColor.sell : uiColor.buy;
        ctx.fillRect(cursor, yTop, width, rowHeight);
        cursor += width;
      }
    }
  }
  ctx.globalAlpha = 1;
  if (profileSupportsValueArea(result.profileMetric)) {
    drawConfiguredRangeLevel(ctx, view, time, drawing, settings, "poc", result.poc, result.developing.map((point) => ({ time: point.time, price: point.poc, valid: point.valid })), left, right, "POC", "dPOC", uiColor.warn);
    drawConfiguredRangeLevel(ctx, view, time, drawing, settings, "vah", result.vah, result.developing.map((point) => ({ time: point.time, price: point.vah, valid: point.valid })), left, right, "VAH", "dVAH", uiColor.info);
    drawConfiguredRangeLevel(ctx, view, time, drawing, settings, "val", result.val, result.developing.map((point) => ({ time: point.time, price: point.val, valid: point.valid })), left, right, "VAL", "dVAL", uiColor.info);
  }
  if (!result.complete || !result.dataComplete) {
    ctx.fillStyle = uiColor.warn;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    const percent = Math.round(result.coverage * 100);
    ctx.fillText(
      drawing.dataState === "loading"
        ? t("indicator.volumeProfile.coverageLoading", { percent })
        : t("indicator.volumeProfile.coverageIncomplete", { percent }),
      left + 4,
      view.area.top + 14
    );
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

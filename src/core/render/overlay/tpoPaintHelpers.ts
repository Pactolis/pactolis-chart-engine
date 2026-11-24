import type { View } from "../../engine/view.js";
import type { FootprintSeries } from "../../model/footprint.js";
import { neighbourBin, quantizeToStep } from "../../priceStep.js";
import { settings, type ChartViewConfig } from "../../settings.js";
import type { VolumeProfileSettings } from "../../analysis/volumeProfile.js";
import {
  tpoBracketLabel,
  type TpoBracketBar,
  type TpoProfileGroup,
} from "../../analysis/tpoProfile.js";
import { getTpoCacheBracket, getTpoCacheBracketCount, updateTpoProfileCache } from "./tpoProfileCache.js";
import { tOr } from "../../chartLocale.js";
import { tpoPalette } from "../../ui/seriesPalette.js";
import { isPerformanceTelemetryEnabled, recordPerformanceDuration } from "../../performanceTelemetry.js";

export interface TpoProfileHit {
  sessionStart: number;
  groupSessionStarts: readonly number[];
  canMergeLeft: boolean;
  canUndoMerges: boolean;
}

export interface TpoProfileHitZone extends TpoProfileHit {
  left: number;
  right: number;
}

export interface TpoCacheGroup {
  sessionStarts: number[];
  firstBracketIndex: number;
  lastBracketIndex: number;
  firstIdx: number;
  lastIdx: number;
  firstSpanIndex: number;
  partial: boolean;
  result: TpoProfileGroup["result"];
}

export interface TpoCacheState {
  key: string;
  brackets: TpoBracketBar[];
  groups: TpoCacheGroup[];
}

export interface TpoRenderHost {
  readonly ctx: CanvasRenderingContext2D;
  readonly chartConfig: ChartViewConfig | null;
  tpoCache: TpoCacheState | null;
  readonly tpoMergeLeftSessionStarts: ReadonlySet<number>;
  readonly getProfileSettings?: () => VolumeProfileSettings;
  pushTpoProfileHitZone(zone: TpoProfileHitZone): void;
}

const TPO_BLOCK_TONES = [-0.2, -0.1, 0.03, -0.15, 0.07, -0.05];
const TPO_MIN_BLOCK_CELL_HEIGHT = 2;
const TPO_MIN_BLOCK_CELL_WIDTH = 1.5;
const valueAreaTones = TPO_BLOCK_TONES.map((tone) => mixHexColor(tpoPalette.valueArea, tone));
const outsideTones = TPO_BLOCK_TONES.map((tone) => mixHexColor(tpoPalette.outside, tone));
const maxCounts = new WeakMap<TpoCacheGroup["result"], number>();

function maxLevelCount(result: TpoCacheGroup["result"]): number {
  let max = maxCounts.get(result);
  if (max !== undefined) return max;
  max = 0;
  if (result.levels.length > 0) {
    for (const { count } of result.levels) max = Math.max(max, count);
  } else if (result.runs) {
    for (const { count } of result.runs) max = Math.max(max, count);
  }
  maxCounts.set(result, max);
  return max;
}

type RetainTpoHistory = (key: string, paint: () => void) => void;

function mixHexColor(hex: string, amount: number): string {
  const raw = hex.startsWith("#") ? hex.slice(1) : hex;
  if (raw.length !== 6) return hex;
  const value = Number.parseInt(raw, 16);
  if (!Number.isFinite(value)) return hex;
  const mix = amount < 0 ? 0 : 255;
  const ratio = Math.min(1, Math.abs(amount));
  const r = ((value >> 16) & 255) + (mix - ((value >> 16) & 255)) * ratio;
  const g = ((value >> 8) & 255) + (mix - ((value >> 8) & 255)) * ratio;
  const b = (value & 255) + (mix - (value & 255)) * ratio;
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function toHexByte(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

/**
 * TPO (Market Profile) chart type: one horizontal count-histogram per UTC-day
 * session, anchored in that session's own x-region. Bar length = number of
 * brackets (bars) that touched the price level. POC/VAH/VAL reuse the volume
 * profile level toggles + value-area percent.
 */
export function drawTpo(
  host: TpoRenderHost,
  view: View,
  series: FootprintSeries,
  [from, to]: [number, number],
  retainHistory?: RetainTpoHistory,
): void {
  const chartCfg = host.chartConfig ?? settings;
  if (chartCfg.chartType !== "tpo" || from >= to) return;
  const cfg = host.getProfileSettings?.();
  const vaPercent = cfg?.valueAreaPercent ?? 0.7;
  const step = series.config.priceStep;
  host.tpoCache = updateTpoProfileCache(host.tpoCache, series, [from, to], chartCfg, vaPercent, host.tpoMergeLeftSessionStarts);

  const paintStartedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
  const cache = host.tpoCache;
  const { groups } = cache;
  const midPrice = view.priceOfY(view.area.top + view.area.height / 2);
  const cellH = Math.abs(view.yOfPrice(midPrice) - view.yOfPrice(midPrice + step));
  // Letters need room in both dimensions. Blocks never need the bracket scan.
  let lettersMode = chartCfg.tpoMode === "letters" && cellH >= 9;
  if (lettersMode) {
    const bracketCount = getTpoCacheBracketCount(cache);
    for (let i = 0; i < bracketCount; i++) {
      const bracket = getTpoCacheBracket(cache, i);
      if (bracket && view.xOfIndex(bracket.lastIdx + 1) - view.xOfIndex(bracket.firstIdx) < 8) {
        lettersMode = false;
        break;
      }
    }
  }

  try {
    if (retainHistory && !lettersMode && !view.isLogScale() && groups.length > 1) {
      // Only the group intersecting the series tail can change in a tail-only frame.
      const closedEnd = groups.at(-1)?.lastIdx === series.length - 1 ? groups.length - 1 : groups.length;
      const key = JSON.stringify([
        closedEnd, vaPercent, series.config.intervalMs, chartCfg.tpoProfilePeriod, chartCfg.tpoBracketSize,
        [...host.tpoMergeLeftSessionStarts],
        settings.profilePoc, settings.profileVah, settings.profileVal,
        groups.some((group) => group.partial) ? tOr("analysis.tpo.partial") : "",
      ]);
      retainHistory(key, () => paintTpoGroups(host, cache, view, from, to, step, cellH, false, 0, closedEnd));
      if (closedEnd < groups.length) {
        paintTpoGroups(host, cache, view, from, to, step, cellH, false, closedEnd, groups.length);
      }
    } else {
      paintTpoGroups(host, cache, view, from, to, step, cellH, lettersMode, 0, groups.length);
    }
  } finally {
    if (paintStartedAt !== null) recordPerformanceDuration("chart.tpo.paint.ms", performance.now() - paintStartedAt);
  }
}

function bracketCenterX(view: View, bracket: TpoBracketBar): number {
  return (view.xOfIndex(bracket.firstIdx) + view.xOfIndex(bracket.lastIdx + 1)) / 2;
}

function findVisibleBracketBounds(
  cache: TpoCacheState, view: View, first: number, last: number, visLeft: number, visRight: number,
): [number, number] {
  let lo = first;
  let hi = last + 1;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >>> 1);
    const b = getTpoCacheBracket(cache, mid);
    if (b && bracketCenterX(view, b) < visLeft) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  lo = start;
  hi = last + 1;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >>> 1);
    const b = getTpoCacheBracket(cache, mid);
    if (b && bracketCenterX(view, b) <= visRight) lo = mid + 1;
    else hi = mid;
  }
  return [start, lo - 1];
}

function findVisibleLevelBounds(
  levels: readonly TpoProfileGroup["result"]["levels"][number][], minPrice: number, maxPrice: number,
): [number, number] {
  let lo = 0;
  let hi = levels.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >>> 1);
    if (levels[mid].priceBin < minPrice) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  lo = start;
  hi = levels.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >>> 1);
    if (levels[mid].priceBin <= maxPrice) lo = mid + 1;
    else hi = mid;
  }
  return [start, lo - 1];
}

function findFirstVisibleRun(
  runs: NonNullable<TpoProfileGroup["result"]["runs"]>, minPrice: number,
): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >>> 1);
    if (runs[mid].endPrice < minPrice) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function collectVisibleRowBrackets(
  cache: TpoCacheState, firstBracketIndex: number, lastBracketIndex: number, priceBin: number, step: number, limit: number,
): number[] {
  const indices: number[] = [];
  for (let i = firstBracketIndex; i <= lastBracketIndex && indices.length < limit; i++) {
    const bracket = getTpoCacheBracket(cache, i);
    if (!bracket) continue;
    const lo = quantizeToStep(bracket.bar.low, step);
    const hi = quantizeToStep(bracket.bar.high, step);
    if (priceBin >= lo && priceBin <= hi) indices.push(i - firstBracketIndex);
  }
  return indices;
}

function paintTpoGroups(
  host: TpoRenderHost, cache: TpoCacheState, view: View, from: number, to: number, step: number,
  cellH: number, lettersMode: boolean, start: number, end: number,
): void {
  const { groups } = cache;
  const ctx = host.ctx;
  const plotTop = view.area.top;
  const plotBottom = plotTop + view.area.height;
  const plotLeft = view.area.left;
  const plotRight = plotLeft + view.area.width;
  const topPrice = view.priceOfY(plotTop);
  const bottomPrice = view.priceOfY(plotBottom);
  const hasFiniteVisPrice = Number.isFinite(topPrice) && Number.isFinite(bottomPrice) && step > 0;
  const minVisPrice = hasFiniteVisPrice ? Math.min(topPrice, bottomPrice) : -Infinity;
  const maxVisPrice = hasFiniteVisPrice ? Math.max(topPrice, bottomPrice) : Infinity;
  const visLoBin = hasFiniteVisPrice ? quantizeToStep(minVisPrice - step, step) : -Infinity;
  const visHiBin = hasFiniteVisPrice ? quantizeToStep(maxVisPrice + step, step) : Infinity;

  ctx.save();
  if (lettersMode) {
    ctx.font = `${Math.min(11, cellH - 1)}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
  }
  for (let groupIndex = start; groupIndex < end; groupIndex++) {
    const g = groups[groupIndex];
    if (g.lastIdx < from || g.firstIdx >= to) continue;
    const result = g.result;
    if (!result.levels.length && !result.runs?.length) continue;

    const left = view.xOfIndex(g.firstIdx);
    const right = view.xOfIndex(g.lastIdx + 1);
    const labelX = right - 2;
    const canUndoMerges = g.sessionStarts.some((sessionStart, index) =>
      index > 0 && host.tpoMergeLeftSessionStarts.has(sessionStart)
    );
    host.pushTpoProfileHitZone({
      left,
      right,
      sessionStart: g.sessionStarts[0],
      groupSessionStarts: [...g.sessionStarts],
      canMergeLeft: g.firstSpanIndex > 0,
      canUndoMerges,
    });
    // MMT-style red marker: only the latest/current price bin of the session,
    // not every price row touched by the last bracket's full high-low range.
    const lastBar = getTpoCacheBracket(cache, g.lastBracketIndex)?.bar;
    const lastCloseBin = lastBar ? quantizeToStep(lastBar.close, step) : NaN;

    if (lettersMode) {
      const maxLabel = tpoBracketLabel(g.lastBracketIndex - g.firstBracketIndex);
      const maxLabelW = typeof ctx.measureText === "function" ? ctx.measureText(maxLabel).width : maxLabel.length * cellH;
      const margin = Math.max(maxLabelW / 2, cellH) + 2;
      const [iStart, iEnd] = findVisibleBracketBounds(
        cache, view, g.firstBracketIndex, g.lastBracketIndex, plotLeft - margin, plotRight + margin,
      );
      for (let i = iStart; i <= iEnd; i++) {
        const bracket = getTpoCacheBracket(cache, i);
        if (!bracket) continue;
        const bar = bracket.bar;
        const label = tpoBracketLabel(i - g.firstBracketIndex);
        const cx = bracketCenterX(view, bracket);
        const lo = quantizeToStep(bar.low, step);
        const hi = quantizeToStep(bar.high, step);
        const drawLo = Math.max(lo, visLoBin);
        const drawHi = Math.min(hi, visHiBin);
        if (drawHi < drawLo) continue;
        const isLast = i === g.lastBracketIndex;
        const ticks = Math.max(0, Math.round((drawHi - drawLo) / step));
        let bin = drawLo;
        for (let tick = 0; tick <= ticks; tick++) {
          const yMid = view.yOfPrice(bin + step / 2);
          if (yMid >= plotTop && yMid <= plotBottom) {
            ctx.fillStyle = isLast && bin === lastCloseBin ? tpoPalette.latest : bin === result.poc ? tpoPalette.pocLetters : tpoPalette.letters;
            ctx.fillText(label, cx, yMid);
          }
          bin = neighbourBin(bin, step, 1);
        }
      }
    } else {
      // Market-Profile block columns: each square is one profile-local bracket
      // occurrence. Non-POC squares get a slight bracket-based tone variation.
      const maxCount = maxLevelCount(result);
      if (maxCount <= 0) continue;
      const sessionPx = Math.max(view.colWidth, right - left);
      const maxWidth = Math.max(8, sessionPx);
      const vaLo = result.val;
      const vaHi = result.vah;
      const rawSquare = Math.min(Math.max(cellH, 4), maxWidth / maxCount);
      const blockMode = cellH >= TPO_MIN_BLOCK_CELL_HEIGHT && rawSquare >= TPO_MIN_BLOCK_CELL_WIDTH;

      if (blockMode) {
        const sqH = Math.max(cellH - 1, 1);
        const sqW = Math.max(rawSquare - 1, 1);
        const latestLocalBracketIndex = g.lastBracketIndex - g.firstBracketIndex;
        const kStart = Math.max(0, Math.ceil((plotLeft - left - sqW) / rawSquare));
        const kEndMax = Math.min(Math.floor(maxWidth / rawSquare), Math.floor((plotRight - left) / rawSquare));
        let previousColor: string | undefined;

        if (kStart <= kEndMax) {
          if (result.levels.length > 0) {
            const [lStart, lEnd] = hasFiniteVisPrice
              ? findVisibleLevelBounds(result.levels, visLoBin, visHiBin)
              : [0, result.levels.length - 1];
            for (let li = lStart; li <= lEnd; li++) {
              const level = result.levels[li];
              const yTop = view.yOfPrice(level.priceBin + step);
              if (yTop > plotBottom || yTop + cellH < plotTop) continue;
              const inVA = vaLo !== null && vaHi !== null && level.priceBin >= vaLo && level.priceBin <= vaHi;
              const isPoc = level.priceBin === result.poc;
              const tones = inVA ? valueAreaTones : outsideTones;
              const latestPriceBin = level.priceBin === lastCloseBin;
              const occurrenceIndices = level.bracketIndices;
              const occurrences = occurrenceIndices.length || level.count;
              const kEnd = Math.min(occurrences - 1, kEndMax);
              for (let k = kStart; k <= kEnd; k++) {
                const bracketIndex = occurrenceIndices[k] ?? k;
                const x = left + k * rawSquare;
                const color = latestPriceBin && bracketIndex === latestLocalBracketIndex ? tpoPalette.latest
                  : isPoc ? tpoPalette.poc
                  : tones[Math.abs(bracketIndex) % tones.length];
                if (color !== previousColor) ctx.fillStyle = previousColor = color;
                ctx.fillRect(x, yTop, sqW, sqH);
              }
            }
          } else if (result.runs && hasFiniteVisPrice) {
            for (let r = findFirstVisibleRun(result.runs, visLoBin); r < result.runs.length; r++) {
              const run = result.runs[r];
              if (run.startPrice > visHiBin) break;
              const drawLo = Math.max(run.startPrice, visLoBin);
              const drawHi = Math.min(run.endPrice, visHiBin);
              const ticks = Math.max(0, Math.round((drawHi - drawLo) / step));
              let bin = drawLo;
              for (let tick = 0; tick <= ticks; tick++) {
                const yTop = view.yOfPrice(bin + step);
                if (yTop <= plotBottom && yTop + cellH >= plotTop) {
                  const inVA = vaLo !== null && vaHi !== null && bin >= vaLo && bin <= vaHi;
                  const isPoc = bin === result.poc;
                  const tones = inVA ? valueAreaTones : outsideTones;
                  const latestPriceBin = bin === lastCloseBin;
                  const kEnd = Math.min(run.count - 1, kEndMax);
                  const rowIndices = collectVisibleRowBrackets(cache, g.firstBracketIndex, g.lastBracketIndex, bin, step, kEnd + 1);
                  for (let k = kStart; k <= kEnd; k++) {
                    const bracketIndex = rowIndices[k] ?? k;
                    const x = left + k * rawSquare;
                    const color = latestPriceBin && bracketIndex === latestLocalBracketIndex ? tpoPalette.latest
                      : isPoc ? tpoPalette.poc
                      : tones[Math.abs(bracketIndex) % tones.length];
                    if (color !== previousColor) ctx.fillStyle = previousColor = color;
                    ctx.fillRect(x, yTop, sqW, sqH);
                  }
                }
                bin = neighbourBin(bin, step, 1);
              }
            }
          }
        }
      } else {
        // Rows too small for blocks: keep TPO colors in a collapsed proportional bar.
        ctx.globalAlpha = 0.55;
        let previousColor: string | undefined;
        if (result.levels.length > 0) {
          const [lStart, lEnd] = hasFiniteVisPrice
            ? findVisibleLevelBounds(result.levels, visLoBin, visHiBin)
            : [0, result.levels.length - 1];
          for (let li = lStart; li <= lEnd; li++) {
            const level = result.levels[li];
            const yTop = view.yOfPrice(level.priceBin + step);
            const yBottom = view.yOfPrice(level.priceBin);
            if (yBottom < plotTop || yTop > plotBottom) continue;
            const barW = maxWidth * (level.count / maxCount);
            if (left + barW < plotLeft || left > plotRight) continue;
            const inVA = vaLo !== null && vaHi !== null && level.priceBin >= vaLo && level.priceBin <= vaHi;
            const latestPriceBin = level.priceBin === lastCloseBin;
            const color = latestPriceBin ? tpoPalette.latest
              : level.priceBin === result.poc ? tpoPalette.poc
              : inVA ? tpoPalette.valueArea
              : tpoPalette.outside;
            if (color !== previousColor) ctx.fillStyle = previousColor = color;
            ctx.fillRect(left, yTop, barW, Math.max(1, yBottom - yTop - 1));
          }
        } else if (result.runs && hasFiniteVisPrice) {
          for (let r = findFirstVisibleRun(result.runs, visLoBin); r < result.runs.length; r++) {
            const run = result.runs[r];
            if (run.startPrice > visHiBin) break;
            const drawLo = Math.max(run.startPrice, visLoBin);
            const drawHi = Math.min(run.endPrice, visHiBin);
            const barW = maxWidth * (run.count / maxCount);
            if (left + barW < plotLeft || left > plotRight) continue;
            if (cellH < 1) {
              const paintCoalescedBand = (bandLo: number, bandHi: number, color: string): void => {
                if (bandHi < bandLo) return;
                const yTop = view.yOfPrice(bandHi + step);
                const yBottom = view.yOfPrice(bandLo);
                if (yBottom < plotTop || yTop > plotBottom) return;
                if (color !== previousColor) ctx.fillStyle = previousColor = color;
                ctx.fillRect(left, yTop, barW, Math.max(1, yBottom - yTop));
              };
              if (vaLo !== null && vaHi !== null) {
                paintCoalescedBand(drawLo, Math.min(drawHi, neighbourBin(vaLo, step, -1)), tpoPalette.outside);
                paintCoalescedBand(Math.max(drawLo, vaLo), Math.min(drawHi, vaHi), tpoPalette.valueArea);
                paintCoalescedBand(Math.max(drawLo, neighbourBin(vaHi, step, 1)), drawHi, tpoPalette.outside);
              } else {
                paintCoalescedBand(drawLo, drawHi, tpoPalette.outside);
              }
              if (result.poc !== null && result.poc >= drawLo && result.poc <= drawHi && result.poc !== lastCloseBin) {
                const yTop = view.yOfPrice(result.poc + step);
                const yBottom = view.yOfPrice(result.poc);
                if (yBottom >= plotTop && yTop <= plotBottom) {
                  if (tpoPalette.poc !== previousColor) ctx.fillStyle = previousColor = tpoPalette.poc;
                  ctx.fillRect(left, yTop, barW, 1);
                }
              }
              if (Number.isFinite(lastCloseBin) && lastCloseBin >= drawLo && lastCloseBin <= drawHi) {
                const yTop = view.yOfPrice(lastCloseBin + step);
                const yBottom = view.yOfPrice(lastCloseBin);
                if (yBottom >= plotTop && yTop <= plotBottom) {
                  if (tpoPalette.latest !== previousColor) ctx.fillStyle = previousColor = tpoPalette.latest;
                  ctx.fillRect(left, yTop, barW, 1);
                }
              }
            } else {
              const ticks = Math.max(0, Math.round((drawHi - drawLo) / step));
              let bin = drawLo;
              for (let tick = 0; tick <= ticks; tick++) {
                const yTop = view.yOfPrice(bin + step);
                const yBottom = view.yOfPrice(bin);
                if (yBottom >= plotTop && yTop <= plotBottom) {
                  const inVA = vaLo !== null && vaHi !== null && bin >= vaLo && bin <= vaHi;
                  const latestPriceBin = bin === lastCloseBin;
                  const color = latestPriceBin ? tpoPalette.latest
                    : bin === result.poc ? tpoPalette.poc
                    : inVA ? tpoPalette.valueArea
                    : tpoPalette.outside;
                  if (color !== previousColor) ctx.fillStyle = previousColor = color;
                  ctx.fillRect(left, yTop, barW, Math.max(1, yBottom - yTop - 1));
                }
                bin = neighbourBin(bin, step, 1);
              }
            }
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    if (g.partial || result.truncated) {
      ctx.save();
      ctx.fillStyle = tpoPalette.leaderVa;
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      const badgeText = g.partial && result.truncated
        ? `${tOr("analysis.tpo.partial")} · Budget`
        : g.partial
          ? tOr("analysis.tpo.partial")
          : "Budget";
      ctx.fillText(badgeText, Math.max(left + 3, view.area.left + 3), view.area.top + 12);
      ctx.restore();
    }
    // Level leaders + labels (both modes): solid white POC, dashed VA.
    if (settings.profilePoc && result.poc !== null) drawTpoLeader(ctx, view, result.poc + step / 2, "POC", tpoPalette.leaderPoc, left, labelX, false);
    if (settings.profileVah && result.vah !== null) drawTpoLeader(ctx, view, result.vah + step / 2, "VAH", tpoPalette.leaderVa, left, labelX, true);
    if (settings.profileVal && result.val !== null) drawTpoLeader(ctx, view, result.val + step / 2, "VAL", tpoPalette.leaderVa, left, labelX, true);
  }
  ctx.restore();
}

/** Level leader line (left→labelX) plus a text label, inside one TPO session. */
function drawTpoLeader(
  ctx: CanvasRenderingContext2D,
  view: View,
  centerPrice: number,
  label: string,
  color: string,
  left: number,
  labelX: number,
  dashed: boolean
): void {
  const y = view.yOfPrice(centerPrice);
  if (y < view.area.top || y > view.area.top + view.area.height) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = dashed ? 0.7 : 0.9;
  ctx.setLineDash(dashed ? [4, 3] : []);
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(labelX, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = "9px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = color;
  ctx.fillText(label, labelX + 3, y);
  ctx.restore();
}

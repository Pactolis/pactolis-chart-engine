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
import { updateTpoProfileCache } from "./tpoProfileCache.js";
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
  for (const { count } of result.levels) max = Math.max(max, count);
  maxCounts.set(result, max);
  return max;
}

type RetainTpoHistory = (key: string, paint: () => void) => void;

interface PaintStep1Collector {
  onPaintMeasure?: (sample: {
    retainedPath: boolean;
    retainHit: boolean;
    b1Ms: number;
    b2Ms: number;
    b3Ms: number;
    totalMs: number;
  }) => void;
}

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
  const { brackets, groups } = cache;
  const midPrice = view.priceOfY(view.area.top + view.area.height / 2);
  const cellH = Math.abs(view.yOfPrice(midPrice) - view.yOfPrice(midPrice + step));
  // Letters need room in both dimensions. Blocks never need the bracket scan.
  const lettersMode = chartCfg.tpoMode === "letters" && cellH >= 9 && brackets.every((bracket) =>
    !(view.xOfIndex(bracket.lastIdx + 1) - view.xOfIndex(bracket.firstIdx) < 8)
  );

  const globalBag = globalThis as Record<string, unknown>;
  const step1 = globalBag.__tpoBenchMode === "main"
    ? (globalBag.__tpoStep1 as PaintStep1Collector | undefined)
    : undefined;
  const step1PaintStart = step1 ? performance.now() : 0;
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
      if (step1) {
        let missed = false;
        const tB1Start = performance.now();
        retainHistory(key, () => {
          missed = true;
          paintTpoGroups(host, cache, view, from, to, step, cellH, false, 0, closedEnd);
        });
        const b1Ms = performance.now() - tB1Start;
        const activeTiming = { blocksMs: 0, leadersMs: 0 };
        if (closedEnd < groups.length) {
          paintTpoGroups(host, cache, view, from, to, step, cellH, false, closedEnd, groups.length, activeTiming);
        }
        step1.onPaintMeasure?.({
          retainedPath: true,
          retainHit: !missed,
          b1Ms,
          b2Ms: activeTiming.blocksMs,
          b3Ms: activeTiming.leadersMs,
          totalMs: performance.now() - step1PaintStart,
        });
      } else {
        retainHistory(key, () => paintTpoGroups(host, cache, view, from, to, step, cellH, false, 0, closedEnd));
        if (closedEnd < groups.length) {
          paintTpoGroups(host, cache, view, from, to, step, cellH, false, closedEnd, groups.length);
        }
      }
    } else if (step1 && !lettersMode && !view.isLogScale() && groups.length > 1) {
      const closedEnd = groups.at(-1)?.lastIdx === series.length - 1 ? groups.length - 1 : groups.length;
      const tB1DirectStart = performance.now();
      paintTpoGroups(host, cache, view, from, to, step, cellH, false, 0, closedEnd);
      const b1Ms = performance.now() - tB1DirectStart;
      const activeTiming = { blocksMs: 0, leadersMs: 0 };
      if (closedEnd < groups.length) {
        paintTpoGroups(host, cache, view, from, to, step, cellH, false, closedEnd, groups.length, activeTiming);
      }
      step1.onPaintMeasure?.({
        retainedPath: false,
        retainHit: false,
        b1Ms,
        b2Ms: activeTiming.blocksMs,
        b3Ms: activeTiming.leadersMs,
        totalMs: performance.now() - step1PaintStart,
      });
    } else {
      paintTpoGroups(host, cache, view, from, to, step, cellH, lettersMode, 0, groups.length);
    }
  } finally {
    if (paintStartedAt !== null) recordPerformanceDuration("chart.tpo.paint.ms", performance.now() - paintStartedAt);
  }
}

function paintTpoGroups(
  host: TpoRenderHost, { brackets, groups }: TpoCacheState, view: View, from: number, to: number, step: number,
  cellH: number, lettersMode: boolean, start: number, end: number,
  timing?: { blocksMs: number; leadersMs: number },
): void {
  const ctx = host.ctx;
  const plotBottom = view.area.top + view.area.height;
  ctx.save();
  if (lettersMode) {
    ctx.font = `${Math.min(11, cellH - 1)}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
  }
  for (let groupIndex = start; groupIndex < end; groupIndex++) {
    const tGroupStart = timing ? performance.now() : 0;
    const g = groups[groupIndex];
    if (g.lastIdx < from || g.firstIdx >= to) continue;
    const result = g.result;
    if (!result.levels.length) continue;

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
    const lastBar = brackets[g.lastBracketIndex]?.bar;
    const lastCloseBin = lastBar ? quantizeToStep(lastBar.close, step) : NaN;

    if (lettersMode) {
      for (let i = g.firstBracketIndex; i <= g.lastBracketIndex; i++) {
        const bracket = brackets[i];
        if (!bracket) continue;
        const bar = bracket.bar;
        const label = tpoBracketLabel(i - g.firstBracketIndex);
        const cx = (view.xOfIndex(bracket.firstIdx) + view.xOfIndex(bracket.lastIdx + 1)) / 2;
        const lo = quantizeToStep(bar.low, step);
        const hi = quantizeToStep(bar.high, step);
        const isLast = i === g.lastBracketIndex;
        const ticks = Math.max(0, Math.round((hi - lo) / step));
        let bin = lo;
        for (let tick = 0; tick <= ticks; tick++) {
          const yMid = view.yOfPrice(bin + step / 2);
          if (yMid >= view.area.top && yMid <= plotBottom) {
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
        let previousColor: string | undefined;
        for (const level of result.levels) {
          const yTop = view.yOfPrice(level.priceBin + step);
          if (yTop > plotBottom || yTop + cellH < view.area.top) continue;
          const inVA = vaLo !== null && vaHi !== null && level.priceBin >= vaLo && level.priceBin <= vaHi;
          const isPoc = level.priceBin === result.poc;
          const tones = inVA ? valueAreaTones : outsideTones;
          const latestPriceBin = level.priceBin === lastCloseBin;
          const occurrenceIndices = level.bracketIndices;
          const occurrences = occurrenceIndices.length || level.count;
          for (let k = 0; k < occurrences; k++) {
            const bracketIndex = occurrenceIndices[k] ?? k;
            const x = left + k * rawSquare;
            if (x - left > maxWidth) break;
            const color = latestPriceBin && bracketIndex === latestLocalBracketIndex ? tpoPalette.latest
              : isPoc ? tpoPalette.poc
              : tones[Math.abs(bracketIndex) % tones.length];
            if (color !== previousColor) ctx.fillStyle = previousColor = color;
            ctx.fillRect(x, yTop, sqW, sqH);
          }
        }
      } else {
        // Rows too small for blocks: keep TPO colors in a collapsed proportional bar.
        ctx.globalAlpha = 0.55;
        let previousColor: string | undefined;
        for (const level of result.levels) {
          const yTop = view.yOfPrice(level.priceBin + step);
          const yBottom = view.yOfPrice(level.priceBin);
          if (yBottom < view.area.top || yTop > plotBottom) continue;
          const inVA = vaLo !== null && vaHi !== null && level.priceBin >= vaLo && level.priceBin <= vaHi;
          const latestPriceBin = level.priceBin === lastCloseBin;
          const color = latestPriceBin ? tpoPalette.latest
            : level.priceBin === result.poc ? tpoPalette.poc
            : inVA ? tpoPalette.valueArea
            : tpoPalette.outside;
          if (color !== previousColor) ctx.fillStyle = previousColor = color;
          ctx.fillRect(left, yTop, maxWidth * (level.count / maxCount), Math.max(1, yBottom - yTop - 1));
        }
        ctx.globalAlpha = 1;
      }
    }

    if (g.partial) {
      ctx.save();
      ctx.fillStyle = tpoPalette.leaderVa;
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.fillText(tOr("analysis.tpo.partial"), Math.max(left + 3, view.area.left + 3), view.area.top + 12);
      ctx.restore();
    }
    if (timing) timing.blocksMs += performance.now() - tGroupStart;
    const tLeaderStart = timing ? performance.now() : 0;
    // Level leaders + labels (both modes): solid white POC, dashed VA.
    if (settings.profilePoc && result.poc !== null) drawTpoLeader(ctx, view, result.poc + step / 2, "POC", tpoPalette.leaderPoc, left, labelX, false);
    if (settings.profileVah && result.vah !== null) drawTpoLeader(ctx, view, result.vah + step / 2, "VAH", tpoPalette.leaderVa, left, labelX, true);
    if (settings.profileVal && result.val !== null) drawTpoLeader(ctx, view, result.val + step / 2, "VAL", tpoPalette.leaderVa, left, labelX, true);
    if (timing) timing.leadersMs += performance.now() - tLeaderStart;
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

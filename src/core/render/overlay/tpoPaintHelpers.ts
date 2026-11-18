import type { View } from "../../engine/view.js";
import type { FootprintSeries } from "../../model/footprint.js";
import { neighbourBin, quantizeToStep } from "../../priceStep.js";
import { settings, type ChartViewConfig } from "../../settings.js";
import type { VolumeProfileSettings } from "../../analysis/volumeProfile.js";
import {
  buildTpoProfileGroups,
  effectiveTpoBracketMs,
  tpoBracketLabel,
  tpoSessionRange,
  type TpoBracketBar,
  type TpoProfileGroup,
} from "../../analysis/tpoProfile.js";
import { tOr } from "../../chartLocale.js";
import { tpoPalette } from "../../ui/seriesPalette.js";

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
const tpoBlockColorCache = new Map<string, string>();

function tpoBlockFillColor(baseColor: string, bracketIndex: number): string {
  const toneIndex = Math.abs(bracketIndex) % TPO_BLOCK_TONES.length;
  const key = `${baseColor}:${toneIndex}`;
  const cached = tpoBlockColorCache.get(key);
  if (cached) return cached;
  const color = mixHexColor(baseColor, TPO_BLOCK_TONES[toneIndex]);
  tpoBlockColorCache.set(key, color);
  return color;
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
export function drawTpo(host: TpoRenderHost, view: View, series: FootprintSeries, [from, to]: [number, number]): void {
  const chartCfg = host.chartConfig ?? settings;
  if (chartCfg.chartType !== "tpo" || from >= to) return;
  const cfg = host.getProfileSettings?.();
  const vaPercent = cfg?.valueAreaPercent ?? 0.7;
  const all = series.listReadonly();
  const step = series.config.priceStep;

  const bracketMs = effectiveTpoBracketMs(chartCfg.tpoBracketSize, series.config.intervalMs);
  const [sessionFrom, sessionTo] = tpoSessionRange(all, from, to, chartCfg.tpoProfilePeriod, host.tpoMergeLeftSessionStarts);
  const key = [vaPercent, step, series.revision, chartCfg.tpoProfilePeriod, chartCfg.tpoBracketSize,
    bracketMs, sessionFrom, sessionTo, ...[...host.tpoMergeLeftSessionStarts].sort((a, b) => a - b)].join("|");
  if (host.tpoCache?.key !== key) {
    const profiles = buildTpoProfileGroups(
      all,
      sessionFrom,
      sessionTo,
      chartCfg.tpoProfilePeriod,
      bracketMs,
      series.config.intervalMs,
      step,
      vaPercent,
      host.tpoMergeLeftSessionStarts,
    );
    host.tpoCache = {
      key,
      brackets: profiles.brackets,
      groups: profiles.groups,
    };
  }

  const brackets = host.tpoCache.brackets;
  const ctx = host.ctx;
  // Letters mode needs vertical room per price row and horizontal room per
  // bracket column; otherwise fall back to the collapsed histogram.
  const midPrice = view.priceOfY(view.area.top + view.area.height / 2);
  const cellH = Math.abs(view.yOfPrice(midPrice) - view.yOfPrice(midPrice + step));
  let minBracketWidth = Number.POSITIVE_INFINITY;
  for (const bracket of brackets) {
    const width = view.xOfIndex(bracket.lastIdx + 1) - view.xOfIndex(bracket.firstIdx);
    if (width < minBracketWidth) minBracketWidth = width;
  }
  const lettersMode = chartCfg.tpoMode === "letters" && cellH >= 9 && minBracketWidth >= 8;

  ctx.save();
  if (lettersMode) {
    ctx.font = `${Math.min(11, cellH - 1)}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
  }
  for (const g of host.tpoCache.groups) {
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
          if (yMid >= view.area.top && yMid <= view.area.top + view.area.height) {
            ctx.fillStyle = isLast && bin === lastCloseBin ? tpoPalette.latest : bin === result.poc ? tpoPalette.pocLetters : tpoPalette.letters;
            ctx.fillText(label, cx, yMid);
          }
          bin = neighbourBin(bin, step, 1);
        }
      }
    } else {
      // Market-Profile block columns: each square is one profile-local bracket
      // occurrence. Non-POC squares get a slight bracket-based tone variation.
      const maxCount = Math.max(...result.levels.map((l) => l.count));
      if (maxCount <= 0) continue;
      const sessionPx = Math.max(view.colWidth, view.xOfIndex(g.lastIdx + 1) - left);
      const maxWidth = Math.max(8, sessionPx);
      const vaLo = result.val;
      const vaHi = result.vah;
      const rawSquare = Math.min(Math.max(cellH, 4), maxWidth / maxCount);
      const blockMode = cellH >= TPO_MIN_BLOCK_CELL_HEIGHT && rawSquare >= TPO_MIN_BLOCK_CELL_WIDTH;

      if (blockMode) {
        const sqH = Math.max(cellH - 1, 1);
        for (const level of result.levels) {
          const yTop = view.yOfPrice(level.priceBin + step);
          if (yTop > view.area.top + view.area.height || yTop + cellH < view.area.top) continue;
          const inVA = vaLo !== null && vaHi !== null && level.priceBin >= vaLo && level.priceBin <= vaHi;
          const baseColor = level.priceBin === result.poc ? tpoPalette.poc
            : inVA ? tpoPalette.valueArea
            : tpoPalette.outside;
          const latestPriceBin = level.priceBin === lastCloseBin;
          const latestLocalBracketIndex = g.lastBracketIndex - g.firstBracketIndex;
          const occurrenceIndices = level.bracketIndices.length
            ? level.bracketIndices
            : Array.from({ length: level.count }, (_, index) => index);
          for (let k = 0; k < occurrenceIndices.length; k++) {
            const bracketIndex = occurrenceIndices[k];
            const x = left + k * rawSquare;
            if (x - left > maxWidth) break;
            ctx.fillStyle = latestPriceBin && bracketIndex === latestLocalBracketIndex ? tpoPalette.latest
              : level.priceBin === result.poc ? baseColor
              : tpoBlockFillColor(baseColor, bracketIndex);
            ctx.fillRect(x, yTop, Math.max(rawSquare - 1, 1), sqH);
          }
        }
      } else {
        // Rows too small for blocks: keep TPO colors in a collapsed proportional bar.
        ctx.globalAlpha = 0.55;
        for (const level of result.levels) {
          const yTop = view.yOfPrice(level.priceBin + step);
          const yBottom = view.yOfPrice(level.priceBin);
          if (yBottom < view.area.top || yTop > view.area.top + view.area.height) continue;
          const inVA = vaLo !== null && vaHi !== null && level.priceBin >= vaLo && level.priceBin <= vaHi;
          const latestPriceBin = level.priceBin === lastCloseBin;
          ctx.fillStyle = latestPriceBin ? tpoPalette.latest
            : level.priceBin === result.poc ? tpoPalette.poc
            : inVA ? tpoPalette.valueArea
            : tpoPalette.outside;
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

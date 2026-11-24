import type { View } from "../../engine/view.js";
import { isLiveOnlyProvisionalBar, type FootprintSeries } from "../../model/footprint.js";
import type { FootprintBar } from "../../types.js";
import type { ResolvedChartDisplayOptions } from "../../model/chartDisplayOptions.js";
import { quoteVolumeForBar } from "../../model/footprintCellMetrics.js";
import { configDecimals } from "../../axisLabelUtils.js";
import { bucketStart } from "../../time.js";
import { uiColor } from "../../ui/seriesPalette.js";
import { HUD_ROW_HEIGHT, hudMaxRows, layoutHud, type HudPart } from "../hudLayout.js";
import { TOUCH_MENU_BUTTON_RESERVE, touchMenuButtonRect } from "../touchControlsRenderer.js";
import type { Crosshair } from "./interactionOverlayRenderer.js";

export interface HudRendererDeps {
  readonly showNotional: boolean;
  readonly displayOptions: ResolvedChartDisplayOptions;
  readonly getSyncCrosshairTime?: () => number | null;
  readonly onHudText?: (text: string | null) => void;
  readonly isOpenBarLiveOnly?: (bar: FootprintBar) => boolean;
}

function liveOnlyLabel(locale: string): string {
  const normalized = locale.toLowerCase();
  return normalized === "tr" || normalized.startsWith("tr-") || normalized.startsWith("tr_")
    ? "Yalnızca canlı"
    : "Live only";
}

function isStandaloneOpenLiveOnlyBar(bar: FootprintBar, intervalMs: number): boolean {
  return isLiveOnlyProvisionalBar(bar) && bar.startTime >= bucketStart(Date.now(), intervalMs);
}

const hudNumberFormatters = new Map<string, Intl.NumberFormat>();

interface HudMemoEntry {
  ctx: CanvasRenderingContext2D;
  barRef: FootprintBar;
  count: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  completeness: FootprintBar["completeness"];
  hovered: boolean;
  showNotional: boolean;
  locale: string;
  pd: number;
  labelsVolume: string;
  labelsTrades: string;
  labelsRange: string;
  labelsChange: string;
  maxWidth: number;
  liveOnly: boolean;
  font: string;
  hudText: string;
  liveOnlyPart: string;
  liveOnlyWidth: number;
  prefix: string;
  prefixWidth: number;
  deltaPart: string;
  deltaWidth: number;
  tradesPart: string;
  tradesWidth: number;
  rangePart: string;
  rangeWidth: number;
  chgPart: string;
  chgWidth: number;
  changePct: number;
  parts: readonly HudPart[] | null;
}

let lastHudMemo: HudMemoEntry | null = null;

export function fmtFixed(v: number, digits: number, locale?: string, grouping = false): string {
  const legacyValue = v.toFixed(digits);
  if (!locale || (locale === "en-US" && !grouping) || !Number.isInteger(digits) || digits < 0 || digits > 100) return legacyValue;
  const key = `${locale}:${digits}:${grouping}`;
  let formatter = hudNumberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { useGrouping: grouping, minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (hudNumberFormatters.size >= 32) hudNumberFormatters.clear();
    hudNumberFormatters.set(key, formatter);
  }
  return formatter.format(Number(legacyValue));
}

export function fmtVol(v: number, locale?: string): string {
  if (v >= 1000) return fmtFixed(v / 1000, 1, locale) + "k";
  if (v >= 100) return fmtFixed(v, 0, locale);
  if (v >= 1) return fmtFixed(v, 1, locale);
  return fmtFixed(v, 3, locale);
}

/** Format a USDT notional value (qty * price) compactly. */
export function fmtNotional(v: number, locale?: string): string {
  if (v >= 1e6) return fmtFixed(v / 1e6, 2, locale) + "M";
  if (v >= 1e3) return fmtFixed(v / 1e3, 1, locale) + "k";
  return fmtFixed(v, 0, locale);
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  crosshair: Crosshair,
  [, to]: [number, number],
  deps: HudRendererDeps,
): void {
  // Bar priority: local crosshair, then synchronized ghost crosshair, else latest bar.
  let bar = series.at(to - 1);
  let hovered = false;
  if (crosshair.visible) {
    const idx = Math.floor(view.indexOfX(crosshair.x));
    const b = series.at(idx);
    if (b) {
      bar = b;
      hovered = true;
    }
  } else {
    const syncTime = deps.getSyncCrosshairTime?.();
    if (syncTime != null) {
      const startTime = series.at(0)?.startTime;
      if (startTime !== undefined) {
        const idx = Math.floor((syncTime - startTime) / series.config.intervalMs);
        const b = series.at(idx);
        if (b) {
          bar = b;
          hovered = true;
        }
      }
    }
  }
  if (!bar) {
    deps.onHudText?.(null);
    return;
  }

  const displayOptions = deps.displayOptions;
  const locale = displayOptions.numberLocale;
  const labels = displayOptions.labels;
  const liveOnly = bar.completeness !== "partial"
    && (deps.isOpenBarLiveOnly?.(bar) ?? isStandaloneOpenLiveOnlyBar(bar, series.config.intervalMs));
  const pd = configDecimals(series.config);
  const x = view.area.left + 8;

  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = uiColor.textHeading;

  const reserved = crosshair.touch && touchMenuButtonRect(view) !== null ? TOUCH_MENU_BUTTON_RESERVE : 0;
  const maxWidth = view.area.width - 16 - reserved;
  const font = ctx.font;

  let entry = lastHudMemo;
  if (
    !entry
    || entry.ctx !== ctx
    || entry.barRef !== bar
    || entry.count !== bar.count
    || entry.open !== bar.open
    || entry.high !== bar.high
    || entry.low !== bar.low
    || entry.close !== bar.close
    || entry.volume !== bar.volume
    || entry.delta !== bar.delta
    || entry.completeness !== bar.completeness
    || entry.hovered !== hovered
    || entry.showNotional !== deps.showNotional
    || entry.locale !== locale
    || entry.pd !== pd
    || entry.labelsVolume !== labels.volume
    || entry.labelsTrades !== labels.trades
    || entry.labelsRange !== labels.range
    || entry.labelsChange !== labels.change
    || entry.maxWidth !== maxWidth
    || entry.liveOnly !== liveOnly
    || entry.font !== font
  ) {
    const unit = deps.showNotional ? "$" : "₿";
    const partialMarker = bar.completeness === "partial" || liveOnly ? "≈" : "";
    const liveOnlyTag = liveOnly ? `[${liveOnlyLabel(locale)}]` : "";
    const volTxt = deps.showNotional ? fmtNotional(quoteVolumeForBar(bar), locale) : fmtVol(bar.volume, locale);
    const deltaTxt = deps.showNotional
      ? fmtNotional(Math.abs(bar.delta) * bar.close, locale)
      : fmtFixed(Math.abs(bar.delta), 2, locale);
    const rangePct = bar.low > 0 ? ((bar.high - bar.low) / bar.low) * 100 : 0;
    const changePct = bar.open > 0 ? ((bar.close - bar.open) / bar.open) * 100 : 0;
    const livePrefix = liveOnlyTag ? `${liveOnlyTag} ` : "";
    const hudText = `${livePrefix}O ${fmtFixed(bar.open, pd, locale)} H ${fmtFixed(bar.high, pd, locale)} L ${fmtFixed(bar.low, pd, locale)} `
      + `C ${fmtFixed(bar.close, pd, locale)} ${labels.volume} ${partialMarker}${unit}${volTxt} Δ ${partialMarker}${bar.delta >= 0 ? "+" : "-"}${unit}${deltaTxt} `
      + `${labels.trades} ${partialMarker}${bar.count} ${labels.range} ${fmtFixed(rangePct, 2, locale)}% ${labels.change} ${changePct >= 0 ? "+" : ""}${fmtFixed(changePct, 2, locale)}%`;

    const hover = hovered ? "◆ " : "";
    const liveOnlyPart = liveOnlyTag ? `${hover}${liveOnlyTag}` : "";
    const liveOnlyWidth = liveOnlyPart ? ctx.measureText(liveOnlyPart + "  ").width : 0;
    const prefix = `${liveOnlyPart ? "" : hover}O ${fmtFixed(bar.open, pd, locale)}  H ${fmtFixed(bar.high, pd, locale)}  L ${fmtFixed(bar.low, pd, locale)}  C ${fmtFixed(bar.close, pd, locale)}  ${labels.volume} ${partialMarker}${unit}${volTxt}`;
    const prefixWidth = ctx.measureText(prefix + "   ").width;
    const deltaPart = `Δ ${partialMarker}${bar.delta >= 0 ? "+" : "-"}${unit}${deltaTxt}`;
    const deltaWidth = ctx.measureText(deltaPart + "   ").width;
    const tradesPart = `${labels.trades} ${partialMarker}${fmtFixed(bar.count, 0, locale, true)}`;
    const tradesWidth = ctx.measureText(tradesPart + "   ").width;
    const rangePart = `${labels.range} ${fmtFixed(rangePct, 2, locale)}%`;
    const rangeWidth = ctx.measureText(rangePart + "   ").width;
    const chgPart = `${labels.change} ${changePct >= 0 ? "+" : ""}${fmtFixed(changePct, 2, locale)}%`;
    const chgWidth = ctx.measureText(chgPart).width;

    const overflows = liveOnlyWidth + prefixWidth + deltaWidth + tradesWidth + rangeWidth + chgWidth > maxWidth;
    const parts: readonly HudPart[] | null = overflows ? [
      ...(liveOnlyTag ? [{ text: `${hover}${liveOnlyTag}`, color: uiColor.warn, dropOrder: 0 }] : []),
      { text: `${liveOnlyTag ? "" : hover}O ${fmtFixed(bar.open, pd, locale)}`, color: uiColor.textHeading, dropOrder: 0 },
      { text: `H ${fmtFixed(bar.high, pd, locale)}`, color: uiColor.textHeading, dropOrder: 0 },
      { text: `L ${fmtFixed(bar.low, pd, locale)}`, color: uiColor.textHeading, dropOrder: 0 },
      { text: `C ${fmtFixed(bar.close, pd, locale)}`, color: uiColor.textHeading, dropOrder: 0 },
      { text: `${labels.volume} ${partialMarker}${unit}${volTxt}`, color: uiColor.textHeading, dropOrder: 2 },
      { text: deltaPart, color: bar.delta >= 0 ? uiColor.buy : uiColor.sell, dropOrder: 3 },
      { text: tradesPart, color: uiColor.textSecondary, dropOrder: 4 },
      { text: rangePart, color: uiColor.textSecondary, dropOrder: 5 },
      { text: chgPart, color: changePct >= 0 ? uiColor.buy : uiColor.sell, dropOrder: 1 },
    ] : null;

    entry = {
      ctx,
      barRef: bar,
      count: bar.count,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      delta: bar.delta,
      completeness: bar.completeness,
      hovered,
      showNotional: deps.showNotional,
      locale,
      pd,
      labelsVolume: labels.volume,
      labelsTrades: labels.trades,
      labelsRange: labels.range,
      labelsChange: labels.change,
      maxWidth,
      liveOnly,
      font,
      hudText,
      liveOnlyPart,
      liveOnlyWidth,
      prefix,
      prefixWidth,
      deltaPart,
      deltaWidth,
      tradesPart,
      tradesWidth,
      rangePart,
      rangeWidth,
      chgPart,
      chgWidth,
      changePct,
      parts,
    };
    lastHudMemo = entry;
  }

  deps.onHudText?.(entry.hudText);

  if (entry.parts) {
    drawHudRows(ctx, view, x, maxWidth, entry.parts);
    return;
  }

  const prefixX = x + entry.liveOnlyWidth;
  const rangeX = prefixX + entry.prefixWidth + entry.deltaWidth + entry.tradesWidth;
  const pillW = Math.min(
    Math.max(0, view.area.width - 8),
    entry.liveOnlyWidth + entry.prefixWidth + entry.deltaWidth + entry.tradesWidth + entry.rangeWidth + entry.chgWidth + 12,
  );
  drawOverlayPill(ctx, x - 6, 4, pillW, 20, 5, "rgba(11, 16, 24, 0.78)", "rgba(148, 163, 184, 0.16)");

  if (entry.liveOnlyPart) {
    ctx.fillStyle = uiColor.warn;
    ctx.fillText(entry.liveOnlyPart, x, 8);
  }
  ctx.fillStyle = uiColor.textHeading;
  ctx.fillText(entry.prefix, prefixX, 8);
  ctx.fillStyle = bar.delta >= 0 ? uiColor.buy : uiColor.sell;
  ctx.fillText(entry.deltaPart, prefixX + entry.prefixWidth, 8);
  ctx.fillStyle = uiColor.textSecondary;
  ctx.fillText(entry.tradesPart, prefixX + entry.prefixWidth + entry.deltaWidth, 8);
  ctx.fillText(entry.rangePart, rangeX, 8);
  ctx.fillStyle = entry.changePct >= 0 ? uiColor.buy : uiColor.sell;
  ctx.fillText(entry.chgPart, rangeX + entry.rangeWidth, 8);
}

/** The readout as rows of `parts`, widest row no wider than `maxWidth`; see layoutHud for what gives way. */
function drawHudRows(ctx: CanvasRenderingContext2D, view: View, x: number, maxWidth: number, parts: readonly HudPart[]): void {
  if (maxWidth < 60) return;
  const layout = layoutHud(parts, (text) => ctx.measureText(text).width, maxWidth, hudMaxRows(view.area.height), ctx.measureText("  ").width);
  const pillW = Math.min(Math.max(0, view.area.width - 8), layout.width + 12);
  drawOverlayPill(ctx, x - 6, 4, pillW, 20 + (layout.rows.length - 1) * HUD_ROW_HEIGHT, 5, "rgba(11, 16, 24, 0.78)", "rgba(148, 163, 184, 0.16)");
  layout.rows.forEach((row, index) => {
    for (const part of row.parts) {
      ctx.fillStyle = part.color;
      ctx.fillText(part.text, x + part.x, 8 + index * HUD_ROW_HEIGHT);
    }
  });
}

export function drawOverlayPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fill: string,
  stroke?: string,
): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = fill;
  if (
    typeof ctx.roundRect === "function" &&
    typeof ctx.fill === "function" &&
    typeof ctx.beginPath === "function" &&
    typeof ctx.stroke === "function"
  ) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1), Math.max(0, radius - 0.5));
      ctx.stroke();
    }
    return;
  }
  ctx.fillRect?.(x, y, w, h);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.strokeRect?.(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  }
}

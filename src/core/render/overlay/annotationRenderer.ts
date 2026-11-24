import type { View } from "../../engine/view.js";
import type { FootprintBar } from "../../types.js";
import {
  getVisibleFootprintCellSlice,
  type FootprintSeries,
} from "../../model/footprint.js";
import { settings, type ChartViewConfig } from "../../settings.js";
import { cellTextModeFor } from "../chartLod.js";
import type { IndicatorPaneRender } from "../../indicatorTypes.js";
import {
  drawIndicatorScaleControls,
  touchPriceScaleControlSpan,
  type IndicatorScaleControlRect,
} from "../axisControlsRenderer.js";
import { placeVerticalLabels } from "../../axisLabelUtils.js";
import type { PriceAxisKeepOut } from "../priceAxisRenderer.js";
import {
  calculateVolumeProfile,
  sessionBars,
  type VolumeProfileResult,
  type VolumeProfileSettings,
} from "../../analysis/volumeProfile.js";
import type { NakedPocLevel } from "../../analysis/nakedPoc.js";
import type { ReferenceLevel } from "../../analysis/referenceLevels.js";
import type { PreviousWeekStrategyLevel, PreviousWeekStrategySettings } from "../../analysis/previousWeekStrategy.js";
import type { MondayRangeLevel, MondayRangeSettings } from "../../analysis/mondayRange.js";
import type { StrategyLevel, StrategyLineStyle } from "../../analysis/strategyLevels.js";
import { periodPrefix, periodUnit } from "../../analysis/periods.js";
import { uiColor, nakedPocPalette, lineLabelPillBg } from "../../ui/seriesPalette.js";
import { levelStartX } from "../levelAnchor.js";
import { drawOverlayPill } from "./hudRenderer.js";
import type { Crosshair } from "./interactionOverlayRenderer.js";
import {
  cellTextCacheKey,
  formatFootprintCellText,
  getOrCreateBarCellTextCache,
  getOrCreateBarCellTextEntries,
  getOrFormatBarCellText,
  type BarCellTextCacheEntry,
  type FormattedCellText,
} from "./footprintCellText.js";

export type { BarCellTextCacheEntry, FormattedCellText };

export interface VolumeProfileCacheState {
  key: string;
  result: VolumeProfileResult;
  maxVolume: number;
}

export interface LineLabelEntry {
  price: number;
  text: string;
  color: string;
  priority: number;
}

export interface IndicatorAxisRect {
  paneId: string;
  plotX: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnnotationRendererHost {
  readonly ctx: CanvasRenderingContext2D;
  readonly showNotional: boolean;
  readonly chartConfig: ChartViewConfig | null;
  profileCache: VolumeProfileCacheState | null;
  readonly cellTextCache: WeakMap<FootprintBar, BarCellTextCacheEntry>;
  readonly lineLabels: readonly LineLabelEntry[];
  readonly getProfileSettings?: () => VolumeProfileSettings;
  readonly getPreviousWeekStrategySettings?: () => PreviousWeekStrategySettings;
  readonly getPreviousWeekStrategyLevels?: () => PreviousWeekStrategyLevel[];
  readonly getMondayRangeSettings?: () => MondayRangeSettings;
  readonly getMondayRangeLevels?: () => MondayRangeLevel[];
  readonly getNakedPocs?: () => NakedPocLevel[];
  readonly getReferenceLevels?: () => ReferenceLevel[];
  readonly getIndicatorPanes?: () => IndicatorPaneRender[];
  readonly getIndicatorPriceOverlays?: () => IndicatorPaneRender[];
  readonly drawIndicatorPaneBackgroundFn?: (
    ctx: CanvasRenderingContext2D,
    view: View,
    rect: { top: number; height: number }
  ) => void;
  pushIndicatorAxisRect(rect: IndicatorAxisRect): void;
  pushIndicatorScaleControlRects(rects: IndicatorScaleControlRect[]): void;
  queueLineObject(price: number, text: string, color: string, priority?: number): void;
  queuePriceMarker(price: number, color: string, priority?: number): void;
}

export function lineLabelPriority(text: string): number {
  if (/current|last/i.test(text)) return 100;
  if (/PPOC|POC|NPOC/i.test(text)) return 70;
  if (/VAH|VAL|VWAP/i.test(text)) return 60;
  if (/LVW|HVW|D-H|D-L|H-H|H-L/i.test(text)) return 50;
  return 40;
}

export function drawPreviousWeekStrategy(host: AnnotationRendererHost, view: View, series: FootprintSeries): void {
  const cfg = host.getPreviousWeekStrategySettings?.();
  if (!cfg) return;
  drawStrategyLevels(host, view, series, cfg, host.getPreviousWeekStrategyLevels?.() ?? []);
}

export function drawMondayRange(host: AnnotationRendererHost, view: View, series: FootprintSeries): void {
  const cfg = host.getMondayRangeSettings?.();
  if (!cfg) return;
  drawStrategyLevels(host, view, series, cfg, host.getMondayRangeLevels?.() ?? []);
}

function drawStrategyLevels<TId extends string, TGroup extends string>(
  host: AnnotationRendererHost,
  view: View,
  series: FootprintSeries,
  cfg: { enabled: boolean; visible: Record<TId, boolean> },
  rawLevels: readonly StrategyLevel<TId, TGroup>[]
): void {
  if (!cfg.enabled) return;
  const levels = rawLevels.filter((level) => cfg.visible[level.id] !== false);
  if (!levels.length) return;
  const ctx = host.ctx;
  const x = levelStartX(view, series, levels[0].sourceEnd);
  const right = view.area.left + view.area.width;
  const zoneLevels: typeof levels = [];
  const lineLevels: typeof levels = [];
  for (const item of levels) {
    if (item.kind === "zone") zoneLevels.push(item);
    else if (item.kind === "line") lineLevels.push(item);
  }
  ctx.save();
  for (const level of zoneLevels) {
    if (level.fromPrice == null || level.toPrice == null) continue;
    const y1 = view.yOfPrice(level.fromPrice);
    const y2 = view.yOfPrice(level.toPrice);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    if (bottom < view.area.top || top > view.area.top + view.area.height) continue;
    ctx.globalAlpha = level.fillOpacity ?? 0.14;
    ctx.fillStyle = level.color;
    ctx.fillRect(
      x,
      Math.max(view.area.top, top),
      right - x,
      Math.max(1, Math.min(view.area.top + view.area.height, bottom) - Math.max(view.area.top, top))
    );
    ctx.globalAlpha = 1;
    const mid = (level.fromPrice + level.toPrice) / 2;
    host.queueLineObject(mid, level.label, level.color, level.priority ?? 62);
  }
  for (const level of lineLevels) {
    if (level.price == null) continue;
    const y = view.yOfPrice(level.price);
    if (y < view.area.top || y > view.area.top + view.area.height) continue;
    ctx.strokeStyle = level.color;
    ctx.lineWidth = level.lineWidth ?? 1.2;
    ctx.setLineDash(lineDash(level.lineStyle));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    host.queueLineObject(level.price, level.label, level.color, level.priority);
  }
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawVolumeProfile(
  host: AnnotationRendererHost,
  view: View,
  series: FootprintSeries,
  [from, to]: [number, number]
): void {
  const cfg = host.getProfileSettings?.();
  if (!cfg || !settings.volumeProfile || from >= to) return;
  const all = series.listReadonly();
  const visible = all.slice(from, to);
  const anchor = visible[visible.length - 1]?.startTime;
  const selected = cfg.mode === "session" && anchor !== undefined ? sessionBars(all, anchor) : visible;
  const last = selected[selected.length - 1];
  const key = [
    cfg.mode, cfg.valueAreaPercent, selected.length, selected[0]?.startTime ?? 0,
    last?.startTime ?? 0, series.revision,
  ].join("|");
  if (host.profileCache?.key !== key) {
    const result = calculateVolumeProfile(selected, cfg.valueAreaPercent);
    let maxVolume = 0;
    for (const level of result.levels) {
      if (level.totalVol > maxVolume) maxVolume = level.totalVol;
    }
    host.profileCache = { key, result, maxVolume };
  }
  const result = host.profileCache.result;
  if (!result.levels.length) return;

  const ctx = host.ctx;
  const step = series.config.priceStep;
  const maxVolume = host.profileCache.maxVolume;
  const maxWidth = Math.min(180, Math.max(80, view.area.width * 0.22));
  const right = view.area.left + view.area.width - 4;
  ctx.save();
  for (const level of result.levels) {
    const yTop = view.yOfPrice(level.priceBin + step);
    const yBottom = view.yOfPrice(level.priceBin);
    if (yBottom < view.area.top || yTop > view.area.top + view.area.height) continue;
    const width = maxWidth * (level.totalVol / maxVolume);
    const buyWidth = width * (level.buyVol / Math.max(level.totalVol, Number.EPSILON));
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = uiColor.sell;
    ctx.fillRect(right - width, yTop, width - buyWidth, Math.max(1, yBottom - yTop - 1));
    ctx.fillStyle = uiColor.buy;
    ctx.fillRect(right - buyWidth, yTop, buyWidth, Math.max(1, yBottom - yTop - 1));
  }
  ctx.globalAlpha = 1;
  drawProfileLevel(host, view, result.poc, "PPOC", uiColor.warn, settings.profilePoc);
  drawProfileLevel(host, view, result.vah, "VAH", uiColor.info, settings.profileVah);
  drawProfileLevel(host, view, result.val, "VAL", uiColor.info, settings.profileVal);
  ctx.restore();
}

function drawProfileLevel(
  host: AnnotationRendererHost,
  view: View,
  price: number | null,
  label: string,
  color: string,
  enabled: boolean
): void {
  if (!enabled || price === null) return;
  const y = view.yOfPrice(price);
  if (y < view.area.top || y > view.area.top + view.area.height) return;
  const ctx = host.ctx;
  ctx.strokeStyle = color;
  ctx.setLineDash(label === "PPOC" ? [] : [5, 4]);
  ctx.beginPath();
  ctx.moveTo(view.area.left, y);
  ctx.lineTo(view.area.left + view.area.width, y);
  ctx.stroke();
  ctx.setLineDash([]);
  host.queueLineObject(price, label, color);
}

export function drawCells(host: AnnotationRendererHost, view: View, series: FootprintSeries, [from, to]: [number, number]): void {
  const ctx = host.ctx;
  const step = series.config.priceStep;
  // Representative row height at the screen midpoint (varies per-price in log).
  const midPrice = view.priceOfY(view.area.top + view.area.height / 2);
  const cellH = Math.abs(view.yOfPrice(midPrice) - view.yOfPrice(midPrice + step));
  // Cell text mode depends on the active footprint chart type (separate
  // memory for Cluster vs Profile). No cell text for plain candlesticks.
  const chartCfg = host.chartConfig ?? settings;
  let mode: typeof settings.clusterCellData;
  if (chartCfg.chartType === "footprint") mode = chartCfg.clusterCellData;
  else if (chartCfg.chartType === "footprintProfile") mode = chartCfg.profileCellData;
  else return;
  if (!chartCfg.cellNumbers) return;

  const candleW = view.candleStripWidth();
  const fpW = view.colWidth - candleW;
  const textMode = cellTextModeFor(cellH, fpW);
  if (textMode === "none") return;
  // Between the heat layer's threshold and a full bid/ask pair there is a wide band
  // where cells were shaded but never labelled. There, one centred value per cell is
  // readable where two are not.
  const compact = textMode === "compact";
  const pTop = view.priceOfY(view.area.top);
  const pBot = view.priceOfY(view.area.top + view.area.height);
  const minVisPrice = Math.min(pTop, pBot) - step;
  const maxVisPrice = Math.max(pTop, pBot) + step;
  const showNotional = host.showNotional;

  ctx.font = `${Math.min(12, cellH - 2)}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = "middle";

  const cacheKey = cellTextCacheKey(mode, compact, showNotional, step);

  for (let i = from; i < to; i++) {
    const bar = series.at(i);
    if (!bar) continue;
    const fpLeft = view.xOfIndex(i) + candleW;
    const half = fpW / 2;

    const barCache = getOrCreateBarCellTextCache(host.cellTextCache, bar, cacheKey);
    const slice = getVisibleFootprintCellSlice(bar, minVisPrice, maxVisPrice, step);
    const iterCells = slice !== null ? slice.cells : null;
    const drawCell = (cell: FootprintBar["cells"] extends Map<number, infer C> ? C : never) => {
      if (cell.priceBin + step < minVisPrice || cell.priceBin > maxVisPrice) return;
      const yMid = view.yOfPrice(cell.priceBin + step / 2);
      if (yMid < view.area.top || yMid > view.area.top + view.area.height) return;

      const entry = getOrFormatBarCellText(barCache, cell, mode, compact, step, showNotional);

      if (entry.centerText !== undefined) {
        ctx.fillStyle = entry.centerColor!;
        ctx.textAlign = "center";
        ctx.fillText(entry.centerText, fpLeft + half, yMid);
      } else {
        ctx.fillStyle = entry.leftColor!;
        ctx.textAlign = "right";
        ctx.fillText(entry.leftText!, fpLeft + half - 4, yMid);

        ctx.fillStyle = entry.rightColor!;
        ctx.textAlign = "left";
        ctx.fillText(entry.rightText!, fpLeft + half + 4, yMid);
      }
    };
    if (iterCells !== null && slice !== null) {
      for (let c = slice.start; c < slice.end; c++) {
        drawCell(iterCells[c]);
      }
    } else {
      for (const cell of bar.cells.values()) {
        drawCell(cell);
      }
    }
  }
}

/** Indicator sub-panes in the band below the plot, above the time axis. */
export function drawSubPanes(
  host: AnnotationRendererHost,
  view: View,
  series: FootprintSeries,
  range: [number, number],
  crosshair?: Crosshair,
  drawControls = true,
): void {
  if (view.subPanesH <= 0) return;
  const ctx = host.ctx;
  const indicatorPanes = host.getIndicatorPanes?.() ?? [];
  if (indicatorPanes.length) {
    // Fill the price-axis gutter band next to the sub-panes up front so
    // indicator axis ticks drawn into it survive; drawPriceAxis only fills
    // the gutter down to the main plot bottom.
    const axisX = view.area.left + view.area.width;
    if (view.priceAxisW > 0) {
      ctx.fillStyle = uiColor.bgApp;
      ctx.fillRect(axisX, view.area.top + view.area.height, view.priceAxisW, view.subPanesH);
      ctx.strokeStyle = uiColor.separator;
      ctx.beginPath();
      ctx.moveTo(axisX + 0.5, view.area.top + view.area.height);
      ctx.lineTo(axisX + 0.5, view.area.top + view.area.height + view.subPanesH);
      ctx.stroke();
    }
    let top = view.area.top + view.area.height;
    for (const pane of indicatorPanes) {
      const rect = { top, height: pane.height };
      host.pushIndicatorAxisRect({ paneId: pane.id, plotX: view.area.left, x: axisX, y: top, w: view.priceAxisW, h: pane.height });
      if (view.priceAxisW > 0) {
        ctx.strokeStyle = uiColor.separatorStrong;
        ctx.beginPath();
        ctx.moveTo(axisX, top + 0.5);
        ctx.lineTo(axisX + view.priceAxisW, top + 0.5);
        ctx.stroke();
      }
      host.drawIndicatorPaneBackgroundFn?.(ctx, view, rect);
      pane.draw(ctx, view, series, rect, range, crosshair);
      if (drawControls) {
        host.pushIndicatorScaleControlRects(drawIndicatorScaleControls(
          ctx,
          axisX,
          view.priceAxisW,
          { ...rect, id: pane.id, scaleMode: pane.scaleMode },
          crosshair,
        ));
      }
      top += pane.height;
    }
    if (view.priceAxisW > 0) {
      ctx.strokeStyle = uiColor.separatorStrong;
      ctx.beginPath();
      ctx.moveTo(axisX, top - 0.5);
      ctx.lineTo(axisX + view.priceAxisW, top - 0.5);
      ctx.stroke();
    }
  }
}

export function drawIndicatorPriceOverlays(
  host: AnnotationRendererHost,
  view: View,
  series: FootprintSeries,
  range: [number, number],
  crosshair?: Crosshair,
): void {
  const overlays = host.getIndicatorPriceOverlays?.() ?? [];
  if (!overlays.length) return;
  const rect = { top: view.area.top, height: view.area.height };
  for (const overlay of overlays) {
    overlay.draw(host.ctx, view, series, rect, range, crosshair);
  }
}

/** Horizontal dashed line + colored axis label at the latest bar's close. */
export function drawLastPrice(host: AnnotationRendererHost, view: View, series: FootprintSeries): void {
  const bar = series.at(series.length - 1);
  if (!bar) return;
  const prev = series.at(series.length - 2);
  const up = !prev || bar.close >= prev.close;
  const color = up ? uiColor.buy : uiColor.sell;
  const y = view.yOfPrice(bar.close);
  if (y < view.area.top || y > view.area.top + view.area.height) return;
  const ctx = host.ctx;
  const axisX = view.area.left + view.area.width;

  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(view.area.left, y);
  ctx.lineTo(axisX, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  host.queuePriceMarker(bar.close, color, 100);
}

export function drawNakedPocs(host: AnnotationRendererHost, view: View, series: FootprintSeries): void {
  const levels = host.getNakedPocs?.() ?? [];
  const ctx = host.ctx;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([7, 4]);
  for (const level of levels) {
    const y = view.yOfPrice(level.price);
    if (y < view.area.top || y > view.area.top + view.area.height) continue;
    const x = levelStartX(view, series, level.periodEnd);
    const prefix = periodPrefix(level.period);
    const unit = periodUnit(level.period);
    const color = nakedPocColor(level.period);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(view.area.left + view.area.width, y);
    ctx.stroke();
    host.queueLineObject(level.price, `${prefix}-NPOC · ${level.age} ${unit}`, color);
  }
  ctx.restore();
}

export function drawReferenceLevels(host: AnnotationRendererHost, view: View, series: FootprintSeries): void {
  const levels = host.getReferenceLevels?.() ?? [];
  const ctx = host.ctx;
  ctx.save();
  ctx.lineWidth = 1;
  for (const level of levels) {
    const y = view.yOfPrice(level.price);
    if (y < view.area.top || y > view.area.top + view.area.height) continue;
    const start = level.family === "open" ? level.sourceStart : level.sourceEnd;
    const x = levelStartX(view, series, start);
    ctx.strokeStyle = level.color;
    ctx.setLineDash(level.family === "level" ? [4, 3] : level.family === "eq" ? [8, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(view.area.left + view.area.width, y);
    ctx.stroke();
    host.queueLineObject(level.price, level.label, level.color);
  }
  ctx.restore();
}

export function drawLineLabels(host: AnnotationRendererHost, view: View): void {
  const ctx = host.ctx;
  ctx.save();
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const boxH = 14;
  const candidates = host.lineLabels
    .map((label) => ({ ...label, desiredY: view.yOfPrice(label.price), boxH }))
    .filter((label) => label.desiredY >= view.area.top && label.desiredY <= view.area.top + view.area.height);
  const labels = placeVerticalLabels(candidates, view.area.top, view.area.top + view.area.height, 2);
  for (const label of labels) {
    const width = ctx.measureText(label.text).width + 12;
    const x = view.area.left + view.area.width - 4;
    const boxX = x - width;
    const boxY = label.y - boxH / 2;
    drawOverlayPill(ctx, boxX, boxY, width, boxH, 4, lineLabelPillBg, "rgba(148, 163, 184, 0.22)");
    ctx.fillStyle = label.color;
    ctx.fillRect?.(boxX + 1, boxY + 2, 2, Math.max(2, boxH - 4));
    ctx.fillText(label.text, x - 4, label.y);
  }
  ctx.restore();
}

/** Price tick labels keep clear of the finger-sized scale buttons, which stand in the gutter in touch mode. */
export function priceAxisKeepOut(view: View, crosshair: Crosshair): PriceAxisKeepOut[] {
  if (!crosshair.touch) return [];
  const span = touchPriceScaleControlSpan(view);
  return span ? [span] : [];
}

function nakedPocColor(period: NakedPocLevel["period"]): string {
  return period === "daily" ? nakedPocPalette.daily
    : period === "weekly" ? nakedPocPalette.weekly
    : period === "monthly" ? nakedPocPalette.monthly
    : period === "quarterly" ? nakedPocPalette.quarterly
    : period === "half-yearly" ? nakedPocPalette.halfYearly
    : nakedPocPalette.yearly;
}

function lineDash(style: StrategyLineStyle | undefined): number[] {
  if (style === "dashed") return [6, 4];
  if (style === "dotted") return [3, 3];
  if (style === "long-dashed") return [10, 4];
  return [];
}

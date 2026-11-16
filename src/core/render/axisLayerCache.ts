import { priceDecimals } from "../axisLabelUtils.js";
import { chartLocale } from "../chartLocale.js";
import { PriceScaleMode, type View } from "../engine/view.js";
import { axisLayoutForChartView } from "../model/axisLayout.js";
import type { ResolvedChartDisplayOptions } from "../model/chartDisplayOptions.js";
import type { FootprintSeries } from "../model/footprint.js";
import { incrementPerformanceCounter } from "../performanceTelemetry.js";
import { axisMajorLabelColor, axisMajorTickColor, uiColor } from "../ui/seriesPalette.js";
import {
  drawPriceAxis,
  drawPriceAxisGridLines,
  drawPriceAxisStrip,
  type PriceAxisKeepOut,
} from "./priceAxisRenderer.js";
import { drawTimeAxis, type TimeMarker } from "./timeAxisRenderer.js";

/** Extra CSS px kept on the left of the price-axis offscreen strip so long labels never clip. */
const PRICE_LABEL_OVERFLOW_PX = 48;

interface AxisTransform {
  readonly a: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

interface DeviceBounds {
  readonly devX: number;
  readonly devY: number;
  readonly devW: number;
  readonly devH: number;
}

interface PriceAxisCacheEntry {
  readonly key: string;
  readonly gridYs: readonly number[];
  readonly devX: number;
  readonly devY: number;
  readonly hasBitmap: boolean;
  readonly axisX: number;
  readonly subPaneSeparatorTop: number;
  readonly subPaneSeparatorBottom: number;
}

interface TimeAxisCacheEntry {
  readonly key: string;
  readonly series: FootprintSeries;
  readonly devX: number;
  readonly devY: number;
  readonly hasBitmap: boolean;
}

/**
 * Offscreen bitmap cache for the static parts of the Annotation `"axis"` layer.
 *
 * Price-axis ticks/backgrounds and time-axis ticks/backgrounds sit outside the main plot
 * and are reused across high-frequency live `"last-price"` updates. Plot horizontal grid
 * lines stay drawn directly onto the main canvas from cached y coordinates so alpha blending
 * over plot content stays pixel-identical, and `"last-price"` / price markers always render live.
 */
export class AxisLayerCache {
  private priceCanvas: HTMLCanvasElement | null = null;
  private timeCanvas: HTMLCanvasElement | null = null;
  private priceEntry: PriceAxisCacheEntry | null = null;
  private timeEntry: TimeAxisCacheEntry | null = null;
  private hasLastTimeViewport = false;
  private lastTimeOffsetX = Number.NaN;
  private lastTimeColWidth = Number.NaN;

  renderPriceAxis(
    ctx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    keepOut: readonly PriceAxisKeepOut[],
    displayOptions: ResolvedChartDisplayOptions,
  ): void {
    const priceStep = series.config.priceStep;
    const pricePrecision = series.config.pricePrecision;
    const env = resolveOffscreenEnvironment(ctx, view);
    if (!env) {
      drawPriceAxis(ctx, view, priceStep, pricePrecision, keepOut, displayOptions);
      return;
    }

    const layout = axisLayoutForChartView(view);
    const axisX = layout.priceAxisRect.left;
    const axisW = layout.priceAxisRect.width;
    const gutterFillH = Math.min(layout.priceAxisRect.height, view.area.top + view.area.height);
    if (axisW <= 0 || gutterFillH <= 0) {
      drawPriceAxis(ctx, view, priceStep, pricePrecision, keepOut, displayOptions);
      return;
    }

    const bounds = computeDeviceBounds(
      axisX - PRICE_LABEL_OVERFLOW_PX,
      layout.priceAxisRect.top,
      axisX + axisW,
      layout.priceAxisRect.top + gutterFillH,
      env.canvasW,
      env.canvasH,
      env.tx,
      1,
      0,
    );
    if (bounds.devW <= 0 || bounds.devH <= 0) {
      drawPriceAxis(ctx, view, priceStep, pricePrecision, keepOut, displayOptions);
      return;
    }

    const key = buildPriceAxisKey(view, series, keepOut, displayOptions, env.canvasW, env.canvasH, env.tx);
    if (this.priceEntry && this.priceEntry.key === key) {
      incrementPerformanceCounter("chart.annotation.axis.price.cache.hit");
      drawPriceAxisGridLines(ctx, view, this.priceEntry.gridYs);
      if (this.priceEntry.hasBitmap && this.priceCanvas) {
        blitOffscreenCanvas(ctx, this.priceCanvas, this.priceEntry.devX, this.priceEntry.devY);
      }
      strokeSubPaneSeparator(ctx, this.priceEntry);
      return;
    }

    const offscreen = this.ensurePriceCanvas(env.doc, bounds.devW, bounds.devH);
    const offCtx = offscreen.getContext("2d");
    if (!offCtx || typeof offCtx.setTransform !== "function") {
      drawPriceAxis(ctx, view, priceStep, pricePrecision, keepOut, displayOptions);
      return;
    }

    incrementPerformanceCounter("chart.annotation.axis.price.cache.miss");
    offCtx.save();
    offCtx.setTransform(1, 0, 0, 1, 0, 0);
    offCtx.clearRect(0, 0, bounds.devW, bounds.devH);
    offCtx.setTransform(env.tx.a, 0, 0, env.tx.d, env.tx.e - bounds.devX, env.tx.f - bounds.devY);
    const gridYs = drawPriceAxisStrip(offCtx, view, priceStep, pricePrecision, keepOut, displayOptions);
    offCtx.restore();

    const separatorTop = layout.priceAxisRect.top + gutterFillH;
    const separatorBottom = view.subPanesH > 0 ? layout.cornerRect.top : separatorTop;
    const entry: PriceAxisCacheEntry = {
      key,
      gridYs,
      devX: bounds.devX,
      devY: bounds.devY,
      hasBitmap: true,
      axisX,
      subPaneSeparatorTop: separatorTop,
      subPaneSeparatorBottom: separatorBottom,
    };
    this.priceEntry = entry;

    drawPriceAxisGridLines(ctx, view, entry.gridYs);
    blitOffscreenCanvas(ctx, offscreen, entry.devX, entry.devY);
    strokeSubPaneSeparator(ctx, entry);
  }

  renderTimeAxis(
    ctx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    timeMarkers: readonly TimeMarker[],
  ): void {
    const offsetX = view.offsetX;
    const colWidth = view.colWidth;
    // Active pan/zoom changes offsetX/colWidth every frame: bypass the offscreen
    // bitmap and draw straight onto ctx to avoid clearRect + offscreen blit overhead.
    if (this.hasLastTimeViewport && (this.lastTimeOffsetX !== offsetX || this.lastTimeColWidth !== colWidth)) {
      this.timeEntry = null;
      this.lastTimeOffsetX = offsetX;
      this.lastTimeColWidth = colWidth;
      incrementPerformanceCounter("chart.annotation.axis.time.cache.bypass");
      drawTimeAxis(ctx, view, series, undefined, timeMarkers);
      return;
    }

    const env = resolveOffscreenEnvironment(ctx, view);
    if (!env) {
      this.timeEntry = null;
      this.hasLastTimeViewport = false;
      drawTimeAxis(ctx, view, series, undefined, timeMarkers);
      return;
    }

    const layout = axisLayoutForChartView(view);
    const axis = layout.timeAxisRect;
    const corner = layout.cornerRect;
    const right = Math.max(axis.left + axis.width, corner.left + corner.width);
    const bottom = Math.max(axis.top + axis.height, corner.top + corner.height);
    const bounds = computeDeviceBounds(axis.left, axis.top, right, bottom, env.canvasW, env.canvasH, env.tx, 0, 0);
    if (bounds.devW <= 0 || bounds.devH <= 0) {
      this.timeEntry = null;
      this.hasLastTimeViewport = false;
      drawTimeAxis(ctx, view, series, undefined, timeMarkers);
      return;
    }

    const key = buildTimeAxisKey(view, series, timeMarkers, env.canvasW, env.canvasH, env.tx);
    if (this.timeEntry && this.timeEntry.key === key && this.timeEntry.series === series) {
      incrementPerformanceCounter("chart.annotation.axis.time.cache.hit");
      if (this.timeEntry.hasBitmap && this.timeCanvas) {
        blitOffscreenCanvas(ctx, this.timeCanvas, this.timeEntry.devX, this.timeEntry.devY);
      }
      return;
    }

    const offscreen = this.ensureTimeCanvas(env.doc, bounds.devW, bounds.devH);
    const offCtx = offscreen.getContext("2d");
    if (!offCtx || typeof offCtx.setTransform !== "function") {
      this.timeEntry = null;
      this.hasLastTimeViewport = false;
      drawTimeAxis(ctx, view, series, undefined, timeMarkers);
      return;
    }

    incrementPerformanceCounter("chart.annotation.axis.time.cache.miss");
    offCtx.save();
    offCtx.setTransform(1, 0, 0, 1, 0, 0);
    offCtx.clearRect(0, 0, bounds.devW, bounds.devH);
    offCtx.setTransform(env.tx.a, 0, 0, env.tx.d, env.tx.e - bounds.devX, env.tx.f - bounds.devY);
    drawTimeAxis(offCtx, view, series, undefined, timeMarkers);
    offCtx.restore();

    const entry: TimeAxisCacheEntry = {
      key,
      series,
      devX: bounds.devX,
      devY: bounds.devY,
      hasBitmap: true,
    };
    this.timeEntry = entry;
    this.lastTimeOffsetX = offsetX;
    this.lastTimeColWidth = colWidth;
    this.hasLastTimeViewport = true;
    blitOffscreenCanvas(ctx, offscreen, entry.devX, entry.devY);
  }

  invalidate(): void {
    this.priceEntry = null;
    this.timeEntry = null;
    this.hasLastTimeViewport = false;
    this.lastTimeOffsetX = Number.NaN;
    this.lastTimeColWidth = Number.NaN;
  }

  dispose(): void {
    this.invalidate();
    releaseCanvas(this.priceCanvas);
    releaseCanvas(this.timeCanvas);
    this.priceCanvas = null;
    this.timeCanvas = null;
  }

  private ensurePriceCanvas(doc: Document, width: number, height: number): HTMLCanvasElement {
    if (!this.priceCanvas) {
      this.priceCanvas = doc.createElement("canvas");
    }
    if (this.priceCanvas.width !== width) this.priceCanvas.width = width;
    if (this.priceCanvas.height !== height) this.priceCanvas.height = height;
    return this.priceCanvas;
  }

  private ensureTimeCanvas(doc: Document, width: number, height: number): HTMLCanvasElement {
    if (!this.timeCanvas) {
      this.timeCanvas = doc.createElement("canvas");
    }
    if (this.timeCanvas.width !== width) this.timeCanvas.width = width;
    if (this.timeCanvas.height !== height) this.timeCanvas.height = height;
    return this.timeCanvas;
  }
}

function resolveOffscreenEnvironment(
  ctx: CanvasRenderingContext2D,
  view: View,
): { doc: Document; canvasW: number; canvasH: number; tx: AxisTransform } | null {
  const canvasW = ctx.canvas?.width ?? 0;
  const canvasH = ctx.canvas?.height ?? 0;
  const doc = ctx.canvas?.ownerDocument;
  if (
    !(canvasW > 0) ||
    !(canvasH > 0) ||
    !doc ||
    typeof doc.createElement !== "function" ||
    typeof ctx.drawImage !== "function" ||
    typeof ctx.setTransform !== "function"
  ) {
    return null;
  }

  const rawTx = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  if (
    rawTx &&
    Number.isFinite(rawTx.a) &&
    Number.isFinite(rawTx.b) &&
    Number.isFinite(rawTx.c) &&
    Number.isFinite(rawTx.d) &&
    Number.isFinite(rawTx.e) &&
    Number.isFinite(rawTx.f)
  ) {
    if (rawTx.b !== 0 || rawTx.c !== 0 || rawTx.a <= 0 || rawTx.d <= 0) return null;
    return {
      doc,
      canvasW,
      canvasH,
      tx: { a: rawTx.a, d: rawTx.d, e: rawTx.e, f: rawTx.f },
    };
  }

  const dpr = view.pixelRatio !== null && view.pixelRatio !== undefined && view.pixelRatio > 0 ? view.pixelRatio : 1;
  return {
    doc,
    canvasW,
    canvasH,
    tx: { a: dpr, d: dpr, e: 0, f: 0 },
  };
}

function computeDeviceBounds(
  cssLeft: number,
  cssTop: number,
  cssRight: number,
  cssBottom: number,
  canvasW: number,
  canvasH: number,
  tx: AxisTransform,
  padLeftDev: number,
  padTopDev: number,
): DeviceBounds {
  const devX = Math.max(0, Math.floor(cssLeft * tx.a + tx.e) - padLeftDev);
  const devY = Math.max(0, Math.floor(cssTop * tx.d + tx.f) - padTopDev);
  const maxX = Math.min(canvasW, Math.ceil(cssRight * tx.a + tx.e));
  const maxY = Math.min(canvasH, Math.ceil(cssBottom * tx.d + tx.f));
  return {
    devX,
    devY,
    devW: Math.max(0, maxX - devX),
    devH: Math.max(0, maxY - devY),
  };
}

function buildPriceAxisKey(
  view: View,
  series: FootprintSeries,
  keepOut: readonly PriceAxisKeepOut[],
  displayOptions: ResolvedChartDisplayOptions,
  canvasW: number,
  canvasH: number,
  tx: AxisTransform,
): string {
  const dec = series.config.pricePrecision ?? priceDecimals(series.config.priceStep);
  const scaleState = view.priceScaleState;
  const logAnchor = scaleState.mode === PriceScaleMode.Logarithmic ? view.fromScale(view.priceTop) : 0;
  const keepOutKey = keepOut.length === 0 ? "" : keepOut.map((z) => `${z.y}:${z.h}`).join(",");
  return [
    canvasW,
    canvasH,
    tx.a,
    tx.d,
    tx.e,
    tx.f,
    view.pixelRatio ?? "",
    view.area.left,
    view.area.top,
    view.area.width,
    view.area.height,
    view.priceAxisW,
    view.subPanesH,
    view.chartLayoutOptions.timeAxisHeight,
    view.chartLayoutOptions.density,
    view.priceTop,
    view.pricePerPx,
    scaleState.mode,
    scaleState.tickMarkDensity,
    logAnchor,
    series.config.priceStep,
    dec,
    displayOptions.numberLocale,
    keepOutKey,
    uiColor.bgApp,
    uiColor.separator,
    axisMajorLabelColor,
  ].join("|");
}

function buildTimeAxisKey(
  view: View,
  series: FootprintSeries,
  timeMarkers: readonly TimeMarker[],
  canvasW: number,
  canvasH: number,
  tx: AxisTransform,
): string {
  const lastIdx = series.length - 1;
  const firstStart = series.length > 0 ? (series.at(0)?.startTime ?? "") : "";
  const lastStart = lastIdx >= 0 ? (series.at(lastIdx)?.startTime ?? "") : "";
  const structureRevision = (series as { structureRevision?: number }).structureRevision ?? "";
  const timeOpts = view.timeScaleOptions;
  const timeMarkersKey = timeMarkers.length === 0
    ? ""
    : timeMarkers.map((m) => `${m.time}:${m.text}:${m.color}:${m.priority}`).join(",");
  return [
    canvasW,
    canvasH,
    tx.a,
    tx.d,
    tx.e,
    tx.f,
    view.pixelRatio ?? "",
    view.area.left,
    view.area.top,
    view.area.width,
    view.area.height,
    view.priceAxisW,
    view.subPanesH,
    view.chartLayoutOptions.timeAxisHeight,
    view.chartLayoutOptions.density,
    view.colWidth,
    view.offsetX,
    timeOpts.visibleRangeEdgePaddingBars,
    timeOpts.tickMarkMaxCharacterLength,
    timeOpts.tickMarkFontSize,
    timeOpts.tickMarkMaxLabelWidth ?? "",
    timeOpts.uniformDistribution ? 1 : 0,
    timeOpts.ignoreWhitespaceIndices ? 1 : 0,
    structureRevision,
    series.length,
    series.config.intervalMs,
    firstStart,
    lastStart,
    safeLocaleAndTimezoneKey(),
    timeMarkersKey,
    uiColor.bgApp,
    uiColor.separator,
    uiColor.textSecondary,
    axisMajorTickColor,
    axisMajorLabelColor,
  ].join("|");
}

function safeLocaleAndTimezoneKey(): string {
  try {
    const loc = chartLocale();
    return `${loc.locale()}|${loc.timeZone()}`;
  } catch {
    return "unconfigured";
  }
}

function blitOffscreenCanvas(
  ctx: CanvasRenderingContext2D,
  offscreen: HTMLCanvasElement,
  devX: number,
  devY: number,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(offscreen, devX, devY);
  ctx.restore();
}

function strokeSubPaneSeparator(ctx: CanvasRenderingContext2D, entry: PriceAxisCacheEntry): void {
  if (!(entry.subPaneSeparatorBottom > entry.subPaneSeparatorTop)) return;
  ctx.strokeStyle = uiColor.separator;
  ctx.beginPath();
  ctx.moveTo(entry.axisX + 0.5, entry.subPaneSeparatorTop);
  ctx.lineTo(entry.axisX + 0.5, entry.subPaneSeparatorBottom);
  ctx.stroke();
}

function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

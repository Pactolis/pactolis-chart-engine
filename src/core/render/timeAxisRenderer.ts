import type { View } from "../engine/view.js";
import type { FootprintSeries } from "../model/footprint.js";
import { TickMarkWeight, TimeScaleModel } from "../model/timeScale.js";
import { alignLabelCenter, axisLayoutForChartView } from "../model/axisLayout.js";
import { tzDateTimeHud, tzDay, tzHM, tzMonth, tzYear } from "../tzFormat.js";
import type { Crosshair } from "./overlay.js";
import { uiColor, axisMajorLabelColor, axisLabelBorderColor, axisMajorTickColor, timeAxisCrosshairLabelBg } from "../ui/seriesPalette.js";

export interface TimeMarker {
  time: number;
  text: string;
  color: string;
  priority: number;
}

export function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  crosshair?: Crosshair,
  timeMarkers: readonly TimeMarker[] = []
): void {
  const layout = axisLayoutForChartView(view);
  const axis = layout.timeAxisRect;
  const corner = layout.cornerRect;
  const axisY = axis.top;
  ctx.fillStyle = uiColor.bgApp;
  ctx.fillRect(axis.left, axis.top, axis.width, axis.height);
  ctx.fillRect(corner.left, corner.top, corner.width, corner.height);
  ctx.strokeStyle = uiColor.separator;
  ctx.beginPath();
  ctx.moveTo(axis.left, axisY + 0.5);
  ctx.lineTo(axis.left + axis.width, axisY + 0.5);
  ctx.moveTo(corner.left + 0.5, corner.top);
  ctx.lineTo(corner.left + 0.5, corner.top + corner.height);
  ctx.stroke();

  if (series.length === 0 || axis.width <= 0 || axis.height <= 0) return;

  const timeScale = TimeScaleModel.fromSeries(series);
  const marks = timeScale.marks(view, { formatLabel: formatTimeAxisTick });
  const tickH = 3;

  ctx.save();
  ctx.beginPath();
  ctx.rect(axis.left, axis.top, axis.width, axis.height);
  ctx.clip();
  ctx.font = `${view.timeScaleOptions.tickMarkFontSize}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (const mark of marks) {
    const x = mark.coord;
    const labelW = ctx.measureText(mark.label).width;
    if (x < axis.left - labelW / 2 || x > axis.left + axis.width + labelW / 2) continue;
    const isMajor = mark.weight >= TickMarkWeight.Day;
    const tickX = Math.max(axis.left, Math.min(axis.left + axis.width, x));
    ctx.strokeStyle = isMajor ? axisMajorTickColor : uiColor.separator;
    ctx.beginPath();
    ctx.moveTo(tickX, axisY);
    ctx.lineTo(tickX, axisY + tickH + (isMajor ? 1 : 0));
    ctx.stroke();
    ctx.fillStyle = isMajor ? axisMajorLabelColor : uiColor.textSecondary;
    ctx.fillText(mark.label, alignLabelCenter(x, labelW, axis), axisY + tickH + 2);
  }

  drawTimeMarkers(ctx, view, series, axis, timeMarkers);

  if (crosshair?.visible) drawCrosshairTimeLabel(ctx, view, series, crosshair);
  ctx.restore();
}

/** Draw only the high-frequency crosshair label over an already-painted time axis. */
export function drawCrosshairTimeLabel(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  crosshair: Crosshair,
): void {
  if (!crosshair.visible || series.length === 0) return;
  const layout = axisLayoutForChartView(view);
  const axis = layout.timeAxisRect;
  if (axis.width <= 0 || axis.height <= 0) return;
  const hovIdx = Math.floor(view.indexOfX(crosshair.x));
  const hx = view.xOfIndex(hovIdx) + view.colWidth / 2;
  const time = series.timeOfIndex(hovIdx);
  const timeLabel = Number.isFinite(time) ? tzDateTimeHud(time, series.config.intervalMs) : null;
  if (!timeLabel || hx < axis.left || hx > axis.left + axis.width) return;

  ctx.save();
  ctx.font = `${view.timeScaleOptions.tickMarkFontSize}px ui-monospace, monospace`;
  const labelW = ctx.measureText(timeLabel).width + 10;
  const labelX = alignLabelCenter(hx, labelW, axis);
  const labelY = axis.top + 1;
  const boxLeft = labelX - labelW / 2;
  ctx.fillStyle = timeAxisCrosshairLabelBg;
  if (typeof ctx.roundRect === "function" && typeof ctx.fill === "function") {
    ctx.beginPath();
    ctx.roundRect(boxLeft, labelY, labelW, 16, 3.5);
    ctx.fill();
    ctx.strokeStyle = axisLabelBorderColor;
    ctx.beginPath();
    ctx.roundRect(boxLeft + 0.5, labelY + 0.5, Math.max(0, labelW - 1), 15, 3);
    ctx.stroke();
  } else {
    ctx.fillRect(boxLeft, labelY, labelW, 16);
    ctx.strokeStyle = axisLabelBorderColor;
    ctx.strokeRect(boxLeft + 0.5, labelY + 0.5, labelW - 1, 15);
  }
  ctx.fillStyle = uiColor.textHeading;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(timeLabel, labelX, labelY + 3);
  ctx.restore();
}

function drawTimeMarkers(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  axis: { left: number; top: number; width: number; height: number },
  markers: readonly TimeMarker[],
): void {
  if (!markers.length) return;
  const intervalMs = series.config.intervalMs;
  const axisY = axis.top;
  const sorted = [...markers]
    .filter((marker) => Number.isFinite(marker.time))
    .sort((a, b) => b.priority - a.priority);
  const placed: Array<{ left: number; right: number }> = [];
  ctx.save();
  ctx.font = `${view.timeScaleOptions.tickMarkFontSize}px ui-monospace, monospace`;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  for (const marker of sorted) {
    const index = series.indexOfTime(marker.time);
    const x = view.xOfIndex(index) + view.colWidth / 2;
    if (x < axis.left || x > axis.left + axis.width) continue;
    const timeText = formatTimeAxisTick(marker.time, TickMarkWeight.Minute1, intervalMs);
    const label = marker.text ? `${timeText}` : timeText;
    const boxW = Math.min(120, Math.max(34, ctx.measureText(label).width + 10));
    const labelX = alignLabelCenter(x, boxW, axis);
    const left = labelX - boxW / 2;
    const right = labelX + boxW / 2;
    if (placed.some((item) => left <= item.right + 2 && right >= item.left - 2)) continue;
    placed.push({ left, right });
    ctx.strokeStyle = marker.color;
    ctx.beginPath();
    ctx.moveTo(x, axisY);
    ctx.lineTo(x, axisY + 6);
    ctx.stroke();
    ctx.fillStyle = marker.color;
    if (typeof ctx.roundRect === "function" && typeof ctx.fill === "function") {
      ctx.beginPath();
      ctx.roundRect(left, axisY + 1, boxW, 16, 3.5);
      ctx.fill();
    } else {
      ctx.fillRect(left, axisY + 1, boxW, 16);
    }
    ctx.fillStyle = uiColor.bgApp;
    ctx.fillText(label, labelX, axisY + 4);
  }
  ctx.restore();
}

/** Format a time-scale tick in the active chart timezone. */
function formatTimeAxisTick(time: number, weight: TickMarkWeight, intervalMs: number): string {
  if (weight >= TickMarkWeight.Year) return tzYear(time);
  if (weight >= TickMarkWeight.Month) return tzMonth(time);
  if (weight >= TickMarkWeight.Day || intervalMs >= 24 * 60 * 60_000) return tzDay(time);
  return tzHM(time);
}

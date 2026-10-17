import type { IndicatorDrawContext, IndicatorPreparedData, IndicatorSettings } from "../types.js";
import type { FootprintBar } from "../../../core/types.js";
import type { PlotSeries, SeriesPoint } from "./taShared.js";

export interface OverlayPreparedMeta extends Record<string, unknown> {
  series: Array<PlotSeries & { chartLabel?: string }>;
}

export type OverlayPreparedData = IndicatorPreparedData<SeriesPoint, OverlayPreparedMeta> & {
  points: SeriesPoint[];
  range: { min: number; max: number };
  meta: OverlayPreparedMeta;
};

export function prepareOverlayData(
  ctx: IndicatorDrawContext<IndicatorSettings>,
  series: Array<PlotSeries & { chartLabel?: string }>,
): OverlayPreparedData {
  if (!ctx.instance.visible) return emptyOverlay("hidden", "gizli");
  let min = Infinity;
  let max = -Infinity;
  let hasValue = false;
  for (const item of series) {
    for (const point of item.points) {
      const value = point.value;
      if (value === null || !Number.isFinite(value)) continue;
      hasValue = true;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!hasValue) return emptyOverlay("no-data", "bu görünümde veri yok");
  return {
    status: "ok",
    points: series[0]?.points ?? [],
    range: { min, max },
    meta: { series },
  };
}

export function asOverlayData(prepared: IndicatorPreparedData | undefined): OverlayPreparedData {
  if (prepared?.meta && Array.isArray(prepared.meta.series)) return prepared as OverlayPreparedData;
  return emptyOverlay("no-data", prepared?.message ?? prepared?.error ?? "bu görünümde veri yok");
}

export function makeOverlayPoints(values: readonly (number | null)[], bars: readonly FootprintBar[], start: number, end: number): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (let i = start; i < end; i++) {
    const bar = bars[i];
    const value = values[i];
    if (bar) points.push({ index: i, time: bar.startTime, value: value === null || !Number.isFinite(value) ? null : value });
  }
  return points;
}

export function drawPriceOverlayLines(ctx: IndicatorDrawContext<IndicatorSettings>, prepared?: IndicatorPreparedData): void {
  const data = asOverlayData(prepared);
  if (data.status !== "ok") return;
  const { ctx: canvas, view } = ctx;
  canvas.save();
  // Price overlays use the main price scale, so off-scale values can map below
  // the main chart and into separate indicator panes. Keep all overlay paint,
  // including optional chart labels, inside the main price plot.
  canvas.beginPath();
  canvas.rect(view.area.left, view.area.top, view.area.width, view.area.height);
  canvas.clip();
  canvas.lineJoin = "round";
  canvas.lineCap = "round";
  for (const series of data.meta.series) {
    canvas.strokeStyle = series.color;
    canvas.lineWidth = Math.max(1, Number(ctx.settings.lineWidth ?? 1.5));
    canvas.beginPath();
    let started = false;
    for (const point of series.points) {
      if (point.value === null) {
        started = false;
        continue;
      }
      const x = view.xOfIndex(point.index) + view.colWidth / 2;
      const y = view.yOfPrice(point.value);
      if (!started) {
        canvas.moveTo(x, y);
        started = true;
      } else {
        canvas.lineTo(x, y);
      }
    }
    canvas.stroke();
    const last = lastValue(series.points);
    if (last && ctx.queuePriceLabel && ctx.settings.showLastValueLabel !== false) {
      ctx.queuePriceLabel(last.value, `${series.label} ${formatPrice(last.value)}`, series.color, 60);
    }
    if (last && series.chartLabel && ctx.settings.showChartLabels === true) {
      const text = series.chartLabel;
      canvas.font = "10px ui-monospace, monospace";
      canvas.fillStyle = series.color;
      const x = Math.min(view.xOfIndex(last.index) + view.colWidth / 2 + 6, view.area.left + view.area.width - canvas.measureText(text).width - 4);
      canvas.fillText(text, x, view.yOfPrice(last.value) - 4);
    }
  }
  canvas.restore();
}

export function overlayAppearanceFields() {
  return [
    { kind: "number" as const, key: "lineWidth", label: "Line Thickness", labelKey: "indicator.common.lineWidth", min: 1, max: 8, step: 0.5 },
    { kind: "boolean" as const, key: "showLastValueLabel", label: "Show Last Price Label", labelKey: "indicator.common.showLastPriceLabel" },
    { kind: "boolean" as const, key: "showPlotLabel", label: "Show Header Label", labelKey: "indicator.common.showPlotLabel" },
  ];
}

function lastValue(points: readonly SeriesPoint[]): (SeriesPoint & { value: number }) | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point.value !== null) return point as SeriesPoint & { value: number };
  }
  return null;
}

function formatPrice(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function emptyOverlay(status: "hidden" | "no-data", message: string): OverlayPreparedData {
  return { status, points: [], range: { min: 0, max: 1 }, meta: { series: [] }, message };
}

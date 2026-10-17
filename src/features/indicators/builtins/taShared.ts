import type { FootprintBar } from "../../../core/types.js";
import type { NumberPoint } from "../../../core/analysis/calc/ta.js";
import type {
  IndicatorDefinition,
  IndicatorDrawContext,
  IndicatorPreparedData,
  IndicatorSettings,
  SettingField,
} from "../types.js";
import {
  compactNumber,
  drawHoveredVerticalGuide,
  drawIndicatorAxisTicks,
  drawIndicatorCrosshairValueLabel,
  drawIndicatorLastValueLabel,
  drawIndicatorMessage,
  drawIndicatorReadout,
  indicatorReadoutToText,
  panePlotBounds,
  settingEnabled,
} from "../render/indicatorPaneUi.js";
import { createIndicatorScale, indicatorDisplayRange, indicatorDisplayScaleMode, type IndicatorScaleMode } from "../scale/indicatorScale.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import { uiColor, taSharedLevelLabelColor } from "../../../core/ui/seriesPalette.js";

export interface SeriesPoint {
  index: number;
  time: number;
  value: number | null;
  color?: string;
}

export interface PlotSeries {
  key: string;
  label: string;
  color: string;
  style?: "line" | "histogram" | "area";
  points: SeriesPoint[];
}

export interface MultiSeriesMeta extends Record<string, unknown> {
  startIndex: number;
  endIndex: number;
  series: PlotSeries[];
  scaleMode: IndicatorScaleMode;
  formatter?: (value: number) => string;
  baseline?: number;
  horizontalLevels?: Array<{ value: number; color?: string; label?: string }>;
  readoutSeries?: PlotSeries[];
}

export type MultiSeriesPreparedData = IndicatorPreparedData<SeriesPoint, MultiSeriesMeta> & {
  points: SeriesPoint[];
  range: { min: number; max: number; baseline?: number };
  meta: MultiSeriesMeta;
};

export interface MultiSeriesIndicatorSettings extends IndicatorSettings {
  lineWidth?: number;
  showLastValueLabel?: boolean;
  showReadout?: boolean;
  showAxisTicks?: boolean;
  showPlotLabel?: boolean;
}

export function numericSetting(settings: IndicatorSettings, key: string, fallback: number, min = -Infinity, max = Infinity): number {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function stringSetting(settings: IndicatorSettings, key: string, fallback: string): string {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function boolSetting(settings: IndicatorSettings, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

export function periodsFromText(value: unknown, fallback: readonly number[], maxCount = 3): number[] {
  if (typeof value !== "string") return [...fallback];
  const parsed = value.split(/[,\s]+/)
    .map((item) => Math.floor(Number(item)))
    .filter((item) => Number.isFinite(item) && item > 0);
  const unique = [...new Set(parsed)];
  return unique.length ? unique.slice(0, maxCount) : [...fallback];
}

export function visibleIndexRange(ctx: IndicatorDrawContext<IndicatorSettings>): { start: number; end: number } {
  const [from, to] = ctx.range;
  return {
    start: Math.max(0, Math.floor(from)),
    end: Math.min(ctx.series.length, Math.ceil(to)),
  };
}

export function makeSeriesPoints(values: readonly (number | null)[], bars: readonly FootprintBar[], start: number, end: number): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (let i = start; i < end; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const value = values[i];
    points.push({ index: i, time: bar.startTime, value: value === null || !Number.isFinite(value) ? null : value });
  }
  return points;
}

export function makeNumberPoints(points: readonly NumberPoint[], bars: readonly FootprintBar[], start: number, end: number): SeriesPoint[] {
  const visible: SeriesPoint[] = [];
  for (let i = start; i < end; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const value = points[i]?.value;
    visible.push({ index: i, time: bar.startTime, value: value === null || !Number.isFinite(value) ? null : value });
  }
  return visible;
}

export function prepareMultiSeries(
  ctx: IndicatorDrawContext<IndicatorSettings>,
  series: PlotSeries[],
  options: {
    scaleMode?: IndicatorScaleMode;
    formatter?: (value: number) => string;
    baseline?: number;
    horizontalLevels?: Array<{ value: number; color?: string; label?: string }>;
    readoutSeries?: PlotSeries[];
    message?: string;
  } = {},
): MultiSeriesPreparedData {
  const { start, end } = visibleIndexRange(ctx);
  if (!ctx.instance.visible) return emptyPrepared(start, end, "hidden", "gizli", options);
  if (start >= end || !series.some((item) => item.points.some((point) => point.value !== null))) {
    return emptyPrepared(start, end, "no-data", options.message ?? "bu görünümde veri yok", options);
  }

  // The pane fits the values of the visible range. The baseline (RSI 50, the zero
  // of a CVD line) is a reference level only; zero stays in view when histogram
  // bars are drawn from it.
  let min = Infinity;
  let max = -Infinity;
  let histogram = false;
  for (const item of series) {
    if (item.style === "histogram") histogram = true;
    for (const point of item.points) {
      const value = point.value;
      if (value === null || !Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!(max > min)) {
    min -= 1;
    max += 1;
  }
  if (histogram) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  const primary = series[0]?.points ?? [];
  return {
    status: "ok",
    points: primary,
    range: { min, max, baseline: options.baseline },
    meta: {
      startIndex: start,
      endIndex: end,
      series,
      scaleMode: options.scaleMode ?? "linear",
      formatter: options.formatter,
      baseline: options.baseline,
      horizontalLevels: options.horizontalLevels,
      readoutSeries: options.readoutSeries,
    },
  };
}

export function asMultiSeriesData(prepared: IndicatorPreparedData | undefined): MultiSeriesPreparedData {
  if (prepared?.range && prepared.meta && Array.isArray(prepared.meta.series)) return prepared as MultiSeriesPreparedData;
  return emptyPrepared(0, 0, "no-data", prepared?.message ?? prepared?.error ?? "bu görünümde veri yok");
}

function multiSeriesScale(ctx: IndicatorDrawContext<MultiSeriesIndicatorSettings>, data: MultiSeriesPreparedData) {
  const { top, bottom } = panePlotBounds(ctx.rect, 8, 5);
  const displayRange = indicatorDisplayRange(ctx.settings, data.range.min, data.range.max);
  const scale = createIndicatorScale({
    mode: data.meta.scaleMode,
    min: displayRange.min,
    max: displayRange.max,
    baseline: data.range.baseline,
    formatter: data.meta.formatter ?? compactNumber,
    paddingFraction: 0.08,
    displayMode: indicatorDisplayScaleMode(ctx.settings),
  }, { top, bottom });
  return { top, bottom, scale };
}

export function drawMultiSeries(ctx: IndicatorDrawContext<MultiSeriesIndicatorSettings>, prepared?: IndicatorPreparedData): void {
  const data = asMultiSeriesData(prepared);
  const { ctx: canvas, view, settings } = ctx;
  if (data.status === "hidden") {
    drawIndicatorMessage(ctx, data.message ?? "gizli");
    return;
  }
  if (data.status !== "ok") {
    drawIndicatorMessage(ctx, data.message ?? data.error ?? "bu görünümde veri yok");
    return;
  }

  const { top, bottom, scale } = multiSeriesScale(ctx, data);

  canvas.save();
  for (const level of data.meta.horizontalLevels ?? []) {
    if (!scale.contains(level.value)) continue;
    const y = scale.y(level.value);
    canvas.strokeStyle = level.color ?? uiColor.separatorStrong;
    canvas.setLineDash([4, 4]);
    canvas.beginPath();
    canvas.moveTo(view.area.left, y + 0.5);
    canvas.lineTo(view.area.left + view.area.width, y + 0.5);
    canvas.stroke();
    canvas.setLineDash([]);
    if (level.label) {
      canvas.font = "10px ui-monospace, monospace";
      canvas.fillStyle = level.color ?? taSharedLevelLabelColor;
      canvas.fillText(level.label, view.area.left + 6, y - 3);
    }
  }
  canvas.restore();

  const lineWidth = Math.max(1, settings.lineWidth ?? 1.5);
  for (const plot of data.meta.series) {
    drawSeriesPath(ctx, plot, scale, top, bottom, lineWidth);
  }

  if (settings.showAxisTicks) drawIndicatorAxisTicks(ctx, scale, top, bottom);

  const last = lastVisibleValue(data.meta.series[0]);
  if (last && settingEnabled(settings, "showLastValueLabel", "showScaleLabel", true)) {
    drawIndicatorLastValueLabel(ctx, { text: scale.format(last.value), color: data.meta.series[0].color, y: Math.max(top + 9, Math.min(bottom - 9, scale.y(last.value))) });
  }
}

export function drawMultiSeriesInteraction(ctx: IndicatorDrawContext<MultiSeriesIndicatorSettings>, prepared?: IndicatorPreparedData): void {
  const data = asMultiSeriesData(prepared);
  if (data.status !== "ok") return;
  const { ctx: canvas, view, settings } = ctx;
  const { top, bottom, scale } = multiSeriesScale(ctx, data);
  const hoverIndex = focusIndex(ctx, data);
  const focus = focusValues(data, hoverIndex);
  if (settingEnabled(settings, "showReadout", "showScaleLabel", true) && focus.length) {
    drawIndicatorReadout(ctx, indicatorReadoutToText({
      title: hoverIndex === null ? "Last" : "◆",
      time: tzDateTimeHud(focus[0].time, ctx.chart?.intervalMs ?? ctx.series.config.intervalMs),
      items: focus.map((item) => ({ label: item.label, value: scale.format(item.value) })),
    }));
  }
  if (hoverIndex !== null) drawHoveredVerticalGuide(canvas, view.xOfIndex(hoverIndex) + view.colWidth / 2, top, bottom);
  drawIndicatorCrosshairValueLabel(ctx, scale, top, bottom);
}

export function standardAppearanceFields(): SettingField[] {
  return [
    { kind: "number", key: "lineWidth", label: "Line Thickness", labelKey: "indicator.common.lineWidth", min: 1, max: 8, step: 0.5 },
    { kind: "boolean", key: "showLastValueLabel", label: "Show Last Value Label", labelKey: "indicator.common.showLastValueLabel" },
    { kind: "boolean", key: "showReadout", label: "Show Readout", labelKey: "indicator.common.showReadout" },
    { kind: "boolean", key: "showAxisTicks", label: "Show Axis Ticks", labelKey: "indicator.common.showAxisTicks" },
    { kind: "boolean", key: "showPlotLabel", label: "Show Header Label", labelKey: "indicator.common.showPlotLabel" },
  ];
}

export function defaultPaneSettings(extra: IndicatorSettings = {}): IndicatorSettings {
  return {
    lineWidth: 1.5,
    showLastValueLabel: true,
    showReadout: true,
    showAxisTicks: true,
    showPlotLabel: true,
    ...extra,
  };
}

export function simpleHeader(name: string): NonNullable<IndicatorDefinition["getHeaderLabel"]> {
  return ({ settings }) => settings.showPlotLabel === false ? "" : name;
}

function drawSeriesPath(
  ctx: IndicatorDrawContext<MultiSeriesIndicatorSettings>,
  series: PlotSeries,
  scale: ReturnType<typeof createIndicatorScale>,
  top: number,
  bottom: number,
  lineWidth: number,
): void {
  const { ctx: canvas, view } = ctx;
  canvas.save();
  canvas.lineJoin = "round";
  canvas.lineCap = "round";
  canvas.lineWidth = lineWidth;
  canvas.strokeStyle = series.color;
  canvas.fillStyle = series.color;
  const style = series.style ?? "line";
  const valid = series.points.filter((point) => point.value !== null) as Array<SeriesPoint & { value: number }>;
  if (style === "histogram") {
    const zeroY = scale.contains(0) ? scale.y(0) : bottom;
    canvas.globalAlpha = 0.72;
    for (const point of valid) {
      const x = view.xOfIndex(point.index) + view.colWidth * 0.18;
      const w = Math.max(1, view.colWidth * 0.64);
      const y = scale.y(point.value);
      canvas.fillStyle = point.color ?? series.color;
      canvas.fillRect(x, Math.min(y, zeroY), w, Math.max(1, Math.abs(y - zeroY)));
    }
    canvas.restore();
    return;
  }
  canvas.beginPath();
  let started = false;
  for (const point of series.points) {
    if (point.value === null) {
      started = false;
      continue;
    }
    const x = view.xOfIndex(point.index) + view.colWidth / 2;
    const y = scale.y(point.value);
    if (!started) {
      canvas.moveTo(x, y);
      started = true;
    } else {
      canvas.lineTo(x, y);
    }
  }
  if (style === "area" && valid.length) {
    canvas.lineTo(view.xOfIndex(valid[valid.length - 1].index) + view.colWidth / 2, bottom);
    canvas.lineTo(view.xOfIndex(valid[0].index) + view.colWidth / 2, bottom);
    canvas.closePath();
    canvas.globalAlpha = 0.16;
    canvas.fill();
    canvas.globalAlpha = 1;
    canvas.beginPath();
    started = false;
    for (const point of series.points) {
      if (point.value === null) {
        started = false;
        continue;
      }
      const x = view.xOfIndex(point.index) + view.colWidth / 2;
      const y = scale.y(point.value);
      if (!started) {
        canvas.moveTo(x, y);
        started = true;
      } else {
        canvas.lineTo(x, y);
      }
    }
  }
  canvas.stroke();
  canvas.restore();
  void top;
}

function focusIndex(ctx: IndicatorDrawContext<MultiSeriesIndicatorSettings>, data: MultiSeriesPreparedData): number | null {
  const crosshair = ctx.crosshair;
  if (!crosshair?.visible) return null;
  const hoverIndex = Math.floor(ctx.view.indexOfX(crosshair.x));
  return data.meta.series.some((series) => series.points.some((point) => point.index === hoverIndex && point.value !== null)) ? hoverIndex : null;
}

function focusValues(data: MultiSeriesPreparedData, index: number | null): Array<{ label: string; value: number; time: number }> {
  const items: Array<{ label: string; value: number; time: number }> = [];
  for (const series of data.meta.readoutSeries ?? data.meta.series) {
    const point = index === null ? lastVisibleValue(series) : series.points.find((candidate) => candidate.index === index && candidate.value !== null) as (SeriesPoint & { value: number }) | undefined;
    if (point) items.push({ label: series.label, value: point.value, time: point.time });
  }
  return items;
}

function lastVisibleValue(series: PlotSeries | undefined): (SeriesPoint & { value: number }) | null {
  if (!series) return null;
  for (let i = series.points.length - 1; i >= 0; i--) {
    const point = series.points[i];
    if (point.value !== null) return point as SeriesPoint & { value: number };
  }
  return null;
}

function emptyPrepared(
  startIndex: number,
  endIndex: number,
  status: "hidden" | "no-data",
  message: string,
  options: { scaleMode?: IndicatorScaleMode; formatter?: (value: number) => string; baseline?: number; horizontalLevels?: Array<{ value: number; color?: string; label?: string }> } = {},
): MultiSeriesPreparedData {
  return {
    status,
    points: [],
    range: { min: 0, max: 1, baseline: options.baseline },
    meta: {
      startIndex,
      endIndex,
      series: [],
      scaleMode: options.scaleMode ?? "linear",
      formatter: options.formatter,
      baseline: options.baseline,
      horizontalLevels: options.horizontalLevels,
    },
    message,
  };
}
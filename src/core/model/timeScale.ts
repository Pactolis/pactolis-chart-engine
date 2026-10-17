import type { ViewReadout } from "./viewContract.js";
import type { FootprintSeries } from "./footprint.js";
import { timeTickMaxLabelWidth } from "./timeScaleOptions.js";
import { TimeTickMarks } from "./timeTickMarks.js";
import { chartLocale } from "../chartLocale.js";

export interface LogicalRange {
  from: number;
  to: number;
}

/** Strict visible range rounded out to integer logical bar indices. */
export interface VisibleStrictRange {
  from: number;
  to: number;
}

/** Horizontal scale geometry derived from the current view. */
export interface TimeScaleViewport {
  /** Pixel distance between adjacent logical bars. */
  readonly barSpacing: number;
  /** Latest loaded logical index, or null when there are no points. */
  readonly baseIndex: number | null;
  /** Bars of empty space to the right of the latest loaded bar. */
  readonly rightOffset: number;
  /** Fractional logical range visible in the plot viewport. */
  readonly visibleLogicalRange: LogicalRange;
  /** Integer logical range rounded out for render/data queries. */
  readonly visibleStrictRange: VisibleStrictRange;
}

export interface TimeScalePoint {
  /** Logical index on the horizontal scale. */
  readonly index: number;
  /** Bucket start timestamp in milliseconds. */
  readonly time: number;
  /** Weight used by tick selection. Higher weights are kept first. */
  readonly timeWeight: TickMarkWeight;
  /** True when the point is projected outside real loaded data. */
  readonly whitespace: boolean;
}

export interface TimeMark {
  readonly index: number;
  readonly time: number;
  readonly coord: number;
  readonly label: string;
  readonly weight: TickMarkWeight;
  readonly whitespace: boolean;
}

export interface TimeScaleCalendar {
  timeAtIndex(anchorTime: number, anchorIndex: number, index: number, intervalMs: number): number;
}

export interface TimeScaleMarkOptions {
  /** Optional label-width override. Defaults to derived TimeScaleOptions character/font budget. */
  maxLabelWidth?: number;
  /** Extra logical points outside the visible viewport for stable edge labels/grid. */
  edgePaddingBars?: number;
  /** Optional UI formatter. The model has a pure UTC fallback for tests/headless use. */
  formatLabel?: TimeMarkFormatter;
}

export type TimeMarkFormatter = (time: number, weight: TickMarkWeight, intervalMs: number) => string;
export type TimeLabelFormatter = (time: number, intervalMs: number) => string;

/**
 * The most significant calendar boundary a point crosses relative to the
 * previous point. Only the order matters: a larger weight is a coarser boundary
 * and wins when tick labels compete for space.
 */
export enum TickMarkWeight {
  LessThanSecond = 0,
  Second,
  Minute1,
  Minute5,
  Minute30,
  Hour1,
  Hour3,
  Hour6,
  Hour12,
  Day,
  Month,
  Year,
}

export const continuousTimeScaleCalendar: TimeScaleCalendar = {
  timeAtIndex(anchorTime: number, anchorIndex: number, index: number, intervalMs: number): number {
    return anchorTime + (index - anchorIndex) * intervalMs;
  },
};

const defaultCalendarCache = new WeakMap<FootprintSeries, {
  structureRevision: number;
  intervalMs: number;
  model: TimeScaleModel;
}>();

/**
 * Small horizontal time-scale model.
 *
 * Renderers ask this model for logical ranges, tick marks, and projected
 * whitespace/future points instead of deriving time labels directly from the
 * data-render range. This keeps chart content, grid, time axis, and crosshair
 * aligned while leaving room for future market calendars/session rules.
 */
export class TimeScaleModel {
  private constructor(
    private readonly times: readonly number[],
    readonly intervalMs: number,
    private readonly calendar: TimeScaleCalendar,
  ) {}

  static fromSeries(series: FootprintSeries, calendar: TimeScaleCalendar = continuousTimeScaleCalendar): TimeScaleModel {
    if (calendar === continuousTimeScaleCalendar) {
      const cached = defaultCalendarCache.get(series);
      if (cached &&
          cached.structureRevision === series.structureRevision &&
          cached.intervalMs === series.config.intervalMs) {
        return cached.model;
      }
    }

    const times: number[] = [];
    for (let i = 0; i < series.length; i++) {
      const bar = series.at(i);
      if (bar) times.push(bar.startTime);
    }
    const model = new TimeScaleModel(times, series.config.intervalMs, calendar);
    if (calendar === continuousTimeScaleCalendar) {
      defaultCalendarCache.set(series, {
        structureRevision: series.structureRevision,
        intervalMs: series.config.intervalMs,
        model,
      });
    }
    return model;
  }

  get length(): number {
    return this.times.length;
  }

  isEmpty(): boolean {
    return this.times.length === 0;
  }

  hasPoints(): boolean {
    return this.times.length > 0;
  }

  baseIndex(): number | null {
    return this.times.length === 0 ? null : this.times.length - 1;
  }

  barSpacing(view: ViewReadout): number {
    return view.colWidth;
  }

  rightOffset(view: ViewReadout): number {
    const baseIndex = this.baseIndex();
    if (baseIndex === null || view.area.width <= 0 || view.colWidth <= 0) return 0;
    // View.offsetX stores the left edge of index 0 relative to the plot area.
    // Convert it to the number of bars between the latest bar's center and the
    // right side of the plot. With scrollToIndex(index, N), this reports
    // approximately N - 1 because that padding is measured from the bar's left
    // edge rather than its center.
    return (view.area.width - view.offsetX) / view.colWidth - baseIndex - 1;
  }

  indexToCoordinate(view: ViewReadout, index: number): number {
    return view.xOfIndex(index) + view.colWidth / 2;
  }

  coordinateToIndex(view: ViewReadout, x: number): number {
    return view.indexOfX(x);
  }

  visibleLogicalRange(view: ViewReadout, edgePaddingBars = view.timeScaleOptions.visibleRangeEdgePaddingBars): LogicalRange {
    const from = Math.floor(this.coordinateToIndex(view, view.area.left)) - edgePaddingBars;
    const to = Math.ceil(this.coordinateToIndex(view, view.area.left + view.area.width)) + edgePaddingBars;
    return { from, to };
  }

  visibleStrictRange(view: ViewReadout, edgePaddingBars = view.timeScaleOptions.visibleRangeEdgePaddingBars): VisibleStrictRange {
    const logical = this.visibleLogicalRange(view, edgePaddingBars);
    return { from: Math.floor(logical.from), to: Math.ceil(logical.to) };
  }

  viewport(view: ViewReadout, edgePaddingBars = view.timeScaleOptions.visibleRangeEdgePaddingBars): TimeScaleViewport {
    return {
      barSpacing: this.barSpacing(view),
      baseIndex: this.baseIndex(),
      rightOffset: this.rightOffset(view),
      visibleLogicalRange: this.visibleLogicalRange(view, edgePaddingBars),
      visibleStrictRange: this.visibleStrictRange(view, edgePaddingBars),
    };
  }

  visibleDataRange(view: ViewReadout, edgePaddingBars = view.timeScaleOptions.visibleRangeEdgePaddingBars): [number, number] {
    const strict = this.visibleStrictRange(view, edgePaddingBars);
    const from = Math.max(0, strict.from);
    const to = Math.min(this.length, strict.to + 1);
    return [from, to];
  }

  timeAtIndex(index: number): number | null {
    if (this.times.length === 0 || !Number.isFinite(index)) return null;
    const roundedIndex = Math.round(index);
    const exact = this.times[roundedIndex];
    if (exact !== undefined) return exact;
    if (roundedIndex < 0) {
      return this.calendar.timeAtIndex(this.times[0], 0, roundedIndex, this.intervalMs);
    }
    return this.calendar.timeAtIndex(
      this.times[this.times.length - 1],
      this.times.length - 1,
      roundedIndex,
      this.intervalMs,
    );
  }

  marks(view: ViewReadout, options: TimeScaleMarkOptions = {}): TimeMark[] {
    const spacing = this.barSpacing(view);
    if (this.times.length === 0 || view.area.width <= 0 || spacing <= 0) return [];
    const maxLabelWidth = options.maxLabelWidth ?? timeTickMaxLabelWidth(view.timeScaleOptions);
    const range = this.visibleLogicalRange(
      view,
      options.edgePaddingBars ?? view.timeScaleOptions.visibleRangeEdgePaddingBars,
    );
    const firstIndex = Math.floor(range.from);
    const lastIndex = Math.ceil(range.to);
    const candidates: TimeScalePoint[] = [];
    for (let index = firstIndex; index <= lastIndex; index++) {
      const time = this.timeAtIndex(index);
      const prevTime = this.timeAtIndex(index - 1);
      if (time === null) continue;
      candidates.push({
        index,
        time,
        timeWeight: tickMarkWeight(time, prevTime),
        whitespace: index < 0 || index >= this.times.length,
      });
    }

    const tickMarks = new TimeTickMarks({
      uniformDistribution: view.timeScaleOptions.uniformDistribution,
      ignoreWhitespaceIndices: view.timeScaleOptions.ignoreWhitespaceIndices,
    });
    const selected = tickMarks.build(candidates, spacing, maxLabelWidth);
    return selected.map((point) => ({
      index: point.index,
      time: point.time,
      coord: this.indexToCoordinate(view, point.index),
      label: (options.formatLabel ?? formatTickMark)(point.time, point.timeWeight, this.intervalMs),
      weight: point.timeWeight,
      whitespace: point.whitespace,
    })).filter((mark) => mark.coord >= view.area.left - maxLabelWidth && mark.coord <= view.area.left + view.area.width + maxLabelWidth);
  }

  formatTimeLabel(index: number, formatter: TimeLabelFormatter = formatDateTime): string | null {
    const time = this.timeAtIndex(index);
    if (time === null) return null;
    return formatter(time, this.intervalMs);
  }
}

export function tickMarkWeight(time: number, prevTime: number | null): TickMarkWeight {
  if (prevTime === null) return TickMarkWeight.Year;
  const prev = new Date(prevTime);
  const current = new Date(time);

  if (current.getUTCFullYear() !== prev.getUTCFullYear()) return TickMarkWeight.Year;
  if (current.getUTCMonth() !== prev.getUTCMonth()) return TickMarkWeight.Month;
  if (current.getUTCDate() !== prev.getUTCDate()) return TickMarkWeight.Day;
  if (current.getUTCHours() !== prev.getUTCHours()) {
    const hour = current.getUTCHours();
    if (hour % 12 === 0) return TickMarkWeight.Hour12;
    if (hour % 6 === 0) return TickMarkWeight.Hour6;
    if (hour % 3 === 0) return TickMarkWeight.Hour3;
    return TickMarkWeight.Hour1;
  }
  if (current.getUTCMinutes() !== prev.getUTCMinutes()) {
    const minute = current.getUTCMinutes();
    if (minute % 30 === 0) return TickMarkWeight.Minute30;
    if (minute % 5 === 0) return TickMarkWeight.Minute5;
    return TickMarkWeight.Minute1;
  }
  return TickMarkWeight.Second;
}

type UtcFormatKind = "month" | "day" | "time" | "date";

const UTC_FORMAT_OPTIONS: Record<UtcFormatKind, Intl.DateTimeFormatOptions> = {
  month: { timeZone: "UTC", month: "short" },
  day: { timeZone: "UTC", day: "2-digit", month: "short" },
  time: { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false },
  date: { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" },
};

/** Building an Intl.DateTimeFormat is far slower than using one, and tick marks are
 *  formatted for every visible tick on every frame, so keep one formatter per locale. */
const utcFormatters = new Map<string, Intl.DateTimeFormat>();

function utcFormat(kind: UtcFormatKind, date: Date): string {
  const locale = chartLocale().locale();
  const key = `${locale}|${kind}`;
  let formatter = utcFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, UTC_FORMAT_OPTIONS[kind]);
    utcFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

function formatTickMark(time: number, weight: TickMarkWeight, intervalMs: number): string {
  const date = new Date(time);
  if (weight >= TickMarkWeight.Year) return String(date.getUTCFullYear());
  if (weight >= TickMarkWeight.Month) return utcFormat("month", date);
  if (weight >= TickMarkWeight.Day || intervalMs >= 24 * 60 * 60_000) return utcFormat("day", date);
  return utcFormat("time", date);
}

function formatDateTime(time: number, intervalMs: number): string {
  const date = new Date(time);
  const day = utcFormat("date", date);
  if (intervalMs >= 24 * 60 * 60_000) return day;
  return `${day} ${utcFormat("time", date)}`;
}

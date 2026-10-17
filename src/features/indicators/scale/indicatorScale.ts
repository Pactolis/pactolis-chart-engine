import { compactNumber, compactUsd } from "../render/indicatorPaneUi.js";

export type IndicatorScaleMode = "linear" | "signed-zero" | "volume" | "usd" | "percent";
export type IndicatorDisplayScaleMode = "linear" | "log";

export interface IndicatorScaleInput {
  mode: IndicatorScaleMode;
  min: number;
  max: number;
  baseline?: number;
  formatter?: (value: number) => string;
  paddingFraction?: number;
  displayMode?: IndicatorDisplayScaleMode;
}

export interface IndicatorScaleBounds {
  top: number;
  bottom: number;
}

export interface IndicatorTick {
  value: number;
  label: string;
  y: number;
}

export interface IndicatorScale {
  mode: IndicatorScaleMode;
  min: number;
  max: number;
  baseline?: number;
  displayMode: IndicatorDisplayScaleMode;
  y(value: number): number;
  valueAtY(y: number): number;
  format(value: number): string;
  ticks(count?: number): IndicatorTick[];
  contains(value: number): boolean;
}

export function createIndicatorScale(input: IndicatorScaleInput, bounds: IndicatorScaleBounds): IndicatorScale {
  const formatter = input.formatter ?? defaultFormatter(input.mode);
  const { min, max, baseline } = normalizeRange(input);
  const top = Math.min(bounds.top, bounds.bottom);
  const bottom = Math.max(bounds.top, bounds.bottom);
  const height = Math.max(1, bottom - top);
  const displayMode = input.displayMode ?? "linear";
  const transform = createValueTransform(min, max, displayMode);
  const transformedMin = transform.forward(min);
  const transformedMax = transform.forward(max);

  const scale: IndicatorScale = {
    mode: input.mode,
    min,
    max,
    baseline,
    displayMode,
    y(value: number): number {
      if (!(max > min)) return top + height / 2;
      return top + height * (1 - (transform.forward(value) - transformedMin) / (transformedMax - transformedMin));
    },
    valueAtY(y: number): number {
      const ratio = 1 - (y - top) / height;
      return transform.inverse(transformedMin + ratio * (transformedMax - transformedMin));
    },
    format(value: number): string {
      return formatter(value);
    },
    ticks(count = 3): IndicatorTick[] {
      const values = tickValues(min, max, input.mode, count, baseline);
      const labels = tickLabels(values, formatter);
      return values.map((value, index) => ({ value, label: labels[index], y: scale.y(value) }));
    },
    contains(value: number): boolean {
      return value >= min && value <= max;
    },
  };

  return scale;
}

export function indicatorDisplayScaleMode(settings: Record<string, unknown>): IndicatorDisplayScaleMode {
  return settings.paneScaleMode === "log" ? "log" : "linear";
}

export function indicatorDisplayRange(
  settings: Record<string, unknown>,
  min: number,
  max: number,
): { min: number; max: number } {
  if (settings.paneScaleAuto !== false || !(max > min)) return { min, max };
  const factor = Math.max(0.05, Math.min(20, Number(settings.paneScaleFactor) || 1));
  const center = (min + max) / 2;
  const half = (max - min) * factor / 2;
  return { min: center - half, max: center + half };
}

function createValueTransform(min: number, max: number, mode: IndicatorDisplayScaleMode): {
  forward(value: number): number;
  inverse(value: number): number;
} {
  if (mode === "linear") return { forward: (value) => value, inverse: (value) => value };
  if (min > 0) return { forward: Math.log, inverse: Math.exp };
  if (max < 0) {
    return {
      forward: (value) => -Math.log(-value),
      inverse: (value) => -Math.exp(-value),
    };
  }
  const constant = Math.max(1e-9, Math.max(Math.abs(min), Math.abs(max)) * 0.01);
  return {
    forward: (value) => Math.sign(value) * Math.log1p(Math.abs(value) / constant),
    inverse: (value) => Math.sign(value) * constant * Math.expm1(Math.abs(value)),
  };
}

/**
 * The scale spans the range it is given, so a pane auto-scales to the values it
 * draws. The baseline is a reference level (a zero line, RSI 50): it is not
 * forced into view, and a signed range is not mirrored around it.
 */
function normalizeRange(input: IndicatorScaleInput): { min: number; max: number; baseline?: number } {
  const paddingFraction = Math.max(0, input.paddingFraction ?? 0);
  const baseline = input.baseline;

  let min = finite(input.min, baseline ?? 0);
  let max = finite(input.max, baseline ?? min + 1);
  if (!(max > min)) {
    const mid = finite((min + max) / 2, baseline ?? 0);
    const half = expandIfFlat(Math.abs(mid) * 0.02);
    min = mid - half;
    max = mid + half;
  }

  if (paddingFraction > 0) {
    const span = Math.max(1e-9, max - min);
    const pad = span * paddingFraction;
    min -= pad;
    max += pad;
  }

  return { min, max, baseline };
}

/**
 * A narrow range can print neighbouring ticks alike ("1.5K", "1.5K"). Then every
 * label gets the decimals the tick spacing needs, keeping the formatter's sign,
 * currency, magnitude suffix and unit ("1.52K", "1.47K").
 */
function tickLabels(values: readonly number[], formatter: (value: number) => string): string[] {
  const labels = values.map((value) => formatter(value));
  if (new Set(labels).size === labels.length) return labels;
  let step = Infinity;
  for (let i = 1; i < values.length; i++) step = Math.min(step, Math.abs(values[i] - values[i - 1]));
  if (!(step > 0 && Number.isFinite(step))) return labels;
  return labels.map((label, index) => {
    const match = /^(-?)(\$?)\d+(?:\.(\d+))?([KMB]?)(\D*)$/.exec(label);
    if (!match) return label;
    const [, sign, currency, fraction = "", magnitude, unit] = match;
    const divisor = magnitude === "B" ? 1e9 : magnitude === "M" ? 1e6 : magnitude === "K" ? 1e3 : 1;
    const decimals = Math.min(8, Math.max(fraction.length, Math.ceil(-Math.log10(step / divisor))));
    return `${sign}${currency}${(Math.abs(values[index]) / divisor).toFixed(decimals)}${magnitude}${unit}`;
  });
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function expandIfFlat(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function defaultFormatter(mode: IndicatorScaleMode): (value: number) => string {
  if (mode === "usd") return compactUsd;
  if (mode === "volume") return compactNumber;
  if (mode === "percent") return (value) => `${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
  return compactNumber;
}

function tickValues(min: number, max: number, mode: IndicatorScaleMode, count: number, baseline?: number): number[] {
  const safeCount = Math.max(2, Math.min(5, Math.floor(count)));
  if (!(max > min)) return [];

  if (mode === "signed-zero") {
    const zero = baseline ?? 0;
    if (zero > min && zero < max) {
      // An end tick this close to zero would print over the zero label.
      const minGap = (max - min) * 0.2;
      return [max, zero, min].filter((value) => value === zero || Math.abs(value - zero) >= minGap);
    }
  }

  if (safeCount === 2) return [max, min];
  const values: number[] = [];
  for (let i = 0; i < safeCount; i++) {
    const t = i / (safeCount - 1);
    values.push(max - (max - min) * t);
  }
  return values;
}

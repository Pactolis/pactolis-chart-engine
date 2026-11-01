/**
 * Price scale model.
 *
 * Owns the vertical scale mode (normal or logarithmic), auto-scale state,
 * margins and tick density, and converts between raw prices and the active
 * scale-space. Runtime/View code asks this model for conversions instead of
 * calling Math.log/Math.exp itself.
 */

import { PriceRange } from "./priceRange.js";
import {
  convertPriceRangeFromLog,
  convertPriceRangeToLog,
  fromLog,
  logFormulaForPriceRange,
  logFormulasAreSame,
  toLog,
  type LogFormula,
} from "./priceScaleConversions.js";
import { buildPriceMarks, type PriceMark } from "./priceTickMarkBuilder.js";

export enum PriceScaleMode {
  /** Equal price differences take equal vertical space. */
  Normal = "normal",
  /** Equal price ratios take equal vertical space. */
  Logarithmic = "logarithmic",
}

export type ScaleMode = "linear" | "log";
export type PriceScaleModeInput = ScaleMode | PriceScaleMode;

export interface PriceScaleMargins {
  /** Fraction of the pane height reserved above the auto-scaled price range. */
  top: number;
  /** Fraction of the pane height reserved below the auto-scaled price range. */
  bottom: number;
}

export interface PriceScaleOptions {
  /** Automatically fit the price scale to the visible data range. */
  autoScale: boolean;
  /** Active vertical price scale mode. */
  mode: PriceScaleMode;
  /** Auto-scale margins around the visible price range. */
  scaleMargins: PriceScaleMargins;
  /** Target density for generated price tick marks. */
  tickMarkDensity: number;
}

export interface PriceScaleState {
  /** Automatically fit the price scale to the visible data range. */
  autoScale: boolean;
  /** Active vertical price scale mode. */
  mode: PriceScaleMode;
  /** Current auto-scale margins. */
  scaleMargins: PriceScaleMargins;
  /** Current price tick density target. */
  tickMarkDensity: number;
}

export interface LogicalRange {
  from: number;
  to: number;
}

export interface AutoscaleInfo {
  /** Source price range in raw price units before active price-scale conversion. */
  priceRange: PriceRange | null;
}

export interface AutoscaleSource {
  /** Whether this source participates in price auto-scale. */
  visible(): boolean;
  /** Return the source range for the currently visible logical bars. */
  autoscaleInfo(visibleRange: LogicalRange): AutoscaleInfo | null;
}

export interface AutoscaleContext {
  /** Minimum movement used to expand a degenerate one-price range. */
  minMove?: number;
}

export interface PriceMarksContext {
  /** Price scale pane height in px. */
  height: number;
  /** Active scale-space value at the top edge. */
  priceTop: number;
  /** Active scale-space units per px. */
  pricePerPx: number;
  /** Decimal places used for labels. */
  pricePrecision: number;
  /** Optional label font size. */
  fontSize?: number;
  /** If true, partially visible top/bottom labels are skipped. */
  entireTextOnly?: boolean;
}

export type { PriceMark };

export type PriceScaleModeState = Partial<Pick<PriceScaleOptions, "autoScale" | "mode">>;

export const DEFAULT_PRICE_SCALE_OPTIONS: PriceScaleOptions = {
  autoScale: true,
  mode: PriceScaleMode.Normal,
  scaleMargins: { top: 0.2, bottom: 0.1 },
  tickMarkDensity: 2.5,
};

export class PriceScaleModel {
  private _options: PriceScaleOptions;
  private _priceRange: PriceRange | null = null;
  private _logFormula: LogFormula = logFormulaForPriceRange(null);
  /** Price-axis drag in progress: pointer height above the pane bottom at drag start, and the range then. */
  private _drag: { startHeight: number; startRange: PriceRange } | null = null;

  constructor(options: Partial<PriceScaleOptions> = {}) {
    this._options = mergePriceScaleOptions(DEFAULT_PRICE_SCALE_OPTIONS, options);
  }

  options(): PriceScaleOptions {
    return clonePriceScaleOptions(this._options);
  }

  state(): PriceScaleState {
    return {
      autoScale: this._options.autoScale,
      mode: this._options.mode,
      scaleMargins: { ...this._options.scaleMargins },
      tickMarkDensity: this._options.tickMarkDensity,
    };
  }

  mode(): PriceScaleMode {
    return this._options.mode;
  }

  isLogarithmic(): boolean {
    return this._options.mode === PriceScaleMode.Logarithmic;
  }

  isAutoScale(): boolean {
    return this._options.autoScale;
  }

  scaleMargins(): PriceScaleMargins {
    return { ...this._options.scaleMargins };
  }

  tickMarkDensity(): number {
    return this._options.tickMarkDensity;
  }

  priceRange(): PriceRange | null {
    return this._priceRange?.clone() ?? null;
  }

  setPriceRange(range: PriceRange | null): void {
    this._priceRange = range?.clone() ?? null;
  }

  /**
   * Start dragging the price axis. `y` is local to the price scale pane.
   *
   * Pressing alone keeps auto-scale on; it turns off once the drag actually
   * rescales (see `scaleTo`).
   */
  startScale(height: number, y: number, priceRange: PriceRange): void {
    if (!Number.isFinite(height) || height <= 1 || priceRange.isEmpty()) {
      this.endScale();
      return;
    }
    this._drag = { startHeight: height - clamp(y, 0, height), startRange: priceRange.clone() };
  }

  /**
   * Continue a price-axis drag and return the scale-space range to apply.
   *
   * Dragging down stretches the range (zooms out) and dragging up compresses it.
   * The stretch factor compares the pointer's height above the pane bottom now
   * and at drag start; a cushion of 20% of the pane keeps it gentle near the
   * bottom edge, and the range never shrinks below a tenth of its start size.
   */
  scaleTo(height: number, y: number): PriceRange | null {
    const drag = this._drag;
    if (drag === null || !Number.isFinite(height) || height <= 1) return null;

    this.setAutoScale(false);
    const cushion = 0.2 * (height - 1);
    const heightNow = height - clamp(y, 0, height);
    const stretch = Math.max((drag.startHeight + cushion) / (heightNow + cushion), MIN_DRAG_STRETCH);
    const next = drag.startRange.clone();
    next.scaleAroundCenter(stretch);
    this.setPriceRange(next);
    return next;
  }

  /** Finish a price-axis drag. */
  endScale(): void {
    this._drag = null;
  }

  /** Reset price scale ownership back to automatic fitting. */
  resetPriceScale(): void {
    this.endScale();
    this.setAutoScale(true);
  }

  getLogFormula(): LogFormula {
    return { ...this._logFormula };
  }

  isEmpty(): boolean {
    return this._priceRange === null || this._priceRange.isEmpty();
  }

  setMode(mode: PriceScaleModeState): void {
    this.applyOptions(mode);
  }

  setAutoScale(autoScale: boolean): void {
    this.applyOptions({ autoScale });
  }

  setScaleMode(mode: PriceScaleModeInput): void {
    this.applyOptions({ mode: normalizePriceScaleMode(mode) });
  }

  /**
   * Apply option changes. Switching between normal and logarithmic mode carries
   * the stored range across through raw prices; a log range that cannot be
   * converted back is dropped and auto-scale takes over.
   */
  applyOptions(options: Partial<PriceScaleOptions>): void {
    const next = mergePriceScaleOptions(this._options, options);
    const wasLog = this.isLogarithmic();
    const willBeLog = next.mode === PriceScaleMode.Logarithmic;

    if (wasLog !== willBeLog) {
      const raw = wasLog ? convertPriceRangeFromLog(this._priceRange, this._logFormula) : this._priceRange;
      if (wasLog && this._priceRange !== null && raw === null) next.autoScale = true;
      if (willBeLog) {
        this._logFormula = logFormulaForPriceRange(raw);
        this._priceRange = convertPriceRangeToLog(raw, this._logFormula);
      } else {
        this._priceRange = raw;
      }
    }
    this._options = next;
  }

  /** Convert a raw price to the active scale's logical value. */
  priceToLogical(price: number): number | null {
    if (!Number.isFinite(price)) return null;
    if (!this.isLogarithmic()) return price;
    const logical = toLog(price, this._logFormula);
    return Number.isFinite(logical) ? logical : null;
  }

  /** Convert an active-scale logical value back to a raw price. */
  logicalToPrice(logical: number): number {
    if (!Number.isFinite(logical)) return NaN;
    return this.isLogarithmic() ? fromLog(logical, this._logFormula) : logical;
  }

  /** Convert a raw price range into active scale-space. */
  rangeToLogical(range: PriceRange): PriceRange | null {
    if (!this.isLogarithmic()) return range.clone();
    this.updateLogFormulaForRawRange(range);
    return convertPriceRangeToLog(range, this._logFormula);
  }

  /** Convert an active scale-space range back to raw price units. */
  logicalRangeToPriceRange(range: PriceRange): PriceRange | null {
    return this.isLogarithmic() ? convertPriceRangeFromLog(range, this._logFormula) : range.clone();
  }

  updateLogFormulaForRawRange(rawRange: PriceRange | null): void {
    if (!this.isLogarithmic()) return;
    const nextFormula = logFormulaForPriceRange(rawRange);
    if (logFormulasAreSame(nextFormula, this._logFormula)) return;

    const rawStoredRange = convertPriceRangeFromLog(this._priceRange, this._logFormula);
    this._logFormula = nextFormula;
    this._priceRange = convertPriceRangeToLog(rawStoredRange, this._logFormula);
  }

  /**
   * Build the active scale-space price range from autoscale sources.
   *
   * Visible sources report raw price ranges; their union is converted into the
   * active scale mode, and the configured margins are reserved around it.
   */
  autoscaleRange(
    visibleRange: LogicalRange,
    sources: readonly AutoscaleSource[],
    context: AutoscaleContext = {},
  ): PriceRange | null {
    if (!this.isAutoScale()) return null;
    let mergedRawRange: PriceRange | null = null;

    for (const source of sources) {
      if (!source.visible()) continue;
      const info = source.autoscaleInfo(visibleRange);
      if (!info?.priceRange || info.priceRange.isEmpty()) continue;
      mergedRawRange = mergedRawRange === null ? info.priceRange.clone() : mergedRawRange.merge(info.priceRange);
    }

    if (mergedRawRange === null) return null;
    let merged = this.rangeToLogical(mergedRawRange);
    if (merged === null || merged.isEmpty()) return null;
    const minMove = Math.max(context.minMove ?? 1e-6, 1e-9);
    merged = expandDegenerateRange(merged, this.logicalMinMoveForRange(merged, minMove));
    return applyScaleMargins(merged, this.scaleMargins());
  }

  /**
   * Build formatted price-axis marks for the current visible scale range.
   *
   * Rendering code should draw these marks instead of calculating linear/log
   * ticks on its own. This keeps price tick spacing and active scale mode in
   * the price-scale model boundary.
   */
  marks(context: PriceMarksContext): PriceMark[] {
    return buildPriceMarks({
      priceScale: this,
      height: context.height,
      priceTop: context.priceTop,
      pricePerPx: context.pricePerPx,
      pricePrecision: context.pricePrecision,
      fontSize: context.fontSize,
      tickMarkDensity: this.tickMarkDensity(),
      entireTextOnly: context.entireTextOnly,
    });
  }

  private logicalMinMoveForRange(range: PriceRange, minMove: number): number {
    if (!this.isLogarithmic()) return minMove;
    const rawRange = convertPriceRangeFromLog(range, this._logFormula);
    if (rawRange === null) return minMove;
    const base = rawRange.minValue();
    const shifted = base + Math.max(minMove, 1e-9);
    const logicalBase = toLog(base, this._logFormula);
    const logicalShifted = toLog(shifted, this._logFormula);
    const diff = Math.abs(logicalShifted - logicalBase);
    return Number.isFinite(diff) && diff > 0 ? diff : minMove;
  }
}

export function normalizePriceScaleMode(mode: PriceScaleModeInput): PriceScaleMode {
  if (mode === PriceScaleMode.Logarithmic || mode === "log") return PriceScaleMode.Logarithmic;
  return PriceScaleMode.Normal;
}

export function priceScaleModeToLegacyScaleMode(mode: PriceScaleMode): ScaleMode {
  return mode === PriceScaleMode.Logarithmic ? "log" : "linear";
}

export function applyScaleMargins(range: PriceRange, margins: PriceScaleMargins): PriceRange {
  const top = clampMargin(margins.top);
  const bottom = clampMargin(margins.bottom);
  const totalMargins = top + bottom;
  const usableFraction = Math.max(1 - totalMargins, 1e-6);
  const dataSpan = Math.max(range.length(), 1e-9);
  const fullSpan = dataSpan / usableFraction;
  return new PriceRange(
    range.minValue() - fullSpan * bottom,
    range.maxValue() + fullSpan * top,
  );
}

function mergePriceScaleOptions(base: PriceScaleOptions, next: Partial<PriceScaleOptions>): PriceScaleOptions {
  return {
    ...base,
    ...next,
    mode: next.mode === undefined ? base.mode : normalizePriceScaleMode(next.mode),
    scaleMargins: normalizeScaleMargins({
      ...base.scaleMargins,
      ...(next.scaleMargins ?? {}),
    }),
  };
}

function clonePriceScaleOptions(options: PriceScaleOptions): PriceScaleOptions {
  return {
    ...options,
    scaleMargins: { ...options.scaleMargins },
  };
}

function normalizeScaleMargins(margins: PriceScaleMargins): PriceScaleMargins {
  const top = clampMargin(margins.top);
  const bottom = clampMargin(margins.bottom);
  if (top + bottom < 1) return { top, bottom };
  const scale = 0.95 / (top + bottom);
  return { top: top * scale, bottom: bottom * scale };
}

function clampMargin(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 0.99));
}

function expandDegenerateRange(range: PriceRange, minMove: number): PriceRange {
  if (range.length() > 0) return range;
  const extend = Math.max(minMove, 1e-9) * 5;
  return new PriceRange(range.minValue() - extend, range.maxValue() + extend);
}

const MIN_DRAG_STRETCH = 0.1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

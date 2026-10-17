/**
 * Horizontal time-scale defaults and policies.
 *
 * This file is an options boundary, not a controller. Later phases can move
 * viewport mutation decisions into a TimeScaleViewportController without
 * hunting for ad-hoc numbers in Runtime/View/renderers.
 */
export interface TimeScaleOptions {
  /** Pixel distance between adjacent logical bars. */
  readonly barSpacing: number;
  /** Minimum supported bar spacing in pixels. */
  readonly minBarSpacing: number;
  /** Maximum supported bar spacing in pixels. */
  readonly maxBarSpacing: number;
  /**
   * Default helper padding for generic `scrollToIndex` calls, expressed in
   * current project column-padding semantics.
   */
  readonly defaultScrollRightPaddingBars: number;
  /** Current policy for placing the latest bar near the right edge. */
  readonly latestBarRightPaddingBars: number;
  /** Right padding used when restoring the default horizontal scale. */
  readonly resetRightPaddingBars: number;
  /** Extra logical bars included around visible range calculations. */
  readonly visibleRangeEdgePaddingBars: number;
  /** Minimum visible bars retained by viewport clamping. */
  readonly minVisibleBars: number;
  /** Edge padding used by viewport clamping. */
  readonly clampEdgePaddingBars: number;
  /** Maximum time tick label length in characters. */
  readonly tickMarkMaxCharacterLength: number;
  /** Font size used by the time tick label density model. */
  readonly tickMarkFontSize: number;
  /**
   * Optional explicit pixel-budget override for tests/special layouts.
   * When null, the width is derived from tickMarkMaxCharacterLength and tickMarkFontSize.
   */
  readonly tickMarkMaxLabelWidth: number | null;
  /** Shift visible range when a new bar is added and the last bar is visible. */
  readonly shiftVisibleRangeOnNewBar: boolean;
  /** Keep same-weight tick marks as an all-or-none group when label density allows. */
  readonly uniformDistribution: boolean;
  /** Skip projected/whitespace-only indices when building time-axis marks. */
  readonly ignoreWhitespaceIndices: boolean;
}

export const DEFAULT_TIME_SCALE_OPTIONS: TimeScaleOptions = Object.freeze({
  // Footprint terminal intentionally uses wide default columns; this preserves
  // current behavior while making the policy named and model-owned.
  barSpacing: 84,
  // Absolute safety floor. View applies the user-facing dynamic limit
  // (plotWidth / 4000) so maximum zoom-out never shows more than 4000 bars.
  minBarSpacing: 0.05,
  maxBarSpacing: 400,
  defaultScrollRightPaddingBars: 3,
  // Padding is measured to the latest bar's left edge, so 2 leaves one empty
  // bar between the latest candle and the price axis.
  latestBarRightPaddingBars: 2,
  resetRightPaddingBars: 2,
  visibleRangeEdgePaddingBars: 1,
  minVisibleBars: 3,
  clampEdgePaddingBars: 1,
  tickMarkMaxCharacterLength: 8,
  tickMarkFontSize: 11,
  tickMarkMaxLabelWidth: null,
  shiftVisibleRangeOnNewBar: true,
  uniformDistribution: false,
  ignoreWhitespaceIndices: false,
});

export function normalizeTimeScaleOptions(options: Partial<TimeScaleOptions> = {}): TimeScaleOptions {
  const merged = { ...DEFAULT_TIME_SCALE_OPTIONS, ...options };
  const minBarSpacing = positiveFinite(merged.minBarSpacing, DEFAULT_TIME_SCALE_OPTIONS.minBarSpacing);
  const maxBarSpacing = positiveFinite(merged.maxBarSpacing, DEFAULT_TIME_SCALE_OPTIONS.maxBarSpacing);
  const normalizedMaxBarSpacing = Math.max(minBarSpacing, maxBarSpacing);
  return Object.freeze({
    barSpacing: clampPositive(
      positiveFinite(merged.barSpacing, DEFAULT_TIME_SCALE_OPTIONS.barSpacing),
      minBarSpacing,
      normalizedMaxBarSpacing,
    ),
    minBarSpacing,
    maxBarSpacing: normalizedMaxBarSpacing,
    defaultScrollRightPaddingBars: nonNegativeFinite(
      merged.defaultScrollRightPaddingBars,
      DEFAULT_TIME_SCALE_OPTIONS.defaultScrollRightPaddingBars,
    ),
    latestBarRightPaddingBars: nonNegativeFinite(
      merged.latestBarRightPaddingBars,
      DEFAULT_TIME_SCALE_OPTIONS.latestBarRightPaddingBars,
    ),
    resetRightPaddingBars: nonNegativeFinite(
      merged.resetRightPaddingBars,
      DEFAULT_TIME_SCALE_OPTIONS.resetRightPaddingBars,
    ),
    visibleRangeEdgePaddingBars: nonNegativeFinite(
      merged.visibleRangeEdgePaddingBars,
      DEFAULT_TIME_SCALE_OPTIONS.visibleRangeEdgePaddingBars,
    ),
    minVisibleBars: Math.max(1, Math.floor(positiveFinite(
      merged.minVisibleBars,
      DEFAULT_TIME_SCALE_OPTIONS.minVisibleBars,
    ))),
    clampEdgePaddingBars: nonNegativeFinite(
      merged.clampEdgePaddingBars,
      DEFAULT_TIME_SCALE_OPTIONS.clampEdgePaddingBars,
    ),
    tickMarkMaxCharacterLength: Math.max(1, Math.floor(positiveFinite(
      merged.tickMarkMaxCharacterLength,
      DEFAULT_TIME_SCALE_OPTIONS.tickMarkMaxCharacterLength,
    ))),
    tickMarkFontSize: positiveFinite(
      merged.tickMarkFontSize,
      DEFAULT_TIME_SCALE_OPTIONS.tickMarkFontSize,
    ),
    tickMarkMaxLabelWidth: nullablePositiveFinite(merged.tickMarkMaxLabelWidth),
    shiftVisibleRangeOnNewBar: Boolean(merged.shiftVisibleRangeOnNewBar),
    uniformDistribution: Boolean(merged.uniformDistribution),
    ignoreWhitespaceIndices: Boolean(merged.ignoreWhitespaceIndices),
  });
}

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function timeTickMaxLabelWidth(options: TimeScaleOptions): number {
  if (options.tickMarkMaxLabelWidth !== null) return options.tickMarkMaxLabelWidth;
  // Estimate a label's width from the font size: each character is taken as
  // (fontSize + 4) * 5 / 8 px, which leaves a little air between labels.
  const pixelsPerCharacter = (options.tickMarkFontSize + 4) * 5 / DEFAULT_TIME_SCALE_OPTIONS.tickMarkMaxCharacterLength;
  return pixelsPerCharacter * options.tickMarkMaxCharacterLength;
}

function nonNegativeFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nullablePositiveFinite(value: number | null | undefined): number | null {
  return Number.isFinite(value) && value !== null && value !== undefined && value > 0 ? value : null;
}

function clampPositive(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

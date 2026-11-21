import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings, IndicatorPreparedData } from "../types.js";
import {
  IncrementalMarketStructure,
  type AmbiguousDualPivot,
  type BreakConfirmationMode,
  type MarketStructureResult,
  type MarketStructureTrend,
  type ProtectedLevel,
  type StructuralSwing,
  type StructureBreakEvent,
  type SweepCandidate,
  type SwingPivot,
} from "../../../core/analysis/swings.js";
import { boolSetting, numericSetting, stringSetting, visibleIndexRange } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";
import { incrementPerformanceCounter } from "../../../core/performanceTelemetry.js";
import type { FootprintSeries } from "../../../core/model/footprint.js";

export type SwingPivotMode = "structural" | "raw" | "both";

export interface SwingMapSettings extends IndicatorSettings {
  left: number;
  right: number;
  showLabels: boolean;
  showUnconfirmed: boolean;
  equalityToleranceSteps: number;
  highColor: string;
  lowColor: string;
  pivotMode?: SwingPivotMode;
  breakConfirmation?: BreakConfirmationMode;
  showBOS?: boolean;
  showCHoCH?: boolean;
  showProtectedLevels?: boolean;
  bullishBreakColor?: string;
  bearishBreakColor?: string;
  protectedLevelColor?: string;
  lineWidth?: number;
}

interface SwingMark extends SwingPivot {
  label: string;
  unconfirmed?: boolean;
}

export interface SwingMapMeta extends Record<string, unknown> {
  evaluatedWindows: number;
  closedLength: number;
  pivotMode: SwingPivotMode;
  breakConfirmation: BreakConfirmationMode;
  trend: MarketStructureTrend;
  provisionalPivotIndex: number | null;
  provisionalPivotKind: SwingPivot["kind"] | null;
  structuralSwings: StructuralSwing[];
  breakEvents: StructureBreakEvent[];
  protectedLevels: ProtectedLevel[];
  activeProtectedLow: ProtectedLevel | null;
  activeProtectedHigh: ProtectedLevel | null;
  sweepCandidates: SweepCandidate[];
  ambiguousDualPivots: AmbiguousDualPivot[];
  supersededRawPivots: SwingPivot[];
}

interface SwingState {
  structure: IncrementalMarketStructure;
  result: MarketStructureResult;
  resetEpoch: number;
  nonTailRevision: number;
  length: number;
  config: string;
  marks: SwingMark[];
  supersededRawPivots: SwingPivot[];
}

const states = new WeakMap<FootprintSeries, Map<string, SwingState>>();

function pivotModeSetting(settings: IndicatorSettings): SwingPivotMode {
  const value = settings.pivotMode;
  return value === "raw" || value === "both" || value === "structural" ? value : "structural";
}

function breakConfirmationSetting(settings: IndicatorSettings): BreakConfirmationMode {
  return settings.breakConfirmation === "wick" ? "wick" : "close";
}

function structureMarks(pivots: readonly SwingPivot[], tolerance: number): SwingMark[] {
  const previous: Partial<Record<SwingPivot["kind"], number>> = {};
  const marks: SwingMark[] = [];
  for (const pivot of pivots) {
    const prev = previous[pivot.kind];
    previous[pivot.kind] = pivot.price;
    // Retain all pivots in detector state, but omit duplicate-price paint/labels.
    if (prev !== undefined && Math.abs(pivot.price - prev) <= tolerance) continue;
    const label = prev === undefined ? (pivot.kind === "high" ? "H" : "L")
      : pivot.kind === "high" ? (pivot.price > prev ? "HH" : "LH") : (pivot.price > prev ? "HL" : "LL");
    marks.push({ ...pivot, label });
  }
  return marks;
}

function structuralMarks(swings: readonly StructuralSwing[], tolerance: number): SwingMark[] {
  const previous: Partial<Record<SwingPivot["kind"], number>> = {};
  const marks: SwingMark[] = [];
  for (const swing of swings) {
    const prev = previous[swing.kind];
    previous[swing.kind] = swing.price;
    if (prev !== undefined && Math.abs(swing.price - prev) <= tolerance) continue;
    const label = prev === undefined ? (swing.kind === "high" ? "H" : "L")
      : swing.kind === "high" ? (swing.price > prev ? "HH" : "LH") : (swing.price > prev ? "HL" : "LL");
    marks.push({
      index: swing.pivotIndex,
      price: swing.price,
      kind: swing.kind,
      confirmedAtIndex: swing.confirmedAtIndex,
      label,
    });
  }
  return marks;
}

function computeSupersededRawPivots(
  rawPivots: readonly SwingPivot[],
  swings: readonly StructuralSwing[],
): SwingPivot[] {
  const structuralKeys = new Set<string>();
  for (const swing of swings) {
    structuralKeys.add(`${swing.pivotIndex}|${swing.kind}`);
  }
  const superseded: SwingPivot[] = [];
  for (const pivot of rawPivots) {
    if (!structuralKeys.has(`${pivot.index}|${pivot.kind}`)) {
      superseded.push(pivot);
    }
  }
  return superseded;
}

function lowerBoundByIndex<T>(items: readonly T[], getIndex: (item: T) => number, target: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getIndex(items[mid]) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sliceByIndexRange<T>(
  items: readonly T[],
  getIndex: (item: T) => number,
  start: number,
  end: number,
): T[] {
  const from = lowerBoundByIndex(items, getIndex, start);
  const to = lowerBoundByIndex(items, getIndex, end);
  return from >= to ? [] : items.slice(from, to);
}

function visibleBreakEvents(events: readonly StructureBreakEvent[], start: number, end: number): StructureBreakEvent[] {
  if (events.length === 0 || start >= end) return [];
  const from = lowerBoundByIndex(events, (event) => event.breakIndex, start);
  const visible: StructureBreakEvent[] = [];
  for (let i = from; i < events.length; i++) {
    const event = events[i];
    if (event.pivotIndex < end && event.breakIndex >= start) visible.push(event);
  }
  return visible;
}

function visibleProtectedLevels(
  levels: readonly ProtectedLevel[],
  closedLength: number,
  start: number,
  end: number,
): ProtectedLevel[] {
  if (levels.length === 0 || start >= end) return [];
  const maxEnd = Math.max(0, closedLength - 1);
  const visible: ProtectedLevel[] = [];
  for (const level of levels) {
    const levelEnd = level.brokenAtIndex ?? level.supersededAtIndex ?? maxEnd;
    if (levelEnd >= start && level.pivotIndex < end) visible.push(level);
  }
  return visible;
}

function prepareSwingMap(ctx: IndicatorDrawContext<SwingMapSettings>): IndicatorPreparedData<SwingMark, SwingMapMeta> {
  if (!ctx.instance.visible) return { status: "hidden", points: [] };
  const bars = ctx.series.listReadonly();
  const left = Math.floor(numericSetting(ctx.settings, "left", 5, 1, 100));
  const right = Math.floor(numericSetting(ctx.settings, "right", 5, 1, 100));
  const tolerance = numericSetting(ctx.settings, "equalityToleranceSteps", 0, 0, 100) * ctx.series.config.priceStep;
  const pivotMode = pivotModeSetting(ctx.settings);
  const breakConfirmation = breakConfirmationSetting(ctx.settings);
  const config = `${left}|${right}|${tolerance}|${pivotMode}|${breakConfirmation}`;

  // The mutable last bar cannot confirm a swing. Replay replaces this series with
  // its as-of prefix, so no future bar can enter this closed history cut either.
  let closedLength = Math.max(0, bars.length - 1);
  if (ctx.chart?.asOfTime !== undefined) {
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (bars[mid].startTime + ctx.series.config.intervalMs <= ctx.chart.asOfTime) lo = mid + 1;
      else hi = mid;
    }
    closedLength = lo;
  }

  let instances = states.get(ctx.series);
  if (!instances) {
    instances = new Map();
    states.set(ctx.series, instances);
  }
  let state = instances.get(ctx.instance.id);
  const reset = !state
    || state.config !== config
    || state.resetEpoch !== ctx.series.resetEpoch
    || state.nonTailRevision !== ctx.series.nonTailRevision
    || closedLength < state.length;

  const buildDisplayMarks = (res: MarketStructureResult): SwingMark[] => (
    pivotMode === "raw"
      ? structureMarks(res.rawPivots, tolerance)
      : structuralMarks(res.swings, tolerance)
  );

  if (reset) {
    const structure = new IncrementalMarketStructure();
    const result = structure.update(
      bars,
      { left, right, equalityTolerance: tolerance, breakConfirmation },
      "reset",
      closedLength,
    );
    state = {
      structure,
      result,
      resetEpoch: ctx.series.resetEpoch,
      nonTailRevision: ctx.series.nonTailRevision,
      length: closedLength,
      config,
      marks: buildDisplayMarks(result),
      supersededRawPivots: pivotMode === "both" ? computeSupersededRawPivots(result.rawPivots, result.swings) : [],
    };
    instances.set(ctx.instance.id, state);
    incrementPerformanceCounter("indicator.incremental.full.swing-map");
  } else if (closedLength > state!.length) {
    const prevRawCount = state!.result.rawPivots.length;
    const prevSwingCount = state!.result.swings.length;
    const prevLastSwing = prevSwingCount > 0 ? state!.result.swings[prevSwingCount - 1] : undefined;
    const result = state!.structure.update(
      bars,
      { left, right, equalityTolerance: tolerance, breakConfirmation },
      "append",
      closedLength,
    );
    state!.result = result;
    state!.length = closedLength;
    const swingsChanged = result.swings.length !== prevSwingCount
      || (prevSwingCount > 0 && result.swings[prevSwingCount - 1] !== prevLastSwing);
    const rawChanged = result.rawPivots.length !== prevRawCount;
    if ((pivotMode === "raw" && rawChanged) || (pivotMode !== "raw" && swingsChanged)) {
      state!.marks = buildDisplayMarks(result);
    }
    if (pivotMode === "both" && (rawChanged || swingsChanged)) {
      state!.supersededRawPivots = computeSupersededRawPivots(result.rawPivots, result.swings);
    }
    incrementPerformanceCounter("indicator.incremental.hit.swing-map");
  } else {
    // A live tick only changes the excluded open bar: zero historical windows.
    incrementPerformanceCounter("indicator.incremental.hit.swing-map");
  }

  const { start, end } = visibleIndexRange(ctx);
  const points = sliceByIndexRange(state!.marks, (point) => point.index, start, end);
  if (ctx.settings.showUnconfirmed && ctx.chart?.asOfTime === undefined && bars.length > left) {
    const i = bars.length - 1;
    const bar = bars[i];
    let high = Number.isFinite(bar.high);
    let low = Number.isFinite(bar.low);
    for (let k = i - left; k < i; k++) {
      if (!Number.isFinite(bars[k].high) || bars[k].high >= bar.high) high = false;
      if (!Number.isFinite(bars[k].low) || bars[k].low <= bar.low) low = false;
    }
    if (i >= start && i < end) {
      if (high) points.push({ index: i, price: bar.high, kind: "high", confirmedAtIndex: i + right, label: "H? (unconfirmed)", unconfirmed: true });
      if (low) points.push({ index: i, price: bar.low, kind: "low", confirmedAtIndex: i + right, label: "L? (unconfirmed)", unconfirmed: true });
    }
  }

  const result = state!.result;
  const lastSwing = result.swings.length > 0 ? result.swings[result.swings.length - 1] : undefined;
  const provisional = pivotMode !== "raw" && lastSwing?.status === "provisional" ? lastSwing : null;
  const breakEvents = visibleBreakEvents(result.breakEvents, start, end);
  const protectedLevels = visibleProtectedLevels(result.protectedLevels, closedLength, start, end);
  const structuralSwings = sliceByIndexRange(result.swings, (swing) => swing.pivotIndex, start, end);
  const sweepCandidates = sliceByIndexRange(result.sweepCandidates, (sweep) => sweep.barIndex, start, end);
  const ambiguousDualPivots = sliceByIndexRange(result.ambiguousDualPivots, (item) => item.index, start, end);
  const supersededRawPivots = pivotMode === "both"
    ? sliceByIndexRange(state!.supersededRawPivots, (pivot) => pivot.index, start, end)
    : [];

  const hasVisibleContent = points.length > 0
    || breakEvents.length > 0
    || protectedLevels.length > 0
    || supersededRawPivots.length > 0;

  return {
    status: hasVisibleContent ? "ok" : "no-data",
    points,
    meta: {
      evaluatedWindows: state!.structure.evaluatedWindows,
      closedLength,
      pivotMode,
      breakConfirmation,
      trend: result.trend,
      provisionalPivotIndex: provisional ? provisional.pivotIndex : null,
      provisionalPivotKind: provisional ? provisional.kind : null,
      structuralSwings,
      breakEvents,
      protectedLevels,
      activeProtectedLow: result.activeProtectedLow,
      activeProtectedHigh: result.activeProtectedHigh,
      sweepCandidates,
      ambiguousDualPivots,
      supersededRawPivots,
    },
  };
}

function drawSwingMap(
  ctx: IndicatorDrawContext<SwingMapSettings>,
  prepared?: IndicatorPreparedData<SwingMark, SwingMapMeta>,
): void {
  if (!prepared || prepared.status === "hidden" || prepared.status === "no-data") return;
  const points = (prepared.points ?? []) as SwingMark[];
  const meta = prepared.meta;
  const hasExtras = Boolean(
    meta && (meta.breakEvents.length || meta.protectedLevels.length || meta.supersededRawPivots.length),
  );
  if (!points.length && !hasExtras) return;

  const canvas = ctx.ctx;
  const view = ctx.view;
  const showLabels = ctx.settings.showLabels !== false;
  const showBOS = boolSetting(ctx.settings, "showBOS", true);
  const showCHoCH = boolSetting(ctx.settings, "showCHoCH", true);
  const showProtected = boolSetting(ctx.settings, "showProtectedLevels", true);
  const highColor = stringSetting(ctx.settings, "highColor", uiColor.sell);
  const lowColor = stringSetting(ctx.settings, "lowColor", uiColor.buy);
  const bullishBreakColor = stringSetting(ctx.settings, "bullishBreakColor", uiColor.buy);
  const bearishBreakColor = stringSetting(ctx.settings, "bearishBreakColor", uiColor.sell);
  const protectedLevelColor = stringSetting(ctx.settings, "protectedLevelColor", uiColor.warn);
  const lineWidth = Math.max(1, numericSetting(ctx.settings, "lineWidth", 1.5, 1, 4));

  const canDrawLines = typeof canvas.moveTo === "function"
    && typeof canvas.lineTo === "function"
    && typeof canvas.stroke === "function";
  const setDash = (dash: number[]) => {
    if (typeof canvas.setLineDash === "function") canvas.setLineDash(dash);
  };

  canvas.save();
  canvas.beginPath();
  canvas.rect(view.area.left, view.area.top, view.area.width, view.area.height);
  canvas.clip();
  canvas.font = "10px ui-monospace, monospace";
  canvas.textAlign = "center";

  if (canDrawLines && meta) {
    canvas.lineWidth = lineWidth;

    if (showProtected && meta.protectedLevels.length) {
      const activeEndIndex = Math.max(0, meta.closedLength - 1);
      for (const level of meta.protectedLevels) {
        const endIndex = level.status === "active"
          ? Math.max(level.pivotIndex, activeEndIndex)
          : (level.brokenAtIndex ?? level.supersededAtIndex ?? level.pivotIndex);
        const x1 = view.xOfIndex(level.pivotIndex) + view.colWidth / 2;
        const x2 = view.xOfIndex(endIndex) + view.colWidth / 2;
        const y = view.yOfPrice(level.price);
        canvas.strokeStyle = protectedLevelColor;
        canvas.fillStyle = protectedLevelColor;
        if (level.status === "active") {
          canvas.globalAlpha = 0.85;
          setDash([6, 4]);
        } else if (level.status === "superseded") {
          canvas.globalAlpha = 0.35;
          setDash([2, 3]);
        } else {
          canvas.globalAlpha = 0.28;
          setDash([2, 4]);
        }
        canvas.beginPath();
        canvas.moveTo(x1, y);
        canvas.lineTo(x2, y);
        canvas.stroke();
        if (showLabels && level.status === "active") {
          const labelX = Math.min(x2, view.area.left + view.area.width - 14);
          canvas.fillText(level.kind === "low" ? "PL" : "PH", labelX, y + (level.kind === "low" ? 11 : -4));
        }
      }
    }

    if ((showBOS || showCHoCH) && meta.breakEvents.length) {
      for (const event of meta.breakEvents) {
        if (event.kind === "BOS" && !showBOS) continue;
        if (event.kind === "CHoCH" && !showCHoCH) continue;
        const x1 = view.xOfIndex(event.pivotIndex) + view.colWidth / 2;
        const x2 = view.xOfIndex(event.breakIndex) + view.colWidth / 2;
        const y = view.yOfPrice(event.levelPrice);
        const color = event.direction === "bullish" ? bullishBreakColor : bearishBreakColor;
        canvas.strokeStyle = color;
        canvas.fillStyle = color;
        canvas.globalAlpha = 0.9;
        setDash(event.kind === "BOS" ? [] : [4, 3]);
        canvas.beginPath();
        canvas.moveTo(x1, y);
        canvas.lineTo(x2, y);
        canvas.stroke();
        if (showLabels) {
          const text = event.confirmation === "wick" ? `${event.kind} (wick)` : event.kind;
          canvas.fillText(text, (x1 + x2) / 2, y + (event.direction === "bullish" ? -4 : 11));
        }
      }
    }

    setDash([]);
  }

  if (meta?.pivotMode === "both" && meta.supersededRawPivots.length && typeof canvas.arc === "function" && typeof canvas.stroke === "function") {
    for (const pivot of meta.supersededRawPivots) {
      const x = view.xOfIndex(pivot.index) + view.colWidth / 2;
      const y = view.yOfPrice(pivot.price);
      canvas.globalAlpha = 0.35;
      canvas.strokeStyle = pivot.kind === "high" ? highColor : lowColor;
      canvas.lineWidth = 1;
      canvas.beginPath();
      canvas.arc(x, y, 2.5, 0, Math.PI * 2);
      canvas.stroke();
    }
  }

  for (const point of points) {
    const x = view.xOfIndex(point.index) + view.colWidth / 2;
    const y = view.yOfPrice(point.price);
    const isProvisional = !point.unconfirmed
      && meta?.provisionalPivotIndex === point.index
      && meta?.provisionalPivotKind === point.kind;
    canvas.globalAlpha = point.unconfirmed ? 0.35 : isProvisional ? 0.72 : 1;
    canvas.fillStyle = point.kind === "high" ? highColor : lowColor;
    canvas.fillRect(x - 2, y - 2, 4, 4);
    if (showLabels) canvas.fillText(point.label, x, y + (point.kind === "high" ? -7 : 15));
  }

  canvas.restore();
}

export const swingMapIndicatorDefinition: IndicatorDefinition<SwingMapSettings> = {
  type: "swing-map",
  name: "Swing Map",
  category: "custom",
  defaultPane: "overlay",
  canOverlay: true,
  defaultPlacement: "price-overlay",
  supportedPlacements: ["price-overlay"],
  paneHeight: 0,
  defaultSettings: () => ({
    left: 5,
    right: 5,
    showLabels: true,
    showUnconfirmed: false,
    equalityToleranceSteps: 0,
    highColor: uiColor.sell,
    lowColor: uiColor.buy,
    pivotMode: "structural",
    breakConfirmation: "close",
    showBOS: true,
    showCHoCH: true,
    showProtectedLevels: true,
    bullishBreakColor: uiColor.buy,
    bearishBreakColor: uiColor.sell,
    protectedLevelColor: uiColor.warn,
    lineWidth: 1.5,
  }),
  settingsSchema: {
    sections: [
      {
        title: "Calculation",
        fields: [
          { kind: "number", key: "left", label: "Left closed bars", min: 1, max: 100, step: 1, requiresRecalc: true },
          { kind: "number", key: "right", label: "Right closed bars", min: 1, max: 100, step: 1, requiresRecalc: true },
          { kind: "number", key: "equalityToleranceSteps", label: "Equal price tolerance (price steps)", min: 0, max: 100, step: 1, requiresRecalc: true },
          {
            kind: "select",
            key: "pivotMode",
            label: "Pivot mode",
            options: [
              { label: "Structural (alternating)", value: "structural" },
              { label: "Raw (legacy)", value: "raw" },
              { label: "Both", value: "both" },
            ],
            requiresRecalc: true,
          },
          {
            kind: "select",
            key: "breakConfirmation",
            label: "Break confirmation",
            options: [
              { label: "Candle close", value: "close" },
              { label: "Wick breach", value: "wick" },
            ],
            requiresRecalc: true,
          },
        ],
      },
      {
        title: "Style",
        fields: [
          { kind: "boolean", key: "showLabels", label: "Show structure labels" },
          { kind: "boolean", key: "showUnconfirmed", label: "Show faint unconfirmed candidates" },
          { kind: "boolean", key: "showBOS", label: "Show BOS lines" },
          { kind: "boolean", key: "showCHoCH", label: "Show CHoCH lines" },
          { kind: "boolean", key: "showProtectedLevels", label: "Show protected levels" },
          { kind: "color", key: "highColor", label: "High color" },
          { kind: "color", key: "lowColor", label: "Low color" },
          { kind: "color", key: "bullishBreakColor", label: "Bullish break color" },
          { kind: "color", key: "bearishBreakColor", label: "Bearish break color" },
          { kind: "color", key: "protectedLevelColor", label: "Protected level color" },
          { kind: "number", key: "lineWidth", label: "Break / level line width", min: 1, max: 4, step: 0.5 },
        ],
      },
    ],
  },
  getHeaderLabel: ({ settings }) => {
    const base = `Swings ${settings.left ?? 5}/${settings.right ?? 5}`;
    return settings.breakConfirmation === "wick" ? `${base} (wick)` : base;
  },
  prepareCache: "series-range",
  prepareData: prepareSwingMap,
  drawPriceOverlay: drawSwingMap,
};

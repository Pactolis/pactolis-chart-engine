import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings, IndicatorPreparedData } from "../types.js";
import { IncrementalSwingDetector, type SwingPivot } from "../../../core/analysis/swings.js";
import { numericSetting, stringSetting, visibleIndexRange } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";
import { incrementPerformanceCounter } from "../../../core/performanceTelemetry.js";
import type { FootprintSeries } from "../../../core/model/footprint.js";

export interface SwingMapSettings extends IndicatorSettings {
  left: number; right: number; showLabels: boolean; showUnconfirmed: boolean;
  equalityToleranceSteps: number; highColor: string; lowColor: string;
}
interface SwingMark extends SwingPivot { label: string; unconfirmed?: boolean }
interface SwingState {
  detector: IncrementalSwingDetector; resetEpoch: number; nonTailRevision: number; length: number;
  config: string; marks: SwingMark[];
}
const states = new WeakMap<FootprintSeries, Map<string, SwingState>>();

function structureMarks(pivots: readonly SwingPivot[], tolerance: number): SwingMark[] {
  const previous: Partial<Record<SwingPivot["kind"], number>> = {};
  const marks: SwingMark[] = [];
  for (const pivot of pivots) {
    const prev = previous[pivot.kind];
    previous[pivot.kind] = pivot.price;
    // Retain all pivots in detector state, but omit duplicate-price paint/labels.
    if (prev !== undefined && Math.abs(pivot.price - prev) <= tolerance) continue;
    const label = prev === undefined ? pivot.kind === "high" ? "H" : "L"
      : pivot.kind === "high" ? pivot.price > prev ? "HH" : "LH" : pivot.price > prev ? "HL" : "LL";
    marks.push({ ...pivot, label });
  }
  return marks;
}

function prepareSwingMap(ctx: IndicatorDrawContext<SwingMapSettings>): IndicatorPreparedData<SwingMark> {
  if (!ctx.instance.visible) return { status: "hidden", points: [] };
  const bars = ctx.series.listReadonly();
  const left = Math.floor(numericSetting(ctx.settings, "left", 5, 1, 100));
  const right = Math.floor(numericSetting(ctx.settings, "right", 5, 1, 100));
  const tolerance = numericSetting(ctx.settings, "equalityToleranceSteps", 0, 0, 100) * ctx.series.config.priceStep;
  const config = `${left}|${right}|${tolerance}`;
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
  if (!instances) { instances = new Map(); states.set(ctx.series, instances); }
  let state = instances.get(ctx.instance.id);
  const reset = !state || state.config !== config || state.resetEpoch !== ctx.series.resetEpoch
    || state.nonTailRevision !== ctx.series.nonTailRevision || closedLength < state.length;
  if (reset) {
    const detector = new IncrementalSwingDetector();
    const pivots = detector.update(bars, left, right, "reset", closedLength);
    state = { detector, resetEpoch: ctx.series.resetEpoch, nonTailRevision: ctx.series.nonTailRevision,
      length: closedLength, config, marks: structureMarks(pivots, tolerance) };
    instances.set(ctx.instance.id, state);
    incrementPerformanceCounter("indicator.incremental.full.swing-map");
  } else if (closedLength > state!.length) {
    const pivots = state!.detector.update(bars, left, right, "append", closedLength);
    state!.marks = structureMarks(pivots, tolerance);
    state!.length = closedLength;
    incrementPerformanceCounter("indicator.incremental.hit.swing-map");
  } else {
    // A live tick only changes the excluded open bar: zero historical windows.
    incrementPerformanceCounter("indicator.incremental.hit.swing-map");
  }
  const { start, end } = visibleIndexRange(ctx);
  const points = state!.marks.filter((pivot) => pivot.index >= start && pivot.index < end);
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
  return { status: points.length ? "ok" : "no-data", points, meta: { evaluatedWindows: state!.detector.evaluatedWindows } };
}

function drawSwingMap(ctx: IndicatorDrawContext<SwingMapSettings>, prepared?: IndicatorPreparedData): void {
  if (!prepared?.points?.length) return;
  const canvas = ctx.ctx;
  const view = ctx.view;
  canvas.save();
  canvas.beginPath();
  canvas.rect(view.area.left, view.area.top, view.area.width, view.area.height);
  canvas.clip();
  canvas.font = "10px ui-monospace, monospace";
  canvas.textAlign = "center";
  for (const point of prepared.points as SwingMark[]) {
    const x = view.xOfIndex(point.index) + view.colWidth / 2;
    const y = view.yOfPrice(point.price);
    canvas.globalAlpha = point.unconfirmed ? 0.35 : 1;
    canvas.fillStyle = point.kind === "high" ? stringSetting(ctx.settings, "highColor", uiColor.sell) : stringSetting(ctx.settings, "lowColor", uiColor.buy);
    canvas.fillRect(x - 2, y - 2, 4, 4);
    if (ctx.settings.showLabels !== false) canvas.fillText(point.label, x, y + (point.kind === "high" ? -7 : 15));
  }
  canvas.restore();
}

export const swingMapIndicatorDefinition: IndicatorDefinition<SwingMapSettings> = {
  type: "swing-map", name: "Swing Map", category: "custom", defaultPane: "overlay", canOverlay: true,
  defaultPlacement: "price-overlay", supportedPlacements: ["price-overlay"], paneHeight: 0,
  defaultSettings: () => ({ left: 5, right: 5, showLabels: true, showUnconfirmed: false, equalityToleranceSteps: 0,
    highColor: uiColor.sell, lowColor: uiColor.buy }),
  settingsSchema: { sections: [
    { title: "Calculation", fields: [
      { kind: "number", key: "left", label: "Left closed bars", min: 1, max: 100, step: 1, requiresRecalc: true },
      { kind: "number", key: "right", label: "Right closed bars", min: 1, max: 100, step: 1, requiresRecalc: true },
      { kind: "number", key: "equalityToleranceSteps", label: "Equal price tolerance (price steps)", min: 0, max: 100, step: 1, requiresRecalc: true },
    ] },
    { title: "Style", fields: [
      { kind: "boolean", key: "showLabels", label: "Show structure labels" },
      { kind: "boolean", key: "showUnconfirmed", label: "Show faint unconfirmed candidates" },
      { kind: "color", key: "highColor", label: "High color" }, { kind: "color", key: "lowColor", label: "Low color" },
    ] },
  ] },
  getHeaderLabel: ({ settings }) => `Swings ${settings.left ?? 5}/${settings.right ?? 5}`,
  prepareCache: "series-range", prepareData: prepareSwingMap, drawPriceOverlay: drawSwingMap,
};

import { calculateAnchoredVwap } from "../../core/analysis/anchoredVwap.js";
import { calculateOrderFlowRangeProfile } from "../../core/analysis/rangeProfile.js";
import type { AnalysisContext } from "../../core/analysisContext.js";
import type { AnalysisRevisionSnapshot } from "../../core/analysisRevision.js";
import type {
  AnalysisDrawingSnapshot,
  AnalysisFootprintCellSnapshot,
  AnalysisIndicatorSnapshot,
  AnalysisLevelSnapshot,
  AnalysisOrderFlowProfileLevelSnapshot,
  AnalysisSnapshotOptions,
  ChartAnalysisSnapshot,
} from "../../core/analysisSnapshot.js";
import { AI_ANALYSIS_POLICY } from "../../core/analysisSnapshotPolicy.js";
import type { Drawing, FibonacciLevel } from "../../core/drawingTypes.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import { normalizeFixedRangeOrderFlowProfileSettings } from "../../core/orderFlowProfileSettings.js";
import { bucketEnd } from "../../core/time.js";
import type { FootprintBar, FootprintCell } from "../../core/types.js";

const DEFAULT_MAX_OBJECTS = 50;

function levelStatus(enabled: boolean, visible: boolean): "ok" | "hidden" {
  return enabled && visible ? "ok" : "hidden";
}

function automaticLevels(context: AnalysisContext): AnalysisLevelSnapshot[] {
  const previousWeek = context.previousWeekStrategyLevels.map((level) => ({
    id: level.id,
    source: "previous-week" as const,
    kind: level.kind,
    label: level.label,
    status: levelStatus(context.previousWeekStrategySettings.enabled, context.previousWeekStrategySettings.visible[level.id] !== false),
    ...(typeof level.price === "number" ? { price: level.price } : {}),
    ...(typeof level.fromPrice === "number" && typeof level.toPrice === "number" ? { low: Math.min(level.fromPrice, level.toPrice), high: Math.max(level.fromPrice, level.toPrice) } : {}),
    sourceStart: level.sourceStart,
    sourceEnd: level.sourceEnd,
  }));
  const monday = context.mondayRangeLevels.map((level) => ({
    id: level.id,
    source: "monday-range" as const,
    kind: level.kind,
    label: level.label,
    status: levelStatus(context.mondayRangeSettings.enabled, context.mondayRangeSettings.visible[level.id] !== false),
    ...(typeof level.price === "number" ? { price: level.price } : {}),
    ...(typeof level.fromPrice === "number" && typeof level.toPrice === "number" ? { low: Math.min(level.fromPrice, level.toPrice), high: Math.max(level.fromPrice, level.toPrice) } : {}),
    sourceStart: level.sourceStart,
    sourceEnd: level.sourceEnd,
  }));
  const naked = context.nakedPocs.map((level) => ({
    id: level.id,
    source: "naked-poc" as const,
    kind: "line" as const,
    label: `Naked POC ${level.period}`,
    status: "ok" as const,
    price: level.price,
    sourceStart: level.periodStart,
    sourceEnd: level.periodEnd,
  }));
  const reference = context.referenceLevels.map((level) => ({
    id: level.id,
    source: "reference-level" as const,
    kind: "line" as const,
    label: level.label,
    status: "ok" as const,
    price: level.price,
    sourceStart: level.sourceStart,
    sourceEnd: level.sourceEnd,
    family: level.family,
    period: level.period,
    ...(level.valueAreaKind ? { valueAreaKind: level.valueAreaKind } : {}),
    age: level.age,
    complete: level.complete,
  }));
  return [...previousWeek, ...monday, ...naked, ...reference];
}

const LINE_TYPES = new Set(["horizontal", "horizontal-ray", "partial-price-line"]);
const ZONE_TYPES = new Set(["rectangle", "extended-rectangle", "session-box", "liquidity-zone", "imbalance-zone", "price-range"]);
const TREND_TYPES = new Set(["trend", "trend-ray", "extended-trend"]);
const DEFAULT_FIB_RETRACEMENT: readonly FibonacciLevel[] = [
  { value: 0 }, { value: 0.236 }, { value: 0.382 }, { value: 0.5 }, { value: 0.618 }, { value: 0.786 }, { value: 1 },
];
const DEFAULT_FIB_EXTENSION: readonly FibonacciLevel[] = [
  { value: 0 }, { value: 0.618 }, { value: 1 }, { value: 1.272 }, { value: 1.618 }, { value: 2 }, { value: 2.618 },
];

function drawingStatus(drawing: Drawing): AnalysisDrawingSnapshot["status"] {
  return drawing.visible === false ? "hidden"
    : drawing.dataState === "loading" ? "loading"
      : drawing.dataState === "error" ? "error"
        : drawing.dataState === "incomplete" ? "no-data"
          : "ok";
}

function fibonacciLevelPrice(drawing: Drawing, level: number): number {
  const a = drawing.points[0]?.price ?? 0;
  const b = drawing.points[1]?.price ?? a;
  if (drawing.type === "fibonacci-extension") {
    const c = drawing.points[2]?.price ?? b;
    const impulse = b - a;
    return drawing.fibReverse === true ? c - impulse * level : c + impulse * level;
  }
  return drawing.fibReverse === true ? a + (b - a) * level : b - (b - a) * level;
}

function fibonacciLevels(drawing: Drawing): AnalysisDrawingSnapshot["levels"] {
  const defaults = drawing.type === "fibonacci-extension" ? DEFAULT_FIB_EXTENSION : DEFAULT_FIB_RETRACEMENT;
  const configured = Array.isArray(drawing.fibLevels) && drawing.fibLevels.length ? drawing.fibLevels : defaults;
  return configured
    .filter((level) => level.visible !== false && Number.isFinite(level.value))
    .map((level) => ({
      key: `fib-${level.value}`,
      label: level.text?.trim() || `${level.value * 100}%`,
      price: fibonacciLevelPrice(drawing, level.value),
      ratio: level.value,
    }))
    .filter((level) => Number.isFinite(level.price));
}

function profileBins(levels: ReturnType<typeof calculateOrderFlowRangeProfile>["levels"]): AnalysisOrderFlowProfileLevelSnapshot[] {
  if (!levels.length) return [];
  const sorted = [...levels].sort((a, b) => a.priceBin - b.priceBin);
  const target = Math.min(AI_ANALYSIS_POLICY.profileTargetBins, AI_ANALYSIS_POLICY.profileMaxBins);
  const groupSize = Math.max(1, Math.ceil(sorted.length / target));
  const bins: AnalysisOrderFlowProfileLevelSnapshot[] = [];
  for (let offset = 0; offset < sorted.length; offset += groupSize) {
    const group = sorted.slice(offset, offset + groupSize);
    const buyVolume = group.reduce((sum, level) => sum + level.buyVol, 0);
    const sellVolume = group.reduce((sum, level) => sum + level.sellVol, 0);
    const totalVolume = buyVolume + sellVolume;
    const weightedPrice = totalVolume > 0
      ? group.reduce((sum, level) => sum + level.priceBin * (level.buyVol + level.sellVol), 0) / totalVolume
      : group.reduce((sum, level) => sum + level.priceBin, 0) / group.length;
    const tradeCount = group.reduce((sum, level) => sum + (level.totalCount ?? 0), 0);
    const buyTradeCount = group.reduce((sum, level) => sum + (level.buyCount ?? 0), 0);
    const sellTradeCount = group.reduce((sum, level) => sum + (level.sellCount ?? 0), 0);
    const value = group.reduce((sum, level) => sum + (level.value ?? 0), 0);
    const magnitude = group.reduce((sum, level) => sum + (level.magnitude ?? 0), 0);
    bins.push({
      price: weightedPrice,
      buyVolume,
      sellVolume,
      totalVolume,
      ...(group.some((level) => typeof level.value === "number" && Number.isFinite(level.value)) ? { value } : {}),
      ...(group.some((level) => typeof level.magnitude === "number" && Number.isFinite(level.magnitude)) ? { magnitude } : {}),
      ...(group.some((level) => typeof level.totalCount === "number" && Number.isFinite(level.totalCount)) ? { tradeCount } : {}),
      ...(group.some((level) => typeof level.buyCount === "number" && Number.isFinite(level.buyCount)) ? { buyTradeCount } : {}),
      ...(group.some((level) => typeof level.sellCount === "number" && Number.isFinite(level.sellCount)) ? { sellTradeCount } : {}),
    });
  }
  return bins.slice(0, AI_ANALYSIS_POLICY.profileMaxBins);
}

function drawingSnapshot(drawing: Drawing, series: FootprintSeries): AnalysisDrawingSnapshot {
  const points = drawing.points.filter((point) => Number.isFinite(point.time) && Number.isFinite(point.price)).map((point) => ({ time: point.time, price: point.price }));
  const base: AnalysisDrawingSnapshot = {
    id: drawing.id,
    type: drawing.type,
    ...(drawing.text?.trim() ? { label: drawing.text.trim() } : {}),
    status: drawingStatus(drawing),
    points,
    numericallySupported: false,
  };
  if (LINE_TYPES.has(drawing.type) && points[0]) return { ...base, numericallySupported: true, price: points[0].price };
  if (ZONE_TYPES.has(drawing.type) && points.length >= 2) {
    return { ...base, numericallySupported: true, low: Math.min(points[0].price, points[1].price), high: Math.max(points[0].price, points[1].price) };
  }
  if (TREND_TYPES.has(drawing.type) && points.length >= 2) return { ...base, numericallySupported: true };
  if ((drawing.type === "long-position" || drawing.type === "short-position") && points.length >= 2) {
    return {
      ...base,
      numericallySupported: true,
      entry: points[0].price,
      stop: points[1].price,
      ...(points[2] ? { target: points[2].price } : {}),
    };
  }
  if ((drawing.type === "fibonacci-retracement" && points.length >= 2)
    || (drawing.type === "fibonacci-extension" && points.length >= 3)) {
    return { ...base, numericallySupported: true, levels: fibonacciLevels(drawing) };
  }
  if (drawing.type === "anchored-vwap" && points[0]) {
    const result = calculateAnchoredVwap(series.listReadonly(), points[0].time);
    const samples = result.points
      .filter((point): point is { time: number; value: number } => typeof point.value === "number" && Number.isFinite(point.value))
      .slice(-AI_ANALYSIS_POLICY.anchoredVwapSamples)
      .map((point) => ({ time: point.time, value: point.value }));
    const lastValue = samples.at(-1)?.value ?? null;
    return {
      ...base,
      status: base.status === "ok" && !samples.length ? "no-data" : base.status,
      numericallySupported: true,
      series: samples.length ? [{ key: "avwap", label: "Anchored VWAP", unit: "price", samples }] : [],
      summary: { anchorTime: points[0].time, lastValue },
      ...(!samples.length ? { warnings: ["Anchored VWAP has no numeric value in loaded history"] } : {}),
    };
  }
  if (drawing.type === "fixed-range-volume-profile" && points.length >= 2) {
    const from = Math.min(points[0].time, points[1].time);
    const to = Math.max(points[0].time, points[1].time);
    const settings = normalizeFixedRangeOrderFlowProfileSettings(drawing as unknown as Record<string, unknown>);
    const result = calculateOrderFlowRangeProfile(series.listReadonly(), from, to, {
      profileMetric: settings.profileMetric,
      profileSide: settings.profileSide,
      valueAreaPercent: settings.valueAreaPercent ?? 0.7,
      developing: false,
    });
    const hasData = result.levels.length > 0;
    return {
      ...base,
      status: base.status === "ok" && !hasData ? "no-data" : base.status,
      numericallySupported: true,
      profile: {
        metric: result.profileMetric,
        side: result.profileSide,
        valueAreaPercent: settings.valueAreaPercent ?? 0.7,
        requestedFrom: result.requestedFrom,
        requestedTo: result.requestedTo,
        coverage: result.coverage,
        complete: result.complete,
        dataComplete: result.dataComplete,
        poc: result.poc,
        vah: result.vah,
        val: result.val,
        totalVolume: result.totalVolume,
        ...(typeof result.totalTradeCount === "number" && Number.isFinite(result.totalTradeCount) ? { totalTradeCount: result.totalTradeCount } : {}),
        bins: profileBins(result.levels),
      },
      ...(!result.complete || !result.dataComplete ? { warnings: [`Fixed range profile coverage ${(result.coverage * 100).toFixed(1)}%; footprint data may be incomplete`] } : {}),
    };
  }
  return base;
}

function sizeOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function shrinkProfileBins(snapshot: ChartAnalysisSnapshot, minimum: number, factor: number): boolean {
  let changed = false;
  for (const drawing of snapshot.drawings) {
    const bins = drawing.profile?.bins;
    if (!bins || bins.length <= minimum) continue;
    const nextLength = Math.max(minimum, Math.floor(bins.length * factor));
    const groupSize = Math.max(1, Math.ceil(bins.length / nextLength));
    const merged: AnalysisOrderFlowProfileLevelSnapshot[] = [];
    for (let offset = 0; offset < bins.length; offset += groupSize) {
      const group = bins.slice(offset, offset + groupSize);
      const buyVolume = group.reduce((sum, item) => sum + item.buyVolume, 0);
      const sellVolume = group.reduce((sum, item) => sum + item.sellVolume, 0);
      const totalVolume = buyVolume + sellVolume;
      const price = totalVolume > 0
        ? group.reduce((sum, item) => sum + item.price * item.totalVolume, 0) / totalVolume
        : group.reduce((sum, item) => sum + item.price, 0) / group.length;
      merged.push({
        price,
        buyVolume,
        sellVolume,
        totalVolume,
        ...(group.some((item) => typeof item.value === "number") ? { value: group.reduce((sum, item) => sum + (item.value ?? 0), 0) } : {}),
        ...(group.some((item) => typeof item.magnitude === "number") ? { magnitude: group.reduce((sum, item) => sum + (item.magnitude ?? 0), 0) } : {}),
        ...(group.some((item) => typeof item.tradeCount === "number") ? { tradeCount: group.reduce((sum, item) => sum + (item.tradeCount ?? 0), 0) } : {}),
        ...(group.some((item) => typeof item.buyTradeCount === "number") ? { buyTradeCount: group.reduce((sum, item) => sum + (item.buyTradeCount ?? 0), 0) } : {}),
        ...(group.some((item) => typeof item.sellTradeCount === "number") ? { sellTradeCount: group.reduce((sum, item) => sum + (item.sellTradeCount ?? 0), 0) } : {}),
      });
    }
    drawing.profile!.bins = merged.slice(-nextLength);
    changed = true;
  }
  return changed;
}

function dropOldestFootprintDetail(snapshot: ChartAnalysisSnapshot): boolean {
  const candle = snapshot.candles.find((item) => item.footprint?.length);
  if (!candle?.footprint?.length) return false;
  delete candle.footprint;
  return true;
}

function shrinkDrawingSeries(snapshot: ChartAnalysisSnapshot, minimum: number, factor: number): boolean {
  let changed = false;
  for (const drawing of snapshot.drawings) {
    for (const series of drawing.series ?? []) {
      if (series.samples.length <= minimum) continue;
      const nextLength = Math.max(minimum, Math.floor(series.samples.length * factor));
      series.samples = series.samples.slice(-nextLength);
      changed = true;
    }
  }
  return changed;
}

function shrinkIndicatorSamples(snapshot: ChartAnalysisSnapshot, minimum: number, factor: number): boolean {
  let changed = false;
  for (const indicator of snapshot.indicators) {
    for (const series of indicator.series) {
      if (series.samples.length <= minimum) continue;
      const nextLength = Math.max(minimum, Math.floor(series.samples.length * factor));
      series.samples = series.samples.slice(-nextLength);
      changed = true;
    }
  }
  return changed;
}

function shrinkObjects(snapshot: ChartAnalysisSnapshot, minimum: number, factor: number): boolean {
  const total = snapshot.levels.length + snapshot.drawings.length;
  if (total <= minimum) return false;
  const nextTotal = Math.max(minimum, Math.floor(total * factor));
  const keepLevels = Math.min(snapshot.levels.length, nextTotal);
  snapshot.levels = snapshot.levels.slice(0, keepLevels);
  snapshot.drawings = snapshot.drawings.slice(0, Math.max(0, nextTotal - keepLevels));
  return nextTotal < total;
}

export function fitAnalysisSnapshotToBytes(snapshot: ChartAnalysisSnapshot, maxBytes: number): void {
  let bytes = sizeOf(snapshot);
  if (bytes <= maxBytes) return;
  snapshot.warnings.push(`Analysis input exceeded ${maxBytes} bytes; oldest rich detail was reduced first`);

  while (bytes > maxBytes && shrinkProfileBins(snapshot, 48, 0.75)) bytes = sizeOf(snapshot);
  while (bytes > maxBytes && dropOldestFootprintDetail(snapshot)) bytes = sizeOf(snapshot);
  while (bytes > maxBytes && shrinkDrawingSeries(snapshot, 32, 0.75)) bytes = sizeOf(snapshot);
  while (bytes > maxBytes && shrinkIndicatorSamples(snapshot, 64, 0.75)) bytes = sizeOf(snapshot);

  while (bytes > maxBytes && snapshot.candles.length > 64) {
    snapshot.candles = snapshot.candles.slice(-Math.max(64, Math.floor(snapshot.candles.length * 0.75)));
    bytes = sizeOf(snapshot);
  }
  while (bytes > maxBytes && shrinkIndicatorSamples(snapshot, 16, 0.75)) bytes = sizeOf(snapshot);
  while (bytes > maxBytes && shrinkObjects(snapshot, 20, 0.75)) bytes = sizeOf(snapshot);
  while (bytes > maxBytes && snapshot.candles.length > 1) {
    snapshot.candles = snapshot.candles.slice(-Math.max(1, Math.floor(snapshot.candles.length / 2)));
    bytes = sizeOf(snapshot);
  }
  while (bytes > maxBytes && shrinkIndicatorSamples(snapshot, 1, 0.5)) bytes = sizeOf(snapshot);
  while (bytes > maxBytes && shrinkObjects(snapshot, 0, 0.5)) bytes = sizeOf(snapshot);
  while (bytes > maxBytes && snapshot.indicators.length) {
    snapshot.indicators.pop();
    bytes = sizeOf(snapshot);
  }

  if (bytes > maxBytes && snapshot.warnings.length > 1) {
    snapshot.warnings = ["Analysis input reduced to byte limit while preserving the newest market context and viewport metadata"];
  }
}

function footprintCell(cell: FootprintCell): AnalysisFootprintCellSnapshot {
  return {
    price: cell.priceBin,
    buyVolume: cell.buyVol,
    sellVolume: cell.sellVol,
    totalVolume: cell.buyVol + cell.sellVol,
    delta: cell.buyVol - cell.sellVol,
    ...(typeof cell.count === "number" && Number.isFinite(cell.count) ? { tradeCount: cell.count } : {}),
    ...(typeof cell.buyCount === "number" && Number.isFinite(cell.buyCount) ? { buyTradeCount: cell.buyCount } : {}),
    ...(typeof cell.sellCount === "number" && Number.isFinite(cell.sellCount) ? { sellTradeCount: cell.sellCount } : {}),
    ...(typeof cell.liquidationBuyVol === "number" && Number.isFinite(cell.liquidationBuyVol) ? { liquidationBuyVolume: cell.liquidationBuyVol } : {}),
    ...(typeof cell.liquidationSellVol === "number" && Number.isFinite(cell.liquidationSellVol) ? { liquidationSellVolume: cell.liquidationSellVol } : {}),
  };
}

function fullFootprintCells(bar: FootprintBar): AnalysisFootprintCellSnapshot[] {
  return [...bar.cells.values()].sort((a, b) => a.priceBin - b.priceBin).map(footprintCell);
}

function normalizeTimeRange(range: AnalysisSnapshotOptions["visibleTimeRange"]): { from: number; to: number } | null {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return null;
  return { from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) };
}

function normalizePriceRange(range: AnalysisSnapshotOptions["visiblePriceRange"]): { low: number; high: number } | null {
  if (!range || !Number.isFinite(range.low) || !Number.isFinite(range.high)) return null;
  return { low: Math.min(range.low, range.high), high: Math.max(range.low, range.high) };
}

function levelIntersectsPriceRange(level: AnalysisLevelSnapshot, range: { low: number; high: number }): boolean {
  if (typeof level.price === "number") return level.price >= range.low && level.price <= range.high;
  if (typeof level.low === "number" && typeof level.high === "number") return level.high >= range.low && level.low <= range.high;
  return true;
}

export function buildChartAnalysisSnapshot(args: {
  panelId: string;
  market: string;
  timeframe: string;
  intervalMs: number;
  selectionGeneration: number;
  series: FootprintSeries;
  analysis: AnalysisContext;
  analysisRevision: AnalysisRevisionSnapshot;
  indicators: AnalysisIndicatorSnapshot[];
  options?: AnalysisSnapshotOptions;
}): ChartAnalysisSnapshot {
  const now = args.options?.now ?? Date.now();
  const timeRange = normalizeTimeRange(args.options?.visibleTimeRange);
  const priceRange = normalizePriceRange(args.options?.visiblePriceRange);
  const maxCandles = Math.max(0, Math.floor(args.options?.maxCandles ?? AI_ANALYSIS_POLICY.candleBars));
  const maxObjects = args.options?.maxLevelsAndDrawings ?? DEFAULT_MAX_OBJECTS;
  const excluded = args.options?.excludedSourceIds ?? new Set<string>();
  const includeHidden = args.options?.includeHiddenSources === true;
  const allBars = args.series.listReadonly();
  const closedBars = allBars.filter((bar) => bucketEnd(bar.startTime, args.intervalMs) <= now);
  const scopedBars = timeRange
    ? closedBars.filter((bar) => bucketEnd(bar.startTime, args.intervalMs) > timeRange.from && bar.startTime <= timeRange.to)
    : closedBars;
  const selectedBars = scopedBars.slice(-maxCandles);
  const warnings: string[] = [];
  let detailedFootprintBars = 0;
  const candles = selectedBars.map((bar, index) => {
    const barsFromEnd = selectedBars.length - index;
    const footprintMeasured = bar.cells.size > 0;
    const includeOrderFlowSummary = footprintMeasured && barsFromEnd <= AI_ANALYSIS_POLICY.orderFlowSummaryBars;
    const includeDeltaBySize = barsFromEnd <= AI_ANALYSIS_POLICY.deltaBySizeBars;
    const includeFootprint = footprintMeasured && barsFromEnd <= AI_ANALYSIS_POLICY.fullFootprintBars;
    if (includeFootprint) detailedFootprintBars++;
    return {
      time: bar.startTime,
      endTime: bucketEnd(bar.startTime, args.intervalMs),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      ...(includeOrderFlowSummary && Number.isFinite(bar.delta) ? { delta: bar.delta } : {}),
      ...(includeOrderFlowSummary && Number.isFinite(bar.count) ? { count: bar.count } : {}),
      ...(includeDeltaBySize && Array.isArray(bar.deltaBySize) && bar.deltaBySize.every(Number.isFinite) ? { deltaBySize: [...bar.deltaBySize] } : {}),
      ...(includeOrderFlowSummary && typeof bar.liquidationBuyVol === "number" && Number.isFinite(bar.liquidationBuyVol) ? { liquidationBuyVolume: bar.liquidationBuyVol } : {}),
      ...(includeOrderFlowSummary && typeof bar.liquidationSellVol === "number" && Number.isFinite(bar.liquidationSellVol) ? { liquidationSellVolume: bar.liquidationSellVol } : {}),
      ...(includeFootprint ? { footprint: fullFootprintCells(bar) } : {}),
    };
  });
  const measuredFootprintBars = selectedBars.filter((bar) => bar.cells.size > 0).length;
  if (measuredFootprintBars > detailedFootprintBars) warnings.push(`Detailed footprint cells are limited to the latest ${AI_ANALYSIS_POLICY.fullFootprintBars} contiguous candles`);
  if (scopedBars.length > selectedBars.length) warnings.push(`Candle context is limited to the latest ${selectedBars.length} contiguous bars`);
  if (timeRange && !selectedBars.length) warnings.push("No closed candles intersect the visible time range");

  let levels = automaticLevels(args.analysis)
    .filter((item) => (includeHidden || item.status !== "hidden") && !excluded.has(`level:${item.id}`))
    .filter((item) => !priceRange || levelIntersectsPriceRange(item, priceRange));
  let drawings = args.analysis.drawings.listForMarket(args.market)
    .filter((drawing) => (includeHidden || drawing.visible !== false) && !excluded.has(`drawing:${drawing.id}`))
    .map((drawing) => drawingSnapshot(drawing, args.series));
  const totalObjects = levels.length + drawings.length;
  if (totalObjects > maxObjects) {
    warnings.push(`Level/drawing scope was reduced from ${totalObjects} to ${maxObjects}`);
    const keepLevels = Math.min(levels.length, maxObjects);
    levels = levels.slice(0, keepLevels);
    drawings = drawings.slice(0, Math.max(0, maxObjects - keepLevels));
  }
  const indicators = args.indicators.filter((item) => (includeHidden || item.status !== "hidden") && !excluded.has(`indicator:${item.instanceId}`));
  for (const indicator of indicators) if (indicator.status !== "ok" && indicator.status !== "hidden") warnings.push(`${indicator.name}: ${indicator.status}`);

  const snapshot: ChartAnalysisSnapshot = {
    schemaVersion: 1,
    panelId: args.panelId,
    market: args.market,
    timeframe: args.timeframe,
    intervalMs: args.intervalMs,
    selectionGeneration: args.selectionGeneration,
    capturedAt: now,
    lastClosedBarEnd: candles.at(-1)?.endTime ?? null,
    historyStatus: allBars.length ? "ready" : "empty",
    automaticAnalysisStatus: args.analysisRevision.canonical.status,
    ...(timeRange && priceRange ? { viewport: { timeFrom: timeRange.from, timeTo: timeRange.to, priceLow: priceRange.low, priceHigh: priceRange.high } } : {}),
    candles,
    levels,
    drawings,
    indicators,
    warnings,
  };
  fitAnalysisSnapshotToBytes(snapshot, args.options?.maxBytes ?? AI_ANALYSIS_POLICY.snapshotTargetBytes);
  return snapshot;
}

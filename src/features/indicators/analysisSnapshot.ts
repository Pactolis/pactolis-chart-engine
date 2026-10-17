import { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type {
  AnalysisIndicatorSeries,
  AnalysisIndicatorSnapshot,
  AnalysisScope,
} from "../../core/analysisSnapshot.js";
import { AI_ANALYSIS_POLICY } from "../../core/analysisSnapshotPolicy.js";
import { IndicatorPrepareCache } from "./prepareCache.js";
import type {
  IndicatorDefinition,
  IndicatorDrawContext,
  IndicatorInstance,
  IndicatorPreparedData,
  IndicatorSettings,
} from "./types.js";

const VISIBLE_RANGE_TYPES = new Set(["bar-stats", "volume-profile"]);
const POINT_ADAPTER_TYPES = new Set(["cross-exchange-open-interest", "funding-regime", "futures-positioning", "liquidations"]);
const PERCENT_TYPES = new Set(["rsi", "stochastic", "stoch-rsi", "williams-r", "mfi", "funding-regime"]);
const PRICE_TYPES = new Set(["ema", "sma", "moving-average", "vwap", "bollinger", "ichimoku", "ichimoku-cloud", "atr", "volume-profile"]);
const USD_TYPES = new Set(["cross-exchange-open-interest", "futures-positioning", "liquidations", "options-gex-wall"]);
// One cache per series, so it goes away with the chart's data. Analysis reads
// alternate between the closed bars and the visible range, so two ranges stay.
const analysisPrepareCaches = new WeakMap<FootprintSeries, IndicatorPrepareCache>();
const ANALYSIS_RANGES_PER_INSTANCE = 2;

type TimeframeVisibilityUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";
interface TimeframeVisibilityRule { enabled?: boolean; min?: number; max?: number }
const TIMEFRAME_VISIBILITY_LIMITS: Record<TimeframeVisibilityUnit, { min: number; max: number }> = {
  seconds: { min: 1, max: 59 }, minutes: { min: 1, max: 59 }, hours: { min: 1, max: 24 },
  days: { min: 1, max: 366 }, weeks: { min: 1, max: 52 }, months: { min: 1, max: 12 },
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function latestSamples<T>(items: readonly T[], requestedLimit: number): T[] {
  const limit = Math.max(1, Math.min(AI_ANALYSIS_POLICY.indicatorSamples, Math.floor(requestedLimit)));
  return items.length <= limit ? [...items] : items.slice(-limit);
}

/**
 * The last `requestedLimit` items that `toSample` maps to a sample, in order.
 * Same result as filtering every item and keeping the tail, but walks back
 * from the end so a 10k-point series costs only the samples it returns.
 */
function latestMappedSamples<T, S>(items: readonly T[], requestedLimit: number, toSample: (item: T) => S | null): S[] {
  const limit = Math.max(1, Math.min(AI_ANALYSIS_POLICY.indicatorSamples, Math.floor(requestedLimit)));
  const samples: S[] = [];
  for (let index = items.length - 1; index >= 0 && samples.length < limit; index--) {
    const sample = toSample(items[index]);
    if (sample !== null) samples.push(sample);
  }
  return samples.reverse();
}

function timeframeUnitAndValue(timeframe: string, intervalMs: number): { unit: TimeframeVisibilityUnit; value: number } {
  const match = /^(\d+)([smhdwM])$/.exec(timeframe);
  if (match) {
    const unitBySuffix: Record<string, TimeframeVisibilityUnit> = { s: "seconds", m: "minutes", h: "hours", d: "days", w: "weeks", M: "months" };
    return { unit: unitBySuffix[match[2]], value: Math.max(1, Number(match[1])) };
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (intervalMs < minute) return { unit: "seconds", value: Math.max(1, Math.round(intervalMs / 1000)) };
  if (intervalMs < hour) return { unit: "minutes", value: Math.max(1, Math.round(intervalMs / minute)) };
  if (intervalMs < day) return { unit: "hours", value: Math.max(1, Math.round(intervalMs / hour)) };
  if (intervalMs < 7 * day) return { unit: "days", value: Math.max(1, Math.round(intervalMs / day)) };
  return { unit: "weeks", value: Math.max(1, Math.round(intervalMs / (7 * day))) };
}

function visibleAtTimeframe(settings: IndicatorSettings, chart: { timeframe: string; intervalMs: number }): boolean {
  const { unit, value } = timeframeUnitAndValue(chart.timeframe, chart.intervalMs);
  const limits = TIMEFRAME_VISIBILITY_LIMITS[unit];
  const rule = asObject(settings.timeframeVisibility)[unit] as TimeframeVisibilityRule | undefined;
  if (rule?.enabled === false) return false;
  const min = Math.max(limits.min, Number.isFinite(rule?.min) ? Number(rule?.min) : limits.min);
  const max = Math.min(limits.max, Number.isFinite(rule?.max) ? Number(rule?.max) : limits.max);
  return value >= Math.min(min, max) && value <= Math.max(min, max);
}

function unitFor(type: string, key: string): string {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey.includes("percent") || normalizedKey.includes("ratio") || normalizedKey.includes("rate")
    || normalizedKey.includes("confidence") || normalizedKey.includes("share") || PERCENT_TYPES.has(type)) return "%";
  if (normalizedKey.includes("price") || normalizedKey.includes("poc") || normalizedKey.includes("vah") || normalizedKey.includes("val")
    || normalizedKey.includes("wall") || normalizedKey.includes("flip") || normalizedKey.includes("maxpain") || normalizedKey.includes("max pain")
    || normalizedKey.includes("strike")) return "price";
  if (normalizedKey.includes("usd") || normalizedKey.includes("notional") || normalizedKey.includes("gex")) return "USD";
  if (normalizedKey.includes("count") || normalizedKey.includes("trades")) return "count";
  if (normalizedKey.includes("volume") || normalizedKey.includes("delta") || normalizedKey.includes("cvd")) return "volume";
  if (USD_TYPES.has(type)) return "USD";
  if (PRICE_TYPES.has(type)) return "price";
  return "value";
}

function finiteSummary(meta: Record<string, unknown> | undefined): Record<string, number | string | boolean | null> {
  if (!meta) return {};
  const summary: Record<string, number | string | boolean | null> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "number" && Number.isFinite(value)) summary[key] = value;
    else if (typeof value === "string" || typeof value === "boolean" || value === null) summary[key] = value;
  }
  return summary;
}

function genericSeries(type: string, prepared: IndicatorPreparedData | undefined, limit: number): AnalysisIndicatorSeries[] {
  const raw = prepared?.meta?.series;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): AnalysisIndicatorSeries[] => {
    if (!item || typeof item !== "object") return [];
    const series = item as { key?: unknown; label?: unknown; points?: unknown[] };
    if (!Array.isArray(series.points)) return [];
    const samples = latestMappedSamples(series.points, limit, (point) => {
      if (!point || typeof point !== "object") return null;
      const value = (point as { value?: unknown }).value;
      const time = (point as { time?: unknown }).time;
      if (typeof value !== "number" || !Number.isFinite(value) || typeof time !== "number" || !Number.isFinite(time)) return null;
      const sourceTime = (point as { sourceTime?: unknown }).sourceTime;
      return { time, value, ...(typeof sourceTime === "number" && Number.isFinite(sourceTime) ? { sourceTime } : {}) };
    });
    if (!samples.length) return [];
    const key = typeof series.key === "string" ? series.key : "value";
    return [{ key, label: typeof series.label === "string" ? series.label : key, unit: unitFor(type, key), samples }];
  });
}

function barStatsSeries(prepared: IndicatorPreparedData | undefined, time: number, limit: number): AnalysisIndicatorSeries[] {
  const meta = prepared?.meta;
  if (!meta || !("volume" in meta) || !("delta" in meta)) return [];
  const keys = ["open", "high", "low", "close", "volume", "delta", "deltaPercent", "count", "liquidationBuyVol", "liquidationSellVol"];
  return keys.flatMap((key): AnalysisIndicatorSeries[] => {
    const value = meta[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    return [{ key, label: key, unit: unitFor("bar-stats", key), samples: latestSamples([{ time, value }], limit) }];
  });
}

function volumeProfileSeries(prepared: IndicatorPreparedData | undefined, time: number): AnalysisIndicatorSeries[] {
  const result = prepared?.meta?.result;
  if (!result || typeof result !== "object") return [];
  const profile = result as { poc?: unknown; vah?: unknown; val?: unknown };
  const output: AnalysisIndicatorSeries[] = [];
  for (const key of ["poc", "vah", "val"] as const) {
    const value = profile[key];
    if (typeof value === "number" && Number.isFinite(value)) output.push({ key, label: key.toUpperCase(), unit: "price", samples: [{ time, value }] });
  }
  return output;
}

function preparedPointSeries(type: string, prepared: IndicatorPreparedData | undefined, limit: number): AnalysisIndicatorSeries[] {
  const raw = prepared?.points;
  if (!Array.isArray(raw) || !raw.length) return [];
  const ignored = new Set(["index", "time", "candleStart", "candleEnd", "hasData"]);
  const keys = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const point = item as Record<string, unknown>;
    for (const key in point) {
      if (!Object.prototype.hasOwnProperty.call(point, key) || ignored.has(key) || keys.has(key)) continue;
      const value = point[key];
      if (typeof value === "number" && Number.isFinite(value)) keys.add(key);
    }
  }
  return [...keys].flatMap((key): AnalysisIndicatorSeries[] => {
    const samples = latestMappedSamples(raw, limit, (item) => {
      if (!item || typeof item !== "object") return null;
      const point = item as Record<string, unknown>;
      const value = point[key];
      const alignedTime = typeof point.candleStart === "number" && Number.isFinite(point.candleStart)
        ? point.candleStart
        : typeof point.time === "number" && Number.isFinite(point.time) ? point.time : null;
      if (typeof value !== "number" || !Number.isFinite(value) || alignedTime === null) return null;
      const sourceTime = typeof point.time === "number" && Number.isFinite(point.time) && point.time !== alignedTime ? point.time : null;
      return { time: alignedTime, value, ...(sourceTime === null ? {} : { sourceTime }) };
    });
    return samples.length ? [{ key, label: key, unit: unitFor(type, key), samples }] : [];
  });
}

function optionsGexSeries(prepared: IndicatorPreparedData | undefined): AnalysisIndicatorSeries[] {
  const surface = asObject(prepared?.meta?.surface);
  const time = typeof surface.timestamp === "number" && Number.isFinite(surface.timestamp) ? surface.timestamp : 0;
  if (!Object.keys(surface).length || !time) return [];
  const values: Record<string, unknown> = {
    spotPrice: surface.spotPrice,
    totalGrossGexUsd: surface.totalGrossGexUsd,
    callTotalGrossGexUsd: surface.callTotalGrossGexUsd,
    putTotalGrossGexUsd: surface.putTotalGrossGexUsd,
    strikeNetGexCrossing: surface.strikeNetGexCrossing,
    callWall: surface.callWall,
    putWall: surface.putWall,
    maxPain: surface.maxPain,
    oiConcentrationHhi: surface.oiConcentrationHhi,
  };
  for (const [prefix, rawZone] of [
    ["callWallZone", surface.callWallZone],
    ["putWallZone", surface.putWallZone],
    ["strikeNetGexCrossingZone", surface.strikeNetGexCrossingZone],
  ] as const) {
    const zone = asObject(rawZone);
    values[`${prefix}Low`] = zone.priceLow;
    values[`${prefix}High`] = zone.priceHigh;
    values[`${prefix}Confidence`] = zone.confidence;
  }
  const distance = asObject(surface.distanceAdjusted);
  values.distanceAdjustedNetGexUsd = distance.netGexUsd;
  values.distanceAdjustedGrossGexUsd = distance.grossGexUsd;
  values.distanceAdjustedAtmIvPct = distance.atmIvPct;

  return Object.entries(values).flatMap(([key, value]): AnalysisIndicatorSeries[] =>
    typeof value === "number" && Number.isFinite(value)
      ? [{ key, label: key, unit: unitFor("options-gex-wall", key), samples: [{ time, value }] }]
      : []);
}

function optionsGexSummary(prepared: IndicatorPreparedData | undefined): Record<string, number | string | boolean | null> {
  const summary = finiteSummary(prepared?.meta);
  const surface = asObject(prepared?.meta?.surface);
  for (const key of ["spotPrice", "totalGrossGexUsd", "callTotalGrossGexUsd", "putTotalGrossGexUsd", "strikeNetGexCrossing", "callWall", "putWall", "maxPain", "oiConcentrationHhi"] as const) {
    const value = surface[key];
    if (typeof value === "number" && Number.isFinite(value)) summary[key] = value;
    else if (value === null) summary[key] = null;
  }
  const crossingKind = surface.strikeNetGexCrossingKind;
  if (typeof crossingKind === "string") summary.strikeNetGexCrossingKind = crossingKind;
  return summary;
}

function scopeFor(instance: IndicatorInstance): AnalysisScope {
  return VISIBLE_RANGE_TYPES.has(instance.type) ? "visible-range" : "closed-bars";
}

function prepareForAnalysis(
  instance: IndicatorInstance,
  definition: IndicatorDefinition,
  series: FootprintSeries,
  chart: { market: string; timeframe: string; intervalMs: number },
  range: [number, number],
  context: IndicatorDrawContext<IndicatorSettings>,
): IndicatorPreparedData | undefined {
  const prepare = definition.prepareData;
  if (!prepare) return undefined;
  const cachePolicy = definition.prepareCache;
  if (!cachePolicy) return prepare(context);
  const maxAgeMs = typeof cachePolicy === "string" ? 0 : Math.max(1, cachePolicy.maxAgeMs);
  let analysisPrepareCache = analysisPrepareCaches.get(series);
  if (!analysisPrepareCache) {
    analysisPrepareCache = new IndicatorPrepareCache(ANALYSIS_RANGES_PER_INSTANCE);
    analysisPrepareCaches.set(series, analysisPrepareCache);
  }
  return analysisPrepareCache.resolve(instance.id, {
    definitionType: definition.type,
    instance,
    series,
    rangeFrom: range[0],
    rangeTo: range[1],
    market: chart.market,
    timeframe: chart.timeframe,
    intervalMs: chart.intervalMs,
    timeBucket: maxAgeMs > 0 ? Math.floor(Date.now() / maxAgeMs) : 0,
  }, () => prepare(context));
}

export function buildIndicatorAnalysisSnapshot(
  instance: IndicatorInstance,
  definition: IndicatorDefinition | undefined,
  series: FootprintSeries,
  chart: { market: string; timeframe: string; intervalMs: number },
  range: [number, number],
  maxSamples: number = AI_ANALYSIS_POLICY.indicatorSamples,
): AnalysisIndicatorSnapshot {
  const base = {
    instanceId: instance.id,
    type: instance.type,
    name: instance.title || definition?.name || instance.type,
    parameters: structuredClone(instance.settings),
    scope: scopeFor(instance),
    warnings: [] as string[],
  };
  if (instance.visible === false || !visibleAtTimeframe(instance.settings, chart)) return { ...base, status: "hidden", series: [], summary: {} };
  if (definition?.inputSource === "view") return { ...base, status: "unsupported", series: [], summary: {}, warnings: ["view-adapter-unavailable"] };
  if (!definition?.prepareData) return { ...base, status: "unsupported", series: [], summary: {}, warnings: ["Indicator does not expose numeric analysis data"] };

  const sampleLimit = Math.max(1, Math.min(AI_ANALYSIS_POLICY.indicatorSamples, Math.floor(maxSamples)));
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 500 };
  const context: IndicatorDrawContext<IndicatorSettings> = {
    ctx: {} as CanvasRenderingContext2D,
    view,
    series,
    rect: { top: 0, height: 200 },
    range,
    instance: instance as IndicatorInstance<IndicatorSettings>,
    settings: instance.settings,
    chart,
    crosshair: { x: 0, y: 0, visible: false },
    requestRefresh: () => {},
  };

  let prepared: IndicatorPreparedData | undefined;
  try {
    prepared = prepareForAnalysis(instance, definition, series, chart, range, context);
  } catch (error) {
    return { ...base, status: "error", series: [], summary: {}, warnings: [error instanceof Error ? error.message : "Indicator analysis failed"] };
  }

  if (definition.analysisExport) {
    try {
      const exported = definition.analysisExport(context, prepared);
      return {
        ...base,
        status: exported.status ?? prepared?.status ?? "ok",
        scope: exported.scope ?? base.scope,
        series: exported.series.map((item) => ({ ...item, samples: latestSamples(item.samples, sampleLimit) })),
        summary: exported.summary ?? finiteSummary(prepared?.meta),
        warnings: exported.warnings ?? [],
      };
    } catch (error) {
      return { ...base, status: "error", series: [], summary: {}, warnings: [error instanceof Error ? error.message : "Indicator analysis export failed"] };
    }
  }

  const time = series.at(Math.max(0, range[1] - 1))?.startTime ?? 0;
  let output = genericSeries(instance.type, prepared, sampleLimit);
  if (!output.length && instance.type === "bar-stats") output = barStatsSeries(prepared, time, sampleLimit);
  if (!output.length && instance.type === "volume-profile") output = volumeProfileSeries(prepared, time);
  if (!output.length && POINT_ADAPTER_TYPES.has(instance.type)) output = preparedPointSeries(instance.type, prepared, sampleLimit);
  if (!output.length && instance.type === "options-gex-wall") output = optionsGexSeries(prepared);
  const warnings = prepared?.message ? [prepared.message] : prepared?.error ? [prepared.error] : [];
  const status = prepared?.status ?? (output.length ? "ok" : "unsupported");
  return {
    ...base,
    status: status === "ok" && !output.length ? "unsupported" : status,
    series: output,
    summary: instance.type === "options-gex-wall" ? optionsGexSummary(prepared) : finiteSummary(prepared?.meta),
    warnings: status === "ok" && !output.length ? [...warnings, "Numeric output shape is not supported"] : warnings,
  };
}

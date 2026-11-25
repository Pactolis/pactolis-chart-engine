import {
  accumulateOrderFlowOiDeltaBar,
  accumulateOrderFlowProfileBar,
  calculateOrderFlowProfile,
  cloneOrderFlowProfileAccumulator,
  createOrderFlowProfileAccumulator,
  finishOrderFlowProfile,
  type OrderFlowProfileAccumulator,
  type OrderFlowProfileOptions,
  type OrderFlowProfileResult,
  type ProfileMetric,
  type ProfileSide,
} from "../../../core/analysis/orderFlowProfile.js";
import { sessionBars } from "../../../core/analysis/volumeProfile.js";
import { chartLocale, t, tOr } from "../../../core/chartLocale.js";
import {
  DEFAULT_OI_VENUES,
  levelModeHasDeveloping,
  levelModeHasStatic,
  normalizeOrderFlowProfileSettings,
  profileSupportsValueArea,
  selectedOiVenues,
  type OiDeltaDisplay,
  type OiProfileVenue,
  type OrderFlowProfilePlacement,
  type ProfileLevelDisplay,
  type ProfileLineStyle,
} from "../../../core/orderFlowProfileSettings.js";
import { lineDash, profileHistogramParts, stepSegments } from "../../../core/render/orderFlowProfile.js";
import { bucketEnd } from "../../../core/time.js";
import type { FootprintBar } from "../../../core/types.js";
import type { FootprintSeries } from "../../../core/model/footprint.js";
import { incrementPerformanceCounter } from "../../../core/performanceTelemetry.js";
import { uiColor, volumeProfileReadoutTextColor } from "../../../core/ui/seriesPalette.js";
import type { IndicatorDefinition, IndicatorDrawContext, IndicatorPreparedData, IndicatorSettings } from "../types.js";
import { indicatorDataSource } from "../indicatorDataSource.js";
import type { OpenInterestSeriesResponse, OpenInterestVenue } from "../metricContracts.js";
import { compactNumber, drawIndicatorBadge, drawIndicatorMessage } from "../render/indicatorPaneUi.js";
import {
  buildOiRevisionKey,
  computeBarOiDeltas,
  formatOiDeltaBadge,
  type OiDeltaComputationResult,
} from "./oiDeltaProfile.js";
import { numericSetting, stringSetting } from "./taShared.js";
import { createIndicatorSeriesStateStore } from "./stateRegistry.js";

interface VolumeProfileIndicatorSettings extends IndicatorSettings {
  mode: "visible" | "session" | "lookback";
  lookbackBars: number;
  profileMetric: ProfileMetric;
  profileSide: ProfileSide;
  profilePlacement: OrderFlowProfilePlacement;
  oiVenues: Record<OiProfileVenue, boolean>;
  oiDeltaDisplay: OiDeltaDisplay;
  valueAreaPercent: number;
  maxWidth: number;
  buyColor: string;
  sellColor: string;
  pocMode: ProfileLevelDisplay;
  vahMode: ProfileLevelDisplay;
  valMode: ProfileLevelDisplay;
  pocStaticColor: string;
  pocStaticWidth: number;
  pocStaticStyle: ProfileLineStyle;
  pocDevelopingColor: string;
  pocDevelopingWidth: number;
  pocDevelopingStyle: ProfileLineStyle;
  vahStaticColor: string;
  vahStaticWidth: number;
  vahStaticStyle: ProfileLineStyle;
  vahDevelopingColor: string;
  vahDevelopingWidth: number;
  vahDevelopingStyle: ProfileLineStyle;
  valStaticColor: string;
  valStaticWidth: number;
  valStaticStyle: ProfileLineStyle;
  valDevelopingColor: string;
  valDevelopingWidth: number;
  valDevelopingStyle: ProfileLineStyle;
  showReadout: boolean;
  showPlotLabel: boolean;
}

interface VolumeProfileOiMeta {
  resolution: string;
  activeVenueCount: number;
  coveragePercent: number;
  effectiveRecordingStartedAt: number | null;
  firstBarTime: number | null;
  source?: "backend" | "browser" | "instant-only";
  oiDeltaDisplay: OiDeltaDisplay;
  oiOpenTotal: number;
  oiCloseTotal: number;
}

interface VolumeProfileMeta extends Record<string, unknown> {
  result: OrderFlowProfileResult;
  maxMagnitude: number;
  selectedBars: number;
  oiMeta?: VolumeProfileOiMeta;
}

type VolumeProfilePreparedData = IndicatorPreparedData<never, VolumeProfileMeta> & { meta: VolumeProfileMeta };

function normalizedSettings(settings: IndicatorSettings): VolumeProfileIndicatorSettings {
  return normalizeOrderFlowProfileSettings(settings) as VolumeProfileIndicatorSettings;
}

/**
 * Per series + instance cache of the profile window minus its last bar.
 *
 * A live tick only changes the series tail, and cells are accumulated in bar order, so
 * `clone(prefix) + tail bar` performs the same float additions in the same order as a full
 * build: the result is bit-identical while the cost no longer scales with the window's
 * bars x cells (only with price levels). The cache is reused only while structureRevision and
 * nonTailRevision are unchanged (so no bar other than the tail changed) and the window has
 * the same first bar, last bar and length; anything else rebuilds the prefix from scratch.
 */
interface VolumeProfileLruEntry {
  key: string;
  structureRevision: number;
  nonTailRevision: number;
  seriesRevision: number;
  startIndex: number;
  endIndex: number;
  prepared: VolumeProfilePreparedData;
}

interface VolumeProfileCache {
  key: string;
  structureRevision: number;
  nonTailRevision: number;
  seriesRevision: number;
  startIndex: number;
  endIndex: number;
  firstTime: number;
  lastTime: number;
  length: number;
  prefix: OrderFlowProfileAccumulator | null;
  visibleAcc: OrderFlowProfileAccumulator | null;
  lruEntries: VolumeProfileLruEntry[];
  prepared: VolumeProfilePreparedData;
}
const MAX_VOLUME_PROFILE_LRU = 4;
const volumeProfileCaches = createIndicatorSeriesStateStore<VolumeProfileCache>();
const seriesAscendingCache = new WeakMap<FootprintSeries, { structureRevision: number; ascending: boolean }>();
const developingIndexCache = new WeakMap<
  VolumeProfileMeta,
  { structureRevision: number; developingIndices: Int32Array }
>();

function windowIsAscending(bars: readonly FootprintBar[]): boolean {
  for (let i = 1; i < bars.length; i++) if (bars[i].startTime <= bars[i - 1].startTime) return false;
  return true;
}

function isSeriesSliceAscending(series: FootprintSeries, all: readonly FootprintBar[], bars: readonly FootprintBar[], startIndex: number): boolean {
  if (bars.length === 0) return false;
  if (startIndex >= 0 && startIndex + bars.length <= all.length && all[startIndex] === bars[0]) {
    const cached = seriesAscendingCache.get(series);
    if (cached && cached.structureRevision === series.structureRevision) {
      return cached.ascending;
    }
    const ascending = windowIsAscending(all);
    seriesAscendingCache.set(series, { structureRevision: series.structureRevision, ascending });
    return ascending;
  }
  return windowIsAscending(bars);
}

function pushVolumeProfileLru(lruEntries: VolumeProfileLruEntry[], entry: VolumeProfileLruEntry): void {
  const existingIdx = lruEntries.findIndex(
    (e) =>
      e.key === entry.key
      && e.structureRevision === entry.structureRevision
      && e.nonTailRevision === entry.nonTailRevision
      && e.seriesRevision === entry.seriesRevision
      && e.startIndex === entry.startIndex
      && e.endIndex === entry.endIndex,
  );
  if (existingIdx >= 0) {
    lruEntries.splice(existingIdx, 1);
  } else if (lruEntries.length >= MAX_VOLUME_PROFILE_LRU) {
    lruEntries.shift();
  }
  lruEntries.push(entry);
}

function safeLocaleTag(): string {
  try {
    return chartLocale().locale();
  } catch {
    return "en";
  }
}

function buildVolumeProfilePrepared(
  ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>,
  profile: OrderFlowProfileResult,
  selectedBars: number,
  startIndex: number,
  oiMeta?: VolumeProfileOiMeta,
): VolumeProfilePreparedData {
  const result = profile;
  if (result.availability === "unavailable") {
    return emptyPrepared("unsupported", tOr("indicator.volumeProfile.estimatedMetricUnsupported"), result);
  }
  const maxMagnitude = result.levels.reduce((max, level) => Math.max(max, level.magnitude ?? 0), 0);
  const validLevels = result.levels.filter((level) => level.value !== null);
  if (!result.levels.length || !validLevels.length) {
    const noDataMsg = result.profileMetric === "oi-delta"
      ? tOr("indicator.volumeProfile.oiNoData")
      : t("indicator.volumeProfile.noData");
    return emptyPrepared("no-data", noDataMsg, result);
  }
  const first = result.levels[0]?.priceBin ?? 0;
  const last = result.levels[result.levels.length - 1]?.priceBin ?? first;
  const message = result.profileMetric === "oi-delta" && oiMeta
    ? formatOiDeltaBadge(oiMeta, result.isEstimated, ctx.series.config.intervalMs, safeLocaleTag())
    : result.isEstimated
      ? (result.provenance === "mixed" ? tOr("indicator.volumeProfile.mixed") : tOr("indicator.volumeProfile.estimated"))
      : (result.dataComplete ? undefined : t("indicator.volumeProfile.incompleteData"));
  let developingIndices: Int32Array | null = null;
  if (result.developing.length > 0 && startIndex >= 0 && selectedBars === result.developing.length) {
    developingIndices = new Int32Array(result.developing.length);
    for (let i = 0; i < result.developing.length; i += 1) {
      developingIndices[i] = startIndex + i;
    }
  }
  const meta: VolumeProfileMeta = oiMeta
    ? { result, maxMagnitude, selectedBars, oiMeta }
    : { result, maxMagnitude, selectedBars };
  if (developingIndices !== null) {
    developingIndexCache.set(meta, {
      structureRevision: ctx.series.structureRevision,
      developingIndices,
    });
  }
  return {
    status: "ok",
    points: [],
    range: { min: first, max: last + ctx.series.config.priceStep },
    meta,
    message,
  };
}

function buildOiMeta(
  result: OrderFlowProfileResult,
  comp: OiDeltaComputationResult,
  firstBarTime: number | null,
  oiDeltaDisplay: OiDeltaDisplay,
): VolumeProfileOiMeta {
  let oiOpenTotal = 0;
  let oiCloseTotal = 0;
  for (const level of result.levels) {
    oiOpenTotal += level.oiOpen ?? 0;
    oiCloseTotal += level.oiClose ?? 0;
  }
  return {
    resolution: comp.resolution,
    activeVenueCount: comp.activeVenueCount,
    coveragePercent: comp.coveragePercent,
    effectiveRecordingStartedAt: comp.effectiveRecordingStartedAt,
    firstBarTime,
    source: comp.source,
    oiDeltaDisplay,
    oiOpenTotal,
    oiCloseTotal,
  };
}

function prepareOiDeltaVolumeProfile(
  ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>,
  settings: VolumeProfileIndicatorSettings,
  bars: FootprintBar[],
  startIndex: number,
  endIndex: number,
): VolumeProfilePreparedData {
  const emptyOi = () => emptyPrepared("no-data", tOr("indicator.volumeProfile.oiNoData"), calculateOrderFlowProfile([], { profileMetric: "oi-delta" }));
  if (bars.length === 0 || !ctx.chart) return emptyOi();

  let requestFn: ReturnType<typeof indicatorDataSource>["requestOpenInterestSeries"] | undefined;
  try {
    requestFn = indicatorDataSource().requestOpenInterestSeries;
  } catch {
    return emptyOi();
  }
  if (!requestFn) return emptyOi();

  const venues = selectedOiVenues(settings.oiVenues) as OpenInterestVenue[];
  const firstBar = bars[0];
  const lastBar = bars[bars.length - 1];
  const intervalMs = ctx.chart.intervalMs || ctx.series.config.intervalMs;
  const state = requestFn({
    market: ctx.chart.market,
    timeframe: ctx.chart.timeframe,
    intervalMs,
    venues,
    from: firstBar.startTime,
    to: bucketEnd(lastBar.startTime, intervalMs),
    onUpdate: ctx.requestRefresh,
  });

  if (state.status === "loading" || state.status === "idle") {
    return emptyPrepared("no-data", tOr("indicator.volumeProfile.oiLoading"), calculateOrderFlowProfile([], { profileMetric: "oi-delta" }));
  }
  if (state.status === "unsupported" || state.status === "error") {
    return emptyOi();
  }
  const response: OpenInterestSeriesResponse = state.data;
  if (response.status === "unsupported" || response.status === "no-data" || response.venues.length === 0) {
    return emptyOi();
  }

  const { series } = ctx;
  const mode = stringSetting(settings, "mode", "visible");
  const oiDeltaDisplay: OiDeltaDisplay = settings.oiDeltaDisplay === "split" ? "split" : "net";
  const options: OrderFlowProfileOptions = {
    profileMetric: "oi-delta",
    profileSide: "total",
    oiDeltaDisplay,
    developing: false,
    priceStep: series.config.priceStep,
    allowOhlcvEstimate: true,
  };
  const oiRev = buildOiRevisionKey(response, venues, oiDeltaDisplay);
  const key = `oi-delta|${oiRev}|${series.config.priceStep}|${mode}|${numericSetting(settings, "lookbackBars", 200, 1, 10_000)}`;
  const all = series.listReadonly();
  const cached = volumeProfileCaches.get(series, ctx.instance.id);

  if (
    cached
    && cached.key === key
    && cached.structureRevision === series.structureRevision
    && cached.nonTailRevision === series.nonTailRevision
    && cached.firstTime === firstBar.startTime
    && cached.lastTime === lastBar.startTime
    && cached.length === bars.length
  ) {
    if (cached.seriesRevision === series.revision) return cached.prepared;
    if (all[all.length - 1] !== lastBar) {
      cached.seriesRevision = series.revision;
      return cached.prepared;
    }
    if (cached.prefix && cached.prepared.meta.oiMeta) {
      const tailComp = computeBarOiDeltas([lastBar], intervalMs, response, venues);
      const acc = cloneOrderFlowProfileAccumulator(cached.prefix);
      accumulateOrderFlowOiDeltaBar(acc, lastBar, tailComp.barDeltas[0], options);
      const result = finishOrderFlowProfile(acc, options);
      const prevOiMeta = cached.prepared.meta.oiMeta;
      const oiMeta = buildOiMeta(result, {
        ...tailComp,
        coveragePercent: prevOiMeta.coveragePercent,
        coveredBarCount: prevOiMeta.coveragePercent,
        totalBarCount: 100,
        activeVenueCount: prevOiMeta.activeVenueCount,
        effectiveRecordingStartedAt: prevOiMeta.effectiveRecordingStartedAt,
      }, firstBar.startTime, oiDeltaDisplay);
      cached.visibleAcc = acc;
      cached.prepared = buildVolumeProfilePrepared(ctx, result, bars.length, startIndex, oiMeta);
      cached.seriesRevision = series.revision;
      incrementPerformanceCounter("indicator.incremental.hit.volumeProfile");
      return cached.prepared;
    }
  }

  const ascending = isSeriesSliceAscending(series, all, bars, startIndex);
  const orderedBars = ascending ? bars : [...bars].sort((a, b) => a.startTime - b.startTime);
  const oiComp = computeBarOiDeltas(orderedBars, intervalMs, response, venues);
  if (oiComp.coveredBarCount === 0) {
    return emptyOi();
  }

  const includesTail = ascending && lastBar === all[all.length - 1] && intervalMs >= oiComp.resolutionMs;
  let prefix: OrderFlowProfileAccumulator | null = null;
  let acc: OrderFlowProfileAccumulator;
  if (includesTail) {
    prefix = createOrderFlowProfileAccumulator();
    for (let i = 0; i < orderedBars.length - 1; i += 1) {
      accumulateOrderFlowOiDeltaBar(prefix, orderedBars[i], oiComp.barDeltas[i], options);
    }
    acc = cloneOrderFlowProfileAccumulator(prefix);
    accumulateOrderFlowOiDeltaBar(acc, lastBar, oiComp.barDeltas[orderedBars.length - 1], options);
  } else {
    acc = createOrderFlowProfileAccumulator();
    for (let i = 0; i < orderedBars.length; i += 1) {
      accumulateOrderFlowOiDeltaBar(acc, orderedBars[i], oiComp.barDeltas[i], options);
    }
  }

  const result = finishOrderFlowProfile(acc, options);
  const oiMeta = buildOiMeta(result, oiComp, orderedBars[0]?.startTime ?? null, oiDeltaDisplay);
  const prepared = buildVolumeProfilePrepared(ctx, result, bars.length, ascending ? startIndex : -1, oiMeta);
  if (ascending) {
    volumeProfileCaches.set(series, ctx.instance.id, {
      key,
      structureRevision: series.structureRevision,
      nonTailRevision: series.nonTailRevision,
      seriesRevision: series.revision,
      startIndex,
      endIndex,
      firstTime: firstBar.startTime,
      lastTime: lastBar.startTime,
      length: bars.length,
      prefix,
      visibleAcc: null,
      lruEntries: cached?.lruEntries ?? [],
      prepared,
    });
  }
  incrementPerformanceCounter("indicator.incremental.full.volumeProfile");
  return prepared;
}

function prepareVolumeProfile(ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>): VolumeProfilePreparedData {
  if (!ctx.instance.visible) return emptyPrepared("hidden", "");
  const settings = normalizedSettings(ctx.settings);
  const { bars, startIndex, endIndex } = selectBars(ctx, settings);
  const profileMetric = settings.profileMetric;
  if (profileMetric === "oi-delta") {
    return prepareOiDeltaVolumeProfile(ctx, settings, bars, startIndex, endIndex);
  }
  const developing = profileSupportsValueArea(profileMetric)
    && [settings.pocMode, settings.vahMode, settings.valMode].some(levelModeHasDeveloping);
  const { series } = ctx;
  const mode = stringSetting(settings, "mode", "visible");
  const options: OrderFlowProfileOptions = {
    profileMetric,
    profileSide: settings.profileSide,
    valueAreaPercent: numericSetting(settings, "valueAreaPercent", 70, 1, 99) / 100,
    developing,
    priceStep: series.config.priceStep,
    allowOhlcvEstimate: true,
  };
  const key = `${profileMetric}|${options.profileSide}|${options.valueAreaPercent}|${developing}|${series.config.priceStep}|${mode}|${numericSetting(settings, "lookbackBars", 200, 1, 10_000)}`;
  const firstBar = bars[0];
  const lastBar = bars[bars.length - 1];
  const all = series.listReadonly();
  const cached = volumeProfileCaches.get(series, ctx.instance.id);
  if (
    cached && firstBar && lastBar
    && cached.key === key
    && cached.structureRevision === series.structureRevision
    && cached.nonTailRevision === series.nonTailRevision
    && cached.firstTime === firstBar.startTime
    && cached.lastTime === lastBar.startTime
    && cached.length === bars.length
  ) {
    if (cached.seriesRevision === series.revision) return cached.prepared;
    // Window ends before the series tail: nothing inside it can have changed.
    if (all[all.length - 1] !== lastBar) {
      cached.seriesRevision = series.revision;
      return cached.prepared;
    }
    if (cached.prefix) {
      const acc = cloneOrderFlowProfileAccumulator(cached.prefix);
      accumulateOrderFlowProfileBar(acc, lastBar, options);
      cached.visibleAcc = acc;
      cached.prepared = buildVolumeProfilePrepared(ctx, finishOrderFlowProfile(acc, options), bars.length, startIndex);
      cached.seriesRevision = series.revision;
      pushVolumeProfileLru(cached.lruEntries, {
        key,
        structureRevision: series.structureRevision,
        nonTailRevision: series.nonTailRevision,
        seriesRevision: series.revision,
        startIndex,
        endIndex,
        prepared: cached.prepared,
      });
      incrementPerformanceCounter("indicator.incremental.hit.volumeProfile");
      return cached.prepared;
    }
  }

  if (cached && startIndex >= 0 && endIndex > startIndex) {
    const lruIdx = cached.lruEntries.findIndex(
      (e) =>
        e.key === key
        && e.structureRevision === series.structureRevision
        && e.nonTailRevision === series.nonTailRevision
        && e.seriesRevision === series.revision
        && e.startIndex === startIndex
        && e.endIndex === endIndex,
    );
    if (lruIdx >= 0) {
      const hit = cached.lruEntries.splice(lruIdx, 1)[0];
      cached.lruEntries.push(hit);
      incrementPerformanceCounter("indicator.incremental.delta.volumeProfile");
      return hit.prepared;
    }
  }

  const ascending = isSeriesSliceAscending(series, all, bars, startIndex);
  if (
    ascending
    && mode === "visible"
    && !developing
    && cached
    && cached.visibleAcc
    && cached.key === key
    && cached.structureRevision === series.structureRevision
    && cached.nonTailRevision === series.nonTailRevision
    && cached.seriesRevision === series.revision
    && startIndex >= 0
    && startIndex === cached.startIndex
    && endIndex > cached.endIndex
  ) {
    const acc = cached.visibleAcc;
    for (let i = cached.endIndex; i < endIndex; i++) {
      accumulateOrderFlowProfileBar(acc, all[i], options);
    }
    acc.fromTime = firstBar!.startTime;
    acc.toTime = lastBar!.startTime;
    const prepared = buildVolumeProfilePrepared(ctx, finishOrderFlowProfile(acc, options), bars.length, startIndex);
    cached.endIndex = endIndex;
    cached.lastTime = lastBar!.startTime;
    cached.length = bars.length;
    cached.prefix = null;
    cached.prepared = prepared;
    pushVolumeProfileLru(cached.lruEntries, {
      key,
      structureRevision: series.structureRevision,
      nonTailRevision: series.nonTailRevision,
      seriesRevision: series.revision,
      startIndex,
      endIndex,
      prepared,
    });
    incrementPerformanceCounter("indicator.incremental.delta.volumeProfile");
    return prepared;
  }

  if (!ascending) {
    volumeProfileCaches.delete(series, ctx.instance.id);
    const acc = createOrderFlowProfileAccumulator();
    for (const bar of [...bars].sort((a, b) => a.startTime - b.startTime)) accumulateOrderFlowProfileBar(acc, bar, options);
    return buildVolumeProfilePrepared(ctx, finishOrderFlowProfile(acc, options), bars.length, -1);
  }

  const includesTail = lastBar === all[all.length - 1];
  let prefix: OrderFlowProfileAccumulator | null = null;
  let acc: OrderFlowProfileAccumulator;
  if (includesTail) {
    prefix = createOrderFlowProfileAccumulator();
    for (let i = 0; i < bars.length - 1; i++) accumulateOrderFlowProfileBar(prefix, bars[i], options);
    acc = cloneOrderFlowProfileAccumulator(prefix);
    accumulateOrderFlowProfileBar(acc, lastBar!, options);
  } else {
    acc = createOrderFlowProfileAccumulator();
    for (let i = 0; i < bars.length; i++) accumulateOrderFlowProfileBar(acc, bars[i], options);
  }
  const prepared = buildVolumeProfilePrepared(ctx, finishOrderFlowProfile(acc, options), bars.length, startIndex);
  const canRightExtend = mode === "visible" && !developing;
  const lruEntries = cached?.lruEntries ?? [];
  if (startIndex >= 0 && endIndex > startIndex) {
    pushVolumeProfileLru(lruEntries, {
      key,
      structureRevision: series.structureRevision,
      nonTailRevision: series.nonTailRevision,
      seriesRevision: series.revision,
      startIndex,
      endIndex,
      prepared,
    });
  }
  volumeProfileCaches.set(series, ctx.instance.id, {
    key,
    structureRevision: series.structureRevision,
    nonTailRevision: series.nonTailRevision,
    seriesRevision: series.revision,
    startIndex,
    endIndex,
    firstTime: firstBar!.startTime,
    lastTime: lastBar!.startTime,
    length: bars.length,
    prefix,
    visibleAcc: canRightExtend ? acc : null,
    lruEntries,
    prepared,
  });
  incrementPerformanceCounter("indicator.incremental.full.volumeProfile");
  return prepared;
}

function lowerBoundBarIndex(all: readonly FootprintBar[], targetTime: number): number {
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (all[mid].startTime < targetTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function selectBars(
  ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>,
  settings = normalizedSettings(ctx.settings),
): { bars: FootprintBar[]; startIndex: number; endIndex: number } {
  const all = ctx.series.listReadonly();
  const [from, to] = ctx.range;
  const s = Math.max(0, from);
  const e = Math.min(all.length, to);
  const visible = all.slice(s, e);
  const mode = stringSetting(settings, "mode", "visible");
  if (mode === "session") {
    const anchor = visible[visible.length - 1]?.startTime ?? all[all.length - 1]?.startTime;
    const bars = anchor === undefined ? visible : sessionBars(all, anchor);
    if (bars.length === 0) return { bars, startIndex: -1, endIndex: -1 };
    const idx = lowerBoundBarIndex(all, bars[0].startTime);
    const startIndex = idx < all.length && all[idx].startTime === bars[0].startTime ? idx : -1;
    return { bars, startIndex, endIndex: startIndex >= 0 ? startIndex + bars.length : -1 };
  }
  if (mode === "lookback") {
    const count = numericSetting(settings, "lookbackBars", 200, 1, 10_000);
    const last = visible.length > 0 ? e : all.length;
    if (last <= 0) return { bars: [], startIndex: -1, endIndex: -1 };
    const startIndex = Math.max(0, last - count);
    return { bars: all.slice(startIndex, last), startIndex, endIndex: last };
  }
  return { bars: visible, startIndex: visible.length > 0 ? s : -1, endIndex: visible.length > 0 ? e : -1 };
}

function asVolumeProfileData(prepared?: IndicatorPreparedData): VolumeProfilePreparedData {
  if (prepared?.meta && "result" in prepared.meta) return prepared as VolumeProfilePreparedData;
  return emptyPrepared("no-data", prepared?.message ?? prepared?.error ?? t("indicator.volumeProfile.noData"));
}

function drawVolumeProfileOverlay(ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>, prepared?: IndicatorPreparedData): void {
  const data = asVolumeProfileData(prepared);
  const { view, series, ctx: canvas } = ctx;
  const { result, maxMagnitude } = data.meta;
  const settings = normalizedSettings(ctx.settings);
  const placement: OrderFlowProfilePlacement = settings.profilePlacement === "left" ? "left" : "right";
  if (data.status !== "ok") {
    if ((result.isEstimated || settings.profileMetric === "oi-delta") && ctx.settings.showPlotLabel !== false) {
      drawIndicatorBadge(
        canvas,
        data.message ?? tOr("indicator.volumeProfile.estimatedMetricUnsupported"),
        placement === "left" ? view.area.left + 8 : view.area.left + view.area.width - 8,
        view.area.top + 18,
        { color: uiColor.warn, align: placement, maxWidth: Math.max(180, view.area.width - 16) },
      );
    }
    return;
  }
  const step = series.config.priceStep;
  const maxWidth = Math.min(view.area.width * 0.34, numericSetting(settings, "maxWidth", 180, 40, 500));
  const anchorX = placement === "left" ? view.area.left + 4 : view.area.left + view.area.width - 4;
  const buyColor = stringSetting(settings, "buyColor", uiColor.buy);
  const sellColor = stringSetting(settings, "sellColor", uiColor.sell);
  const deltaZeroX = placement === "left" ? anchorX + maxWidth / 2 : anchorX - maxWidth / 2;

  canvas.save();
  canvas.beginPath();
  canvas.rect(view.area.left, view.area.top, view.area.width, view.area.height);
  canvas.clip();
  for (const level of result.levels) {
    const yTop = view.yOfPrice(level.priceBin + step);
    const yBottom = view.yOfPrice(level.priceBin);
    if (yBottom < view.area.top || yTop > view.area.top + view.area.height) continue;
    const rowHeight = Math.max(1, yBottom - yTop - 1);
    const parts = profileHistogramParts(level, result.profileMetric, result.profileSide, settings.oiDeltaDisplay);
    canvas.globalAlpha = 0.55;
    if (result.profileMetric === "delta" || result.profileMetric === "oi-delta") {
      for (const part of parts) {
        const width = (maxWidth / 2) * (part.value / Math.max(maxMagnitude, Number.EPSILON));
        canvas.fillStyle = part.signed >= 0 ? buyColor : sellColor;
        canvas.fillRect(part.signed >= 0 ? deltaZeroX : deltaZeroX - width, yTop, width, rowHeight);
      }
      continue;
    }
    let cursor = anchorX;
    const orderedParts = placement === "left" ? parts : [...parts].reverse();
    for (const part of orderedParts) {
      const width = maxWidth * (part.value / Math.max(maxMagnitude, Number.EPSILON));
      canvas.fillStyle = part.side === "sell"
        ? sellColor
        : part.side === "total" && result.isEstimated
          ? uiColor.info
          : buyColor;
      if (placement === "left") {
        canvas.fillRect(cursor, yTop, width, rowHeight);
        cursor += width;
      } else {
        canvas.fillRect(cursor - width, yTop, width, rowHeight);
        cursor -= width;
      }
    }
  }
  canvas.globalAlpha = 1;
  if (profileSupportsValueArea(result.profileMetric)) {
    const estSuffix = result.isEstimated ? " (~)" : "";
    const anyDeveloping = (["poc", "vah", "val"] as const).some((prefix) =>
      levelModeHasDeveloping(stringSetting(settings, `${prefix}Mode`, "static") as ProfileLevelDisplay),
    );
    const sharedIndices = anyDeveloping && result.developing.length > 0
      ? resolveSharedDevelopingIndices(series, data.meta)
      : null;
    drawConfiguredLevel(ctx, settings, "poc", result.poc, result.developing, sharedIndices, `POC${estSuffix}`, `dPOC${estSuffix}`, uiColor.warn);
    drawConfiguredLevel(ctx, settings, "vah", result.vah, result.developing, sharedIndices, `VAH${estSuffix}`, `dVAH${estSuffix}`, uiColor.info);
    drawConfiguredLevel(ctx, settings, "val", result.val, result.developing, sharedIndices, `VAL${estSuffix}`, `dVAL${estSuffix}`, uiColor.info);
  }
  if (result.profileMetric === "oi-delta" && data.meta.oiMeta && settings.showPlotLabel !== false) {
    const badge = data.message ?? formatOiDeltaBadge(
      data.meta.oiMeta,
      result.isEstimated,
      series.config.intervalMs,
      safeLocaleTag(),
    );
    drawIndicatorBadge(canvas, badge, anchorX, view.area.top + 16, {
      color: result.isEstimated || data.meta.oiMeta.coveragePercent < 100 ? uiColor.warn : uiColor.info,
      align: placement,
      maxWidth: Math.max(160, Math.min(340, view.area.width - 16)),
    });
  } else if (result.isEstimated && settings.showPlotLabel !== false) {
    const badge = tOr(result.provenance === "mixed" ? "indicator.volumeProfile.mixed" : "indicator.volumeProfile.estimated");
    drawIndicatorBadge(canvas, badge, anchorX, view.area.top + 16, {
      color: uiColor.warn,
      align: placement,
      maxWidth: Math.max(120, Math.min(240, view.area.width - 16)),
    });
  }
  canvas.restore();
}

function resolveSharedDevelopingIndices(
  series: FootprintSeries,
  meta: VolumeProfileMeta,
): Int32Array {
  const points = meta.result.developing;
  const cached = developingIndexCache.get(meta);
  if (
    cached
    && cached.structureRevision === series.structureRevision
    && cached.developingIndices.length === points.length
  ) {
    return cached.developingIndices;
  }
  const all = series.listReadonly();
  const indices = new Int32Array(points.length);
  if (points.length === 0 || all.length === 0) {
    indices.fill(-1);
    developingIndexCache.set(meta, {
      structureRevision: series.structureRevision,
      developingIndices: indices,
    });
    return indices;
  }
  let cursor = lowerBoundBarIndex(all, points[0].time);
  for (let i = 0; i < points.length; i += 1) {
    const targetTime = points[i].time;
    if (cursor < all.length && all[cursor].startTime === targetTime) {
      indices[i] = cursor;
      cursor += 1;
      continue;
    }
    const found = lowerBoundBarIndex(all, targetTime);
    if (found < all.length && all[found].startTime === targetTime) {
      indices[i] = found;
      cursor = found + 1;
    } else {
      indices[i] = -1;
      cursor = found;
    }
  }
  developingIndexCache.set(meta, {
    structureRevision: series.structureRevision,
    developingIndices: indices,
  });
  return indices;
}

function drawConfiguredLevel(
  ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>,
  settings: VolumeProfileIndicatorSettings,
  prefix: "poc" | "vah" | "val",
  staticPrice: number | null,
  developing: OrderFlowProfileResult["developing"],
  developingIndices: Int32Array | null,
  staticLabel: string,
  developingLabel: string,
  fallbackColor: string,
): void {
  const mode = stringSetting(settings, `${prefix}Mode`, "static") as ProfileLevelDisplay;
  if (levelModeHasStatic(mode)) {
    drawStaticLevel(
      ctx,
      staticPrice,
      staticLabel,
      stringSetting(settings, `${prefix}StaticColor`, fallbackColor),
      numericSetting(settings, `${prefix}StaticWidth`, 1, 1, 5),
      stringSetting(settings, `${prefix}StaticStyle`, "dashed") as ProfileLineStyle,
    );
  }
  if (levelModeHasDeveloping(mode) && developingIndices) {
    drawDevelopingLevel(
      ctx,
      developing,
      developingIndices,
      prefix,
      developingLabel,
      stringSetting(settings, `${prefix}DevelopingColor`, fallbackColor),
      numericSetting(settings, `${prefix}DevelopingWidth`, 1, 1, 5),
      stringSetting(settings, `${prefix}DevelopingStyle`, "solid") as ProfileLineStyle,
    );
  }
}

function drawStaticLevel(
  ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>,
  price: number | null,
  label: string,
  color: string,
  width: number,
  style: ProfileLineStyle,
): void {
  if (price == null || !Number.isFinite(price)) return;
  const { ctx: canvas, view } = ctx;
  const y = view.yOfPrice(price);
  if (y < view.area.top || y > view.area.top + view.area.height) return;
  canvas.strokeStyle = color;
  canvas.lineWidth = width;
  canvas.setLineDash(lineDash(style));
  canvas.beginPath();
  canvas.moveTo(view.area.left, y);
  canvas.lineTo(view.area.left + view.area.width, y);
  canvas.stroke();
  canvas.setLineDash([]);
  ctx.queuePriceLabel?.(price, label, color, 64);
}

function drawDevelopingLevel(
  ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>,
  points: OrderFlowProfileResult["developing"],
  developingIndices: Int32Array,
  field: "poc" | "vah" | "val",
  label: string,
  color: string,
  width: number,
  style: ProfileLineStyle,
): void {
  const { ctx: canvas, view } = ctx;
  const runs: Array<Array<{ x: number; y: number; price: number }>> = [];
  let current: Array<{ x: number; y: number; price: number }> = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const price = point[field];
    if (!point.valid || price === null || !Number.isFinite(price)) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    const index = developingIndices[i];
    if (index < 0) continue;
    current.push({ x: view.xOfIndex(index) + view.colWidth / 2, y: view.yOfPrice(price), price });
  }
  if (current.length) runs.push(current);
  if (!runs.length) return;
  canvas.strokeStyle = color;
  canvas.lineWidth = width;
  canvas.setLineDash(lineDash(style));
  for (const run of runs) {
    for (const [x1, y1, x2, y2] of stepSegments(run)) {
      canvas.beginPath();
      canvas.moveTo(x1, y1);
      canvas.lineTo(x2, y2);
      canvas.stroke();
    }
  }
  canvas.setLineDash([]);
  const lastRun = runs[runs.length - 1];
  const last = lastRun[lastRun.length - 1];
  if (last) ctx.queuePriceLabel?.(last.price, label, color, 63);
}

function metricLabel(metric: ProfileMetric): string {
  if (metric === "oi-delta") return tOr("indicator.volumeProfile.metric.oiDelta");
  if (metric === "trade-count") return t("indicator.volumeProfile.metric.tradeCount");
  if (metric === "average-trade-size") return t("indicator.volumeProfile.metric.averageTradeSize");
  if (metric === "delta") return t("indicator.volumeProfile.metric.delta");
  return t("indicator.volumeProfile.metric.volume");
}

function sideLabel(side: ProfileSide): string {
  if (side === "buy") return t("indicator.volumeProfile.side.buy");
  if (side === "sell") return t("indicator.volumeProfile.side.sell");
  return t("indicator.volumeProfile.side.total");
}

function headerLabel({ settings, prepared }: { settings: VolumeProfileIndicatorSettings; prepared?: IndicatorPreparedData }): string {
  if (settings.showPlotLabel === false) return "";
  const normalized = normalizedSettings(settings);
  const data = asVolumeProfileData(prepared);
  const result = data.meta.result;
  if (normalized.profileMetric === "oi-delta") {
    const displayLabel = normalized.oiDeltaDisplay === "split"
      ? tOr("indicator.volumeProfile.oiDeltaDisplay.split")
      : tOr("indicator.volumeProfile.oiDeltaDisplay.net");
    const badge = data.status === "ok" && data.message ? ` · ${data.message}` : "";
    const count = data.status === "ok" ? ` · ${data.meta.selectedBars} ${t("indicator.volumeProfile.bars")}` : "";
    return `Order Flow Profile · ${metricLabel(normalized.profileMetric)} · ${displayLabel}${badge}${count}`;
  }
  const provenanceTag = result.provenance === "mixed"
    ? ` · ${tOr("indicator.volumeProfile.mixed")}`
    : result.isEstimated
      ? ` · ${tOr("indicator.volumeProfile.estimated")}`
      : "";
  const count = data.status === "ok" ? ` · ${data.meta.selectedBars} ${t("indicator.volumeProfile.bars")}` : "";
  const side = normalized.profileMetric === "delta" || result.isEstimated ? "" : ` · ${sideLabel(normalized.profileSide)}`;
  return `Order Flow Profile · ${metricLabel(normalized.profileMetric)}${side}${provenanceTag}${count}`;
}

function drawProfilePane(ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>, prepared?: IndicatorPreparedData): void {
  const data = asVolumeProfileData(prepared);
  const { ctx: canvas, rect, view } = ctx;
  if (data.status !== "ok") {
    drawIndicatorMessage(ctx, data.message ?? t("indicator.volumeProfile.noData"));
    return;
  }
  if (ctx.settings.showReadout === false) return;
  const { result, selectedBars, oiMeta } = data.meta;
  const lines = result.profileMetric === "oi-delta" && oiMeta
    ? [
        `${t("indicator.volumeProfile.bars")}: ${selectedBars}`,
        `${metricLabel(result.profileMetric)}: ${result.summaryValue === null ? "—" : compactNumber(result.summaryValue)}`,
        `${tOr("indicator.volumeProfile.oiDeltaDisplay.split")}: +${compactNumber(oiMeta.oiOpenTotal)} / ${compactNumber(oiMeta.oiCloseTotal)}`,
      ]
    : [
        `${t("indicator.volumeProfile.bars")}: ${selectedBars}`,
        `${metricLabel(result.profileMetric)}: ${result.summaryValue === null ? "—" : compactNumber(result.summaryValue)}`,
        `POC: ${result.poc?.toLocaleString() ?? "—"}`,
        `VAH/VAL: ${result.vah?.toLocaleString() ?? "—"} / ${result.val?.toLocaleString() ?? "—"}`,
      ];
  if (!result.dataComplete) lines.push(t("indicator.volumeProfile.dataIncomplete"));
  canvas.save();
  canvas.fillStyle = volumeProfileReadoutTextColor;
  canvas.font = "12px ui-sans-serif, system-ui, sans-serif";
  lines.forEach((line, index) => canvas.fillText(line, view.area.left + 10 + index * 135, rect.top + 18));
  if (result.profileMetric === "oi-delta" && data.message) {
    canvas.fillStyle = result.isEstimated || (oiMeta && oiMeta.coveragePercent < 100) ? uiColor.warn : uiColor.info;
    canvas.fillText(data.message, view.area.left + 10, rect.top + 36);
  } else if (result.isEstimated) {
    canvas.fillStyle = uiColor.warn;
    const badge = tOr(result.provenance === "mixed" ? "indicator.volumeProfile.mixed" : "indicator.volumeProfile.estimated");
    canvas.fillText(badge, view.area.left + 10, rect.top + 36);
  }
  canvas.restore();
}

function emptyPrepared(
  status: "hidden" | "no-data" | "unsupported",
  message: string,
  result: OrderFlowProfileResult = calculateOrderFlowProfile([]),
): VolumeProfilePreparedData {
  return {
    status,
    points: [],
    range: { min: 0, max: 1 },
    meta: {
      result,
      maxMagnitude: 0,
      selectedBars: 0,
    },
    message,
  };
}

const levelModeOptions = [
  { label: "Off", value: "off", labelKey: "indicator.volumeProfile.levelMode.off" },
  { label: "Static", value: "static", labelKey: "indicator.volumeProfile.levelMode.static" },
  { label: "Developing", value: "developing", labelKey: "indicator.volumeProfile.levelMode.developing" },
  { label: "Both", value: "both", labelKey: "indicator.volumeProfile.levelMode.both" },
] as const;

const lineStyleOptions = [
  { label: "Solid", value: "solid", labelKey: "draw.lineStyle.solid" },
  { label: "Dashed", value: "dashed", labelKey: "draw.lineStyle.dashed" },
  { label: "Dotted", value: "dotted", labelKey: "draw.lineStyle.dotted" },
] as const;

const supportsLevels = { key: "profileMetric", values: ["volume", "trade-count"] };

export const volumeProfileIndicatorDefinition: IndicatorDefinition<VolumeProfileIndicatorSettings> = {
  type: "volume-profile",
  name: "Order Flow Profile",
  category: "flow",
  defaultPane: "overlay",
  canOverlay: true,
  defaultPlacement: "price-overlay",
  supportedPlacements: ["price-overlay"],
  paneHeight: 72,
  defaultSettings: () => ({
    mode: "visible",
    lookbackBars: 200,
    profileMetric: "volume",
    profileSide: "total",
    profilePlacement: "right",
    oiVenues: { ...DEFAULT_OI_VENUES },
    oiDeltaDisplay: "net",
    valueAreaPercent: 70,
    maxWidth: 180,
    buyColor: uiColor.buy,
    sellColor: uiColor.sell,
    pocMode: "static",
    vahMode: "static",
    valMode: "static",
    pocStaticColor: uiColor.warn,
    pocStaticWidth: 1,
    pocStaticStyle: "dashed",
    pocDevelopingColor: uiColor.warn,
    pocDevelopingWidth: 1,
    pocDevelopingStyle: "solid",
    vahStaticColor: uiColor.info,
    vahStaticWidth: 1,
    vahStaticStyle: "dashed",
    vahDevelopingColor: uiColor.info,
    vahDevelopingWidth: 1,
    vahDevelopingStyle: "solid",
    valStaticColor: uiColor.info,
    valStaticWidth: 1,
    valStaticStyle: "dashed",
    valDevelopingColor: uiColor.info,
    valDevelopingWidth: 1,
    valDevelopingStyle: "solid",
    showReadout: true,
    showPlotLabel: true,
  }),
  settingsSchema: { sections: [
    { title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [
      { kind: "select", key: "mode", label: "Range", labelKey: "indicator.volumeProfile.range", options: [
        { label: "Visible Range", value: "visible", labelKey: "indicator.volumeProfile.mode.visible" },
        { label: "Current Session", value: "session", labelKey: "indicator.volumeProfile.mode.session" },
        { label: "Lookback Bars", value: "lookback", labelKey: "indicator.volumeProfile.mode.lookback" },
      ], requiresRecalc: true },
      { kind: "number", key: "lookbackBars", label: "Lookback Bars", labelKey: "indicator.volumeProfile.lookbackBars", min: 1, max: 10_000, step: 1, requiresRecalc: true, visibleWhen: { key: "mode", values: ["lookback"] } },
      { kind: "select", key: "profileMetric", label: "Metric", labelKey: "indicator.volumeProfile.metric", options: [
        { label: "Volume", value: "volume", labelKey: "indicator.volumeProfile.metric.volume" },
        { label: "Delta", value: "delta", labelKey: "indicator.volumeProfile.metric.delta" },
        { label: "Trade Count", value: "trade-count", labelKey: "indicator.volumeProfile.metric.tradeCount" },
        { label: "Average Trade Size", value: "average-trade-size", labelKey: "indicator.volumeProfile.metric.averageTradeSize" },
        { label: "OI Delta", value: "oi-delta", labelKey: "indicator.volumeProfile.metric.oiDelta" },
      ], requiresRecalc: true },
      { kind: "select", key: "profileSide", label: "Side", labelKey: "indicator.volumeProfile.side", options: [
        { label: "Buy + Sell", value: "total", labelKey: "indicator.volumeProfile.side.total" },
        { label: "Buy", value: "buy", labelKey: "indicator.volumeProfile.side.buy" },
        { label: "Sell", value: "sell", labelKey: "indicator.volumeProfile.side.sell" },
      ], requiresRecalc: true, visibleWhen: { key: "profileMetric", notValues: ["delta", "oi-delta"] } },
      { kind: "select", key: "oiDeltaDisplay", label: "OI Delta Display", labelKey: "indicator.volumeProfile.oiDeltaDisplay", options: [
        { label: "Net", value: "net", labelKey: "indicator.volumeProfile.oiDeltaDisplay.net" },
        { label: "Opened / Closed", value: "split", labelKey: "indicator.volumeProfile.oiDeltaDisplay.split" },
      ], requiresRecalc: true, visibleWhen: { key: "profileMetric", values: ["oi-delta"] } },
      { kind: "exchange-matrix", key: "oiVenues", label: "OI Venues", labelKey: "indicator.volumeProfile.oiVenues", requiresRecalc: true, visibleWhen: { key: "profileMetric", values: ["oi-delta"] } },
      { kind: "number", key: "valueAreaPercent", label: "Value Area %", labelKey: "indicator.volumeProfile.valueAreaPercent", min: 1, max: 99, step: 1, requiresRecalc: true, visibleWhen: supportsLevels },
      { kind: "select", key: "pocMode", label: "POC", labelKey: "indicator.volumeProfile.pocMode", options: [...levelModeOptions], requiresRecalc: true, visibleWhen: supportsLevels },
      { kind: "select", key: "vahMode", label: "VAH", labelKey: "indicator.volumeProfile.vahMode", options: [...levelModeOptions], requiresRecalc: true, visibleWhen: supportsLevels },
      { kind: "select", key: "valMode", label: "VAL", labelKey: "indicator.volumeProfile.valMode", options: [...levelModeOptions], requiresRecalc: true, visibleWhen: supportsLevels },
    ] },
    { title: "Style", titleKey: "indicator.common.section.style", fields: [
      { kind: "select", key: "profilePlacement", label: "Placement", labelKey: "indicator.volumeProfile.placement", options: [
        { label: "Right", value: "right", labelKey: "indicator.volumeProfile.placement.right" },
        { label: "Left", value: "left", labelKey: "indicator.volumeProfile.placement.left" },
      ], requiresRecalc: false },
      { kind: "number", key: "maxWidth", label: "Max Width", labelKey: "indicator.volumeProfile.maxWidth", min: 40, max: 500, step: 5 },
      { kind: "color", key: "buyColor", label: "Buy Color", labelKey: "indicator.volumeProfile.buyColor" },
      { kind: "color", key: "sellColor", label: "Sell Color", labelKey: "indicator.volumeProfile.sellColor" },
      { kind: "color", key: "pocStaticColor", label: "POC Static Color", labelKey: "indicator.volumeProfile.pocStaticColor", visibleWhen: supportsLevels },
      { kind: "number", key: "pocStaticWidth", label: "POC Static Width", labelKey: "indicator.volumeProfile.pocStaticWidth", min: 1, max: 5, step: 1, visibleWhen: supportsLevels },
      { kind: "select", key: "pocStaticStyle", label: "POC Static Style", labelKey: "indicator.volumeProfile.pocStaticStyle", options: [...lineStyleOptions], visibleWhen: supportsLevels },
      { kind: "color", key: "pocDevelopingColor", label: "POC Developing Color", labelKey: "indicator.volumeProfile.pocDevelopingColor", visibleWhen: supportsLevels },
      { kind: "number", key: "pocDevelopingWidth", label: "POC Developing Width", labelKey: "indicator.volumeProfile.pocDevelopingWidth", min: 1, max: 5, step: 1, visibleWhen: supportsLevels },
      { kind: "select", key: "pocDevelopingStyle", label: "POC Developing Style", labelKey: "indicator.volumeProfile.pocDevelopingStyle", options: [...lineStyleOptions], visibleWhen: supportsLevels },
      { kind: "color", key: "vahStaticColor", label: "VAH Static Color", labelKey: "indicator.volumeProfile.vahStaticColor", visibleWhen: supportsLevels },
      { kind: "number", key: "vahStaticWidth", label: "VAH Static Width", labelKey: "indicator.volumeProfile.vahStaticWidth", min: 1, max: 5, step: 1, visibleWhen: supportsLevels },
      { kind: "select", key: "vahStaticStyle", label: "VAH Static Style", labelKey: "indicator.volumeProfile.vahStaticStyle", options: [...lineStyleOptions], visibleWhen: supportsLevels },
      { kind: "color", key: "vahDevelopingColor", label: "VAH Developing Color", labelKey: "indicator.volumeProfile.vahDevelopingColor", visibleWhen: supportsLevels },
      { kind: "number", key: "vahDevelopingWidth", label: "VAH Developing Width", labelKey: "indicator.volumeProfile.vahDevelopingWidth", min: 1, max: 5, step: 1, visibleWhen: supportsLevels },
      { kind: "select", key: "vahDevelopingStyle", label: "VAH Developing Style", labelKey: "indicator.volumeProfile.vahDevelopingStyle", options: [...lineStyleOptions], visibleWhen: supportsLevels },
      { kind: "color", key: "valStaticColor", label: "VAL Static Color", labelKey: "indicator.volumeProfile.valStaticColor", visibleWhen: supportsLevels },
      { kind: "number", key: "valStaticWidth", label: "VAL Static Width", labelKey: "indicator.volumeProfile.valStaticWidth", min: 1, max: 5, step: 1, visibleWhen: supportsLevels },
      { kind: "select", key: "valStaticStyle", label: "VAL Static Style", labelKey: "indicator.volumeProfile.valStaticStyle", options: [...lineStyleOptions], visibleWhen: supportsLevels },
      { kind: "color", key: "valDevelopingColor", label: "VAL Developing Color", labelKey: "indicator.volumeProfile.valDevelopingColor", visibleWhen: supportsLevels },
      { kind: "number", key: "valDevelopingWidth", label: "VAL Developing Width", labelKey: "indicator.volumeProfile.valDevelopingWidth", min: 1, max: 5, step: 1, visibleWhen: supportsLevels },
      { kind: "select", key: "valDevelopingStyle", label: "VAL Developing Style", labelKey: "indicator.volumeProfile.valDevelopingStyle", options: [...lineStyleOptions], visibleWhen: supportsLevels },
      { kind: "boolean", key: "showReadout", label: "Show Pane Readout", labelKey: "indicator.volumeProfile.showReadout" },
      { kind: "boolean", key: "showPlotLabel", label: "Show Header Label", labelKey: "indicator.volumeProfile.showPlotLabel" },
    ] },
  ] },
  getHeaderLabel: headerLabel,
  prepareCache: "series-range",
  prepareData: prepareVolumeProfile,
  drawPriceOverlay: drawVolumeProfileOverlay,
  drawSubPane: drawProfilePane,
};

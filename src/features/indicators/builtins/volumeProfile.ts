import {
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
import { t } from "../../../core/chartLocale.js";
import {
  levelModeHasDeveloping,
  levelModeHasStatic,
  normalizeOrderFlowProfileSettings,
  profileSupportsValueArea,
  type ProfileLevelDisplay,
  type ProfileLineStyle,
} from "../../../core/orderFlowProfileSettings.js";
import { lineDash, profileHistogramParts, stepSegments } from "../../../core/render/orderFlowProfile.js";
import type { FootprintBar } from "../../../core/types.js";
import type { FootprintSeries } from "../../../core/model/footprint.js";
import { incrementPerformanceCounter } from "../../../core/performanceTelemetry.js";
import { uiColor, volumeProfileReadoutTextColor } from "../../../core/ui/seriesPalette.js";
import type { IndicatorDefinition, IndicatorDrawContext, IndicatorPreparedData, IndicatorSettings } from "../types.js";
import { compactNumber, drawIndicatorMessage } from "../render/indicatorPaneUi.js";
import { numericSetting, stringSetting } from "./taShared.js";

interface VolumeProfileIndicatorSettings extends IndicatorSettings {
  mode: "visible" | "session" | "lookback";
  lookbackBars: number;
  profileMetric: ProfileMetric;
  profileSide: ProfileSide;
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

interface VolumeProfileMeta extends Record<string, unknown> {
  result: OrderFlowProfileResult;
  maxMagnitude: number;
  selectedBars: number;
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
interface VolumeProfileCache {
  key: string;
  structureRevision: number;
  nonTailRevision: number;
  seriesRevision: number;
  firstTime: number;
  lastTime: number;
  length: number;
  prefix: OrderFlowProfileAccumulator;
  prepared: VolumeProfilePreparedData;
}
const volumeProfileCaches = new WeakMap<FootprintSeries, Map<string, VolumeProfileCache>>();

function windowIsAscending(bars: readonly FootprintBar[]): boolean {
  for (let i = 1; i < bars.length; i++) if (bars[i].startTime <= bars[i - 1].startTime) return false;
  return true;
}

function buildVolumeProfilePrepared(
  ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>,
  profile: OrderFlowProfileResult,
  selectedBars: number,
): VolumeProfilePreparedData {
  const result = profile;
  const maxMagnitude = result.levels.reduce((max, level) => Math.max(max, level.magnitude ?? 0), 0);
  const validLevels = result.levels.filter((level) => level.value !== null);
  if (!result.levels.length || !validLevels.length) return emptyPrepared("no-data", t("indicator.volumeProfile.noData"));
  const first = result.levels[0]?.priceBin ?? 0;
  const last = result.levels[result.levels.length - 1]?.priceBin ?? first;
  return {
    status: "ok",
    points: [],
    range: { min: first, max: last + ctx.series.config.priceStep },
    meta: { result, maxMagnitude, selectedBars },
    message: result.dataComplete ? undefined : t("indicator.volumeProfile.incompleteData"),
  };
}

function prepareVolumeProfile(ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>): VolumeProfilePreparedData {
  if (!ctx.instance.visible) return emptyPrepared("hidden", "");
  const settings = normalizedSettings(ctx.settings);
  const bars = selectBars(ctx, settings);
  const profileMetric = settings.profileMetric;
  const developing = profileSupportsValueArea(profileMetric)
    && [settings.pocMode, settings.vahMode, settings.valMode].some(levelModeHasDeveloping);
  const options: OrderFlowProfileOptions = {
    profileMetric,
    profileSide: settings.profileSide,
    valueAreaPercent: numericSetting(settings, "valueAreaPercent", 70, 1, 99) / 100,
    developing,
  };
  const { series } = ctx;
  const key = `${profileMetric}|${options.profileSide}|${options.valueAreaPercent}|${developing}|${stringSetting(settings, "mode", "visible")}|${numericSetting(settings, "lookbackBars", 200, 1, 10_000)}`;
  let perSeries = volumeProfileCaches.get(series);
  if (!perSeries) { perSeries = new Map(); volumeProfileCaches.set(series, perSeries); }
  const firstBar = bars[0];
  const lastBar = bars[bars.length - 1];
  const cached = perSeries.get(ctx.instance.id);
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
    const seriesBars = series.listReadonly();
    // Window ends before the series tail: nothing inside it can have changed.
    if (seriesBars[seriesBars.length - 1] !== lastBar) {
      cached.seriesRevision = series.revision;
      return cached.prepared;
    }
    const acc = cloneOrderFlowProfileAccumulator(cached.prefix);
    accumulateOrderFlowProfileBar(acc, lastBar, options);
    cached.prepared = buildVolumeProfilePrepared(ctx, finishOrderFlowProfile(acc, options), bars.length);
    cached.seriesRevision = series.revision;
    incrementPerformanceCounter("indicator.incremental.hit.volumeProfile");
    return cached.prepared;
  }

  const ascending = firstBar !== undefined && windowIsAscending(bars);
  if (!ascending) {
    perSeries.delete(ctx.instance.id);
    const acc = createOrderFlowProfileAccumulator();
    for (const bar of [...bars].sort((a, b) => a.startTime - b.startTime)) accumulateOrderFlowProfileBar(acc, bar, options);
    return buildVolumeProfilePrepared(ctx, finishOrderFlowProfile(acc, options), bars.length);
  }
  const prefix = createOrderFlowProfileAccumulator();
  for (let i = 0; i < bars.length - 1; i++) accumulateOrderFlowProfileBar(prefix, bars[i], options);
  const acc = cloneOrderFlowProfileAccumulator(prefix);
  accumulateOrderFlowProfileBar(acc, lastBar!, options);
  const prepared = buildVolumeProfilePrepared(ctx, finishOrderFlowProfile(acc, options), bars.length);
  perSeries.set(ctx.instance.id, { key, structureRevision: series.structureRevision, nonTailRevision: series.nonTailRevision, seriesRevision: series.revision, firstTime: firstBar!.startTime, lastTime: lastBar!.startTime, length: bars.length, prefix, prepared });
  incrementPerformanceCounter("indicator.incremental.full.volumeProfile");
  return prepared;
}

function selectBars(
  ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>,
  settings = normalizedSettings(ctx.settings),
): FootprintBar[] {
  const all = ctx.series.listReadonly();
  const [from, to] = ctx.range;
  const visible = all.slice(Math.max(0, from), Math.min(all.length, to));
  const mode = stringSetting(settings, "mode", "visible");
  if (mode === "session") {
    const anchor = visible[visible.length - 1]?.startTime ?? all[all.length - 1]?.startTime;
    return anchor === undefined ? visible : sessionBars(all, anchor);
  }
  if (mode === "lookback") {
    const count = numericSetting(settings, "lookbackBars", 200, 1, 10_000);
    const end = visible[visible.length - 1]?.startTime ?? all[all.length - 1]?.startTime;
    if (end === undefined) return [];
    const endIndex = all.findIndex((bar) => bar.startTime === end);
    const last = endIndex >= 0 ? endIndex + 1 : all.length;
    return all.slice(Math.max(0, last - count), last);
  }
  return visible;
}

function asVolumeProfileData(prepared?: IndicatorPreparedData): VolumeProfilePreparedData {
  if (prepared?.meta && "result" in prepared.meta) return prepared as VolumeProfilePreparedData;
  return emptyPrepared("no-data", prepared?.message ?? prepared?.error ?? t("indicator.volumeProfile.noData"));
}

function drawVolumeProfileOverlay(ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>, prepared?: IndicatorPreparedData): void {
  const data = asVolumeProfileData(prepared);
  if (data.status !== "ok") return;
  const settings = normalizedSettings(ctx.settings);
  const { view, series, ctx: canvas } = ctx;
  const { result, maxMagnitude } = data.meta;
  const step = series.config.priceStep;
  const maxWidth = Math.min(view.area.width * 0.34, numericSetting(settings, "maxWidth", 180, 40, 500));
  const right = view.area.left + view.area.width - 4;
  const buyColor = stringSetting(settings, "buyColor", uiColor.buy);
  const sellColor = stringSetting(settings, "sellColor", uiColor.sell);
  const deltaZeroX = right - maxWidth / 2;

  canvas.save();
  canvas.beginPath();
  canvas.rect(view.area.left, view.area.top, view.area.width, view.area.height);
  canvas.clip();
  for (const level of result.levels) {
    const yTop = view.yOfPrice(level.priceBin + step);
    const yBottom = view.yOfPrice(level.priceBin);
    if (yBottom < view.area.top || yTop > view.area.top + view.area.height) continue;
    const rowHeight = Math.max(1, yBottom - yTop - 1);
    const parts = profileHistogramParts(level, result.profileMetric, result.profileSide);
    canvas.globalAlpha = 0.55;
    if (result.profileMetric === "delta") {
      const part = parts[0];
      if (!part) continue;
      const width = (maxWidth / 2) * (part.value / Math.max(maxMagnitude, Number.EPSILON));
      canvas.fillStyle = part.signed >= 0 ? buyColor : sellColor;
      canvas.fillRect(part.signed >= 0 ? deltaZeroX : deltaZeroX - width, yTop, width, rowHeight);
      continue;
    }
    let cursor = right;
    for (const part of [...parts].reverse()) {
      const width = maxWidth * (part.value / Math.max(maxMagnitude, Number.EPSILON));
      canvas.fillStyle = part.side === "sell" ? sellColor : buyColor;
      canvas.fillRect(cursor - width, yTop, width, rowHeight);
      cursor -= width;
    }
  }
  canvas.globalAlpha = 1;
  if (profileSupportsValueArea(result.profileMetric)) {
    drawConfiguredLevel(ctx, settings, "poc", result.poc, result.developing.map((point) => ({ time: point.time, price: point.poc, valid: point.valid })), "POC", "dPOC", uiColor.warn);
    drawConfiguredLevel(ctx, settings, "vah", result.vah, result.developing.map((point) => ({ time: point.time, price: point.vah, valid: point.valid })), "VAH", "dVAH", uiColor.info);
    drawConfiguredLevel(ctx, settings, "val", result.val, result.developing.map((point) => ({ time: point.time, price: point.val, valid: point.valid })), "VAL", "dVAL", uiColor.info);
  }
  canvas.restore();
}

function drawConfiguredLevel(
  ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>,
  settings: VolumeProfileIndicatorSettings,
  prefix: "poc" | "vah" | "val",
  staticPrice: number | null,
  developing: Array<{ time: number; price: number | null; valid: boolean }>,
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
  if (levelModeHasDeveloping(mode)) {
    drawDevelopingLevel(
      ctx,
      developing,
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
  points: Array<{ time: number; price: number | null; valid: boolean }>,
  label: string,
  color: string,
  width: number,
  style: ProfileLineStyle,
): void {
  const { ctx: canvas, view, series } = ctx;
  const all = series.listReadonly();
  const indexByTime = new Map(all.map((bar, index) => [bar.startTime, index] as const));
  const runs: Array<Array<{ x: number; y: number; price: number }>> = [];
  let current: Array<{ x: number; y: number; price: number }> = [];
  for (const point of points) {
    if (!point.valid || point.price === null || !Number.isFinite(point.price)) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    const index = indexByTime.get(point.time);
    if (index === undefined) continue;
    current.push({ x: view.xOfIndex(index) + view.colWidth / 2, y: view.yOfPrice(point.price), price: point.price });
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
  const count = data.status === "ok" ? ` · ${data.meta.selectedBars} ${t("indicator.volumeProfile.bars")}` : "";
  const side = normalized.profileMetric === "delta" ? "" : ` · ${sideLabel(normalized.profileSide)}`;
  return `Order Flow Profile · ${metricLabel(normalized.profileMetric)}${side}${count}`;
}

function drawProfilePane(ctx: IndicatorDrawContext<VolumeProfileIndicatorSettings>, prepared?: IndicatorPreparedData): void {
  const data = asVolumeProfileData(prepared);
  const { ctx: canvas, rect, view } = ctx;
  if (data.status !== "ok") {
    drawIndicatorMessage(ctx, data.message ?? t("indicator.volumeProfile.noData"));
    return;
  }
  if (ctx.settings.showReadout === false) return;
  const { result, selectedBars } = data.meta;
  const lines = [
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
  canvas.restore();
}

function emptyPrepared(status: "hidden" | "no-data", message: string): VolumeProfilePreparedData {
  return {
    status,
    points: [],
    range: { min: 0, max: 1 },
    meta: {
      result: calculateOrderFlowProfile([]),
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
      ], requiresRecalc: true },
      { kind: "select", key: "profileSide", label: "Side", labelKey: "indicator.volumeProfile.side", options: [
        { label: "Buy + Sell", value: "total", labelKey: "indicator.volumeProfile.side.total" },
        { label: "Buy", value: "buy", labelKey: "indicator.volumeProfile.side.buy" },
        { label: "Sell", value: "sell", labelKey: "indicator.volumeProfile.side.sell" },
      ], requiresRecalc: true, visibleWhen: { key: "profileMetric", notValues: ["delta"] } },
      { kind: "number", key: "valueAreaPercent", label: "Value Area %", labelKey: "indicator.volumeProfile.valueAreaPercent", min: 1, max: 99, step: 1, requiresRecalc: true, visibleWhen: supportsLevels },
      { kind: "select", key: "pocMode", label: "POC", labelKey: "indicator.volumeProfile.pocMode", options: [...levelModeOptions], requiresRecalc: true, visibleWhen: supportsLevels },
      { kind: "select", key: "vahMode", label: "VAH", labelKey: "indicator.volumeProfile.vahMode", options: [...levelModeOptions], requiresRecalc: true, visibleWhen: supportsLevels },
      { kind: "select", key: "valMode", label: "VAL", labelKey: "indicator.volumeProfile.valMode", options: [...levelModeOptions], requiresRecalc: true, visibleWhen: supportsLevels },
    ] },
    { title: "Style", titleKey: "indicator.common.section.style", fields: [
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
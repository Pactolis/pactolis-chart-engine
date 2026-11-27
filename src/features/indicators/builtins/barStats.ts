import type { FootprintBar } from "../../../core/types.js";
import type { IndicatorDefinition, IndicatorDrawContext, IndicatorPreparedData, IndicatorSettings } from "../types.js";
import { compactNumber, drawIndicatorMessage } from "../render/indicatorPaneUi.js";
import { boolSetting, numericSetting, stringSetting } from "./taShared.js";
import { uiColor, barStatsTextColorDefault, barStatsLabelColor } from "../../../core/ui/seriesPalette.js";
import { chartLocale, t } from "../../../core/chartLocale.js";
import { createIndicatorSeriesStateStore } from "./stateRegistry.js";

interface BarStatsSettings extends IndicatorSettings {
  mode: "latest" | "crosshair" | "visible-sum";
  textColor: string;
  positiveColor: string;
  negativeColor: string;
  showDeltaPercent: boolean;
  showLiquidations: boolean;
  showPlotLabel: boolean;
}

interface BarStatsMeta extends Record<string, unknown> {
  label: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number;
  delta: number;
  deltaPercent: number | null;
  count: number;
  liquidationBuyVol: number;
  liquidationSellVol: number;
  /**
   * Whether any bar in the range actually carries liquidation measurement.
   * Binance Vision's aggTrades archive has no liquidation flag, so historical bars
   * are built with zeros that mean "not measured" — only the live trade stream
   * marks them. Rendering that zero as `0 / 0` reads as "no liquidations happened",
   * which is a different claim than the data supports.
   */
  liquidationsMeasured: boolean;
}

type BarStatsPreparedData = IndicatorPreparedData<never, BarStatsMeta> & { meta: BarStatsMeta };

interface BarStatsCacheEntry {
  instance: object;
  mode: string;
  seriesRevision: number;
  nonTailRevision: number;
  resetEpoch: number;
  from: number;
  to: number;
  index: number;
  closedEnd: number;
  closedVolume: number;
  closedDelta: number;
  closedCount: number;
  closedHigh: number;
  closedLow: number;
  closedLiqBuy: number;
  closedLiqSell: number;
  closedLiqMeasured: boolean;
  prepared: BarStatsPreparedData;
}

const barStatsCacheStore = createIndicatorSeriesStateStore<BarStatsCacheEntry>();

function prepareBarStats(ctx: IndicatorDrawContext<BarStatsSettings>): BarStatsPreparedData {
  if (!ctx.instance.visible) return emptyPrepared("hidden", t("indicator.barStats.hidden"));
  const bars = ctx.series.listReadonly();
  if (!bars.length) return emptyPrepared("no-data", t("indicator.barStats.noData"));
  const [from, to] = ctx.range;
  const mode = stringSetting(ctx.settings, "mode", "latest");
  const crosshairIndex = ctx.crosshair?.visible ? Math.round(ctx.view.indexOfX(ctx.crosshair.x)) : -1;
  const index = mode === "crosshair" && crosshairIndex >= 0 ? crosshairIndex : Math.min(bars.length - 1, Math.max(0, to - 1));

  if (mode === "visible-sum") {
    const start = Math.max(0, from);
    const end = Math.min(bars.length, to);
    if (start >= end) return emptyPrepared("no-data", t("indicator.barStats.noData"));
    const cached = barStatsCacheStore.get(ctx.series, ctx.instance.id);
    if (
      cached
      && cached.instance === ctx.instance
      && cached.mode === mode
      && cached.seriesRevision === ctx.series.revision
      && cached.from === start
      && cached.to === end
    ) {
      return cached.prepared;
    }

    const tailLabel = t("indicator.barStats.visible");
    const lastClosedEnd = Math.max(start, end - 1);
    if (
      cached
      && cached.instance === ctx.instance
      && cached.mode === mode
      && cached.resetEpoch === ctx.series.resetEpoch
      && cached.nonTailRevision === ctx.series.nonTailRevision
      && cached.from === start
      && (cached.closedEnd === lastClosedEnd || cached.closedEnd + 1 === lastClosedEnd)
    ) {
      let volume = cached.closedVolume;
      let delta = cached.closedDelta;
      let count = cached.closedCount;
      let high = cached.closedHigh;
      let low = cached.closedLow;
      let liqBuy = cached.closedLiqBuy;
      let liqSell = cached.closedLiqSell;
      let liqMeasured = cached.closedLiqMeasured;

      if (cached.closedEnd + 1 === lastClosedEnd) {
        const newlyClosed = bars[cached.closedEnd];
        volume += newlyClosed.volume ?? 0;
        delta += newlyClosed.delta ?? 0;
        count += newlyClosed.count ?? 0;
        if (newlyClosed.high > high) high = newlyClosed.high;
        if (newlyClosed.low < low) low = newlyClosed.low;
        liqBuy += newlyClosed.liquidationBuyVol ?? 0;
        liqSell += newlyClosed.liquidationSellVol ?? 0;
        if (newlyClosed.sources?.includes("live")) liqMeasured = true;
      }

      const tail = bars[end - 1];
      const totalVolume = volume + (tail.volume ?? 0);
      const totalDelta = delta + (tail.delta ?? 0);
      const totalCount = count + (tail.count ?? 0);
      const totalHigh = end - 1 === start ? tail.high : Math.max(high, tail.high);
      const totalLow = end - 1 === start ? tail.low : Math.min(low, tail.low);
      const totalLiqBuy = liqBuy + (tail.liquidationBuyVol ?? 0);
      const totalLiqSell = liqSell + (tail.liquidationSellVol ?? 0);
      const totalLiqMeasured = liqMeasured || (tail.sources?.includes("live") ?? false);

      const prepared = buildBarStatsPrepared(
        tailLabel,
        bars[start].open,
        totalHigh,
        totalLow,
        tail.close,
        totalVolume,
        totalDelta,
        totalCount,
        totalLiqBuy,
        totalLiqSell,
        totalLiqMeasured,
      );
      barStatsCacheStore.set(ctx.series, ctx.instance.id, {
        instance: ctx.instance,
        mode,
        seriesRevision: ctx.series.revision,
        nonTailRevision: ctx.series.nonTailRevision,
        resetEpoch: ctx.series.resetEpoch,
        from: start,
        to: end,
        index: -1,
        closedEnd: lastClosedEnd,
        closedVolume: volume,
        closedDelta: delta,
        closedCount: count,
        closedHigh: high,
        closedLow: low,
        closedLiqBuy: liqBuy,
        closedLiqSell: liqSell,
        closedLiqMeasured: liqMeasured,
        prepared,
      });
      return prepared;
    }

    const prefix = aggregateBarRange(bars, start, lastClosedEnd);
    const tail = bars[end - 1];
    const totalVolume = prefix.volume + (tail.volume ?? 0);
    const totalDelta = prefix.delta + (tail.delta ?? 0);
    const totalCount = prefix.count + (tail.count ?? 0);
    const totalHigh = lastClosedEnd > start ? Math.max(prefix.high, tail.high) : tail.high;
    const totalLow = lastClosedEnd > start ? Math.min(prefix.low, tail.low) : tail.low;
    const totalLiqBuy = prefix.liqBuy + (tail.liquidationBuyVol ?? 0);
    const totalLiqSell = prefix.liqSell + (tail.liquidationSellVol ?? 0);
    const totalLiqMeasured = prefix.liqMeasured || (tail.sources?.includes("live") ?? false);
    const prepared = buildBarStatsPrepared(
      tailLabel,
      bars[start].open,
      totalHigh,
      totalLow,
      tail.close,
      totalVolume,
      totalDelta,
      totalCount,
      totalLiqBuy,
      totalLiqSell,
      totalLiqMeasured,
    );
    barStatsCacheStore.set(ctx.series, ctx.instance.id, {
      instance: ctx.instance,
      mode,
      seriesRevision: ctx.series.revision,
      nonTailRevision: ctx.series.nonTailRevision,
      resetEpoch: ctx.series.resetEpoch,
      from: start,
      to: end,
      index: -1,
      closedEnd: lastClosedEnd,
      closedVolume: prefix.volume,
      closedDelta: prefix.delta,
      closedCount: prefix.count,
      closedHigh: prefix.high,
      closedLow: prefix.low,
      closedLiqBuy: prefix.liqBuy,
      closedLiqSell: prefix.liqSell,
      closedLiqMeasured: prefix.liqMeasured,
      prepared,
    });
    return prepared;
  }

  const bar = bars[index];
  return bar
    ? preparedFromBarRange(new Date(bar.startTime).toLocaleString(chartLocale().locale()), bars, index, index + 1)
    : emptyPrepared("no-data", t("indicator.barStats.noSelectedBar"));
}

function aggregateBarRange(bars: readonly FootprintBar[], start: number, end: number): {
  volume: number;
  delta: number;
  count: number;
  high: number;
  low: number;
  liqBuy: number;
  liqSell: number;
  liqMeasured: boolean;
} {
  let volume = 0;
  let delta = 0;
  let count = 0;
  let high = -Infinity;
  let low = Infinity;
  let liqBuy = 0;
  let liqSell = 0;
  let liqMeasured = false;
  for (let i = start; i < end; i++) {
    const bar = bars[i];
    volume += bar.volume ?? 0;
    delta += bar.delta ?? 0;
    count += bar.count ?? 0;
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
    liqBuy += bar.liquidationBuyVol ?? 0;
    liqSell += bar.liquidationSellVol ?? 0;
    if (!liqMeasured && bar.sources?.includes("live")) liqMeasured = true;
  }
  return { volume, delta, count, high, low, liqBuy, liqSell, liqMeasured };
}

function buildBarStatsPrepared(
  label: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  delta: number,
  count: number,
  liquidationBuyVol: number,
  liquidationSellVol: number,
  liquidationsMeasured: boolean,
): BarStatsPreparedData {
  return {
    status: "ok",
    points: [],
    range: { min: Math.min(0, delta), max: Math.max(1, delta) },
    meta: {
      label,
      open,
      high,
      low,
      close,
      volume,
      delta,
      deltaPercent: volume > 0 ? (delta / volume) * 100 : null,
      count,
      liquidationBuyVol,
      liquidationSellVol,
      liquidationsMeasured,
    },
  };
}

function preparedFromBarRange(
  label: string,
  bars: readonly FootprintBar[],
  start: number,
  end: number,
): BarStatsPreparedData {
  if (start >= end) return emptyPrepared("no-data", t("indicator.barStats.noData"));
  const first = bars[start];
  const last = bars[end - 1];
  const agg = aggregateBarRange(bars, start, end);
  return buildBarStatsPrepared(
    label,
    first.open,
    agg.high,
    agg.low,
    last.close,
    agg.volume,
    agg.delta,
    agg.count,
    agg.liqBuy,
    agg.liqSell,
    agg.liqMeasured,
  );
}

function asBarStatsData(prepared?: IndicatorPreparedData): BarStatsPreparedData {
  if (prepared?.meta && "volume" in prepared.meta && "delta" in prepared.meta) return prepared as BarStatsPreparedData;
  return emptyPrepared("no-data", prepared?.message ?? prepared?.error ?? t("indicator.barStats.noData"));
}

function drawBarStatsSubPane(ctx: IndicatorDrawContext<BarStatsSettings>, prepared?: IndicatorPreparedData): void {
  const data = asBarStatsData(prepared);
  if (data.status !== "ok" || ctx.series.listReadonly().length === 0) {
    drawIndicatorMessage(ctx, data.message ?? t("indicator.barStats.noData"));
  }
}

function drawBarStatsInteraction(ctx: IndicatorDrawContext<BarStatsSettings>, prepared?: IndicatorPreparedData): void {
  const data = asBarStatsData(prepared ?? prepareBarStats(ctx));
  if (data.status !== "ok" || ctx.series.listReadonly().length === 0) return;
  const { ctx: canvas, view, rect } = ctx;
  const m = data.meta;
  const showDeltaPercent = boolSetting(ctx.settings, "showDeltaPercent", true);
  const showLiquidations = boolSetting(ctx.settings, "showLiquidations", true);
  const items = [
    [t("indicator.barStats.label.range"), m.label, stringSetting(ctx.settings, "textColor", barStatsTextColorDefault)],
    [t("indicator.barStats.label.ohlc"), `${price(m.open)} / ${price(m.high)} / ${price(m.low)} / ${price(m.close)}`, stringSetting(ctx.settings, "textColor", barStatsTextColorDefault)],
    [t("indicator.barStats.label.volume"), compactNumber(m.volume), stringSetting(ctx.settings, "textColor", barStatsTextColorDefault)],
    [t("indicator.barStats.label.delta"), `${compactNumber(m.delta)}${showDeltaPercent && m.deltaPercent !== null ? ` (${m.deltaPercent.toFixed(1)}%)` : ""}`, m.delta >= 0 ? stringSetting(ctx.settings, "positiveColor", uiColor.buy) : stringSetting(ctx.settings, "negativeColor", uiColor.sell)],
    [t("indicator.barStats.label.trades"), compactNumber(m.count), stringSetting(ctx.settings, "textColor", barStatsTextColorDefault)],
  ];
  if (showLiquidations) {
    const liquidations = m.liquidationsMeasured
      ? `${compactNumber(m.liquidationBuyVol)} / ${compactNumber(m.liquidationSellVol)}`
      : "—";
    items.push([t("indicator.barStats.label.liquidations"), liquidations, stringSetting(ctx.settings, "textColor", barStatsTextColorDefault)]);
  }
  canvas.save();
  canvas.font = `${numericSetting(ctx.settings, "fontSize", 12, 9, 18)}px ui-sans-serif, system-ui, sans-serif`;
  let x = view.area.left + 10;
  const y = rect.top + Math.min(rect.height - 10, 22);
  for (const [label, value, color] of items) {
    canvas.fillStyle = barStatsLabelColor;
    canvas.fillText(`${label}:`, x, y);
    x += canvas.measureText(`${label}: `).width;
    canvas.fillStyle = color;
    canvas.fillText(value, x, y);
    x += canvas.measureText(value).width + 22;
  }
  canvas.restore();
}

function price(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(chartLocale().locale(), { maximumFractionDigits: 2 });
}

function headerLabel({ settings, prepared }: { settings: BarStatsSettings; prepared?: IndicatorPreparedData }): string {
  if (settings.showPlotLabel === false) return "";
  const data = asBarStatsData(prepared);
  const title = t("indicator.barStats.title");
  if (data.status !== "ok") return title;
  return `${title} · Δ ${compactNumber(data.meta.delta)} · V ${compactNumber(data.meta.volume)}`;
}

function emptyPrepared(status: "hidden" | "no-data", message: string): BarStatsPreparedData {
  return { status, points: [], range: { min: 0, max: 1 }, meta: { label: "—", open: null, high: null, low: null, close: null, volume: 0, delta: 0, deltaPercent: null, count: 0, liquidationBuyVol: 0, liquidationSellVol: 0, liquidationsMeasured: false }, message };
}

export const barStatsIndicatorDefinition: IndicatorDefinition<BarStatsSettings> = {
  type: "bar-stats",
  name: "Bar Stats",
  category: "flow",
  defaultPane: "separate",
  canOverlay: false,
  defaultPlacement: "separate-pane",
  supportedPlacements: ["separate-pane"],
  paneHeight: 52,
  defaultSettings: () => ({ mode: "latest", fontSize: 12, textColor: barStatsTextColorDefault, positiveColor: uiColor.buy, negativeColor: uiColor.sell, showDeltaPercent: true, showLiquidations: true, showPlotLabel: true }),
  settingsSchema: { sections: [
    { title: "Source", titleKey: "indicator.barStats.section.source", fields: [{ kind: "select", key: "mode", label: "Mode", labelKey: "indicator.common.mode", options: [{ label: "Latest Visible Bar", value: "latest", labelKey: "indicator.barStats.mode.latest" }, { label: "Crosshair Bar", value: "crosshair", labelKey: "indicator.barStats.mode.crosshair" }, { label: "Visible Sum", value: "visible-sum", labelKey: "indicator.barStats.mode.visibleSum" }], requiresRecalc: true }] },
    { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "number", key: "fontSize", label: "Font Size", min: 9, max: 18, step: 1 }, { kind: "color", key: "textColor", label: "Text", labelKey: "indicator.barStats.textColor" }, { kind: "color", key: "positiveColor", label: "Positive Delta", labelKey: "indicator.barStats.positiveColor" }, { kind: "color", key: "negativeColor", label: "Negative Delta", labelKey: "indicator.barStats.negativeColor" }, { kind: "boolean", key: "showDeltaPercent", label: "Show Delta %", labelKey: "indicator.barStats.showDeltaPercent" }, { kind: "boolean", key: "showLiquidations", label: "Show Liquidations", labelKey: "indicator.barStats.showLiquidations" }, { kind: "boolean", key: "showPlotLabel", label: "Show Header Label", labelKey: "indicator.common.showPlotLabel" }] },
  ] },
  getHeaderLabel: headerLabel,
  prepareData: prepareBarStats,
  drawSubPane: drawBarStatsSubPane,
  drawInteraction: drawBarStatsInteraction,
};

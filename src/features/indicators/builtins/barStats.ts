import type { FootprintBar } from "../../../core/types.js";
import type { IndicatorDefinition, IndicatorDrawContext, IndicatorPreparedData, IndicatorSettings } from "../types.js";
import { compactNumber, drawIndicatorMessage } from "../render/indicatorPaneUi.js";
import { boolSetting, numericSetting, stringSetting } from "./taShared.js";
import { uiColor, barStatsTextColorDefault, barStatsLabelColor } from "../../../core/ui/seriesPalette.js";
import { chartLocale, t } from "../../../core/chartLocale.js";

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

function prepareBarStats(ctx: IndicatorDrawContext<BarStatsSettings>): BarStatsPreparedData {
  if (!ctx.instance.visible) return emptyPrepared("hidden", t("indicator.barStats.hidden"));
  const bars = ctx.series.listReadonly();
  if (!bars.length) return emptyPrepared("no-data", t("indicator.barStats.noData"));
  const [from, to] = ctx.range;
  const mode = stringSetting(ctx.settings, "mode", "latest");
  const crosshairIndex = ctx.crosshair?.visible ? Math.round(ctx.view.indexOfX(ctx.crosshair.x)) : -1;
  const index = mode === "crosshair" && crosshairIndex >= 0 ? crosshairIndex : Math.min(bars.length - 1, Math.max(0, to - 1));
  if (mode === "visible-sum") return preparedFromBars(t("indicator.barStats.visible"), bars.slice(Math.max(0, from), Math.min(bars.length, to)));
  const bar = bars[index];
  return bar ? preparedFromBars(new Date(bar.startTime).toLocaleString(chartLocale().locale()), [bar]) : emptyPrepared("no-data", t("indicator.barStats.noSelectedBar"));
}

function preparedFromBars(label: string, bars: readonly FootprintBar[]): BarStatsPreparedData {
  if (!bars.length) return emptyPrepared("no-data", t("indicator.barStats.noData"));
  const first = bars[0];
  const last = bars[bars.length - 1];
  const volume = bars.reduce((sum, bar) => sum + (bar.volume ?? 0), 0);
  const delta = bars.reduce((sum, bar) => sum + (bar.delta ?? 0), 0);
  const count = bars.reduce((sum, bar) => sum + (bar.count ?? 0), 0);
  const high = Math.max(...bars.map((bar) => bar.high));
  const low = Math.min(...bars.map((bar) => bar.low));
  const liquidationBuyVol = bars.reduce((sum, bar) => sum + (bar.liquidationBuyVol ?? 0), 0);
  const liquidationSellVol = bars.reduce((sum, bar) => sum + (bar.liquidationSellVol ?? 0), 0);
  // `sources` distinguishes a store-loaded bar from one the live stream folded in.
  const liquidationsMeasured = bars.some((bar) => bar.sources?.includes("live") ?? false);
  return { status: "ok", points: [], range: { min: Math.min(0, delta), max: Math.max(1, delta) }, meta: {
    label,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    delta,
    deltaPercent: volume > 0 ? delta / volume * 100 : null,
    count,
    liquidationBuyVol,
    liquidationSellVol,
    liquidationsMeasured,
  } };
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

import type { IndicatorDefinition, IndicatorDrawContext, IndicatorSettings } from "../types.js";
import type { FootprintBar } from "../../../core/types.js";
import type { NumberPoint } from "../../../core/analysis/calc/ta.js";
import { cellTradeCounts } from "../../../core/model/footprintCellMetrics.js";
import { compactNumber } from "../render/indicatorPaneUi.js";
import { defaultPaneSettings, drawMultiSeries, makeNumberPoints, prepareMultiSeries, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries } from "./taShared.js";
import { tradeCountColorDefault, uiColor } from "../../../core/ui/seriesPalette.js";

export interface TradeCountSettings extends IndicatorSettings { mode: "count" | "avg-size"; directional: boolean; color: string; lineWidth: number; showLastValueLabel: boolean; showReadout: boolean; showAxisTicks: boolean; showPlotLabel: boolean; }

/**
 * Avg-size değerleri (volume/count) çoğu piyasada 1'in altında ondalık olur; ortak
 * `compactNumber` <1000 için `toFixed(0)` yaptığından son değeri "0" gösteriyordu.
 * Bu formatter küçük değerleri ondalıkla, büyükleri kompakt gösterir.
 */
function avgSizeFormatter(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return compactNumber(value);
  if (abs >= 1) return value.toFixed(2);
  if (abs > 0) return value.toFixed(4);
  return "0";
}

/**
 * Bir barın taker buy/sell trade sayısı ve hacmi.
 * - Footprint hücresi varsa (Vision/geçmiş) kesin: hücrelerden toplanır.
 * - Hücre yoksa (recent pencere, Vision henüz yok) kline'dan yaklaşık türetilir:
 *   buy/sell hacim delta özdeşliğinden, buy/sell işlem sayısı toplam count'un
 *   hacim oranıyla bölünmesinden. Yaklaşıktır; footprint gelince kesine döner.
 */
function barBuySell(bar: FootprintBar): { buyCount: number; sellCount: number; buyVol: number; sellVol: number } {
  if (bar.cells.size > 0) {
    let buyCount = 0, sellCount = 0, buyVol = 0, sellVol = 0;
    for (const cell of bar.cells.values()) {
      const counts = cellTradeCounts(cell);
      buyCount += counts.buy;
      sellCount += counts.sell;
      buyVol += cell.buyVol;
      sellVol += cell.sellVol;
    }
    return { buyCount, sellCount, buyVol, sellVol };
  }
  const volume = bar.volume;
  const buyVol = Math.max(0, (volume + bar.delta) / 2);
  const sellVol = Math.max(0, (volume - bar.delta) / 2);
  const buyCount = volume > 0 ? Math.round(bar.count * (buyVol / volume)) : 0;
  const sellCount = Math.max(0, bar.count - buyCount);
  return { buyCount, sellCount, buyVol, sellVol };
}

function prepareTradeCount(ctx: IndicatorDrawContext<TradeCountSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const averageSize = ctx.settings.mode === "avg-size";
  const directional = ctx.settings.directional === true;
  const formatter = averageSize ? avgSizeFormatter : undefined;

  if (directional) {
    // Çift-taraflı histogram: buy pozitif (yukarı), sell negatif (aşağı), baseline 0.
    const buyPoints: NumberPoint[] = [];
    const sellPoints: NumberPoint[] = [];
    for (const bar of bars) {
      const agg = barBuySell(bar);
      // Avg size notional (USD) olarak gösterilir — uygulamanın geri kalanı (footprint
      // hücreleri, HUD) hacimleri notional gösteriyor; base bırakmak ~fiyat kadar sapardı.
      const buyValue = averageSize ? (agg.buyCount > 0 ? (agg.buyVol / agg.buyCount) * bar.close : 0) : agg.buyCount;
      const sellValue = averageSize ? (agg.sellCount > 0 ? (agg.sellVol / agg.sellCount) * bar.close : 0) : agg.sellCount;
      buyPoints.push({ time: bar.startTime, value: buyValue });
      sellPoints.push({ time: bar.startTime, value: sellValue > 0 ? -sellValue : 0 });
    }
    const series: PlotSeries[] = [
      { key: "buy", label: averageSize ? "Buy Avg" : "Buy", color: uiColor.buy, style: "histogram", points: makeNumberPoints(buyPoints, bars, start, end) },
      { key: "sell", label: averageSize ? "Sell Avg" : "Sell", color: uiColor.sell, style: "histogram", points: makeNumberPoints(sellPoints, bars, start, end) },
    ];
    return prepareMultiSeries(ctx, series, { scaleMode: "signed-zero", baseline: 0, formatter });
  }

  // Avg size = (volume/count) × fiyat → notional (USD); count = ham işlem sayısı.
  const values: NumberPoint[] = bars.map((bar) => ({
    time: bar.startTime,
    value: averageSize ? (bar.count > 0 ? (bar.volume / bar.count) * bar.close : 0) : bar.count,
  }));
  const series: PlotSeries[] = [{ key: "count", label: averageSize ? "Avg Size" : "Trades", color: stringSetting(ctx.settings, "color", tradeCountColorDefault), style: "histogram", points: makeNumberPoints(values, bars, start, end) }];
  return prepareMultiSeries(ctx, series, { scaleMode: "volume", baseline: 0, formatter });
}

export const tradeCountIndicatorDefinition: IndicatorDefinition<TradeCountSettings> = {
  type: "trade-count", name: "Trade Count / Avg Size", category: "volume", defaultPane: "separate", canOverlay: false, defaultPlacement: "separate-pane", supportedPlacements: ["separate-pane"], paneHeight: 104,
  defaultSettings: () => defaultPaneSettings({ mode: "count", directional: false, color: tradeCountColorDefault }) as TradeCountSettings,
  settingsSchema: { sections: [{ title: "Calculation", titleKey: "indicator.common.section.calculation", fields: [{ kind: "select", key: "mode", label: "Mode", labelKey: "indicator.common.mode", options: [{ label: "Trade Count", value: "count", labelKey: "indicator.tradeCount.mode.count" }, { label: "Average Trade Size", value: "avg-size", labelKey: "indicator.tradeCount.mode.avgSize" }], requiresRecalc: true }, { kind: "boolean", key: "directional", label: "Directional (Buy/Sell)", labelKey: "indicator.tradeCount.directional", requiresRecalc: true }] }, { title: "Style", titleKey: "indicator.common.section.style", fields: [{ kind: "color", key: "color", label: "Histogram Color", labelKey: "indicator.common.histogramColor" }, ...standardAppearanceFields()] }] },
  getHeaderLabel: ({ settings }) => {
    // Kullanıcı ayara girmeden hangi modun aktif olduğunu görebilsin.
    if (settings.showPlotLabel === false) return "";
    const base = settings.mode === "avg-size" ? "Avg Trade Size" : "Trade Count";
    return settings.directional ? `${base} ⇅` : base;
  },
  prepareCache: "series-range", prepareData: prepareTradeCount, drawSubPane: drawMultiSeries,
};

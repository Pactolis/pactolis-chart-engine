import type { OrderbookHeatmapSettings } from "../../core/orderbookHeatmap/settings.js";

/**
 * The user's orderbook heatmap settings, read by the chart's heatmap overlay.
 * The engine does not store them; the host application supplies the source
 * before mounting a chart.
 */
export interface OrderbookHeatmapSettingsSource {
  /** Settings as they apply on `market`. */
  settingsFor(market: string): OrderbookHeatmapSettings;
  /** Call `listener` after the settings change. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}

let configured: OrderbookHeatmapSettingsSource | null = null;

export function configureOrderbookHeatmapSettingsSource(source: OrderbookHeatmapSettingsSource): void {
  configured = source;
}

export function orderbookHeatmapSettingsSource(): OrderbookHeatmapSettingsSource {
  if (configured === null) {
    throw new Error("orderbook heatmap settings source is not configured; call configureOrderbookHeatmapSettingsSource() before mounting a chart");
  }
  return configured;
}

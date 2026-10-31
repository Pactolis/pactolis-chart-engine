// Shared display/feature flags toggled from the left side panel. Renderers
// read these each frame; the panel flips them and requests a redraw.

/** Which value is printed inside footprint cells. */
export type FootprintCellData =
  | "bidask"
  | "volume"
  | "delta"
  | "deltaPct"
  | "count"
  | "countBidask"
  | "avgTradeSize"
  | "avgTradeSizeBidask";
export type TpoProfilePeriod = "daily" | "weekly" | "monthly" | "visible";
export type TpoBracketSize = "auto" | "5m" | "15m" | "30m" | "1h";
export type MagnetMode = "weak" | "strong";

/**
 * Per-chart görünüm ayarlarının çözülmüş (effective) hali. Alan adları
 * `DisplaySettings`'in ilgili alanlarıyla birebir aynı; bu sayede renderer/overlay
 * read site'ları `const cfg = this.chartConfig ?? settings` deyip `cfg.chartType`
 * yazabiliyor. Runtime bunu `ChartPanelState`'ten (fallback global settings) üretip
 * her chart'ın renderer'ına ve overlay'ine iter.
 */
export interface ChartViewConfig {
  chartType: "footprint" | "footprintProfile" | "candlestick" | "tpo";
  tpoMode: "blocks" | "letters";
  tpoProfilePeriod: TpoProfilePeriod;
  tpoBracketSize: TpoBracketSize;
  clusterCellData: FootprintCellData;
  profileCellData: FootprintCellData;
  // Footprint visibility toggles. These used to be read straight off the global
  // `settings` inside the renderer and overlay while chartType came from here, so
  // toggling heat/POC/imbalance on one panel silently affected every other one.
  candles: boolean;
  heat: boolean;
  cellNumbers: boolean;
  poc: boolean;
  stackedImbalance: boolean;
}

export interface DisplaySettings {
  /** Mini candlestick (wick + body) in the footprint strip. */
  candles: boolean;
  /**
   * Chart type.
   *  - `footprint`: bid×ask cluster heatmap cells + mini candle strip.
   *  - `footprintProfile`: per-bar horizontal volume histogram (length = total
   *    volume, color = delta sign) + mini candle strip.
   *  - `candlestick`: plain full-width candles with no footprint.
   *  - `tpo`: per-session Market Profile (TPO count histogram), drawn in overlay.
   */
  chartType: "footprint" | "footprintProfile" | "candlestick" | "tpo";
  /** TPO rendering: Market-Profile block columns or classic A/B/C letters. */
  tpoMode: "blocks" | "letters";
  /** Time span represented by one TPO profile. */
  tpoProfilePeriod: TpoProfilePeriod;
  /** Time span represented by one TPO bracket inside a profile. */
  tpoBracketSize: TpoBracketSize;
  /** Buy/sell volume heat behind each footprint cell. */
  heat: boolean;
  /** Buy/sell volume numbers inside each cell. */
  cellNumbers: boolean;
  /** Text shown inside footprint Cluster cells (separate memory per type). */
  clusterCellData: FootprintCellData;
  /** Text shown inside footprint Profile cells (separate memory per type). */
  profileCellData: FootprintCellData;
  /** Point-of-control (busiest price) row highlight. */
  poc: boolean;
  /** Horizontal line + axis label at the latest price. */
  lastPrice: boolean;
  /** Global chart grid (time + price lines). Strict bool, default true; persisted under its own key, never per chart or layout. */
  grid: boolean;
  /** Highlight stacked diagonal buy/sell imbalances in the footprint. */
  stackedImbalance: boolean;
  volumeProfile: boolean;
  profilePoc: boolean;
  profileVah: boolean;
  profileVal: boolean;
  /** Auto-scale top margin ratio (0–0.49). Default 0.2. */
  scaleMarginTop: number;
  /** Auto-scale bottom margin ratio (0–0.49). Default 0.1. */
  scaleMarginBottom: number;
  /** Snap drawing points to nearby OHLC prices. */
  magnet: boolean;
  /** Magnet sensitivity mode: "weak" snaps within threshold, "strong" forces snap to nearest level. Default "weak". */
  magnetMode: MagnetMode;
}

export const DEFAULT_SCALE_MARGINS = { top: 0.2, bottom: 0.1 } as const;

/**
 * Display settings shared by every chart. The host may restore persisted values
 * into this object before charts mount and persist changes itself; the engine
 * does not read or write browser storage.
 */
export const settings: DisplaySettings = {
  candles: true,
  chartType: "footprint",
  tpoMode: "blocks",
  tpoProfilePeriod: "daily",
  tpoBracketSize: "30m",
  heat: true,
  cellNumbers: true,
  clusterCellData: "bidask",
  profileCellData: "volume",
  poc: true,
  lastPrice: true,
  grid: true,
  stackedImbalance: false,
  volumeProfile: false,
  profilePoc: true,
  profileVah: true,
  profileVal: true,
  scaleMarginTop: DEFAULT_SCALE_MARGINS.top,
  scaleMarginBottom: DEFAULT_SCALE_MARGINS.bottom,
  magnet: false,
  magnetMode: "weak",
};

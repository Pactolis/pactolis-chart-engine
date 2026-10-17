import type { View } from "./engine/view.js";
import type { FootprintSeries } from "./model/footprint.js";
import type { AnalysisIndicatorSeries, AnalysisScope } from "./analysisSnapshot.js";
import { t } from "./chartLocale.js";

export type IndicatorCategory = "flow" | "derivatives" | "volume" | "custom";
export type IndicatorPaneMode = "separate" | "overlay";
export type IndicatorPlacement = "separate-pane" | "price-overlay" | "overlay-scale";
export type IndicatorPlotStyle = "line" | "histogram" | "area";

export type IndicatorSettings = Record<string, unknown>;
export type IndicatorStatus = "ok" | "loading" | "error" | "no-data" | "hidden" | "unsupported";

export interface IndicatorLegendItem {
  label: string;
  value?: string;
  color?: string;
  muted?: boolean;
}

export interface IndicatorReadout {
  title?: string;
  time?: string;
  items: IndicatorLegendItem[];
}

export interface IndicatorPaneUiModel {
  title: string;
  subtitle?: string;
  status: IndicatorStatus;
  leftBadges?: IndicatorLegendItem[];
  rightReadout?: IndicatorReadout;
  lastValueLabel?: {
    value: string;
    color?: string;
  };
  message?: string;
}

export interface IndicatorDataRange {
  min: number;
  max: number;
  baseline?: number;
}

export interface IndicatorPreparedData<
  P = unknown,
  M extends Record<string, unknown> = Record<string, unknown>,
> {
  status: IndicatorStatus;
  points?: P[];
  range?: IndicatorDataRange;
  meta?: M;
  message?: string;
  error?: string;
}

export interface IndicatorAnalysisExport {
  status?: IndicatorStatus;
  scope?: AnalysisScope;
  series: AnalysisIndicatorSeries[];
  summary?: Record<string, number | string | boolean | null>;
  warnings?: string[];
}

export interface IndicatorInstance<S extends IndicatorSettings = IndicatorSettings> {
  id: string;
  type: string;
  title: string;
  visible: boolean;
  locked?: boolean;
  paneId: string;
  order: number;
  settings: S;
  style?: IndicatorSettings;
  /** Current preferred pane height in pixels. Persisted per chart. */
  paneHeight?: number;
  /** Collapsed panes keep their header/controls but do not draw the plot. */
  collapsed?: boolean;
  /** Where the indicator should be rendered. Existing indicators use separate panes. */
  placement?: IndicatorPlacement;
}

export interface IndicatorPaneRect {
  top: number;
  height: number;
}

export interface IndicatorChartContext {
  market: string;
  timeframe: string;
  intervalMs: number;
}

export interface IndicatorCrosshair {
  x: number;
  y: number;
  visible: boolean;
}

export interface IndicatorHeaderContext<S extends IndicatorSettings = IndicatorSettings> {
  instance: IndicatorInstance<S>;
  settings: S;
  chart?: IndicatorChartContext;
  prepared?: IndicatorPreparedData;
}

export interface IndicatorDrawContext<S extends IndicatorSettings = IndicatorSettings> {
  ctx: CanvasRenderingContext2D;
  view: View;
  series: FootprintSeries;
  rect: IndicatorPaneRect;
  range: [number, number];
  instance: IndicatorInstance<S>;
  settings: S;
  chart?: IndicatorChartContext;
  crosshair?: IndicatorCrosshair;
  requestRefresh: () => void;
  queuePriceLabel?: (price: number, text: string, color: string, priority?: number) => void;
}

export interface IndicatorPaneRender {
  id: string;
  title: string;
  height: number;
  visible: boolean;
  collapsed: boolean;
  placement: IndicatorPlacement;
  scaleMode: "linear" | "log";
  toggleScaleMode(): "linear" | "log";
  draw(ctx: CanvasRenderingContext2D, view: View, series: FootprintSeries, rect: IndicatorPaneRect, range: [number, number], crosshair?: IndicatorCrosshair): void;
  /** High-frequency cursor/readout pass. Static plot geometry must stay in draw(). */
  drawInteraction?(ctx: CanvasRenderingContext2D, view: View, series: FootprintSeries, rect: IndicatorPaneRect, range: [number, number], crosshair: IndicatorCrosshair): void;
  /** Temporary fallback for panes whose static draw still consumes crosshair state. */
  requiresInteractionRedraw?: boolean;
}

export interface SettingVisibilityCondition {
  key: string;
  values?: Array<string | number | boolean>;
  notValues?: Array<string | number | boolean>;
}

type SettingFieldVisibility = {
  /** Optional explanatory copy shown with the control. */
  description?: string;
  descriptionKey?: string;
  /** Serializable field visibility rule. Functions are intentionally not supported. */
  visibleWhen?: SettingVisibilityCondition;
};

export type SettingField = (
  | { kind: "select"; key: string; label: string; labelKey?: string; options: Array<{ label: string; value: string | number | boolean; labelKey?: string }>; requiresRecalc?: boolean; }
  | { kind: "number"; key: string; label: string; labelKey?: string; min?: number; max?: number; step?: number; requiresRecalc?: boolean; }
  | { kind: "boolean"; key: string; label: string; labelKey?: string; requiresRecalc?: boolean; }
  | { kind: "color"; key: string; label: string; labelKey?: string; requiresRecalc?: boolean; }
  | { kind: "text"; key: string; label: string; labelKey?: string; requiresRecalc?: boolean; }
  | { kind: "exchange-matrix"; key: string; label: string; labelKey?: string; requiresRecalc?: boolean; }
  | { kind: "line-list"; key: string; label: string; labelKey?: string; variant?: "moving-average" | "vwap"; requiresRecalc?: boolean; }
) & SettingFieldVisibility;

export interface SettingSection {
  title: string;
  titleKey?: string;
  fields: SettingField[];
}

export function resolveLabel(labelKey: string | undefined, label: string): string {
  if (!labelKey) return label;
  const resolved = t(labelKey);
  return resolved === labelKey ? label : resolved;
}

export function resolveTitle(titleKey: string | undefined, title: string): string {
  return resolveLabel(titleKey, title);
}

export interface IndicatorSettingsSchema {
  sections: SettingSection[];
}

export interface IndicatorDefinition<S extends IndicatorSettings = IndicatorSettings> {
  type: string;
  name: string;
  category: IndicatorCategory;
  defaultPane: IndicatorPaneMode;
  canOverlay: boolean;
  paneHeight: number;
  defaultPlacement?: IndicatorPlacement;
  supportedPlacements?: IndicatorPlacement[];
  defaultSettings(): S;
  settingsSchema: IndicatorSettingsSchema;
  /** Internal raw/view input contract; definition-level, never settings or persistence. */
  inputSource?: "raw" | "view";
  getPaneUi?(ctx: IndicatorDrawContext<S>): IndicatorPaneUiModel;
  getHeaderLabel?(ctx: IndicatorHeaderContext<S>): string;
  /** Opt-in only for preparation that is pure for series revision + visible range + instance/chart identity. */
  prepareCache?: "series-range" | { mode: "series-range"; maxAgeMs: number };
  prepareData?(ctx: IndicatorDrawContext<S>): IndicatorPreparedData;
  /** Optional typed numeric export for non-standard prepared-data shapes. It must be read-only and must not draw. */
  analysisExport?(ctx: IndicatorDrawContext<S>, prepared: IndicatorPreparedData | undefined): IndicatorAnalysisExport;
  getReadout?(
    ctx: IndicatorDrawContext<S>,
    prepared: IndicatorPreparedData,
    index: number | null,
  ): IndicatorReadout | null;
  drawSubPane?(ctx: IndicatorDrawContext<S>, prepared?: IndicatorPreparedData): void;
  drawPriceOverlay?(ctx: IndicatorDrawContext<S>, prepared?: IndicatorPreparedData): void;
  /** Optional cursor/readout-only pass for split annotation/interaction canvases. */
  drawInteraction?(ctx: IndicatorDrawContext<S>, prepared?: IndicatorPreparedData): void;
}

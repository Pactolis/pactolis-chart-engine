import type { ProfileMetric, ProfileSide } from "./analysis/orderFlowProfile.js";
import type { ProfileLevelDisplay, ProfileLineStyle } from "./orderFlowProfileSettings.js";

export type DrawingType =
  | "horizontal" | "horizontal-ray" | "vertical"
  | "trend" | "trend-ray" | "extended-trend" | "partial-price-line"
  | "rectangle" | "extended-rectangle" | "session-box" | "ellipse" | "triangle" | "brush" | "liquidity-zone" | "imbalance-zone"
  | "measure" | "price-range" | "date-range" | "long-position" | "short-position"
  | "fibonacci-retracement" | "fibonacci-extension" | "parallel-channel" | "regression-channel" | "pitchfork" | "gann-fan" | "gann-grid"
  | "text" | "callout-note" | "arrow-marker" | "arrow-line" | "date-marker" | "event-marker"
  | "anchored-vwap" | "fixed-range-volume-profile";

export type DrawingDataState = "placing" | "ready" | "loading" | "incomplete" | "error";

export interface DrawingPoint {
  time: number;
  price: number;
}

export type PositionOrderKind = "market" | "limit";

export interface PositionRiskSettings {
  accountBalance: number;
  riskPercent: number;
  makerFeeRate: number;
  takerFeeRate: number;
}

export type FibonacciLabelFormat = "percent" | "price" | "percent-price" | "text-price";
export type FibonacciLabelSide = "left" | "right";

export interface FibonacciLevel {
  value: number;
  text?: string;
  visible?: boolean;
  color?: string;
  lineWidth?: number;
  lineStyle?: "solid" | "dashed" | "dotted";
  fillColor?: string;
  fillOpacity?: number;
}

export type DrawingStylePreset = Partial<Pick<
  Drawing,
  | "color"
  | "lineWidth"
  | "lineStyle"
  | "showLabel"
  | "showPriceLabel"
  | "showTimeLabel"
  | "opacity"
  | "fillOpacity"
  | "extendLeft"
  | "extendRight"
  | "text"
  | "valueAreaPercent"
  | "showPoc"
  | "showVah"
  | "showVal"
  | "profileWidth"
  | "profileMetric"
  | "profileSide"
  | "pocMode"
  | "vahMode"
  | "valMode"
  | "pocStaticColor"
  | "pocStaticWidth"
  | "pocStaticStyle"
  | "pocDevelopingColor"
  | "pocDevelopingWidth"
  | "pocDevelopingStyle"
  | "vahStaticColor"
  | "vahStaticWidth"
  | "vahStaticStyle"
  | "vahDevelopingColor"
  | "vahDevelopingWidth"
  | "vahDevelopingStyle"
  | "valStaticColor"
  | "valStaticWidth"
  | "valStaticStyle"
  | "valDevelopingColor"
  | "valDevelopingWidth"
  | "valDevelopingStyle"
  | "riskPercent"
  | "entryOrderType"
  | "stopOrderType"
  | "targetOrderType"
  | "fibLevels"
  | "fibLabelFormat"
  | "fibLabelSide"
  | "fibReverse"
  | "fibFillBands"
>>;

export interface DrawingNamedPreset {
  id: string;
  name: string;
  type: DrawingType;
  style: DrawingStylePreset;
  createdAt: number;
}

export interface DrawingTemplateState {
  defaults: Partial<Record<DrawingType, DrawingStylePreset>>;
  presets: DrawingNamedPreset[];
}

export interface PositionRiskMetrics {
  entry: number;
  stop: number;
  target: number;
  risk: number;
  reward: number;
  riskReward: number;
  accountBalance: number;
  riskPercent: number;
  riskBudget: number;
  makerFeeRate: number;
  takerFeeRate: number;
  entryOrderType: PositionOrderKind;
  stopOrderType: PositionOrderKind;
  targetOrderType: PositionOrderKind;
  entryFeeRate: number;
  stopFeeRate: number;
  targetFeeRate: number;
  entryFee: number;
  stopFee: number;
  targetFee: number;
  riskPerUnitGross: number;
  riskPerUnitWithFees: number;
  rewardPerUnitGross: number;
  rewardPerUnitNet: number;
  positionSize: number;
  notional: number;
  netRisk: number;
  netReward: number;
  netRiskReward: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  points: DrawingPoint[];
  color: string;
  lineWidth: number;
  text?: string;
  locked: boolean;
  visible: boolean;
  market?: string;
  opacity?: number;
  fillOpacity?: number;
  lineStyle?: "solid" | "dashed" | "dotted";
  showLabel?: boolean;
  showPriceLabel?: boolean;
  showTimeLabel?: boolean;
  valueAreaPercent?: number;
  showPoc?: boolean;
  showVah?: boolean;
  showVal?: boolean;
  profileWidth?: number;
  profileMetric?: ProfileMetric;
  profileSide?: ProfileSide;
  pocMode?: ProfileLevelDisplay;
  vahMode?: ProfileLevelDisplay;
  valMode?: ProfileLevelDisplay;
  pocStaticColor?: string;
  pocStaticWidth?: number;
  pocStaticStyle?: ProfileLineStyle;
  pocDevelopingColor?: string;
  pocDevelopingWidth?: number;
  pocDevelopingStyle?: ProfileLineStyle;
  vahStaticColor?: string;
  vahStaticWidth?: number;
  vahStaticStyle?: ProfileLineStyle;
  vahDevelopingColor?: string;
  vahDevelopingWidth?: number;
  vahDevelopingStyle?: ProfileLineStyle;
  valStaticColor?: string;
  valStaticWidth?: number;
  valStaticStyle?: ProfileLineStyle;
  valDevelopingColor?: string;
  valDevelopingWidth?: number;
  valDevelopingStyle?: ProfileLineStyle;
  dataState?: DrawingDataState;
  extendLeft?: boolean;
  extendRight?: boolean;
  schemaVersion?: number;
  accountBalance?: number;
  riskPercent?: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
  entryOrderType?: PositionOrderKind;
  stopOrderType?: PositionOrderKind;
  targetOrderType?: PositionOrderKind;
  fibLevels?: FibonacciLevel[];
  fibLabelFormat?: FibonacciLabelFormat;
  fibLabelSide?: FibonacciLabelSide;
  fibReverse?: boolean;
  fibFillBands?: boolean;
}

export interface DrawingContext {
  indexForTime(time: number): number;
  timeForIndex(index: number): number;
}

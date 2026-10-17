/** Persisted state of a chart panel, as the chart engine reads and writes it. */

import type { IndicatorInstance } from "./indicatorTypes.js";
import type { FootprintCellData, TpoProfilePeriod, TpoBracketSize } from "./settings.js";
import type { AnalysisPeriod } from "./analysis/periods.js";
import type { ReferenceLevelFamily } from "./analysis/referenceLevels.js";
import type { PreviousWeekStrategyId } from "./analysis/previousWeekStrategy.js";
import type { MondayRangeId } from "./analysis/mondayRange.js";

export type ChartType = "footprint" | "footprintProfile" | "candlestick" | "tpo";
export type TpoMode = "blocks" | "letters";

export interface ChartPanelState {
  type: "chart";
  market: string;
  timeframe: string;
  scaleMode: "linear" | "log";
  indicators?: IndicatorInstance[];
  linkGroup?: LinkGroupColor;
  chartType?: ChartType;
  clusterCellData?: FootprintCellData;
  profileCellData?: FootprintCellData;
  tpoMode?: TpoMode;
  tpoProfilePeriod?: TpoProfilePeriod;
  tpoBracketSize?: TpoBracketSize;
  candles?: boolean;
  heat?: boolean;
  cellNumbers?: boolean;
  poc?: boolean;
  stackedImbalance?: boolean;
  /** Per-chart automatic-object visibility. Added in workspace schema v14. */
  previousWeekStrategyVisibility?: Partial<Record<PreviousWeekStrategyId, boolean>>;
  mondayRangeVisibility?: Partial<Record<MondayRangeId, boolean>>;
  hiddenNakedPocIds?: string[];
  nakedPocVisibility?: Partial<Record<AnalysisPeriod, boolean>>;
  hiddenReferenceLevelIds?: string[];
  referenceVisibility?: Partial<Record<ReferenceLevelFamily, Partial<Record<AnalysisPeriod, boolean>>>>;
}

export function hasChartAutomaticVisibility(state: ChartPanelState): boolean {
  return state.previousWeekStrategyVisibility !== undefined
    || state.mondayRangeVisibility !== undefined
    || state.hiddenNakedPocIds !== undefined
    || state.nakedPocVisibility !== undefined
    || state.hiddenReferenceLevelIds !== undefined
    || state.referenceVisibility !== undefined;
}

export type LinkGroupColor = "red" | "blue" | "green" | "orange" | "purple";

import type { FootprintBar } from "../types.js";
import {
  calculateStrategyLevels,
  normalizeStrategySettings,
  strategyLevelIds,
  type StrategyDefinition,
  type StrategyGroupDefinition,
  type StrategyLevel,
  type StrategySettings,
} from "./strategyLevels.js";
import { uiColor, strategyExtSoftColor, strategyGoldenColor } from "../ui/seriesPalette.js";

export type PreviousWeekStrategyId =
  | "pw-ext-upper" | "pw-ext-upper-1272" | "pw-ext-upper-1114"
  | "pw-high" | "pw-golden-upper" | "pw-eq" | "pw-golden-lower"
  | "pw-low" | "pw-ext-lower-1114" | "pw-ext-lower-1272" | "pw-ext-lower";
export type PreviousWeekStrategyGroup = "high-low" | "golden" | "eq" | "extension";
export type PreviousWeekStrategyLevel = StrategyLevel<PreviousWeekStrategyId, PreviousWeekStrategyGroup>;
export type PreviousWeekStrategySettings = StrategySettings<PreviousWeekStrategyId, PreviousWeekStrategyGroup>;

export const PREVIOUS_WEEK_STRATEGY_GROUPS: readonly StrategyGroupDefinition<PreviousWeekStrategyGroup>[] = [
  { id: "high-low", label: "PW High / Low", treeStateKey: "pwStrategyHighLow" },
  { id: "golden", label: "Golden Zones", treeStateKey: "pwStrategyGolden" },
  { id: "eq", label: "EQ", treeStateKey: "pwStrategyEq" },
  { id: "extension", label: "Extensions", treeStateKey: "pwStrategyExtension" },
];

export const PREVIOUS_WEEK_STRATEGY_DEFINITION: StrategyDefinition<"previous-week", PreviousWeekStrategyId, PreviousWeekStrategyGroup> = {
  id: "previous-week",
  label: "PW Strategy",
  treeStateKey: "pwStrategy",
  source: { kind: "previous-completed-period", period: "weekly" },
  groups: PREVIOUS_WEEK_STRATEGY_GROUPS,
  labelFormat: "label",
  levels: [
    { id: "pw-ext-upper", group: "extension", kind: "zone", fromRatio: -0.272, toRatio: -0.114, label: "PW Extension 1", color: uiColor.warn, fillOpacity: 0.14, priority: 62 },
    { id: "pw-golden-upper", group: "golden", kind: "zone", fromRatio: 0.34, toRatio: 0.382, label: "PW Golden 0.34–0.382", color: strategyGoldenColor, fillOpacity: 0.18, priority: 62 },
    { id: "pw-golden-lower", group: "golden", kind: "zone", fromRatio: 0.618, toRatio: 0.66, label: "PW Golden 0.618–0.66", color: strategyGoldenColor, fillOpacity: 0.18, priority: 62 },
    { id: "pw-ext-lower", group: "extension", kind: "zone", fromRatio: 1.114, toRatio: 1.272, label: "PW Extension 2", color: uiColor.warn, fillOpacity: 0.14, priority: 62 },
    { id: "pw-ext-upper-1272", group: "extension", kind: "line", ratio: -0.272, label: "PW Ext 1 · -0.272", color: uiColor.warn, lineStyle: "dashed", priority: 64 },
    { id: "pw-ext-upper-1114", group: "extension", kind: "line", ratio: -0.114, label: "PW Ext 1 · -0.114", color: strategyExtSoftColor, lineStyle: "dashed", priority: 64 },
    { id: "pw-high", group: "high-low", kind: "line", ratio: 0, label: "PW High", color: uiColor.buy, priority: 72 },
    { id: "pw-eq", group: "eq", kind: "line", ratio: 0.5, label: "PW EQ", color: uiColor.info, lineStyle: "dotted", priority: 64 },
    { id: "pw-low", group: "high-low", kind: "line", ratio: 1, label: "PW Low", color: uiColor.sell, priority: 72 },
    { id: "pw-ext-lower-1114", group: "extension", kind: "line", ratio: 1.114, label: "PW Ext 2 · 1.114", color: strategyExtSoftColor, lineStyle: "dashed", priority: 64 },
    { id: "pw-ext-lower-1272", group: "extension", kind: "line", ratio: 1.272, label: "PW Ext 2 · 1.272", color: uiColor.warn, lineStyle: "dashed", priority: 64 },
  ],
};

export const PREVIOUS_WEEK_STRATEGY_IDS = strategyLevelIds(PREVIOUS_WEEK_STRATEGY_DEFINITION);

export const DEFAULT_PREVIOUS_WEEK_STRATEGY_SETTINGS: PreviousWeekStrategySettings =
  normalizePreviousWeekStrategySettings(undefined);

export function normalizePreviousWeekStrategySettings(
  settings: Partial<PreviousWeekStrategySettings> | null | undefined
): PreviousWeekStrategySettings {
  return normalizeStrategySettings(PREVIOUS_WEEK_STRATEGY_DEFINITION, settings);
}

export function calculatePreviousWeekStrategyLevels(
  bars: readonly FootprintBar[],
  now = Date.now(),
  settings?: Partial<PreviousWeekStrategySettings> | null,
  sourceIntervalMs?: number
): PreviousWeekStrategyLevel[] {
  return calculateStrategyLevels(PREVIOUS_WEEK_STRATEGY_DEFINITION, bars, now, settings, sourceIntervalMs);
}

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
import { uiColor, strategyExtSoftColor } from "../ui/seriesPalette.js";

export type MondayRangeId =
  | "mr-invalid-upper" | "mr-ext-upper-0214" | "mr-ext-upper-0114"
  | "mr-high" | "mr-eq" | "mr-low"
  | "mr-ext-lower-1114" | "mr-ext-lower-1214" | "mr-invalid-lower";
export type MondayRangeGroup = "high-low" | "eq" | "extension" | "invalidation";
export type MondayRangeLevel = StrategyLevel<MondayRangeId, MondayRangeGroup>;
export type MondayRangeSettings = StrategySettings<MondayRangeId, MondayRangeGroup>;

export const MONDAY_RANGE_GROUPS: readonly StrategyGroupDefinition<MondayRangeGroup>[] = [
  { id: "high-low", label: "Monday High / Low", treeStateKey: "mondayRangeHighLow" },
  { id: "eq", label: "EQ", treeStateKey: "mondayRangeEq" },
  { id: "extension", label: "Extensions", treeStateKey: "mondayRangeExtension" },
  { id: "invalidation", label: "Invalidation", treeStateKey: "mondayRangeInvalidation" },
];

export const MONDAY_RANGE_DEFINITION: StrategyDefinition<"monday-range", MondayRangeId, MondayRangeGroup> = {
  id: "monday-range",
  label: "Monday Range",
  treeStateKey: "mondayRange",
  source: { kind: "latest-completed-weekday", period: "daily", weekday: 1 },
  groups: MONDAY_RANGE_GROUPS,
  labelFormat: "label",
  levels: [
    { id: "mr-invalid-upper", group: "invalidation", kind: "line", ratio: -0.618, label: "Monday Invalidation · -0.618", color: uiColor.sell, lineStyle: "long-dashed", priority: 68 },
    { id: "mr-ext-upper-0214", group: "extension", kind: "line", ratio: -0.214, label: "Monday Ext · -0.214", color: uiColor.warn, lineStyle: "dashed", priority: 63 },
    { id: "mr-ext-upper-0114", group: "extension", kind: "line", ratio: -0.114, label: "Monday Ext · -0.114", color: strategyExtSoftColor, lineStyle: "dashed", priority: 63 },
    { id: "mr-high", group: "high-low", kind: "line", ratio: 0, label: "Monday High", color: uiColor.buy, priority: 73 },
    { id: "mr-eq", group: "eq", kind: "line", ratio: 0.5, label: "Monday EQ", color: uiColor.info, lineStyle: "dotted", priority: 63 },
    { id: "mr-low", group: "high-low", kind: "line", ratio: 1, label: "Monday Low", color: uiColor.sell, priority: 73 },
    { id: "mr-ext-lower-1114", group: "extension", kind: "line", ratio: 1.114, label: "Monday Ext · 1.114", color: strategyExtSoftColor, lineStyle: "dashed", priority: 63 },
    { id: "mr-ext-lower-1214", group: "extension", kind: "line", ratio: 1.214, label: "Monday Ext · 1.214", color: uiColor.warn, lineStyle: "dashed", priority: 63 },
    { id: "mr-invalid-lower", group: "invalidation", kind: "line", ratio: 1.618, label: "Monday Invalidation · 1.618", color: uiColor.sell, lineStyle: "long-dashed", priority: 68 },
  ],
};

export const MONDAY_RANGE_IDS = strategyLevelIds(MONDAY_RANGE_DEFINITION);

export const DEFAULT_MONDAY_RANGE_SETTINGS: MondayRangeSettings =
  normalizeMondayRangeSettings(undefined);

export function normalizeMondayRangeSettings(
  settings: Partial<MondayRangeSettings> | null | undefined
): MondayRangeSettings {
  return normalizeStrategySettings(MONDAY_RANGE_DEFINITION, settings);
}

export function calculateMondayRangeLevels(
  bars: readonly FootprintBar[],
  now = Date.now(),
  settings?: Partial<MondayRangeSettings> | null,
  sourceIntervalMs?: number
): MondayRangeLevel[] {
  return calculateStrategyLevels(MONDAY_RANGE_DEFINITION, bars, now, settings, sourceIntervalMs);
}

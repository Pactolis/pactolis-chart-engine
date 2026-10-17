import type { FootprintBar } from "../types.js";
import {
  aggregatePeriodCandles,
  previousAnalysisPeriodStart,
  type AnalysisPeriod,
  type PeriodCandle,
} from "./periods.js";

export type StrategyLevelKind = "line" | "zone";
export type StrategyLineStyle = "solid" | "dashed" | "dotted" | "long-dashed";
export type StrategyLabelFormat = "label" | "name" | "ratio" | "name-ratio";

export interface StrategyGroupDefinition<TGroup extends string = string> {
  id: TGroup;
  label: string;
  treeStateKey?: string;
}

export type StrategySourceDefinition =
  | { kind: "previous-completed-period"; period: AnalysisPeriod }
  | { kind: "latest-completed-weekday"; period: "daily"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 };

export interface StrategyLevelDefinition<TId extends string = string, TGroup extends string = string> {
  id: TId;
  group: TGroup;
  kind: StrategyLevelKind;
  color: string;
  label?: string;
  name?: string;
  ratio?: number;
  fromRatio?: number;
  toRatio?: number;
  labelFormat?: StrategyLabelFormat;
  lineStyle?: StrategyLineStyle;
  lineWidth?: number;
  fillOpacity?: number;
  priority?: number;
}

export interface StrategyDefinition<
  TStrategyId extends string = string,
  TLevelId extends string = string,
  TGroup extends string = string,
> {
  id: TStrategyId;
  label: string;
  treeStateKey?: string;
  source: StrategySourceDefinition;
  groups: readonly StrategyGroupDefinition<TGroup>[];
  levels: readonly StrategyLevelDefinition<TLevelId, TGroup>[];
  labelFormat?: StrategyLabelFormat;
}

export interface StrategyLevel<TId extends string = string, TGroup extends string = string> {
  id: TId;
  group: TGroup;
  kind: StrategyLevelKind;
  label: string;
  color: string;
  sourceStart: number;
  sourceEnd: number;
  ratio?: number;
  fromRatio?: number;
  toRatio?: number;
  price?: number;
  fromPrice?: number;
  toPrice?: number;
  lineStyle?: StrategyLineStyle;
  lineWidth?: number;
  fillOpacity?: number;
  priority?: number;
}

export interface StrategyPreset<TLevelId extends string = string, TGroup extends string = string> {
  id: string;
  name: string;
  groups: StrategyGroupDefinition<TGroup>[];
  levels: StrategyLevelDefinition<TLevelId, TGroup>[];
  labelFormat?: StrategyLabelFormat;
  createdAt: number;
}

export interface StrategySettings<TLevelId extends string = string, TGroup extends string = string> {
  enabled: boolean;
  visible: Record<TLevelId, boolean>;
  groups: StrategyGroupDefinition<TGroup>[];
  levels: StrategyLevelDefinition<TLevelId, TGroup>[];
  labelFormat: StrategyLabelFormat;
  activePresetId?: string;
  presets: StrategyPreset<TLevelId, TGroup>[];
}

export function strategyLevelIds<TLevelId extends string, TGroup extends string>(
  definition: StrategyDefinition<string, TLevelId, TGroup>
): readonly TLevelId[] {
  return definition.levels.map((level) => level.id);
}

export function normalizeStrategySettings<TLevelId extends string, TGroup extends string>(
  definition: StrategyDefinition<string, TLevelId, TGroup>,
  settings: Partial<StrategySettings<TLevelId, TGroup>> | null | undefined
): StrategySettings<TLevelId, TGroup> {
  const groups = normalizeGroups(settings?.groups, definition.groups);
  const levels = normalizeLevels(settings?.levels, definition.levels, groups);
  const visibleSource: Partial<Record<TLevelId, boolean>> = isRecord(settings?.visible)
    ? settings.visible as Partial<Record<TLevelId, boolean>>
    : {};
  const visible = Object.fromEntries(
    levels.map((level) => [
      level.id,
      typeof visibleSource[level.id] === "boolean" ? visibleSource[level.id] : true,
    ])
  ) as Record<TLevelId, boolean>;
  const labelFormat = normalizeLabelFormat(settings?.labelFormat, definition.labelFormat ?? "label");
  const presets = normalizePresets(settings?.presets, definition, groups);
  const activePresetId = typeof settings?.activePresetId === "string"
    && presets.some((preset) => preset.id === settings.activePresetId)
    ? settings.activePresetId
    : undefined;

  return {
    enabled: typeof settings?.enabled === "boolean" ? settings.enabled : true,
    visible,
    groups,
    levels,
    labelFormat,
    activePresetId,
    presets,
  };
}

export function resolveStrategyDefinition<TStrategyId extends string, TLevelId extends string, TGroup extends string>(
  definition: StrategyDefinition<TStrategyId, TLevelId, TGroup>,
  settings?: Partial<StrategySettings<TLevelId, TGroup>> | null
): StrategyDefinition<TStrategyId, TLevelId, TGroup> {
  const normalized = normalizeStrategySettings(definition, settings);
  const preset = normalized.activePresetId
    ? normalized.presets.find((item) => item.id === normalized.activePresetId)
    : undefined;
  return {
    ...definition,
    groups: structuredClone(preset?.groups ?? normalized.groups),
    levels: structuredClone(preset?.levels ?? normalized.levels),
    labelFormat: preset?.labelFormat ?? normalized.labelFormat,
  };
}

export function calculateStrategyLevels<TStrategyId extends string, TLevelId extends string, TGroup extends string>(
  definition: StrategyDefinition<TStrategyId, TLevelId, TGroup>,
  bars: readonly FootprintBar[],
  now = Date.now(),
  settings?: Partial<StrategySettings<TLevelId, TGroup>> | null,
  sourceIntervalMs?: number
): StrategyLevel<TLevelId, TGroup>[] {
  const activeDefinition = resolveStrategyDefinition(definition, settings);
  const source = resolveSourceCandle(activeDefinition.source, bars, now, sourceIntervalMs);
  if (!source || !(source.high > source.low)) return [];
  const priceAt = (ratio: number) => source.high + (source.low - source.high) * ratio;

  return activeDefinition.levels.flatMap((level): StrategyLevel<TLevelId, TGroup>[] => {
    const label = formatStrategyLevelLabel(level, activeDefinition.labelFormat ?? "label");
    const base = {
      id: level.id,
      group: level.group,
      kind: level.kind,
      label,
      color: level.color,
      sourceStart: source.start,
      sourceEnd: source.end,
      lineStyle: level.lineStyle,
      lineWidth: level.lineWidth,
      fillOpacity: level.fillOpacity,
      priority: level.priority,
    };
    if (level.kind === "zone") {
      if (!Number.isFinite(level.fromRatio) || !Number.isFinite(level.toRatio)) return [];
      const fromRatio = level.fromRatio as number;
      const toRatio = level.toRatio as number;
      return [{
        ...base,
        fromRatio,
        toRatio,
        fromPrice: priceAt(fromRatio),
        toPrice: priceAt(toRatio),
      }];
    }
    if (!Number.isFinite(level.ratio)) return [];
    const ratio = level.ratio as number;
    return [{ ...base, ratio, price: priceAt(ratio) }];
  });
}

export function saveStrategyPreset<TLevelId extends string, TGroup extends string>(
  definition: StrategyDefinition<string, TLevelId, TGroup>,
  settings: Partial<StrategySettings<TLevelId, TGroup>> | null | undefined,
  name: string,
  now = Date.now()
): StrategySettings<TLevelId, TGroup> {
  const normalized = normalizeStrategySettings(definition, settings);
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) return normalized;
  const preset: StrategyPreset<TLevelId, TGroup> = {
    id: `strategy-preset-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    groups: structuredClone(normalized.groups),
    levels: structuredClone(normalized.levels),
    labelFormat: normalized.labelFormat,
    createdAt: now,
  };
  return {
    ...normalized,
    activePresetId: preset.id,
    presets: [preset, ...normalized.presets.filter((item) => item.name !== trimmed)].slice(0, 50),
  };
}

export function applyStrategyPreset<TLevelId extends string, TGroup extends string>(
  definition: StrategyDefinition<string, TLevelId, TGroup>,
  settings: Partial<StrategySettings<TLevelId, TGroup>> | null | undefined,
  presetId: string
): StrategySettings<TLevelId, TGroup> {
  const normalized = normalizeStrategySettings(definition, settings);
  const preset = normalized.presets.find((item) => item.id === presetId);
  if (!preset) return normalized;
  return {
    ...normalized,
    groups: structuredClone(preset.groups),
    levels: structuredClone(preset.levels),
    labelFormat: preset.labelFormat ?? normalized.labelFormat,
    activePresetId: preset.id,
  };
}

function resolveSourceCandle(
  source: StrategySourceDefinition,
  bars: readonly FootprintBar[],
  now: number,
  sourceIntervalMs?: number
): PeriodCandle | null {
  const completed = aggregatePeriodCandles(bars, source.period, now, sourceIntervalMs)
    .filter((item) => item.complete && Number.isFinite(item.high) && Number.isFinite(item.low));
  if (source.kind === "latest-completed-weekday") {
    const matching = completed.filter((item) => new Date(item.start).getUTCDay() === source.weekday);
    return matching.length ? matching[matching.length - 1] : null;
  }
  // "Previous" is a calendar identity, not "the newest candle that happens
  // to be marked complete". Select the exact immediately preceding bucket so
  // a mislabeled/current upstream aggregate can never become PW Strategy.
  const expectedStart = previousAnalysisPeriodStart(now, source.period);
  return completed.find((item) => item.start === expectedStart) ?? null;
}

function normalizeGroups<TGroup extends string>(
  groups: readonly StrategyGroupDefinition<TGroup>[] | undefined,
  fallback: readonly StrategyGroupDefinition<TGroup>[]
): StrategyGroupDefinition<TGroup>[] {
  const source = Array.isArray(groups) && groups.length ? groups : fallback;
  const seen = new Set<string>();
  return source.flatMap((group): StrategyGroupDefinition<TGroup>[] => {
    if (!group || typeof group.id !== "string" || !group.id.trim() || seen.has(group.id)) return [];
    seen.add(group.id);
    return [{
      id: group.id,
      label: typeof group.label === "string" && group.label.trim() ? group.label.trim().slice(0, 80) : group.id,
      treeStateKey: typeof group.treeStateKey === "string" && group.treeStateKey.trim() ? group.treeStateKey.trim() : undefined,
    }];
  });
}

function normalizeLevels<TLevelId extends string, TGroup extends string>(
  levels: readonly StrategyLevelDefinition<TLevelId, TGroup>[] | undefined,
  fallback: readonly StrategyLevelDefinition<TLevelId, TGroup>[],
  groups: readonly StrategyGroupDefinition<TGroup>[]
): StrategyLevelDefinition<TLevelId, TGroup>[] {
  const source = Array.isArray(levels) && levels.length ? levels : fallback;
  const groupIds = new Set(groups.map((group) => group.id));
  const seen = new Set<string>();
  return source.flatMap((level): StrategyLevelDefinition<TLevelId, TGroup>[] => {
    if (!level || typeof level.id !== "string" || !level.id.trim() || seen.has(level.id)) return [];
    if (!groupIds.has(level.group)) return [];
    if (level.kind !== "line" && level.kind !== "zone") return [];
    if (!isColor(level.color)) return [];
    if (level.kind === "line" && !Number.isFinite(level.ratio)) return [];
    if (level.kind === "zone" && (!Number.isFinite(level.fromRatio) || !Number.isFinite(level.toRatio))) return [];
    seen.add(level.id);
    return [{
      id: level.id,
      group: level.group,
      kind: level.kind,
      color: level.color,
      label: typeof level.label === "string" && level.label.trim() ? level.label.trim().slice(0, 100) : undefined,
      name: typeof level.name === "string" && level.name.trim() ? level.name.trim().slice(0, 80) : undefined,
      ratio: level.kind === "line" ? level.ratio : undefined,
      fromRatio: level.kind === "zone" ? level.fromRatio : undefined,
      toRatio: level.kind === "zone" ? level.toRatio : undefined,
      labelFormat: normalizeOptionalLabelFormat(level.labelFormat),
      lineStyle: normalizeLineStyle(level.lineStyle),
      lineWidth: Number.isFinite(level.lineWidth) ? Math.max(0.5, Math.min(8, level.lineWidth as number)) : undefined,
      fillOpacity: Number.isFinite(level.fillOpacity) ? Math.max(0, Math.min(0.8, level.fillOpacity as number)) : undefined,
      priority: Number.isFinite(level.priority) ? Math.max(0, Math.min(100, level.priority as number)) : undefined,
    }];
  });
}

function normalizePresets<TLevelId extends string, TGroup extends string>(
  presets: readonly StrategyPreset<TLevelId, TGroup>[] | undefined,
  definition: StrategyDefinition<string, TLevelId, TGroup>,
  fallbackGroups: readonly StrategyGroupDefinition<TGroup>[]
): StrategyPreset<TLevelId, TGroup>[] {
  if (!Array.isArray(presets)) return [];
  return presets.flatMap((preset): StrategyPreset<TLevelId, TGroup>[] => {
    if (!preset || typeof preset.name !== "string" || !preset.name.trim()) return [];
    const groups = normalizeGroups(preset.groups, fallbackGroups);
    const levels = normalizeLevels(preset.levels, definition.levels, groups);
    if (!levels.length) return [];
    return [{
      id: typeof preset.id === "string" && preset.id.trim()
        ? preset.id.trim()
        : `strategy-preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: preset.name.trim().slice(0, 60),
      groups,
      levels,
      labelFormat: normalizeOptionalLabelFormat(preset.labelFormat),
      createdAt: Number.isFinite(preset.createdAt) ? preset.createdAt : Date.now(),
    }];
  }).slice(0, 50);
}

function formatStrategyLevelLabel(
  level: StrategyLevelDefinition,
  strategyFormat: StrategyLabelFormat
): string {
  if (level.labelFormat !== undefined) {
    const format = normalizeLabelFormat(level.labelFormat, strategyFormat);
    return formatGeneratedLabel(level, format);
  }
  if (level.label && strategyFormat === "label") return level.label;
  return formatGeneratedLabel(level, strategyFormat);
}

function formatGeneratedLabel(level: StrategyLevelDefinition, format: StrategyLabelFormat): string {
  const name = level.name ?? level.label ?? level.id;
  if (format === "label" && level.label) return level.label;
  if (format === "name") return name;
  const ratio = level.kind === "line"
    ? formatRatio(level.ratio as number)
    : `${formatRatio(level.fromRatio as number)}-${formatRatio(level.toRatio as number)}`;
  if (format === "ratio") return ratio;
  return `${name} · ${ratio}`;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function normalizeLabelFormat(value: unknown, fallback: StrategyLabelFormat | undefined): StrategyLabelFormat {
  return value === "label" || value === "name" || value === "ratio" || value === "name-ratio"
    ? value
    : fallback ?? "label";
}

function normalizeOptionalLabelFormat(value: unknown): StrategyLabelFormat | undefined {
  return value === "label" || value === "name" || value === "ratio" || value === "name-ratio"
    ? value
    : undefined;
}

function normalizeLineStyle(value: unknown): StrategyLineStyle | undefined {
  return value === "solid" || value === "dashed" || value === "dotted" || value === "long-dashed"
    ? value
    : undefined;
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

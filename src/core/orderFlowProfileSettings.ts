import type { ProfileMetric, ProfileSide } from "./analysis/orderFlowProfile.js";

export type ProfileLevelDisplay = "off" | "static" | "developing" | "both";
export type ProfileLineStyle = "solid" | "dashed" | "dotted";

export interface CommonOrderFlowProfileSettings {
  profileMetric: ProfileMetric;
  profileSide: ProfileSide;
  pocMode: ProfileLevelDisplay;
  vahMode: ProfileLevelDisplay;
  valMode: ProfileLevelDisplay;
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
}

export interface FixedRangeOrderFlowProfileSettings extends CommonOrderFlowProfileSettings {
  valueAreaPercent?: number;
  profileWidth?: number;
}

export const DEFAULT_ORDER_FLOW_PROFILE_SETTINGS: Readonly<Pick<
  CommonOrderFlowProfileSettings,
  "profileMetric" | "profileSide" | "pocMode" | "vahMode" | "valMode"
>> = {
  profileMetric: "volume",
  profileSide: "total",
  pocMode: "static",
  vahMode: "static",
  valMode: "static",
};

type UnknownSettings = Record<string, unknown>;
type LevelPrefix = "poc" | "vah" | "val";
type LineVariant = "Static" | "Developing";

const LEVEL_PREFIXES: readonly LevelPrefix[] = ["poc", "vah", "val"];
const LINE_VARIANTS: readonly LineVariant[] = ["Static", "Developing"];

export function normalizeOrderFlowProfileSettings(
  input: UnknownSettings | undefined,
): CommonOrderFlowProfileSettings & UnknownSettings {
  const source = input ?? {};
  const next: CommonOrderFlowProfileSettings & UnknownSettings = { ...source } as CommonOrderFlowProfileSettings & UnknownSettings;
  next.profileMetric = normalizeMetric(source.profileMetric);
  next.profileSide = normalizeSide(source.profileSide);
  next.pocMode = normalizeLevelMode(source.pocMode, legacyMode(source.showPoc, true));
  const legacyVa = legacyMode(source.showValueArea, true);
  next.vahMode = normalizeLevelMode(source.vahMode, legacyVa);
  next.valMode = normalizeLevelMode(source.valMode, legacyVa);

  if (typeof source.pocStaticColor !== "string" && typeof source.pocColor === "string") {
    next.pocStaticColor = source.pocColor;
  }
  if (typeof source.vahStaticColor !== "string" && typeof source.vaColor === "string") {
    next.vahStaticColor = source.vaColor;
  }
  if (typeof source.valStaticColor !== "string" && typeof source.vaColor === "string") {
    next.valStaticColor = source.vaColor;
  }
  normalizeLineSettings(source, next);
  return next;
}

export function normalizeFixedRangeOrderFlowProfileSettings(
  input: UnknownSettings | undefined,
): FixedRangeOrderFlowProfileSettings & UnknownSettings {
  const source = input ?? {};
  const next = normalizeOrderFlowProfileSettings({
    ...source,
    pocMode: source.pocMode ?? legacyMode(source.showPoc, true),
    vahMode: source.vahMode ?? legacyMode(source.showVah, true),
    valMode: source.valMode ?? legacyMode(source.showVal, true),
  }) as FixedRangeOrderFlowProfileSettings & UnknownSettings;
  if (typeof source.valueAreaPercent === "number" && Number.isFinite(source.valueAreaPercent)) {
    next.valueAreaPercent = Math.max(0.01, Math.min(0.99, source.valueAreaPercent));
  }
  if (typeof source.profileWidth === "number" && Number.isFinite(source.profileWidth)) {
    next.profileWidth = Math.max(0.05, Math.min(0.9, source.profileWidth));
  }
  return next;
}

export function profileSupportsValueArea(metric: ProfileMetric): boolean {
  return metric === "volume" || metric === "trade-count";
}

export function levelModeHasStatic(mode: ProfileLevelDisplay): boolean {
  return mode === "static" || mode === "both";
}

export function levelModeHasDeveloping(mode: ProfileLevelDisplay): boolean {
  return mode === "developing" || mode === "both";
}

function normalizeLineSettings(source: UnknownSettings, next: UnknownSettings): void {
  for (const prefix of LEVEL_PREFIXES) {
    for (const variant of LINE_VARIANTS) {
      const widthKey = `${prefix}${variant}Width`;
      if (widthKey in source) {
        const width = source[widthKey];
        next[widthKey] = typeof width === "number" && Number.isFinite(width)
          ? Math.max(1, Math.min(5, width))
          : 1;
      }
      const styleKey = `${prefix}${variant}Style`;
      if (styleKey in source) next[styleKey] = normalizeLineStyle(source[styleKey]);
      const colorKey = `${prefix}${variant}Color`;
      if (colorKey in source && typeof source[colorKey] !== "string") delete next[colorKey];
    }
  }
}

function legacyMode(value: unknown, defaultVisible: boolean): ProfileLevelDisplay {
  if (value === false) return "off";
  if (value === true) return "static";
  return defaultVisible ? "static" : "off";
}

function normalizeMetric(value: unknown): ProfileMetric {
  return value === "delta" || value === "trade-count" || value === "average-trade-size"
    ? value
    : "volume";
}

function normalizeSide(value: unknown): ProfileSide {
  return value === "buy" || value === "sell" ? value : "total";
}

function normalizeLevelMode(value: unknown, fallback: ProfileLevelDisplay): ProfileLevelDisplay {
  return value === "off" || value === "developing" || value === "both" || value === "static"
    ? value
    : fallback;
}

function normalizeLineStyle(value: unknown): ProfileLineStyle {
  return value === "dashed" || value === "dotted" ? value : "solid";
}

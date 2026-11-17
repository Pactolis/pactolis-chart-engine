import type { FootprintBar } from "../types.js";
import { calculateOrderFlowProfile, type ProfileSourceProvenance } from "./orderFlowProfile.js";

export type VolumeProfileMode = "visible" | "session";

export interface VolumeProfileSettings {
  enabled: boolean;
  mode: VolumeProfileMode;
  valueAreaPercent: number;
  showPoc: boolean;
  showVah: boolean;
  showVal: boolean;
}

export interface VolumeProfileOptions {
  valueAreaPercent?: number;
  priceStep?: number;
  allowOhlcvEstimate?: boolean;
}

export interface VolumeProfileLevel {
  priceBin: number;
  buyVol: number;
  sellVol: number;
  totalVol: number;
}

export interface VolumeProfileResult {
  levels: VolumeProfileLevel[];
  totalVolume: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  fromTime: number | null;
  toTime: number | null;
  provenance: ProfileSourceProvenance;
  isEstimated: boolean;
  exactBarCount: number;
  estimatedBarCount: number;
}

export const DEFAULT_VOLUME_PROFILE_SETTINGS: VolumeProfileSettings = {
  enabled: false,
  mode: "visible",
  valueAreaPercent: 0.7,
  showPoc: true,
  showVah: true,
  showVal: true,
};

export function calculateVolumeProfile(
  bars: readonly FootprintBar[],
  valueAreaPercentOrOptions: number | VolumeProfileOptions = 0.7,
  options?: Omit<VolumeProfileOptions, "valueAreaPercent">,
): VolumeProfileResult {
  const resolvedOptions = typeof valueAreaPercentOrOptions === "number"
    ? { valueAreaPercent: valueAreaPercentOrOptions, ...options }
    : valueAreaPercentOrOptions;
  const result = calculateOrderFlowProfile(bars, {
    profileMetric: "volume",
    profileSide: "total",
    valueAreaPercent: resolvedOptions.valueAreaPercent ?? 0.7,
    priceStep: resolvedOptions.priceStep,
    allowOhlcvEstimate: resolvedOptions.allowOhlcvEstimate,
  });
  return {
    levels: result.levels.map(({ priceBin, buyVol, sellVol, totalVol }) => ({
      priceBin,
      buyVol,
      sellVol,
      totalVol,
    })),
    totalVolume: result.totalVolume,
    poc: result.poc,
    vah: result.vah,
    val: result.val,
    fromTime: result.fromTime,
    toTime: result.toTime,
    provenance: result.provenance,
    isEstimated: result.isEstimated,
    exactBarCount: result.exactBarCount,
    estimatedBarCount: result.estimatedBarCount,
  };
}

export function sessionBars(bars: readonly FootprintBar[], anchorTime: number): FootprintBar[] {
  const dayStart = Math.floor(anchorTime / 86_400_000) * 86_400_000;
  const dayEnd = dayStart + 86_400_000;
  return bars.filter((bar) => bar.startTime >= dayStart && bar.startTime < dayEnd);
}

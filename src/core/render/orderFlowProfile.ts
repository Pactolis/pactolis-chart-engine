import type { OiDeltaDisplay } from "../orderFlowProfileSettings.js";
import type { ProfileMetric, ProfileSide } from "../analysis/orderFlowProfile.js";

export type HistogramPartSide = "buy" | "sell" | "total" | "delta";

export interface HistogramLevelLike {
  value: number | null;
  buyValue: number | null;
  sellValue: number | null;
  magnitude: number | null;
  oiOpen?: number;
  oiClose?: number;
}

export interface HistogramPart {
  side: HistogramPartSide;
  value: number;
  signed: number;
}

export function profileHistogramParts(
  level: HistogramLevelLike,
  metric: ProfileMetric,
  side: ProfileSide,
  oiDeltaDisplay: OiDeltaDisplay = "net",
): HistogramPart[] {
  if (level.value === null || level.magnitude === null || !Number.isFinite(level.value)) return [];
  if (metric === "delta") {
    return [{ side: "delta", value: level.magnitude, signed: level.value }];
  }
  if (metric === "oi-delta") {
    if (oiDeltaDisplay === "split") {
      const openVal = Math.max(0, level.oiOpen ?? level.buyValue ?? 0);
      const closeVal = Math.max(0, Math.abs(level.oiClose ?? level.sellValue ?? 0));
      const parts: HistogramPart[] = [];
      if (closeVal > 0) parts.push({ side: "sell", value: closeVal, signed: -closeVal });
      if (openVal > 0) parts.push({ side: "buy", value: openVal, signed: openVal });
      return parts;
    }
    return [{ side: "delta", value: Math.abs(level.value), signed: level.value }];
  }
  if ((metric === "volume" || metric === "trade-count") && side === "total") {
    if (level.buyValue !== null && level.sellValue !== null) {
      return [
        { side: "sell", value: Math.max(0, level.sellValue), signed: Math.max(0, level.sellValue) },
        { side: "buy", value: Math.max(0, level.buyValue), signed: Math.max(0, level.buyValue) },
      ];
    }
    return [{ side: "total", value: level.magnitude, signed: level.value }];
  }
  return [{
    side: side === "buy" ? "buy" : side === "sell" ? "sell" : "total",
    value: level.magnitude,
    signed: level.value,
  }];
}

export function stepSegments(points: readonly { x: number; y: number }[]): [number, number, number, number][] {
  if (!points.length) return [];
  if (points.length === 1) {
    const point = points[0];
    return [[point.x, point.y, point.x + 1, point.y]];
  }
  const segments: [number, number, number, number][] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index];
    const next = points[index + 1];
    segments.push([current.x, current.y, next.x, current.y]);
    segments.push([next.x, current.y, next.x, next.y]);
  }
  return segments;
}

export function lineDash(style: "solid" | "dashed" | "dotted"): number[] {
  if (style === "dashed") return [6, 5];
  if (style === "dotted") return [2, 4];
  return [];
}

import type { RenderStage, RenderSurface } from "./chartScene.js";
import { STAGE_RANK, surfaceForStage } from "./chartScene.js";

export type BuiltInChartType = "footprint" | "footprintProfile" | "candlestick" | "tpo";

export interface BuiltInLayerPreset {
  readonly gpu: readonly string[];
  readonly annotation: readonly string[];
  readonly interaction: readonly string[];
}

const COMMON_ANNOTATION = [
  "orderbook-heatmap",
  "volume-profile",
  "strategy-levels",
  "naked-poc",
  "reference-levels",
  "drawings",
  "indicators",
  "last-price",
  "axis",
] as const;

const COMMON_INTERACTION = ["crosshair", "hud", "interaction-controls"] as const;

export function resolveBuiltInLayerPreset(chartType: BuiltInChartType): BuiltInLayerPreset {
  switch (chartType) {
    case "candlestick":
      return {
        gpu: ["grid", "candles"],
        annotation: [...COMMON_ANNOTATION],
        interaction: [...COMMON_INTERACTION],
      };
    case "footprintProfile":
      return {
        gpu: ["grid", "candles", "footprint-profile"],
        annotation: ["footprint-text", ...COMMON_ANNOTATION],
        interaction: [...COMMON_INTERACTION],
      };
    case "tpo":
      return {
        gpu: ["grid", "candles"],
        annotation: ["tpo", ...COMMON_ANNOTATION],
        interaction: [...COMMON_INTERACTION],
      };
    case "footprint":
      return {
        gpu: ["grid", "candles", "footprint"],
        annotation: ["footprint-text", ...COMMON_ANNOTATION],
        interaction: [...COMMON_INTERACTION],
      };
  }
}

export const LAYER_STAGE: Readonly<Record<string, { stage: RenderStage; order: number }>> = {
  grid: { stage: "gpu-background", order: 10 },
  candles: { stage: "gpu-series", order: 20 },
  footprint: { stage: "gpu-series", order: 30 },
  "footprint-profile": { stage: "gpu-series", order: 30 },
  "orderbook-heatmap": { stage: "annotation-data", order: 5 },
  "footprint-text": { stage: "annotation-data", order: 20 },
  "volume-profile": { stage: "annotation-data", order: 30 },
  tpo: { stage: "annotation-data", order: 40 },
  "strategy-levels": { stage: "annotation-overlay", order: 50 },
  "naked-poc": { stage: "annotation-overlay", order: 60 },
  "reference-levels": { stage: "annotation-overlay", order: 70 },
  drawings: { stage: "annotation-overlay", order: 80 },
  indicators: { stage: "annotation-overlay", order: 90 },
  "last-price": { stage: "annotation-overlay", order: 100_000 },
  axis: { stage: "axis-ui", order: 110_000 },
  crosshair: { stage: "interaction", order: 10 },
  hud: { stage: "interaction", order: 20 },
  "interaction-controls": { stage: "interaction", order: 30 },
};

export interface ResolvedLayerOrder {
  readonly gpu: ReadonlySet<string>;
  readonly annotation: readonly string[];
  readonly interaction: readonly string[];
}

export function resolveLayerOrder(
  chartType: BuiltInChartType,
  visibleIndicatorIds: readonly string[] = [],
): ResolvedLayerOrder {
  const preset = resolveBuiltInLayerPreset(chartType);
  const entries: Array<{ id: string; passId: string; surface: RenderSurface; stage: RenderStage; order: number }> = [];
  for (const id of [...preset.gpu, ...preset.annotation, ...preset.interaction]) {
    if (id === "indicators") continue;
    const descriptor = LAYER_STAGE[id];
    if (!descriptor) throw new Error(`Unknown built-in chart layer '${id}'`);
    entries.push({
      id,
      passId: `${id}:pass`,
      surface: surfaceForStage(descriptor.stage),
      stage: descriptor.stage,
      order: descriptor.order,
    });
  }
  for (let index = 0; index < visibleIndicatorIds.length; index++) {
    const instanceId = visibleIndicatorIds[index];
    const stage: RenderStage = "annotation-overlay";
    entries.push({
      id: `indicator:${instanceId}`,
      passId: `indicator:${instanceId}:pass`,
      surface: surfaceForStage(stage),
      stage,
      order: 90_000 + Math.max(0, index),
    });
  }
  entries.sort((a, b) => {
    const stageDelta = STAGE_RANK[a.stage] - STAGE_RANK[b.stage];
    if (stageDelta !== 0) return stageDelta;
    const orderDelta = a.order - b.order;
    if (orderDelta !== 0) return orderDelta;
    return a.passId.localeCompare(b.passId);
  });
  const forSurface = (surface: RenderSurface): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.surface !== surface || seen.has(entry.id)) continue;
      seen.add(entry.id);
      ids.push(entry.id);
    }
    return ids;
  };
  return {
    gpu: new Set(forSurface("gpu-scene")),
    annotation: forSurface("annotation"),
    interaction: forSurface("interaction"),
  };
}

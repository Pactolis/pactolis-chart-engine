import type { ChartLayer, RenderStage, RenderSurface } from "./chartScene.js";
import { surfaceForStage } from "./chartScene.js";

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

const LAYER_STAGE: Readonly<Record<string, { stage: RenderStage; order: number }>> = {
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

function layerDescriptor(id: string): ChartLayer {
  const descriptor = LAYER_STAGE[id];
  if (!descriptor) throw new Error(`Unknown built-in chart layer '${id}'`);
  const surface: RenderSurface = surfaceForStage(descriptor.stage);
  return {
    id,
    kind: id,
    visible: true,
    passes: [{
      id: `${id}:pass`,
      surface,
      stage: descriptor.stage,
      order: descriptor.order,
    }],
  };
}

/** Build the runtime scene metadata for a built-in chart preset. */
export function buildBuiltInSceneLayers(chartType: BuiltInChartType): readonly ChartLayer[] {
  const preset = resolveBuiltInLayerPreset(chartType);
  // Indicator instances are registered individually by ChartRuntime; the preset's
  // `indicators` entry remains the compatibility adapter key for Overlay.
  return [...preset.gpu, ...preset.annotation, ...preset.interaction]
    .filter((id) => id !== "indicators")
    .map(layerDescriptor);
}

export function buildIndicatorSceneLayer(instanceId: string, order: number): ChartLayer {
  const stage: RenderStage = "annotation-overlay";
  return {
    id: `indicator:${instanceId}`,
    kind: "indicator",
    visible: true,
    passes: [{
      id: `indicator:${instanceId}:pass`,
      surface: surfaceForStage(stage),
      stage,
      order: 90_000 + Math.max(0, order),
    }],
  };
}

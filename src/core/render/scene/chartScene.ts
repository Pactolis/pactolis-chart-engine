import type { ChartDataUpdateKind } from "../../dataUpdateEvent.js";

export type RenderSurface = "gpu-scene" | "annotation" | "interaction";

export type RenderStage =
  | "gpu-background"
  | "gpu-series"
  | "gpu-signal"
  | "annotation-data"
  | "annotation-overlay"
  | "axis-ui"
  | "interaction";

/**
 * Semantic reasons a chart needs a new frame. Callers name what changed; `surfaceDirtyForChanges`
 * decides which physical surfaces that redraws. A bare `invalidate()` still means `All`.
 */
export enum ChartChange {
  None = 0,
  /** The newest bar changed or new bars were appended; closed bars are untouched. */
  DataTail = 1 << 0,
  /** Price/time mapping moved: pan, zoom, auto-fit, scale mode, indicator pane scale. */
  Viewport = 1 << 1,
  /** Plot, pane or canvas geometry changed. */
  Layout = 1 << 2,
  /** Colors, chart type, locale and other presentation settings. */
  Style = 1 << 3,
  Interaction = 1 << 4,
  /** A layer or indicator was shown or hidden. */
  Visibility = 1 << 5,
  GpuContext = 1 << 6,
  /** Bars before the tail were corrected, reloaded or cleared (history load/patch, replay reset). */
  DataNonTail = 1 << 7,
  Data = DataTail | DataNonTail,
  All = Data | Viewport | Layout | Style | Interaction | Visibility | GpuContext,
}

export enum ChartSurfaceDirty {
  None = 0,
  GpuScene = 1 << 0,
  Annotation = 1 << 1,
  Interaction = 1 << 2,
  All = GpuScene | Annotation | Interaction,
}

export const STAGE_RANK: Readonly<Record<RenderStage, number>> = {
  "gpu-background": 0,
  "gpu-series": 1,
  "gpu-signal": 2,
  "annotation-data": 3,
  "annotation-overlay": 4,
  "axis-ui": 5,
  interaction: 6,
};

export function surfaceForStage(stage: RenderStage): RenderSurface {
  switch (stage) {
    case "gpu-background":
    case "gpu-series":
    case "gpu-signal":
      return "gpu-scene";
    case "annotation-data":
    case "annotation-overlay":
    case "axis-ui":
      return "annotation";
    case "interaction":
      return "interaction";
  }
}

/** Which data change a classified pipeline/replay update carries. */
export function chartChangeForDataUpdate(kind: ChartDataUpdateKind): ChartChange {
  switch (kind) {
    case "same-bar-update":
    case "new-bar-appended":
    case "replay-step":
      return ChartChange.DataTail;
    case "history-loaded":
    case "history-patched":
    case "price-step-reset":
    case "series-cleared":
    case "replay-reset":
    case "metadata-updated":
      return ChartChange.DataNonTail;
  }
}

/**
 * The redraw a set of changes asks for. First stage of T05-A: the vocabulary is narrow, the
 * surfaces are not — every non-interaction change still redraws all three surfaces in full.
 */
export interface ChartInvalidationScope {
  readonly changes: ChartChange;
  readonly surfaces: ChartSurfaceDirty;
}

export function invalidationScopeForChanges(changes: ChartChange): ChartInvalidationScope {
  return { changes, surfaces: surfaceDirtyForChanges(changes) };
}

export function surfaceDirtyForChanges(changes: ChartChange): ChartSurfaceDirty {
  let dirty = ChartSurfaceDirty.None;
  if (changes & ChartChange.GpuContext) dirty |= ChartSurfaceDirty.GpuScene;
  if (changes & ChartChange.Interaction) dirty |= ChartSurfaceDirty.Interaction;
  if (changes & (ChartChange.Data | ChartChange.Viewport | ChartChange.Layout | ChartChange.Style | ChartChange.Visibility)) {
    dirty |= ChartSurfaceDirty.All;
  }
  return dirty;
}

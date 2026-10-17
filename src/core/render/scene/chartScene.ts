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

const STAGE_RANK: Readonly<Record<RenderStage, number>> = {
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

export interface ChartRenderPass {
  readonly id: string;
  readonly surface: RenderSurface;
  readonly stage: RenderStage;
  readonly order: number;
  readonly interests?: ChartChange;
}

export interface ChartLayer {
  readonly id: string;
  readonly kind: string;
  readonly visible: boolean;
  readonly passes: readonly ChartRenderPass[];
  dispose?(): void;
}

interface OwnedPass extends ChartRenderPass {
  readonly ownerLayerId: string;
}

export class ChartRenderScene {
  private readonly layers = new Map<string, ChartLayer>();
  private readonly passIds = new Set<string>();

  addLayer(layer: ChartLayer): void {
    if (this.layers.has(layer.id)) throw new Error(`ChartRenderScene: duplicate layer id '${layer.id}'`);
    for (const pass of layer.passes) {
      if (this.passIds.has(pass.id)) throw new Error(`ChartRenderScene: duplicate pass id '${pass.id}'`);
      const requiredSurface = surfaceForStage(pass.stage);
      if (pass.surface !== requiredSurface) {
        throw new Error(
          `ChartRenderScene: stage '${pass.stage}' requires surface '${requiredSurface}', got '${pass.surface}'`,
        );
      }
    }
    this.layers.set(layer.id, layer);
    for (const pass of layer.passes) this.passIds.add(pass.id);
  }

  removeLayer(id: string): boolean {
    const layer = this.layers.get(id);
    if (!layer) return false;
    this.layers.delete(id);
    for (const pass of layer.passes) this.passIds.delete(pass.id);
    layer.dispose?.();
    return true;
  }

  clear(): void {
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
  }

  passesForSurface(surface: RenderSurface): readonly OwnedPass[] {
    const passes: OwnedPass[] = [];
    for (const layer of this.layers.values()) {
      if (!layer.visible) continue;
      for (const pass of layer.passes) {
        if (pass.surface !== surface) continue;
        passes.push({ ...pass, ownerLayerId: layer.id });
      }
    }
    passes.sort((a, b) => {
      const stageDelta = STAGE_RANK[a.stage] - STAGE_RANK[b.stage];
      if (stageDelta !== 0) return stageDelta;
      const orderDelta = a.order - b.order;
      if (orderDelta !== 0) return orderDelta;
      return a.id.localeCompare(b.id);
    });
    return passes;
  }

  layerIdsForSurface(surface: RenderSurface): readonly string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const pass of this.passesForSurface(surface)) {
      if (seen.has(pass.ownerLayerId)) continue;
      seen.add(pass.ownerLayerId);
      ids.push(pass.ownerLayerId);
    }
    return ids;
  }

  hasLayer(id: string): boolean {
    return this.layers.has(id);
  }

  dispose(): void {
    this.clear();
  }
}
